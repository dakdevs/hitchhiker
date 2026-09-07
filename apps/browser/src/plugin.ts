import { readPluginPackage } from "./plugin-package.ts";
import { Effect, Schema, Stream } from "effect";
import { EngineConnection, runLivePlugin, type GrantStoreApi } from "@hitchhiker/runtime";
import { browserMcpApi } from "./mcp.ts";
import type { BrowserController } from "./controller.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { BrowserComposition } from "./composition.ts";
import type { PluginArtifact } from "./plugin-artifacts.ts";

/** Captures only trusted services; persisted grant IDs never become wire credentials. */
export const createInstalledPluginLauncher = Effect.fn("Browser.createInstalledPluginLauncher")(
  function* (options: {
    readonly executable: string;
    readonly grants: GrantStoreApi;
    readonly controller: BrowserController;
    readonly onRecoveryFailure?: Effect.Effect<void>;
    readonly composition?: BrowserComposition;
  }) {
    const engine = yield* EngineConnection;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let generation = 0;
    return (artifact: PluginArtifact, grantId: string, onReady: Effect.Effect<void>) => {
      const owner = crypto.randomUUID();
      const composition = options.composition;
      const composedOwner = { id: artifact.manifest.id, generation: ++generation };
      const hasUi = artifact.manifest.capabilities.some(
        (capability) => capability === "ui.compose" || capability === "browser.full-control",
      );
      // The manager chose this ID from its private registry. The worker cannot select
      // an ID or invoke any GrantStore method; its dispatcher receives this fixed binding.
      const boundGrants: GrantStoreApi = {
        ...options.grants,
        authenticate: (_token, request) => options.grants.authenticateGrant(grantId, request),
        authorize: (_token, request) => options.grants.authorizeGrant(grantId, request),
      };
      const run = runLivePlugin({
        manifest: artifact.manifest,
        code: artifact.code,
        executable: options.executable,
        token: "trusted-installed-grant",
        profileId: "default",
        grants: boundGrants,
        browser: browserMcpApi(options.controller),
        publish: (surface) => options.controller.publishPluginSurface(owner, surface),
        release: composition
          ? composition.release(composedOwner)
          : options.controller.releasePluginSurface(owner),
        onStop: composition ? Effect.void : undefined,
        stopWhen: composition?.failure(composedOwner),
        composition: composition
          ? {
              publishLayout: (surface) => composition.publishLayout(composedOwner, surface),
              publishContribution: (id, surface) =>
                composition.publishContribution(composedOwner, id, surface),
              withdrawContribution: (id) => composition.withdrawContribution(composedOwner, id),
            }
          : undefined,
        onReady,
        onRecoveryFailure: options.onRecoveryFailure,
        events: Stream.merge(
          composition ? composition.events(composedOwner) : options.controller.pluginEvents(owner),
          engine.events.pipe(
            Stream.filter((event) => event.event.startsWith("pages.")),
            Stream.map((event) => ({ event: event.event, payload: event.params })),
          ),
        ),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      if (!composition || !hasUi) return run;
      return Effect.acquireRelease(composition.activate(composedOwner), () =>
        composition.remove(composedOwner).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => options.onRecoveryFailure ?? Effect.die(cause)),
        ),
      ).pipe(Effect.andThen(run), Effect.scoped);
    };
  },
);

/** Developer packages have fixed filenames; the manifest cannot select another local path. */
export const runPluginDirectory = Effect.fn("Browser.runPluginDirectory")(function* (options: {
  readonly directory: string;
  readonly executable: string;
  readonly token: string;
  readonly grants: GrantStoreApi;
  readonly controller: BrowserController;
  readonly onRecoveryFailure?: Effect.Effect<void>;
}) {
  const files = yield* readPluginPackage(options.directory);
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    files.manifest,
  );
  const code = files.code;
  const owner = crypto.randomUUID();
  const engine = yield* EngineConnection;
  const pageEvents = engine.events.pipe(
    Stream.filter((event) => event.event.startsWith("pages.")),
    Stream.map((event) => ({ event: event.event, payload: event.params })),
  );
  yield* runLivePlugin({
    manifest,
    code,
    executable: options.executable,
    token: options.token,
    profileId: "default",
    grants: options.grants,
    browser: browserMcpApi(options.controller),
    publish: (surface) => options.controller.publishPluginSurface(owner, surface),
    release: options.controller.releasePluginSurface(owner),
    onRecoveryFailure: options.onRecoveryFailure,
    events: Stream.merge(options.controller.pluginEvents(owner), pageEvents),
  });
});
