import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  EngineConnection,
  EngineError,
  NativeSurface,
  createGrantStore,
  createPluginStorage,
  runMcpStdio,
  openCdpRelay,
  type McpPluginApi,
} from "@hitchhiker/runtime";
import { Console, Deferred, Effect, Fiber, Layer, Logger, Stream } from "effect";
import { createInstalledPluginLauncher, runPluginDirectory } from "./plugin.ts";
import { createPluginArtifactStore } from "./plugin-artifacts.ts";
import { createBrowserComposition } from "./composition.ts";
import { readCompositionRecipe } from "./composition-recipe.ts";
import { readServiceRecipe } from "./service-recipe.ts";
import { createPluginManager } from "./plugin-manager.ts";
import { createPluginManagement } from "./plugin-management.ts";
import { loadBrowserPersistence } from "./persistence.ts";
import {
  loadDefaultPluginBundle,
  packagedDefaultPluginBundleDirectory,
} from "./default-plugin-bundle.ts";
import { runDefaultPluginBootstrap } from "./default-plugin-bootstrap.ts";
import { startDefaultPluginInterface } from "./default-plugin-startup.ts";
import { browserMcpApi } from "./mcp.ts";
import { makeBrowserController } from "./controller.ts";
import { makeBrowserDomDriver } from "./dom.ts";
import { acquireProfileWriteLease } from "./profile-write-lease.ts";
import { createExtensionArtifactStore } from "./extension-artifacts.ts";
import { createExtensionManager, type ExtensionManagerError } from "./extension-manager.ts";
import type { BrowserExtensionControls } from "./extension-controls.ts";
import { createExtensionManagement, type ExtensionManagement } from "./extension-management.ts";

const argument = (name: string) => {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
};
const executable = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginDirectory = argument("--plugin");
const pluginExecutable = process.env.HITCHHIKER_PLUGIN_HOST;
const profileRoot =
  argument("--profile-root") ??
  join(homedir(), "Library", "Application Support", "Hitchhiker", "profiles", "default");

