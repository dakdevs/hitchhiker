import { readPluginPackage } from "./plugin-package.ts";
import { Effect, Schema, Stream } from "effect";
import {
  EngineConnection,
  runLivePlugin,
  createPluginStorage,
  LivePluginManifest,
  type GrantStoreApi,
  type ScopedDomDriver,
} from "@hitchhiker/runtime";
import { browserMcpApi } from "./mcp.ts";
import type { BrowserController } from "./controller.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { BrowserComposition } from "./composition.ts";
import type { PluginArtifact } from "./plugin-artifacts.ts";
import type { InstalledPluginActivation } from "./plugin-manager.ts";
import type { PluginManagement } from "./plugin-management.ts";
import type { ExtensionManagement } from "./extension-management.ts";
import type { createExtensionInstallation } from "./extension-installation.ts";
type ExtensionInstallation = Effect.Success<ReturnType<typeof createExtensionInstallation>>;

/** Captures only trusted services; persisted grant IDs never become wire credentials. */
export const createInstalledPluginLauncher = Effect.fn("Browser.createInstalledPluginLauncher")(
  function* (options: {
    readonly executable: string;
    readonly grants: GrantStoreApi;
    readonly controller: BrowserController;
    readonly dom?: ScopedDomDriver;
    readonly onRecoveryFailure?: Effect.Effect<void>;
    readonly composition?: BrowserComposition;
    readonly management?: PluginManagement;
    readonly extensions?: ExtensionManagement;
    readonly extensionInstallation?: ExtensionInstallation;
  }) {
    const engine = yield* EngineConnection;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return (
      artifact: PluginArtifact,
      grantId: string,
      onReady: Effect.Effect<void>,
      activation: InstalledPluginActivation,
    ) => {
      const owner = crypto.randomUUID();
      let managementActive = false;
      const composition = options.composition;
      const composedOwner = { id: artifact.manifest.id, generation: activation.generation };
      const services = activation.services;
      const serviceParty = {
        ...composedOwner,
        profileId: activation.profileId,
        grantId,
        declaredCapabilities: artifact.manifest.capabilities,
      };
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
      const run = Effect.gen(function* () {
        const pageWatch = artifact.manifest.capabilities.some(
          (capability) => capability === "pages.list" || capability === "browser.full-control",
        )
          ? yield* options.controller.observePages(owner)
          : undefined;
        const devtools = artifact.manifest.capabilities.some(
          (capability) => capability === "devtools.manage" || capability === "browser.full-control",
        )
          ? yield* options.controller.devtools.forOwner(
              boundGrants
                .authorize("trusted-installed-grant", {
                  profileId: activation.profileId,
                  capability: "devtools.manage",
                })
                .pipe(
                  Effect.flatMap((grant) =>
                    grant.principal === artifact.manifest.id
                      ? Effect.void
                      : Effect.fail("Plugin identity no longer authorized"),
                  ),
                ),
            )
          : undefined;
        const extensionInstallation =
          options.extensionInstallation &&
          artifact.manifest.capabilities.some(
            (capability) =>
              capability === "extensions.install" || capability === "browser.full-control",
          )
            ? yield* options.extensionInstallation.forOwner({
                principal: artifact.manifest.id,
                grantId,
                authorize: options.grants
                  .authorizeGrant(grantId, {
                    profileId: activation.profileId,
                    capability: "extensions.install",
                  })
                  .pipe(
                    Effect.flatMap((authorized) =>
                      authorized.principal === artifact.manifest.id
                        ? Effect.void
                        : Effect.fail("Plugin identity no longer authorized"),
                    ),
                  ),
              })
            : undefined;
        yield* runLivePlugin({
          extensionInstallation,
          dom: options.dom,
          devtools,
          manifest: artifact.manifest,
          code: artifact.code,
          executable: options.executable,
          token: "trusted-installed-grant",
          profileId: activation.profileId,
          grants: boundGrants,
          browser: browserMcpApi(options.controller),
          pageWatch: pageWatch?.watch,
          storage: activation.storage,
          management: options.management?.forPlugin(artifact.manifest.id, () => managementActive),
          extensions: options.extensions?.forOwner((capability) =>
            boundGrants
              .authorize("trusted-installed-grant", {
                profileId: activation.profileId,
                capability,
              })
              .pipe(
                Effect.flatMap((grant) =>
                  grant.principal === artifact.manifest.id
                    ? Effect.void
                    : Effect.fail("Plugin identity no longer authorized"),
                ),
              ),
          ),
          publish: (surface) => options.controller.publishPluginSurface(owner, surface),
          release: composition
            ? composition.release(composedOwner)
            : options.controller.releasePluginSurface(owner),
          onStop: composition ? Effect.void : undefined,
          stopWhen: Effect.raceFirst(
            composition?.failure(composedOwner) ?? Effect.never,
            services?.failure(composedOwner) ?? Effect.never,
          ),
          serviceEvents: services?.events(composedOwner),
          services: services
            ? {
                publish: (service, value) => services.publish(composedOwner, service, value),
                get: (dependency) => services.get(composedOwner, dependency),
                subscribe: (dependency) => services.subscribe(composedOwner, dependency),
                call: (dependency, method, params) =>
                  services.call(composedOwner, dependency, method, params),
                respond: (response) => services.respond(composedOwner, response),
              }
            : undefined,
          composition: composition
            ? {
                publishLayout: (surface) => composition.publishLayout(composedOwner, surface),
                publishContribution: (id, surface) =>
                  composition.publishContribution(composedOwner, id, surface),
                withdrawContribution: (id) => composition.withdrawContribution(composedOwner, id),
              }
            : undefined,
          onReady: (services
            ? services.ready(composedOwner).pipe(Effect.andThen(onReady))
            : onReady
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                managementActive = true;
              }),
            ),
          ),
          onRecoveryFailure: options.onRecoveryFailure,
          events: Stream.merge(
            Stream.merge(
              composition
                ? composition.events(composedOwner)
                : options.controller.pluginEvents(owner),
              engine.events.pipe(
                Stream.filter(
                  (event) => event.event.startsWith("pages.") || event.event === "devtools.changed",
                ),
                Stream.map((event) => ({ event: event.event, payload: event.params })),
              ),
            ),
            pageWatch?.events ?? Stream.empty,
          ),
        });
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const composedRun =
        !composition || !hasUi
          ? run
          : Effect.acquireRelease(composition.activate(composedOwner), () =>
              composition.remove(composedOwner).pipe(
                Effect.asVoid,
                Effect.catchCause((cause) => options.onRecoveryFailure ?? Effect.die(cause)),
              ),
            ).pipe(Effect.andThen(run), Effect.scoped);
      const supervised = composedRun.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            managementActive = false;
          }).pipe(Effect.andThen(activation.onStopping)),
        ),
      );
      return services
        ? Effect.acquireRelease(services.activate(serviceParty), () =>
            services.deactivate(composedOwner),
          ).pipe(Effect.andThen(supervised), Effect.scoped)
        : supervised;
    };
  },
);

