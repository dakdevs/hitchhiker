import { Effect, Schedule, Schema, Stream } from "effect";
import type { PluginDispatchOptions } from "./plugin-dispatch.ts";
import { LivePluginManifest, createPluginDispatcher } from "./plugin-dispatch.ts";
import { spawnPluginHost } from "./plugin.ts";
import { makePluginDomSession } from "./plugin-dom.ts";
import type { ScopedDomDriver } from "./scoped-dom.ts";
import type { ExtensionManagementApi } from "./extension-management.ts";

export interface LivePluginOptions extends Omit<
  PluginDispatchOptions,
  "manifest" | "dom" | "extensions"
> {
  readonly manifest: unknown;
  /** Shared trusted browser adapter. A finite reference session is created per plugin activation. */
  readonly dom?: ScopedDomDriver;
  /** Owner-bound extension management port; installation review remains native-only. */
  readonly extensions?: ExtensionManagementApi;
  readonly executable: string;
  readonly code: string;
  readonly events: Stream.Stream<{ readonly event: string; readonly payload: unknown }, unknown>;
  /** Broker-owned events already enforce service bindings and current authority on delivery. */
  readonly serviceEvents?: Stream.Stream<
    { readonly event: string; readonly payload: Schema.Json },
    unknown
  >;
  /** An owner-specific inbox/resource failure terminates this worker, including activation. */
  readonly stopWhen?: Effect.Effect<never, unknown>;
  /** Trusted lifecycle cleanup, distinct from a worker requesting ui.release. */
  readonly onStop?: Effect.Effect<void, unknown>;
  /** Runs only after the isolated worker's activation Promise has fulfilled. */
  readonly onReady?: Effect.Effect<void, unknown>;
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
  const { dom: domDriver, ...dispatchOptions } = options;
  const dom = yield* makePluginDomSession({
    manifest,
    profileId: options.profileId,
    token: options.token,
    grants: options.grants,
    driver: domDriver,
  });
  const dispatch = createPluginDispatcher({
    ...dispatchOptions,
    manifest,
    ...(dom === undefined ? {} : { dom }),
  });
  const host = yield* spawnPluginHost({ executable: options.executable, call: dispatch });
  yield* Effect.addFinalizer(() =>
    (options.onStop ?? options.release).pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced(100) }),
      Effect.catchCause((cause) => options.onRecoveryFailure ?? Effect.die(cause)),
    ),
  );
  const stopped = Effect.raceFirst(host.failure, options.stopWhen ?? Effect.never);
  yield* Effect.raceFirst(
    host.activate(options.code).pipe(Effect.andThen(options.onReady ?? Effect.void)),
    stopped,
  );
  const forwarding = options.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const capability =
          event.event === "ui.event"
            ? "ui.compose"
            : event.event === "devtools.changed"
              ? "devtools.manage"
              : event.event === "extensions.installation.changed"
                ? "extensions.install"
                : event.event.startsWith("pages.")
                  ? "pages.list"
                  : undefined;
        if (capability === undefined) return;
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
  const serviceForwarding = options.serviceEvents
    ? options.serviceEvents.pipe(
        Stream.runForEach((event) => host.sendEvent(event.event, event.payload)),
      )
    : Effect.never;
  const lease = Effect.gen(function* () {
    const current = yield* options.grants.authenticate(options.token, {
      profileId: options.profileId,
    });
    if (current.principal !== manifest.id)
      return yield* Effect.fail("Plugin identity no longer authorized");
    yield* Effect.sleep(500);
  }).pipe(Effect.forever);
  yield* Effect.raceFirst(
    Effect.raceFirst(Effect.raceFirst(forwarding, serviceForwarding), lease),
    stopped,
  );
}, Effect.scoped);
