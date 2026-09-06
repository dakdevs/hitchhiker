import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  EngineConnection,
  EngineError,
  NativeSurface,
  createGrantStore,
  runMcpStdio,
  openCdpRelay,
  type McpPluginApi,
} from "@hitchhiker/runtime";
import { Console, Deferred, Effect, Fiber, Layer, Logger, Stream } from "effect";
import { createInstalledPluginLauncher, runPluginDirectory } from "./plugin.ts";
import { createPluginArtifactStore } from "./plugin-artifacts.ts";
import { createPluginManager } from "./plugin-manager.ts";
import { browserMcpApi } from "./mcp.ts";
import { makeBrowserController } from "./controller.ts";
import { makeBrowserDomDriver } from "./dom.ts";
import { acquireProfileWriteLease } from "./profile-write-lease.ts";
import { createExtensionArtifactStore } from "./extension-artifacts.ts";
import { createExtensionManager, type ExtensionManagerError } from "./extension-manager.ts";
import type { BrowserExtensionControls } from "./extension-controls.ts";

const argument = (name: string) => {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
};
const executable = process.env.HITCHHIKER_NATIVE_BINARY;
const profileRoot =
  argument("--profile-root") ??
  join(homedir(), "Library", "Application Support", "Hitchhiker", "profiles", "default");