/** Developer packages have fixed filenames; the manifest cannot select another local path. */
export const runPluginDirectory = Effect.fn("Browser.runPluginDirectory")(function* (options: {
  readonly directory: string;
  readonly profileRoot: string;
  readonly executable: string;
  readonly token: string;
  readonly grants: GrantStoreApi;
  readonly controller: BrowserController;
  readonly dom?: ScopedDomDriver;
  readonly extensions?: ExtensionManagement;
  readonly extensionInstallation?: ExtensionInstallation;
  readonly onRecoveryFailure?: Effect.Effect<void>;
}) {
  const files = yield* readPluginPackage(options.directory);
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LivePluginManifest))(
    files.manifest,
  );
  const code = files.code;
  const owner = crypto.randomUUID();
  const credential = yield* options.grants.authenticate(options.token, { profileId: "default" });
  if (credential.principal !== manifest.id)
    return yield* Effect.fail("Plugin identity is not authorized");
  const pageWatch = manifest.capabilities.some(
    (capability) => capability === "pages.list" || capability === "browser.full-control",
  )
    ? yield* options.controller.observePages(owner)
    : undefined;
  const storage = manifest.capabilities.some(
    (capability) => capability === "storage.local" || capability === "browser.full-control",
  )
    ? yield* createPluginStorage({ profileRoot: options.profileRoot }).pipe(
        Effect.flatMap((store) => store.forOwner(manifest.id)),
      )
    : undefined;
  const engine = yield* EngineConnection;
  const pageEvents = engine.events.pipe(
    Stream.filter(
      (event) => event.event.startsWith("pages.") || event.event === "devtools.changed",
    ),
    Stream.map((event) => ({ event: event.event, payload: event.params })),
  );
  const devtools = manifest.capabilities.some(
    (capability) => capability === "devtools.manage" || capability === "browser.full-control",
  )
    ? yield* options.controller.devtools.forOwner(
        options.grants
          .authorize(options.token, {
            profileId: "default",
            capability: "devtools.manage",
          })
          .pipe(
            Effect.flatMap((grant) =>
              grant.principal === manifest.id
                ? Effect.void
                : Effect.fail("Plugin identity no longer authorized"),
            ),
          ),
      )
    : undefined;
  const extensionInstallation =
    options.extensionInstallation &&
    manifest.capabilities.some(
      (capability) => capability === "extensions.install" || capability === "browser.full-control",
    )
      ? yield* options.extensionInstallation.forOwner({
          principal: manifest.id,
          grantId: credential.grant.id,
          authorize: options.grants
            .authorize(options.token, {
              profileId: "default",
              capability: "extensions.install",
            })
            .pipe(
              Effect.flatMap((authorized) =>
                authorized.principal === manifest.id && authorized.grant.id === credential.grant.id
                  ? Effect.void
                  : Effect.fail("Plugin identity no longer authorized"),
              ),
            ),
        })
      : undefined;
  yield* runLivePlugin({
    extensionInstallation,
    dom: options.dom,
    extensions: options.extensions?.forOwner((capability) =>
      options.grants
        .authorize(options.token, { profileId: "default", capability })
        .pipe(
          Effect.flatMap((grant) =>
            grant.principal === manifest.id
              ? Effect.void
              : Effect.fail("Plugin identity no longer authorized"),
          ),
        ),
    ),
    devtools,
    manifest,
    code,
    executable: options.executable,
    token: options.token,
    profileId: "default",
    grants: options.grants,
    browser: browserMcpApi(options.controller),
    pageWatch: pageWatch?.watch,
    storage,
    publish: (surface) => options.controller.publishPluginSurface(owner, surface),
    release: options.controller.releasePluginSurface(owner),
    onRecoveryFailure: options.onRecoveryFailure,
    events: Stream.merge(
      Stream.merge(options.controller.pluginEvents(owner), pageEvents),
      pageWatch?.events ?? Stream.empty,
    ),
  });
});
