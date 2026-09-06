import { Effect, Schedule, Schema, Stream } from "effect";
import type { PluginDispatchOptions } from "./plugin-dispatch.ts";
import { LivePluginManifest, createPluginDispatcher } from "./plugin-dispatch.ts";
import { spawnPluginHost } from "./plugin.ts";

export interface LivePluginOptions extends Omit<PluginDispatchOptions, "manifest"> {
  readonly manifest: unknown;
  readonly executable: string;
  readonly code: string;
  readonly events: Stream.Stream<{ readonly event: string; readonly payload: unknown }>;
  /** Runs only after the isolated worker's activation Promise has fulfilled. */
  readonly onReady?: Effect.Effect<void>;
  /** Escalates a failed trusted-interface recovery to the owning application. */
  readonly onRecoveryFailure?: Effect.Effect<void>;
}

/** A revision gets its own process and scope. Any failure returns control to the trusted interface. */
export const runLivePlugin = Effect.fn("runLivePlugin")(function* (options: LivePluginOptions) {
  const manifest = yield* Schema.decodeUnknownEffect(LivePluginManifest, {
    onExcessProperty: "error",
  })(options.manifest);
  const credential = yield* options.grants.authenticate(options.token, {
    profileId: options.profileId,
  });
  if (credential.principal !== manifest.id)
    return yield* Effect.fail("Plugin identity is not authorized");
  const dispatch = createPluginDispatcher({ ...options, manifest });
  const host = yield* spawnPluginHost({ executable: options.executable, call: dispatch });
  yield* Effect.addFinalizer(() =>
    options.release.pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced(100) }),
      Effect.catchCause((cause) => options.onRecoveryFailure ?? Effect.die(cause)),
    ),
  );
  yield* host.activate(options.code);
  yield* options.onReady ?? Effect.void;
  const forwarding = options.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const capability = event.event === "ui.event" ? "ui.compose" : "pages.list";
        if (
          !manifest.capabilities.includes(capability) &&
          !manifest.capabilities.includes("browser.full-control")
        )
          return;
        const grant = yield* options.grants.authorize(options.token, {
          profileId: options.profileId,
          capability,
        });
        if (grant.principal !== manifest.id)
          return yield* Effect.fail("Plugin identity no longer authorized");
        const payload = yield* Schema.decodeUnknownEffect(Schema.Json)(event.payload);
        yield* host.sendEvent(event.event, payload);
      }),
    ),
  );
  const monitoring = host.events.pipe(
    Stream.runForEach((event) =>
      event.event === "plugin.crash" || event.event === "plugin.resource"
        ? Effect.fail("Plugin was stopped by its resource watchdog")
        : Effect.void,
    ),
  );
  const lease = Effect.gen(function* () {
    const current = yield* options.grants.authenticate(options.token, {
      profileId: options.profileId,
    });
    if (current.principal !== manifest.id)
      return yield* Effect.fail("Plugin identity no longer authorized");
    yield* Effect.sleep(500);
  }).pipe(Effect.forever);
  yield* Effect.raceFirst(Effect.raceFirst(forwarding, monitoring), lease);
}, Effect.scoped);