const program = Effect.gen(function* () {
  if (!executable || !isAbsolute(executable) || !isAbsolute(profileRoot))
    return yield* Effect.die("HITCHHIKER_NATIVE_BINARY and --profile-root must be absolute paths");
  const profileLease = yield* acquireProfileWriteLease(profileRoot, executable);
  const safeMode = process.argv.includes("--safe-mode");
  if (
    !safeMode &&
    pluginDirectory === undefined &&
    (!pluginExecutable || !isAbsolute(pluginExecutable))
  )
    return yield* Effect.die("Normal startup requires an absolute HITCHHIKER_PLUGIN_HOST");
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
    let extensionManagement: ExtensionManagement | undefined;
    if (!safeMode) {
      yield* engine.ready;
      const extensionServices = yield* Effect.gen(function* () {
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
        const onFailure = (error: ExtensionManagerError) =>
          error.restartRequired
            ? Deferred.fail(
                fatalRecovery,
                new EngineError({ code: "extensions", message: error.message }),
              ).pipe(Effect.asVoid)
            : Effect.void;
        const checked = <A>(operation: Effect.Effect<A, ExtensionManagerError>) =>
          operation.pipe(Effect.tapError(onFailure));
        return {
          management: createExtensionManagement(manager, onFailure),
          controls: {
            list: manager.list,
            previewLocal: (path: string) => checked(manager.previewLocal(path)),
            reviewPrepared: (id: string, digest: string) =>
              checked(manager.reviewPrepared(id, digest)),
            confirmInstall: (id: string, digest: string) =>
              checked(manager.confirmInstall(id, digest)),
            cancelPreview: (id: string, digest: string) =>
              checked(manager.cancelPreview(id, digest)),
            remove: (id: string) => checked(manager.remove(id)),
            readOnly: rawCdp,
          } satisfies BrowserExtensionControls,
        };
      }).pipe(
        Effect.catch((error) =>
          "restartRequired" in error && error.restartRequired
            ? Effect.fail(new EngineError({ code: "extensions", message: error.message }))
            : Effect.logError(
                "Extension metadata is unavailable; starting without managed extensions. Use --safe-mode to skip extension startup.",
              ).pipe(Effect.as(undefined)),
        ),
      );
      extensions = extensionServices?.controls;
      extensionManagement = extensionServices?.management;
    }
    const installedPluginMode =
      pluginExecutable !== undefined && !safeMode && pluginDirectory === undefined;
    const initialPersistence = yield* profileLease.withWrite(
      loadBrowserPersistence(profileLease.profileRoot, "default"),
    );
    const controller = yield* makeBrowserController(profileLease.profileRoot, {
      interfaceMode: installedPluginMode ? "plugins" : "legacy",
      initialPersistence: { value: initialPersistence },
      freezeEnabled: !rawCdp,
      onDevToolsFailure: Deferred.fail(
        fatalRecovery,
        new EngineError({
          code: "devtools-recovery",
          message: "Could not close an unauthorized DevTools window; closing the browser",
        }),
      ).pipe(Effect.asVoid),
      extensions,
      profileLease,
    });
    yield* controller.start;
    const dom = yield* makeBrowserDomDriver({ protectWrite: controller.protectDomWrite });
    const mcp = process.argv.includes("--mcp");
    const grants = yield* createGrantStore({
      directory: join(profileLease.profileRoot, "hitchhiker-grants"),
    });
    const recoveryFailure = Deferred.fail(
      fatalRecovery,
      new EngineError({
        code: "recovery",
        message: "The trusted interface could not be restored; closing the browser",
      }),
    ).pipe(Effect.asVoid);
    const readLegacyPlan = Effect.gen(function* () {
      const composition = yield* readCompositionRecipe(profileLease.profileRoot);
      const services = yield* readServiceRecipe(profileLease.profileRoot);
      return { composition, serviceBindings: services?.bindings ?? [] };
    });
    if (pluginDirectory && !safeMode) {
      const legacy = yield* readLegacyPlan;
      const inspector = yield* createPluginManager({
        profileRoot: profileLease.profileRoot,
        grants,
        safeMode: true,
        launch: () => Effect.never,
      });
      const installed = yield* inspector.plan();
      if (
        installed.enabled.length > 0 ||
        installed.composition ||
        legacy.composition ||
        legacy.serviceBindings.length > 0
      )
        return yield* Effect.die(
          "A profile composition uses installed plugins; --plugin cannot replace it. Use a separate developer profile.",
        );
    }
    const composition =
      pluginExecutable !== undefined && !safeMode && pluginDirectory === undefined
        ? yield* createBrowserComposition({
            recipe: undefined,
            controller,
            onRecoveryFailure: recoveryFailure,
          })
        : undefined;
    let plugins: McpPluginApi | undefined;
    let stopDeveloperPlugin: Effect.Effect<void> = Effect.void;
    let stopInstalledPlugins: Effect.Effect<void, unknown> = Effect.void;
    if (
      pluginExecutable !== undefined &&
      !process.argv.includes("--safe-mode") &&
      pluginDirectory === undefined
    ) {
      if (!isAbsolute(pluginExecutable))
        return yield* Effect.die("HITCHHIKER_PLUGIN_HOST must be absolute");
      const management = yield* createPluginManagement({ startPaused: true });
      const launch = yield* createInstalledPluginLauncher({
        executable: pluginExecutable,
        grants,
        controller,
        dom,
        onRecoveryFailure: recoveryFailure,
        composition,
        management,
        extensions: extensionManagement,
      });
      const manager = yield* createPluginManager({
        profileRoot: profileLease.profileRoot,
        grants,
        launch,
        composition,
        readLegacyPlan,
        safeMode: process.argv.includes("--safe-mode") || pluginDirectory !== undefined,
        onRecoveryFailure: recoveryFailure,
      });
      const artifacts = yield* createPluginArtifactStore(profileLease.profileRoot);
      yield* management.bind(manager);
      stopInstalledPlugins = manager.plan().pipe(
        Effect.flatMap((current) =>
          manager.applyPlan(current.revision, {
            enabled: [],
            serviceBindings: current.serviceBindings,
          }),
        ),
        Effect.asVoid,
      );
      plugins = {
        stage: artifacts.stage,
        install: manager.install,
        list: manager.list,
        enable: manager.enable,
        disable: manager.disable,
        uninstall: manager.uninstall,
        rollback: manager.rollback,
        plans: {
          current: manager.plan,
          apply: manager.applyPlan,
          stageInstall: (hash, grantId) => manager.install(hash, grantId, { staged: true }),
        },
        requirements: () =>
          manager.list().pipe(
            Effect.flatMap((entries) =>
              Effect.forEach(entries, (entry) =>
                artifacts.read(entry.hash).pipe(
                  Effect.map((artifact) => ({
                    manifest: artifact.manifest,
                    hash: entry.hash,
                    enabled: entry.enabled,
                  })),
                ),
              ),
            ),
          ),
      };
      const storage = yield* createPluginStorage({ profileRoot: profileLease.profileRoot });
      const bundleDirectory =
        process.env.HITCHHIKER_DEFAULT_PLUGINS ??
        packagedDefaultPluginBundleDirectory(new URL(import.meta.url));
      if (!isAbsolute(bundleDirectory))
        return yield* Effect.die(
          "HITCHHIKER_DEFAULT_PLUGINS must be an absolute trusted bundle directory",
        );
      yield* startDefaultPluginInterface({
        mode: "installed",
        persistence: initialPersistence,
        controller,
        bootstrap: (seed, placement) =>
          runDefaultPluginBootstrap({
            profileRoot: profileLease.profileRoot,
            lease: profileLease,
            manager,
            artifacts,
            grants,
            storage,
            seed,
            placement,
            loadBundle: loadDefaultPluginBundle(bundleDirectory),
          }),
      });
      yield* management.enableMutations();
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
        profileRoot: profileLease.profileRoot,
        executable: pluginExecutable,
        token,
        grants,
        controller,
        dom,
        extensions: extensionManagement,
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
          if (composition) yield* composition.recover;
          if (!installedPluginMode) yield* controller.dispatch("interface.plugins");
        }).pipe(Effect.catchCause(() => recoveryFailure)),
      ),
      Effect.forkScoped,
    );
    if (mcp) {
      const token = process.env.HITCHHIKER_MCP_TOKEN;
      if (!token) return yield* Effect.die("--mcp requires a pre-issued HITCHHIKER_MCP_TOKEN");
      const devtools = yield* controller.devtools.forOwner(
        grants
          .authorize(token, {
            profileId: "default",
            capability: "devtools.manage",
          })
          .pipe(Effect.asVoid),
      );
      const mcpIdentity = yield* grants.authenticate(token, { profileId: "default" });
      const mcpExtensions = extensionManagement?.forOwner((capability) =>
        grants
          .authorize(token, { profileId: "default", capability })
          .pipe(
            Effect.flatMap((grant) =>
              grant.principal === mcpIdentity.principal
                ? Effect.void
                : Effect.fail("MCP identity no longer authorized"),
            ),
          ),
      );
      yield* Effect.raceFirst(
        browserExit,
        runMcpStdio({
          devtools,
          extensions: mcpExtensions,
          profileId: "default",
          token,
          grants,
          browser: browserMcpApi(controller),
          plugins,
          dom,
        }),
      );
    } else yield* browserExit;
  }).pipe(
    // Close controller and plugin lifetimes while their Native services are still available.
    Effect.scoped,
    Effect.provide(layers),
  );
}).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
);

NodeRuntime.runMain(program);