const program = Effect.gen(function* () {
  if (!executable || !isAbsolute(executable) || !isAbsolute(profileRoot))
    return yield* Effect.die("HITCHHIKER_NATIVE_BINARY and --profile-root must be absolute paths");
  const profileLease = yield* acquireProfileWriteLease(profileRoot, executable);
  const safeMode = process.argv.includes("--safe-mode");
  const runtime = EngineConnection.layer({
    executable,
    profileRoot: profileLease.profileRoot,
    extensionManagement: !safeMode,
  });
  const layers = Layer.provideMerge(NativeSurface.layer, runtime);
  yield* Effect.gen(function* () {
    const engine = yield* EngineConnection;
    const fatalRecovery = yield* Deferred.make<never, EngineError>();
    const browserExit = Effect.raceFirst(engine.exit, Deferred.await(fatalRecovery));
    const rawCdp = process.argv.includes("--cdp");
    let extensions: BrowserExtensionControls | undefined;
    if (!safeMode) {
      yield* engine.ready;
      extensions = yield* Effect.gen(function* () {
        // Engine readiness excludes a surviving previous engine. The outer
        // descriptor lease excludes any previous controller filesystem writer.
        const artifacts = yield* createExtensionArtifactStore({ profileLease });
        const manager = yield* createExtensionManager({
          profileRoot: profileLease.profileRoot,
          lease: profileLease,
          engine,
          artifacts,
        });
        yield* manager.restoreBeforePages();
        if (rawCdp) yield* manager.enterReadOnly();
        const checked = <A>(operation: Effect.Effect<A, ExtensionManagerError>) =>
          operation.pipe(
            Effect.tapError((error) =>
              error.restartRequired
                ? Deferred.fail(
                    fatalRecovery,
                    new EngineError({ code: "extensions", message: error.message }),
                  )
                : Effect.void,
            ),
          );
        return {
          list: manager.list,
          previewLocal: (path: string) => checked(manager.previewLocal(path)),
          reviewPrepared: (id: string, digest: string) =>
            checked(manager.reviewPrepared(id, digest)),
          confirmInstall: (id: string, digest: string) =>
            checked(manager.confirmInstall(id, digest)),
          cancelPreview: (id: string, digest: string) => checked(manager.cancelPreview(id, digest)),
          remove: (id: string) => checked(manager.remove(id)),
          readOnly: rawCdp,
        } satisfies BrowserExtensionControls;
      }).pipe(
        Effect.catch((error) =>
          "restartRequired" in error && error.restartRequired
            ? Effect.fail(new EngineError({ code: "extensions", message: error.message }))
            : Effect.logError(
                "Extension metadata is unavailable; starting without managed extensions. Use --safe-mode to skip extension startup.",
              ).pipe(Effect.as(undefined)),
        ),
      );
    }
    const controller = yield* makeBrowserController(profileLease.profileRoot, {
      freezeEnabled: !rawCdp,
      extensions,
      profileLease,
    });
    yield* controller.start;
    const pluginDirectory = argument("--plugin");
    const mcp = process.argv.includes("--mcp");
    const grants = yield* createGrantStore({ directory: join(profileRoot, "hitchhiker-grants") });
    const recoveryFailure = Deferred.fail(
      fatalRecovery,
      new EngineError({
        code: "recovery",
        message: "The trusted interface could not be restored; closing the browser",
      }),
    ).pipe(Effect.asVoid);
    let plugins: McpPluginApi | undefined;
    let stopDeveloperPlugin: Effect.Effect<void> = Effect.void;
    let stopInstalledPlugins: Effect.Effect<void, unknown> = Effect.void;
    const pluginExecutable = process.env.HITCHHIKER_PLUGIN_HOST;
    if (
      pluginExecutable !== undefined &&
      !process.argv.includes("--safe-mode") &&
      pluginDirectory === undefined
    ) {
      if (!isAbsolute(pluginExecutable))
        return yield* Effect.die("HITCHHIKER_PLUGIN_HOST must be absolute");
      const launch = yield* createInstalledPluginLauncher({
        executable: pluginExecutable,
        grants,
        controller,
        onRecoveryFailure: recoveryFailure,
      });
      const manager = yield* createPluginManager({
        profileRoot,
        grants,
        launch,
        safeMode: process.argv.includes("--safe-mode") || pluginDirectory !== undefined,
        onRecoveryFailure: recoveryFailure,
      });
      const artifacts = yield* createPluginArtifactStore(profileRoot);
      stopInstalledPlugins = manager.list().pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            entries.filter((entry) => entry.enabled),
            (entry) => manager.disable(entry.id),
            { discard: true },
          ),
        ),
      );
      plugins = {
        stage: artifacts.stage,
        install: manager.install,
        list: manager.list,
        enable: manager.enable,
        disable: manager.disable,
        rollback: manager.rollback,
        requirements: () =>
          manager.list().pipe(
            Effect.map((entries) =>
              entries.map((entry) => ({
                manifest: {
                  id: entry.id,
                  name: entry.name,
                  version: entry.version,
                  capabilities: entry.capabilities,
                },
                hash: entry.hash,
                enabled: entry.enabled,
              })),
            ),
          ),
      };
      yield* manager
        .restore()
        .pipe(
          Effect.catchCause(() =>
            Effect.logError(
              "Installed plugins could not be restored. The default browser remains available; --safe-mode skips plugin startup.",
            ),
          ),
        );
      let reportedPluginMetadataError = false;
      yield* Effect.gen(function* () {
        const entries = yield* manager.list();
        yield* controller.updatePluginControls(entries, (operation, id) => manager[operation](id));
        reportedPluginMetadataError = false;
      }).pipe(
        Effect.catchCause(() =>
          Effect.gen(function* () {
            if (!reportedPluginMetadataError)
              yield* Effect.logError(
                "Installed plugin metadata is unavailable. Browser controls remain available.",
              );
            reportedPluginMetadataError = true;
          }),
        ),
        Effect.andThen(Effect.sleep(1000)),
        Effect.forever,
        Effect.forkScoped,
      );
    }
    if (rawCdp) {
      const token = process.env.HITCHHIKER_CDP_TOKEN;
      if (!token)
        return yield* Effect.die("--cdp requires a separately issued HITCHHIKER_CDP_TOKEN");
      const initial = yield* grants.authorize(token, {
        profileId: "default",
        capability: "cdp.connect",
      });
      const relay = yield* openCdpRelay({
        engine,
        principal: initial.principal,
        authorize: () =>
          grants.authorize(token, { profileId: "default", capability: "cdp.connect" }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          ),
      });
      yield* Console.error(JSON.stringify({ cdpDiscoveryUrl: relay.discoveryUrl }));
    }
    if (pluginDirectory && !process.argv.includes("--safe-mode")) {
      const token = process.env.HITCHHIKER_PLUGIN_TOKEN;
      if (
        !pluginExecutable ||
        !isAbsolute(pluginExecutable) ||
        !isAbsolute(pluginDirectory) ||
        !token
      )
        return yield* Effect.die(
          "--plugin requires an absolute package directory, HITCHHIKER_PLUGIN_HOST, and a pre-issued HITCHHIKER_PLUGIN_TOKEN",
        );
      const developerPlugin = yield* runPluginDirectory({
        directory: pluginDirectory,
        executable: pluginExecutable,
        token,
        grants,
        controller,
        onRecoveryFailure: recoveryFailure,
      }).pipe(
        Effect.catchCause(() => Effect.logError("Plugin stopped.")),
        Effect.forkScoped,
      );
      stopDeveloperPlugin = Fiber.interrupt(developerPlugin);
    }
    yield* engine.events.pipe(
      Stream.filter((event) => event.event === "browser.recover"),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          yield* stopDeveloperPlugin;
          // Only a native app key monitor emits this event. Plugin-provided actions
          // cannot invoke recovery or select a grant/registry identity.
          yield* stopInstalledPlugins;
          yield* controller.dispatch("interface.plugins");
        }).pipe(Effect.catchCause(() => recoveryFailure)),
      ),
      Effect.forkScoped,
    );
    if (mcp) {
      const token = process.env.HITCHHIKER_MCP_TOKEN;
      if (!token) return yield* Effect.die("--mcp requires a pre-issued HITCHHIKER_MCP_TOKEN");
      const dom = yield* makeBrowserDomDriver({ protectWrite: controller.protectDomWrite });
      yield* Effect.raceFirst(
        browserExit,
        runMcpStdio({
          profileId: "default",
          token,
          grants,
          browser: browserMcpApi(controller),
          plugins,
          dom,
        }),
      );
    } else yield* browserExit;
  }).pipe(Effect.provide(layers));
}).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
);

NodeRuntime.runMain(program);
