import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Capability, CapabilityGrant } from "@hitchhiker/core";
import {
  createPluginStorage,
  createPluginServiceBroker,
  createServiceAuthority,
  validateServiceGraph,
  type GrantStoreApi,
  type PluginStorageAdapter,
  type PluginServiceBroker,
  type ServiceBinding,
  type ServiceGraph,
  type PluginCompositionRecipe,
  type EngineError,
} from "@hitchhiker/runtime";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Option,
  PubSub,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect";
import { createPluginArtifactStore, type PluginArtifact } from "./plugin-artifacts.ts";
import { planInstalledServices, requiredDependentClosure } from "./installed-service-plan.ts";
import {
  MaxInstalledPluginWorkers,
  InstalledPluginPlanSchema,
  InstalledPluginPlanInputSchema,
  prepareInstalledPluginPlan,
  diffInstalledPluginPlans,
  type InstalledPluginPlan,
  type InstalledPluginPlanInput,
  type PreparedInstalledPluginPlan,
} from "./installed-plugin-plan.ts";

const RegistryName = "plugins.json";
const MutationLockName = ".plugin-write-lock";
const MaxPlugins = 16;
const RegistryLimit = 256 * 1024;
const MutationLockTimeoutMs = 1_000;
const MutationLockRetryMs = 25;
const Hash = /^[a-f0-9]{64}$/;
// A compositor can outlive a manager scope during in-process recovery.
let nextActivationGeneration = 0;

export class PluginManagerError extends Schema.TaggedError<PluginManagerError>()(
  "PluginManagerError",
  { message: Schema.String },
) {}

const failure = (message: string) => new PluginManagerError({ message });
const capabilities = new Set<Capability>([
  "pages.list",
  "pages.manage",
  "pages.read",
  "pages.write",
  "ui.compose",
  "configuration.write",
  "configuration.read",
  "plugins.install",
  "plugins.read",
  "plugins.manage",
  "extensions.read",
  "extensions.manage",
  "extensions.install",
  "storage.local",
  "browser.full-control",
  "devtools.manage",
  "cdp.connect",
]);
/** Admission validates declared authority without pretending an origin-scoped page operation exists. */
const grantContainsDeclaredCapability = (grant: CapabilityGrant, capability: Capability) =>
  capability === "cdp.connect"
    ? grant.capabilities.includes("cdp.connect")
    : grant.capabilities.includes("browser.full-control") ||
      grant.capabilities.includes(capability);

interface Revision {
  readonly hash: string;
  readonly grantId: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly Capability[];
}
interface StoredPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly revision: Revision;
  readonly previous?: Revision;
  readonly enabled: boolean;
  readonly starting?: boolean;
  readonly suspended?: boolean;
  readonly removing?: boolean;
  readonly failures?: number;
  readonly lastFailure?: string;
}
interface RegistryV1 {
  readonly version: 1;
  readonly plugins: readonly StoredPlugin[];
}
interface RegistryV2 {
  readonly version: 2;
  readonly plugins: readonly StoredPlugin[];
  readonly activePlan: InstalledPluginPlan;
  readonly pendingPlan?: { readonly candidate: InstalledPluginPlan };
}
type Registry = RegistryV1 | RegistryV2;

export interface ManagedPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hash: string;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly removing?: boolean;
  readonly capabilities: readonly Capability[];
  readonly previousVersion?: string;
  readonly lastFailure?: string;
}
/** Metadata that an installed manager may expose to a plugin-management caller. */
export type PublicManagedPlugin = Omit<ManagedPlugin, "hash">;
export interface PluginManager {
  /** Profile-local invalidations; read managementSnapshot for current public state. */
  readonly events: Stream.Stream<{
    readonly event: "plugins.changed";
    readonly payload: Record<string, never>;
  }>;
  readonly list: () => Effect.Effect<readonly ManagedPlugin[], PluginManagerError>;
  /** One coherent public view of the current plan and installed plugin metadata. */
  readonly managementSnapshot: () => Effect.Effect<
    { readonly revision: number; readonly plugins: readonly PublicManagedPlugin[] },
    PluginManagerError
  >;
  /** Trusted recovery metadata; no bearer credential and no worker/MCP endpoint. */
  readonly inspectInstallation: (id: string) => Effect.Effect<
    | {
        readonly hash: string;
        readonly grantId: string;
        readonly enabled: boolean;
        readonly removing: boolean;
        readonly suspended: boolean;
      }
    | undefined,
    PluginManagerError
  >;
  readonly install: (
    hash: string,
    grantId: string,
    options?: { readonly staged?: boolean },
  ) => Effect.Effect<void, PluginManagerError>;
  readonly plan: () => Effect.Effect<InstalledPluginPlan, PluginManagerError>;
  readonly applyPlan: (
    expectedRevision: number,
    candidate: InstalledPluginPlanInput,
  ) => Effect.Effect<InstalledPluginPlan, PluginManagerError>;
  /** Replaces an enabled source everywhere it owns the active plan. Trusted management only. */
  readonly replace: (
    sourceId: string,
    targetId: string,
    expectedRevision: number,
  ) => Effect.Effect<InstalledPluginPlan, PluginManagerError>;
  /** Replaces the authenticated caller everywhere it owns the active plan. */
  readonly replaceSelf: (
    callerId: string,
    targetId: string,
    expectedRevision: number,
  ) => Effect.Effect<InstalledPluginPlan, PluginManagerError>;
  readonly enable: (id: string) => Effect.Effect<void, PluginManagerError>;
  readonly disable: (id: string) => Effect.Effect<void, PluginManagerError>;
  readonly uninstall: (id: string) => Effect.Effect<void, PluginManagerError>;
  readonly rollback: (id: string) => Effect.Effect<void, PluginManagerError>;
  readonly restore: () => Effect.Effect<void, PluginManagerError>;
}
export interface InstalledPluginActivation {
  readonly generation: number;
  readonly profileId: string;
  readonly services?: PluginServiceBroker;
  readonly storage?: PluginStorageAdapter;
  /** Runs before the launcher removes this provider from the broker. */
  readonly onStopping: Effect.Effect<void>;
}
export interface PluginManagerOptions {
  readonly profileRoot: string;
  readonly profileId?: string;
  readonly grants: GrantStoreApi;
  readonly launch: (
    artifact: PluginArtifact,
    grantId: string,
    /** The launcher runs this only after activation has fulfilled. */
    onReady: Effect.Effect<void>,
    activation: InstalledPluginActivation,
  ) => Effect.Effect<void, unknown>;
  readonly safeMode?: boolean;
  /** Configured UI owners use the host compositor instead of whole-window ownership. */
  readonly compositionOwners?: ReadonlySet<string>;
  readonly serviceBindings?: readonly ServiceBinding[];
  readonly compositionRecipe?: PluginCompositionRecipe;
  readonly composition?: {
    readonly owners: ReadonlySet<string>;
    readonly reconfigure: (
      recipe: PluginCompositionRecipe | undefined,
    ) => Effect.Effect<number, EngineError>;
    readonly complete: Effect.Effect<boolean>;
  };
  readonly readLegacyPlan?: Effect.Effect<
    {
      readonly composition?: PluginCompositionRecipe;
      readonly serviceBindings: readonly ServiceBinding[];
    },
    unknown
  >;
  /** Reserved for launcher failures to restore the trusted interface. */
  readonly onRecoveryFailure?: Effect.Effect<void>;
}

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const CapabilitySchema = Schema.Literals([
  "pages.list",
  "pages.manage",
  "pages.read",
  "pages.write",
  "ui.compose",
  "configuration.write",
  "configuration.read",
  "plugins.install",
  "plugins.read",
  "plugins.manage",
  "extensions.read",
  "extensions.manage",
  "extensions.install",
  "storage.local",
  "browser.full-control",
  "devtools.manage",
  "cdp.connect",
]);
const RevisionSchema = Schema.Struct({
  hash: Schema.String.check(Schema.isPattern(Hash)),
  grantId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  name: Text,
  version: Text,
  capabilities: Schema.Array(CapabilitySchema).check(Schema.isMaxLength(16)),
});
const StoredPluginSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,62}$/)),
  name: Text,
  version: Schema.String.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  ),
  revision: RevisionSchema,
  previous: Schema.optional(RevisionSchema),
  enabled: Schema.Boolean,
  starting: Schema.optional(Schema.Boolean),
  suspended: Schema.optional(Schema.Boolean),
  removing: Schema.optional(Schema.Boolean),
  failures: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  lastFailure: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
});
const RegistrySchema = Schema.Struct({
  version: Schema.Literal(1),
  plugins: Schema.Array(StoredPluginSchema).check(Schema.isMaxLength(MaxPlugins)),
});
const RegistryV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  plugins: Schema.Array(StoredPluginSchema).check(Schema.isMaxLength(MaxPlugins)),
  activePlan: InstalledPluginPlanSchema,
  pendingPlan: Schema.optional(Schema.Struct({ candidate: InstalledPluginPlanSchema })),
});
const decodeRegistry = Schema.decodeUnknownOption(
  Schema.Union([RegistrySchema, RegistryV2Schema]),
  { onExcessProperty: "error" },
);

/** Durable policy around immutable data artifacts. This module never executes a plugin. */
export const createPluginManager = Effect.fn("PluginManager.create")(function* (
  options: PluginManagerOptions,
) {
  if (!isAbsolute(options.profileRoot)) return yield* failure("Profile root must be absolute");
  const profileId = options.profileId ?? "default";
  const requestedDirectory = join(options.profileRoot, "hitchhiker-plugins");
  yield* Effect.tryPromise({
    try: () => mkdir(requestedDirectory, { recursive: true, mode: 0o700 }),
    catch: () => failure("Could not create plugin registry"),
  });
  const directory = yield* Effect.tryPromise({
    try: () => realpath(requestedDirectory),
    catch: () => failure("Could not resolve plugin registry"),
  });
  const registryPath = join(directory, RegistryName);
  const mutationLockPath = join(directory, MutationLockName);
  const artifacts = yield* createPluginArtifactStore(options.profileRoot).pipe(
    Effect.mapError((error) => failure(error.message)),
  );
  const lock = yield* Semaphore.make(1);
  const managerScope = yield* Scope.make();
  const changes = yield* PubSub.sliding<{
    readonly event: "plugins.changed";
    readonly payload: Record<string, never>;
  }>({ capacity: 1 });
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
  let mutationActive = false;
  let changePending = false;
  const invalidate = () => {
    if (mutationActive) changePending = true;
    else PubSub.publishUnsafe(changes, { event: "plugins.changed", payload: {} });
  };

  const running = new Map<
    string,
    {
      readonly generation: number;
      readonly hash: string;
      readonly grantId: string;
      expectedStop: boolean;
      readonly stop: () => Effect.Effect<void>;
    }
  >();
  const latestGeneration = new Map<string, number>();
  yield* Effect.addFinalizer((exit) =>
    Effect.sync(() => {
      for (const record of running.values()) record.expectedStop = true;
    }).pipe(Effect.andThen(Scope.close(managerScope, exit))),
  );
  const pluginStorage = yield* createPluginStorage({ profileRoot: options.profileRoot }).pipe(
    Effect.mapError((error) => failure(error.message)),
    Effect.provideService(Scope.Scope, managerScope),
  );
  let serviceGraph = yield* validateServiceGraph([], []).pipe(Effect.orDie);
  const serviceAuthority = createServiceAuthority(options.grants);
  const serviceBroker = yield* createPluginServiceBroker({
    graph: serviceGraph,
    profileId,
    authority: serviceAuthority,
  }).pipe(Effect.provideService(Scope.Scope, managerScope));
  let mutationPoisoned = false;
  const poisonMutation = Effect.sync(() => {
    mutationPoisoned = true;
  });
  let runtimeFailure: (id: string, generation: number) => Effect.Effect<void, PluginManagerError>;

  const ensureDirectory = Effect.tryPromise({
    try: async () => {
      const [info, resolved] = await Promise.all([lstat(directory), realpath(directory)]);
      if (!info.isDirectory() || info.isSymbolicLink() || resolved !== directory)
        throw new Error("invalid registry directory");
    },
    catch: () => failure("Plugin registry is invalid"),
  });
  const load = Effect.fn("PluginManager.load")(function* (): Effect.fn.Return<
    Registry,
    PluginManagerError
  > {
    yield* ensureDirectory;
    const text = yield* Effect.tryPromise({
      try: async () => {
        try {
          const info = await lstat(registryPath);
          if (!info.isFile() || info.isSymbolicLink() || info.size > RegistryLimit)
            throw new Error("invalid registry");
          const fd = await open(registryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const before = await fd.stat();
            if (
              !before.isFile() ||
              before.dev !== info.dev ||
              before.ino !== info.ino ||
              before.size > RegistryLimit
            )
              throw new Error("changed registry");
            const bytes = Buffer.alloc(RegistryLimit + 1);
            let bytesRead = 0;
            while (bytesRead < bytes.length) {
              const read = await fd.read(bytes, bytesRead, bytes.length - bytesRead, null);
              if (read.bytesRead === 0) break;
              bytesRead += read.bytesRead;
            }
            const after = await fd.stat();
            if (
              bytesRead > RegistryLimit ||
              after.dev !== before.dev ||
              after.ino !== before.ino ||
              after.size !== before.size
            )
              throw new Error("changed registry");
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
          } finally {
            await fd.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        }
      },
      catch: () => failure("Plugin registry is invalid"),
    });
    if (text === "")
      return {
        version: 2,
        plugins: [],
        activePlan: { revision: 0, enabled: [], serviceBindings: options.serviceBindings ?? [] },
      };
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () => failure("Plugin registry is invalid"),
    });
    const decoded = decodeRegistry(parsed);
    if (
      Option.isNone(decoded) ||
      new Set(decoded.value.plugins.map((plugin) => plugin.id)).size !==
        decoded.value.plugins.length ||
      decoded.value.plugins.some(
        (plugin) =>
          plugin.name !== plugin.revision.name || plugin.version !== plugin.revision.version,
      )
    )
      return yield* failure("Plugin registry is invalid");
    if (decoded.value.version === 2) {
      const { activePlan, pendingPlan, plugins } = decoded.value;
      if (
        new Set(activePlan.enabled).size !== activePlan.enabled.length ||
        activePlan.enabled.some((id) => !plugins.some((plugin) => plugin.id === id)) ||
        plugins.some(
          (plugin) =>
            plugin.enabled !== activePlan.enabled.includes(plugin.id) ||
            plugin.starting === true ||
            (plugin.removing === true && plugin.enabled),
        ) ||
        (pendingPlan !== undefined && pendingPlan.candidate.revision !== activePlan.revision + 1)
      )
        return yield* failure("Plugin registry is invalid");
    }
    return decoded.value;
  });
  const loadLegacy = () =>
    load().pipe(
      Effect.flatMap((registry) =>
        registry.version === 1
          ? Effect.succeed(registry)
          : Effect.fail(failure("Plugin registry changed; retry the operation")),
      ),
    );
  const save = (registry: Registry) =>
    Effect.uninterruptible(
      Effect.tryPromise({
        try: async () => {
          const encoded = JSON.stringify(registry);
          if (Buffer.byteLength(encoded, "utf8") > RegistryLimit)
            throw new Error("registry too large");
          const [info, resolved] = await Promise.all([lstat(directory), realpath(directory)]);
          if (!info.isDirectory() || info.isSymbolicLink() || resolved !== directory)
            throw new Error("invalid directory");
          let temporary: string | undefined;
          try {
            const created = `${registryPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
            const fd = await open(
              created,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            temporary = created;
            try {
              await fd.writeFile(encoded, "utf8");
              await fd.sync();
            } finally {
              await fd.close();
            }
            await rename(created, registryPath);
            invalidate();
            temporary = undefined;
            const root = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              await root.sync();
            } finally {
              await root.close();
            }
          } catch (error) {
            if (temporary) await rm(temporary, { force: true });
            throw error;
          }
        },
        catch: () => failure("Could not persist plugin registry"),
      }),
    );
  const put = (registry: Registry, plugin: StoredPlugin) =>
    save({
      ...registry,
      plugins: [...registry.plugins.filter((entry) => entry.id !== plugin.id), plugin],
    });
  const acquireMutationLock = Effect.fn("PluginManager.acquireMutationLock")(
    function* (): Effect.fn.Return<void, PluginManagerError> {
      const startedAt = yield* Clock.currentTimeMillis;
      for (;;) {
        const acquired = yield* Effect.tryPromise({
          try: async () => {
            try {
              await mkdir(mutationLockPath, { mode: 0o700 });
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
              throw error;
            }
          },
          catch: () => failure("Could not acquire plugin registry mutation lock"),
        });
        if (acquired) return;
        if ((yield* Clock.currentTimeMillis) - startedAt >= MutationLockTimeoutMs)
          return yield* failure(
            "Plugin registry mutation lock is held; stop all writers before removing a stale lock",
          );
        yield* Effect.sleep(MutationLockRetryMs);
      }
    },
  );
  const withMutationLock = <A>(effect: Effect.Effect<A, PluginManagerError>) =>
    lock.withPermit(
      Effect.acquireUseRelease(
        acquireMutationLock(),
        () =>
          mutationPoisoned
            ? Effect.fail(failure("Plugin registry recovery failed; restart required"))
            : Effect.suspend(() => {
                mutationActive = true;
                return effect.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      mutationActive = false;
                      if (changePending) {
                        changePending = false;
                        invalidate();
                      }
                    }),
                  ),
                );
              }),
        () =>
          Effect.tryPromise({
            try: () => rm(mutationLockPath, { recursive: true }),
            catch: () => failure("Could not release plugin registry mutation lock"),
          }).pipe(Effect.orDie),
      ),
    );
  const revision = (artifact: PluginArtifact, grantId: string): Revision => ({
    hash: artifact.hash,
    grantId,
    name: artifact.manifest.name,
    version: artifact.manifest.version,
    capabilities: artifact.manifest.capabilities,
  });
  const applyRevision = (plugin: StoredPlugin, next: Revision): StoredPlugin => ({
    ...plugin,
    revision: next,
    name: next.name,
    version: next.version,
  });
  const authorize = Effect.fn("PluginManager.authorize")(function* (
    artifact: PluginArtifact,
    grantId: string,
  ) {
    const authenticated = yield* options.grants
      .authenticateGrant(grantId, { profileId })
      .pipe(Effect.mapError(() => failure("Plugin grant is not authorized")));
    if (authenticated.principal !== artifact.manifest.id)
      return yield* failure("Plugin grant principal does not match manifest");
    for (const capability of artifact.manifest.capabilities) {
      if (!capabilities.has(capability))
        return yield* failure("Plugin manifest capability is invalid");
      if (!grantContainsDeclaredCapability(authenticated.grant, capability))
        return yield* failure("Plugin grant does not allow declared capabilities");
    }
  });
  const artifactFor = Effect.fn("PluginManager.artifactFor")(function* (
    plugin: StoredPlugin,
    current: Revision,
  ) {
    const artifact = yield* artifacts
      .read(current.hash)
      .pipe(Effect.mapError((error) => failure(error.message)));
    if (
      artifact.manifest.id !== plugin.id ||
      artifact.manifest.name !== current.name ||
      artifact.manifest.version !== current.version ||
      artifact.manifest.capabilities.length !== current.capabilities.length ||
      artifact.manifest.capabilities.some(
        (capability, index) => capability !== current.capabilities[index],
      )
    )
      return yield* failure("Plugin revision metadata does not match its artifact");
    return artifact;
  });
  const stopGeneration = (id: string, generation?: number) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const active = running.get(id);
        if (!active || (generation !== undefined && active.generation !== generation)) return;
        active.expectedStop = true;
        running.delete(id);
        invalidate();
        yield* active.stop().pipe(Effect.catch(() => Effect.void));
      }),
    );
  const stop = (id: string) => stopGeneration(id);
  const start = Effect.fn("PluginManager.start")(function* (
    plugin: StoredPlugin,
  ): Effect.fn.Return<void, PluginManagerError> {
    if (options.safeMode) return;
    if (running.size >= MaxInstalledPluginWorkers)
      return yield* failure(`At most ${MaxInstalledPluginWorkers} plugins may run`);
    const artifact = yield* artifactFor(plugin, plugin.revision);
    if (
      (options.composition?.owners ?? options.compositionOwners) &&
      artifact.manifest.capabilities.some(
        (capability) => capability === "ui.compose" || capability === "browser.full-control",
      ) &&
      !(options.composition?.owners ?? options.compositionOwners)?.has(plugin.id)
    )
      return yield* failure("UI plugin is not configured in the composition recipe");
    if (
      (options.composition?.owners ?? options.compositionOwners)?.has(plugin.id) &&
      !artifact.manifest.capabilities.some(
        (capability) => capability === "ui.compose" || capability === "browser.full-control",
      )
    )
      return yield* failure("Configured composition owner must declare ui.compose");
    yield* authorize(artifact, plugin.revision.grantId);
    const storage = artifact.manifest.capabilities.some(
      (capability) => capability === "storage.local" || capability === "browser.full-control",
    )
      ? yield* pluginStorage
          .forOwner(plugin.id)
          .pipe(Effect.mapError((error) => failure(error.message)))
      : undefined;
    const ready = yield* Deferred.make<void, PluginManagerError>();
    if (nextActivationGeneration >= Number.MAX_SAFE_INTEGER)
      return yield* failure("Plugin activation generation limit reached");
    const generation = ++nextActivationGeneration;
    const launched = options
      .launch(artifact, plugin.revision.grantId, Deferred.succeed(ready, undefined), {
        generation,
        profileId,
        services:
          (artifact.manifest.provides?.length ?? 0) + (artifact.manifest.requires?.length ?? 0) > 0
            ? serviceBroker
            : undefined,
        ...(storage ? { storage } : {}),
        onStopping: Effect.sync(() => {
          if (latestGeneration.get(plugin.id) !== generation) return;
          for (const id of requiredDependentClosure(serviceGraph, new Set([plugin.id]))) {
            if (id === plugin.id) continue;
            const dependent = running.get(id);
            if (dependent) dependent.expectedStop = true;
          }
        }),
      })
      .pipe(Effect.catch(() => Deferred.fail(ready, failure("Plugin host stopped"))));
    const fiber = yield* launched.pipe(
      Effect.mapError(() => failure("Plugin host stopped")),
      Effect.ensuring(
        Effect.sync(() => {
          if (running.get(plugin.id)?.generation === generation) {
            running.delete(plugin.id);
            invalidate();
          }
        }),
      ),
      (effect) => Effect.forkIn(effect, managerScope),
    );
    const record = {
      generation,
      hash: plugin.revision.hash,
      grantId: plugin.revision.grantId,
      expectedStop: false,
      stop: () => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    };
    latestGeneration.set(plugin.id, generation);
    running.set(plugin.id, record);
    invalidate();
    yield* Effect.gen(function* () {
      yield* Deferred.await(ready).pipe(
        Effect.timeoutOrElse({
          duration: 8_000,
          orElse: () => Effect.fail(failure("Plugin startup timed out")),
        }),
      );
      yield* Effect.sleep(250);
      if (running.get(plugin.id)?.generation !== generation)
        return yield* failure("Plugin host stopped during startup health check");
      // A health-window crash is an activation failure, not an already-promoted crash.
      yield* Fiber.await(fiber).pipe(
        Effect.andThen(() =>
          record.expectedStop ? Effect.void : runtimeFailure(plugin.id, generation),
        ),
        (effect) => Effect.forkIn(effect, managerScope),
      );
    }).pipe(Effect.onError(() => stopGeneration(plugin.id, generation)));
  });
  const hasUi = (artifact: PluginArtifact) =>
    artifact.manifest.capabilities.some(
      (capability) => capability === "ui.compose" || capability === "browser.full-control",
    );
  const prepareServices = Effect.fn("PluginManager.prepareServices")(function* (
    registry: Registry,
    requiredTarget?: string,
  ) {
    const enabled = registry.plugins.filter((plugin) => plugin.enabled);
    const selected = new Map<
      string,
      { readonly plugin: StoredPlugin; readonly artifact: PluginArtifact }
    >();
    for (const plugin of enabled) {
      const artifact = yield* artifactFor(plugin, plugin.revision);
      selected.set(plugin.id, { plugin, artifact });
    }
    const plan = yield* planInstalledServices(
      [...selected.values()].map(({ artifact }) => ({
        manifest: artifact.manifest,
        enabled: true,
      })),
      options.serviceBindings ?? [],
    ).pipe(Effect.mapError((error) => failure(error.message)));
    if (requiredTarget && !plan.graph.order.includes(requiredTarget))
      return yield* failure("Required service provider is unavailable");
    if (plan.graph.order.length > MaxInstalledPluginWorkers)
      return yield* failure(`At most ${MaxInstalledPluginWorkers} plugins may run`);
    for (const id of plan.graph.order) {
      const entry = selected.get(id)!;
      yield* authorize(entry.artifact, entry.plugin.revision.grantId);
    }
    const party = (id: string) => {
      const entry = selected.get(id)!;
      return {
        id,
        generation: 1,
        profileId,
        grantId: entry.plugin.revision.grantId,
        declaredCapabilities: entry.artifact.manifest.capabilities,
      };
    };
    for (const binding of plan.graph.bindings)
      yield* serviceAuthority
        .authorizeService(party(binding.consumer), party(binding.provider))
        .pipe(Effect.mapError(() => failure("Service authority is not authorized")));
    return plan.graph;
  });
  const quiesceServices = Effect.fn("PluginManager.quiesceServices")(function* (
    registry: Registry,
    next: ServiceGraph,
  ) {
    const desired = new Map(registry.plugins.map((plugin) => [plugin.id, plugin]));
    const changed = new Set<string>();
    for (const [id, record] of running)
      if (
        record.expectedStop ||
        !next.order.includes(id) ||
        desired.get(id)?.revision.hash !== record.hash ||
        desired.get(id)?.revision.grantId !== record.grantId
      )
        changed.add(id);
    const affected = requiredDependentClosure(serviceGraph, changed);
    // Mark the entire closure before any provider cleanup can wake a crash supervisor.
    for (const id of affected) {
      const record = running.get(id);
      if (record) record.expectedStop = true;
    }
    const order = [...serviceGraph.order, ...running.keys()].filter(
      (id, index, all) => all.indexOf(id) === index,
    );
    for (const id of order.reverse()) if (affected.has(id)) yield* stop(id);
    yield* serviceBroker.reconfigure(next).pipe(Effect.mapError((error) => failure(error.message)));
    serviceGraph = next;
  });
  const reconcileServices = Effect.fn("PluginManager.reconcileServices")(function* (
    registry: Registry,
  ): Effect.fn.Return<void, PluginManagerError> {
    const next = yield* prepareServices(registry);
    yield* quiesceServices(registry, next);
    for (const id of next.order) {
      if (running.has(id)) continue;
      const plugin = registry.plugins.find((entry) => entry.id === id)!;
      yield* start(plugin);
    }
  });
  const activate = Effect.fn("PluginManager.activate")(function* (
    registry: Registry,
    plugin: StoredPlugin,
    failures = 0,
  ): Effect.fn.Return<void, PluginManagerError> {
    if (plugin.enabled && running.has(plugin.id)) return;
    const candidate = yield* artifactFor(plugin, plugin.revision);
    if (
      hasUi(candidate) &&
      (options.composition?.owners ?? options.compositionOwners) &&
      !(options.composition?.owners ?? options.compositionOwners)?.has(plugin.id)
    )
      return yield* failure("UI plugin is not configured in the composition recipe");
    if (hasUi(candidate) && !(options.composition?.owners ?? options.compositionOwners)) {
      for (const other of registry.plugins) {
        if (other.id === plugin.id || !other.enabled) continue;
        if (hasUi(yield* artifactFor(other, other.revision)))
          return yield* failure("Disable the existing UI plugin before enabling another one");
      }
    }
    const starting: StoredPlugin = {
      ...plugin,
      enabled: true,
      starting: true,
      failures,
      lastFailure: undefined,
    };
    const prospective = {
      ...registry,
      plugins: [...registry.plugins.filter((entry) => entry.id !== plugin.id), starting],
    };
    yield* prepareServices(prospective, plugin.id);
    yield* put(registry, starting);
    yield* reconcileServices(prospective);
    const fresh = yield* loadLegacy();
    const persisted = fresh.plugins.find((entry) => entry.id === plugin.id);
    if (!persisted || persisted.revision.hash !== starting.revision.hash)
      return yield* failure("Plugin registry changed during activation");
    yield* put(fresh, { ...starting, starting: false, failures });
  });
  const restoreAfterFailedActivation = (
    old: StoredPlugin | undefined,
    candidate: StoredPlugin,
    reason: string,
  ) =>
    Effect.gen(function* () {
      yield* stop(candidate.id);
      const fresh = yield* loadLegacy();
      if (!old) {
        const current = fresh.plugins.find((entry) => entry.id === candidate.id) ?? candidate;
        yield* put(fresh, { ...current, enabled: false, starting: false, lastFailure: reason });
        yield* reconcileServices(yield* loadLegacy());
        return;
      }
      const recovered = { ...old, starting: false, lastFailure: reason };
      yield* put(fresh, recovered);
      if (recovered.enabled && !options.safeMode)
        yield* reconcileServices(yield* loadLegacy()).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* stop(recovered.id);
              yield* put(yield* loadLegacy(), {
                ...recovered,
                enabled: false,
                starting: false,
                lastFailure: error.message,
              });
              yield* reconcileServices(yield* loadLegacy());
            }),
          ),
        );
    });
  const recoverMutation = <A>(
    old: StoredPlugin | undefined,
    candidate: StoredPlugin,
    reason: string,
    mutation: Effect.Effect<A, PluginManagerError>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      restore(mutation).pipe(
        Effect.onError(() =>
          Effect.uninterruptible(
            restoreAfterFailedActivation(old, candidate, reason).pipe(
              Effect.catch(() => poisonMutation),
            ),
          ),
        ),
      ),
    );
  runtimeFailure = (id, failedGeneration) =>
    withMutationLock(
      Effect.gen(function* () {
        if (latestGeneration.get(id) !== failedGeneration) return;
        const active = running.get(id);
        if (active && active.generation !== failedGeneration) return;
        if (active?.generation === failedGeneration) {
          running.delete(id);
          invalidate();
        }
        const registry = yield* loadLegacy();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin || !plugin.enabled) return;
        if (plugin.previous && (plugin.failures ?? 0) === 0) {
          const rollback = applyRevision(plugin, plugin.previous);
          const recovered = {
            ...rollback,
            previous: plugin.revision,
            starting: false,
            failures: 1,
            lastFailure: "Plugin host stopped",
          };
          yield* activate(registry, recovered, 1).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const fresh = yield* loadLegacy();
                yield* put(fresh, {
                  ...recovered,
                  enabled: false,
                  starting: false,
                  lastFailure: error.message,
                });
                yield* reconcileServices(yield* loadLegacy());
              }),
            ),
          );
          return;
        }
        yield* put(registry, {
          ...plugin,
          enabled: false,
          starting: false,
          lastFailure: "Plugin host stopped",
        });
        yield* reconcileServices(yield* loadLegacy());
      }).pipe(Effect.tapError(() => poisonMutation)),
    );
  const restore = () =>
    options.safeMode
      ? Effect.void
      : withMutationLock(
          Effect.gen(function* () {
            const initial = yield* loadLegacy();
            for (const entry of initial.plugins) {
              const registry = yield* loadLegacy();
              const plugin = registry.plugins.find((candidate) => candidate.id === entry.id);
              if (!plugin || !plugin.enabled || options.safeMode) continue;
              if (plugin.starting && !plugin.previous) {
                yield* put(registry, {
                  ...plugin,
                  enabled: false,
                  starting: false,
                  lastFailure: "Interrupted initial activation",
                });
                continue;
              }
              const recovered = plugin.starting
                ? {
                    ...applyRevision(plugin, plugin.previous!),
                    previous: plugin.revision,
                    starting: false,
                    failures: 1,
                    lastFailure: "Interrupted activation",
                  }
                : { ...plugin, starting: false };
              if (plugin.starting) yield* put(registry, recovered);
              yield* artifactFor(recovered, recovered.revision).pipe(
                Effect.flatMap((artifact) => authorize(artifact, recovered.revision.grantId)),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    const fresh = yield* loadLegacy();
                    yield* put(fresh, {
                      ...recovered,
                      enabled: false,
                      starting: false,
                      lastFailure: error.message,
                    });
                  }),
                ),
              );
            }
            const registry = yield* loadLegacy();
            const plan = yield* prepareServices(registry);
            yield* quiesceServices(registry, plan);
            for (const id of plan.order) {
              if (!serviceGraph.order.includes(id) || running.has(id)) continue;
              const current = (yield* loadLegacy()).plugins.find((entry) => entry.id === id)!;
              yield* start(current).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    yield* put(yield* loadLegacy(), {
                      ...current,
                      enabled: false,
                      starting: false,
                      lastFailure: error.message,
                    });
                    const updated = yield* loadLegacy();
                    yield* quiesceServices(updated, yield* prepareServices(updated));
                  }),
                ),
              );
            }
          }).pipe(Effect.tapError(() => poisonMutation)),
        );
  const publicSummary = (plugin: StoredPlugin): PublicManagedPlugin =>
    ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      enabled: plugin.enabled,
      running: running.has(plugin.id),
      ...(plugin.removing ? { removing: true } : {}),
      capabilities: plugin.revision.capabilities,
      ...(plugin.previous ? { previousVersion: plugin.previous.version } : {}),
      ...(plugin.lastFailure ? { lastFailure: plugin.lastFailure } : {}),
    }) satisfies PublicManagedPlugin;
  const list = () =>
    lock.withPermit(
      Effect.gen(function* () {
        const registry = yield* load();
        return registry.plugins.map((plugin) => ({
          ...publicSummary(plugin),
          hash: plugin.revision.hash,
        })) satisfies readonly ManagedPlugin[];
      }),
    );
  const install = (hash: string, grantId: string) =>
    withMutationLock(
      Effect.gen(function* () {
        const artifact = yield* artifacts
          .read(hash)
          .pipe(Effect.mapError((error) => failure(error.message)));
        yield* authorize(artifact, grantId);
        const registry = yield* loadLegacy();
        const old = registry.plugins.find((entry) => entry.id === artifact.manifest.id);
        if (!old && registry.plugins.length >= MaxPlugins)
          return yield* failure("At most sixteen plugins may be installed");
        const candidate: StoredPlugin = {
          id: artifact.manifest.id,
          name: artifact.manifest.name,
          version: artifact.manifest.version,
          revision: revision(artifact, grantId),
          ...(old
            ? { previous: old.revision, enabled: old.enabled }
            : { enabled: !options.safeMode }),
          starting: old?.enabled === true,
        };
        const prospective: Registry = {
          ...registry,
          plugins: [...registry.plugins.filter((entry) => entry.id !== candidate.id), candidate],
        };
        const plan = yield* prepareServices(
          prospective,
          candidate.enabled ? candidate.id : undefined,
        );
        yield* recoverMutation(
          old,
          candidate,
          "Activation failed",
          Effect.gen(function* () {
            yield* quiesceServices(prospective, plan);
            yield* put(registry, candidate);
            if (!candidate.enabled) return;
            yield* activate(
              {
                ...registry,
                plugins: [
                  ...registry.plugins.filter((entry) => entry.id !== candidate.id),
                  candidate,
                ],
              },
              candidate,
            );
          }),
        );
      }),
    );
  const enable = (id: string) =>
    withMutationLock(
      Effect.gen(function* () {
        if (options.safeMode) return yield* failure("Plugins cannot be enabled in safe mode");
        const registry = yield* loadLegacy();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin) return yield* failure("Plugin is not installed");
        const candidate = { ...plugin, enabled: true };
        yield* prepareServices(
          {
            ...registry,
            plugins: [...registry.plugins.filter((entry) => entry.id !== id), candidate],
          },
          id,
        );
        yield* recoverMutation(
          undefined,
          candidate,
          "Activation failed",
          activate(registry, candidate),
        );
      }),
    );
  const disable = (id: string) =>
    withMutationLock(
      Effect.gen(function* () {
        const registry = yield* loadLegacy();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin) return yield* failure("Plugin is not installed");
        const next: Registry = {
          ...registry,
          plugins: registry.plugins.map((entry) =>
            entry.id === id ? { ...entry, enabled: false, starting: false } : entry,
          ),
        };
        const plan = yield* prepareServices(next);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* quiesceServices(next, plan);
            yield* save(next);
          }).pipe(Effect.tapError(() => poisonMutation)),
        );
      }),
    );
  const uninstall = (id: string) =>
    withMutationLock(
      Effect.gen(function* () {
        const registry = yield* loadLegacy();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin) return yield* failure("Plugin is not installed");
        const grantIds = new Set([
          plugin.revision.grantId,
          ...(plugin.previous ? [plugin.previous.grantId] : []),
        ]);
        const grants = yield* options.grants
          .list()
          .pipe(Effect.mapError(() => failure("Could not inspect plugin grants")));
        const owned = grants.filter((grant) => grantIds.has(grant.id));
        if (owned.some((grant) => grant.principal !== id || grant.profileId !== profileId))
          return yield* failure("Plugin revision grant does not belong to this plugin and profile");
        const next: Registry = {
          ...registry,
          plugins: registry.plugins.filter((entry) => entry.id !== id),
        };
        const plan = yield* prepareServices(next);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* quiesceServices(next, plan);
            // Retain revision grant IDs in disabled state until revocation succeeds.
            yield* put(registry, { ...plugin, enabled: false, starting: false });
            for (const grant of owned) {
              yield* options.grants
                .revoke(grant.id)
                .pipe(Effect.mapError(() => failure("Could not revoke removed plugin grants")));
            }
            yield* pluginStorage
              .remove(id)
              .pipe(Effect.mapError((error) => failure(error.message)));
            yield* save({
              ...registry,
              plugins: registry.plugins.filter((entry) => entry.id !== id),
            });
          }).pipe(Effect.tapError(() => poisonMutation)),
        );
      }),
    );
  const rollback = (id: string) =>
    withMutationLock(
      Effect.gen(function* () {
        const registry = yield* loadLegacy();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin || !plugin.previous) return yield* failure("Plugin has no previous version");
        const next = {
          ...applyRevision(plugin, plugin.previous),
          previous: plugin.revision,
          starting: plugin.enabled,
        };
        const prospective: Registry = {
          ...registry,
          plugins: [...registry.plugins.filter((entry) => entry.id !== id), next],
        };
        const plan = yield* prepareServices(prospective, next.enabled ? id : undefined);
        yield* recoverMutation(
          plugin,
          next,
          "Rollback failed",
          Effect.gen(function* () {
            yield* quiesceServices(prospective, plan);
            yield* put(registry, next);
            if (!next.enabled) return;
            yield* activate(
              {
                ...registry,
                plugins: [...registry.plugins.filter((entry) => entry.id !== id), next],
              },
              next,
            );
          }),
        );
      }),
    );
  const inputOf = (plan: InstalledPluginPlanInput): InstalledPluginPlanInput => ({
    enabled: plan.enabled,
    ...(plan.composition === undefined ? {} : { composition: plan.composition }),
    serviceBindings: plan.serviceBindings,
  });
  const nextPlan = (registry: RegistryV2, input: InstalledPluginPlanInput) => {
    if (registry.activePlan.revision >= Number.MAX_SAFE_INTEGER)
      return Effect.fail(failure("Plugin plan revision limit reached"));
    return Schema.decodeUnknownEffect(InstalledPluginPlanInputSchema, {
      onExcessProperty: "error",
    })(input).pipe(
      Effect.map((plan) => ({ ...plan, revision: registry.activePlan.revision + 1 })),
      Effect.mapError(() => failure("Malformed installed plugin plan")),
    );
  };
  const mirror = (plugins: readonly StoredPlugin[], plan: InstalledPluginPlanInput) =>
    plugins.map((plugin) => ({
      ...plugin,
      enabled: plan.enabled.includes(plugin.id),
      starting: false,
    }));
  const preparePlan = Effect.fn("PluginManager.preparePlan")(function* (
    plugins: readonly StoredPlugin[],
    input: InstalledPluginPlanInput,
    checkAuthority: boolean,
  ): Effect.fn.Return<PreparedInstalledPluginPlan, PluginManagerError> {
    const selected = new Map<string, { plugin: StoredPlugin; artifact: PluginArtifact }>();
    for (const id of input.enabled) {
      const plugin = plugins.find((entry) => entry.id === id);
      if (!plugin) return yield* failure("Enabled plugin is not installed");
      selected.set(id, { plugin, artifact: yield* artifactFor(plugin, plugin.revision) });
    }
    const prepared = yield* prepareInstalledPluginPlan(
      inputOf(input),
      [...selected.values()].map(({ plugin, artifact }) => ({
        manifest: artifact.manifest,
        hash: plugin.revision.hash,
        grantId: plugin.revision.grantId,
      })),
    ).pipe(Effect.mapError((error) => failure(error.message)));
    const operational = yield* planInstalledServices(
      [...selected.values()].map(({ plugin, artifact }) => ({
        manifest: artifact.manifest,
        enabled: !plugin.suspended,
      })),
      input.serviceBindings,
    ).pipe(Effect.mapError((error) => failure(error.message)));
    if (checkAuthority) {
      for (const id of operational.graph.order) {
        const entry = selected.get(id)!;
        yield* authorize(entry.artifact, entry.plugin.revision.grantId);
      }
      const party = (id: string) => {
        const entry = selected.get(id)!;
        return {
          id,
          generation: 1,
          profileId,
          grantId: entry.plugin.revision.grantId,
          declaredCapabilities: entry.artifact.manifest.capabilities,
        };
      };
      for (const binding of operational.graph.bindings)
        yield* serviceAuthority
          .authorizeService(party(binding.consumer), party(binding.provider))
          .pipe(Effect.mapError(() => failure("Service authority is not authorized")));
    }
    return {
      ...prepared,
      graph: operational.graph,
      order: prepared.order.filter((id) => operational.graph.order.includes(id)),
      blocked: prepared.plan.enabled.filter((id) => !operational.graph.order.includes(id)),
    };
  });
  const requireComplete = (prepared: PreparedInstalledPluginPlan) => {
    const recipe = prepared.plan.composition;
    if (!recipe) return true;
    const owners = new Set([
      recipe.layout,
      ...recipe.slots.flatMap((slot) =>
        slot.contributions.filter((entry) => !entry.optional).map((entry) => entry.pluginId),
      ),
    ]);
    return [...owners].every((id) => prepared.graph.order.includes(id));
  };
  const reconfigure = Effect.fn("PluginManager.reconfigurePlan")(function* (
    previous: PreparedInstalledPluginPlan,
    target: PreparedInstalledPluginPlan,
    plugins: readonly StoredPlugin[],
    verifyComplete: boolean,
    rollbackBaseline?: ReadonlyMap<string, number>,
  ) {
    const difference = diffInstalledPluginPlans(previous, target);
    const seeds = rollbackBaseline
      ? new Set(
          [...new Set([...rollbackBaseline.keys(), ...running.keys()])].filter(
            (id) => running.get(id)?.generation !== rollbackBaseline.get(id),
          ),
        )
      : new Set(difference.stop);
    for (const [id, record] of running) {
      const desired = plugins.find((plugin) => plugin.id === id);
      if (
        record.expectedStop ||
        !target.graph.order.includes(id) ||
        desired?.revision.hash !== record.hash ||
        desired?.revision.grantId !== record.grantId
      )
        seeds.add(id);
    }
    let affected = seeds;
    for (;;) {
      const next = requiredDependentClosure(previous.graph, affected);
      for (const id of requiredDependentClosure(target.graph, next)) next.add(id);
      if (next.size === affected.size) break;
      affected = next;
    }
    for (const id of affected) {
      const record = running.get(id);
      if (record) record.expectedStop = true;
    }
    const order = [...previous.order, ...running.keys()].filter(
      (id, index, all) => all.indexOf(id) === index,
    );
    for (const id of order.reverse()) if (affected.has(id)) yield* stop(id);
    yield* serviceBroker
      .reconfigure(target.graph)
      .pipe(Effect.mapError((error) => failure(error.message)));
    serviceGraph = target.graph;
    if (options.composition)
      yield* options.composition
        .reconfigure(target.plan.composition)
        .pipe(Effect.mapError((error) => failure(error.message)));
    for (const id of target.order)
      if (!running.has(id)) yield* start(plugins.find((plugin) => plugin.id === id)!);
    if (verifyComplete && options.composition && !(yield* options.composition.complete))
      return yield* failure("Plugin composition is incomplete");
  });
  const migrate = Effect.fn("PluginManager.migratePlan")(function* (
    registry: Registry,
  ): Effect.fn.Return<RegistryV2, PluginManagerError> {
    if (registry.version === 2) return registry;
    if (options.safeMode) return yield* failure("Plugin plan migration requires a normal restart");
    const legacy = options.readLegacyPlan
      ? yield* options.readLegacyPlan.pipe(
          Effect.mapError(() => failure("Could not read legacy plugin plan")),
        )
      : {
          composition: options.compositionRecipe,
          serviceBindings: options.serviceBindings ?? [],
        };
    const plugins = registry.plugins.map((plugin) => {
      if (!plugin.starting) return { ...plugin, starting: false };
      if (!plugin.previous)
        return {
          ...plugin,
          enabled: false,
          starting: false,
          lastFailure: "Interrupted initial activation",
        };
      return {
        ...applyRevision(plugin, plugin.previous),
        previous: plugin.revision,
        starting: false,
        failures: 1,
        lastFailure: "Interrupted activation",
      };
    });
    const enabled = plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id);
    let composition = legacy.composition;
    if (!composition) {
      const ui = plugins.filter(
        (plugin) =>
          plugin.enabled &&
          plugin.revision.capabilities.some(
            (cap) => cap === "ui.compose" || cap === "browser.full-control",
          ),
      );
      if (ui.length > 1)
        return yield* failure("Legacy profile contains multiple whole-window UI plugins");
      if (ui[0]) composition = { layout: ui[0].id, slots: [] };
    }
    const activePlan: InstalledPluginPlan = {
      enabled,
      ...(composition ? { composition } : {}),
      serviceBindings: legacy.serviceBindings,
      revision: 0,
    };
    yield* preparePlan(plugins, activePlan, true);
    const migrated: RegistryV2 = { version: 2, plugins: mirror(plugins, activePlan), activePlan };
    yield* save(migrated);
    return migrated;
  });
  const loadedPlan = Effect.fn("PluginManager.loadedPlan")(function* () {
    const registry = yield* migrate(yield* load());
    if (registry.pendingPlan || registry.plugins.some((plugin) => plugin.removing))
      return yield* failure("Plugin plan recovery requires restart");
    return registry;
  });
  const transition = Effect.fn("PluginManager.transitionPlan")(function* (
    registry: RegistryV2,
    prospective: readonly StoredPlugin[],
    candidate: InstalledPluginPlan,
    failureReason = "Activation failed",
    afterPromotion: Effect.Effect<void, PluginManagerError> = Effect.void,
  ): Effect.fn.Return<InstalledPluginPlan, PluginManagerError> {
    if (registry.pendingPlan) return yield* failure("Plugin plan recovery requires restart");
    if (candidate.revision !== registry.activePlan.revision + 1)
      return yield* failure("Plugin plan revision is stale");
    const plugins = mirror(prospective, candidate);
    const previous = yield* preparePlan(registry.plugins, registry.activePlan, false);
    const next = yield* preparePlan(plugins, candidate, true);
    if (!requireComplete(next)) return yield* failure("A visible plan contains suspended plugins");
    const marked: RegistryV2 = { ...registry, pendingPlan: { candidate } };
    const promoted: RegistryV2 = { version: 2, plugins, activePlan: candidate };
    const baseline = new Map([...running].map(([id, record]) => [id, record.generation]));
    const restored: RegistryV2 = {
      ...registry,
      plugins: registry.plugins.map((plugin) => {
        const replacement = prospective.find((entry) => entry.id === plugin.id);
        return replacement &&
          (replacement.revision.hash !== plugin.revision.hash ||
            replacement.revision.grantId !== plugin.revision.grantId)
          ? { ...plugin, lastFailure: failureReason }
          : plugin;
      }),
    };
    let runtimeStarted = false;
    yield* Effect.uninterruptibleMask((restore) =>
      save(marked).pipe(
        Effect.andThen(
          restore(
            Effect.sync(() => {
              runtimeStarted = true;
            }).pipe(
              Effect.andThen(
                options.safeMode ? Effect.void : reconfigure(previous, next, plugins, true),
              ),
            ),
          ),
        ),
        Effect.andThen(save(promoted)),
        Effect.onError(() =>
          (!runtimeStarted || options.safeMode
            ? Effect.void
            : reconfigure(next, previous, registry.plugins, requireComplete(previous), baseline)
          ).pipe(
            Effect.andThen(save(restored)),
            Effect.catchCause(() =>
              poisonMutation.pipe(
                Effect.andThen(save(marked).pipe(Effect.catchCause(() => Effect.void))),
                Effect.andThen(options.onRecoveryFailure ?? Effect.void),
              ),
            ),
          ),
        ),
        Effect.andThen(afterPromotion),
      ),
    );
    return candidate;
  });
  const plan = () =>
    withMutationLock(loadedPlan().pipe(Effect.map((registry) => registry.activePlan)));
  /**
   * This deliberately does not take the mutation lock: a newly-starting plugin may ask for
   * management metadata before it acknowledges activation, while a transition holds that lock.
   * Registry replacement is atomic, so this returns either committed registry generation.
   */
  const managementSnapshot = () =>
    load().pipe(
      Effect.map((registry) => ({
        revision: registry.version === 2 ? registry.activePlan.revision : 0,
        plugins: registry.plugins.map(publicSummary),
      })),
    );
  const applyPlan = (expectedRevision: number, input: InstalledPluginPlanInput) =>
    withMutationLock(
      Effect.gen(function* () {
        if (options.safeMode && input.enabled.length > 0)
          return yield* failure("Plugins cannot be enabled in safe mode");
        const registry = yield* loadedPlan();
        if (registry.activePlan.revision !== expectedRevision)
          return yield* failure("Plugin plan revision is stale");
        const candidate = yield* nextPlan(registry, input);
        const plugins = registry.plugins.map((plugin) =>
          input.enabled.includes(plugin.id)
            ? { ...plugin, suspended: false, lastFailure: undefined }
            : plugin,
        );
        return yield* transition(registry, plugins, candidate);
      }),
    );
  const replace = (sourceId: string, targetId: string, expectedRevision: number) =>
    withMutationLock(
      Effect.gen(function* () {
        const registry = yield* loadedPlan();
        if (registry.activePlan.revision !== expectedRevision)
          return yield* failure("Plugin plan revision is stale");
        const source = registry.plugins.find((plugin) => plugin.id === sourceId);
        if (!source || !source.enabled || source.removing || !running.has(sourceId))
          return yield* failure("Source plugin is not enabled and running");
        const target = registry.plugins.find((plugin) => plugin.id === targetId);
        if (sourceId === targetId || !target || target.enabled || target.removing)
          return yield* failure("Replacement target must be a distinct disabled installed plugin");
        const active = registry.activePlan;
        const candidate = yield* nextPlan(registry, {
          enabled: active.enabled.map((id) => (id === sourceId ? targetId : id)),
          ...(active.composition === undefined
            ? {}
            : {
                composition: {
                  layout:
                    active.composition.layout === sourceId ? targetId : active.composition.layout,
                  slots: active.composition.slots.map((slot) => ({
                    ...slot,
                    ...(slot.route === undefined
                      ? {}
                      : {
                          route: {
                            fallback: {
                              ...slot.route.fallback,
                              pluginId:
                                slot.route.fallback.pluginId === sourceId
                                  ? targetId
                                  : slot.route.fallback.pluginId,
                            },
                          },
                        }),
                    contributions: slot.contributions.map((contribution) => ({
                      ...contribution,
                      pluginId:
                        contribution.pluginId === sourceId ? targetId : contribution.pluginId,
                    })),
                  })),
                },
              }),
          serviceBindings: active.serviceBindings.map((binding) => ({
            ...binding,
            consumer: binding.consumer === sourceId ? targetId : binding.consumer,
            provider: binding.provider === sourceId ? targetId : binding.provider,
          })),
        });
        const plugins = registry.plugins.map((plugin) =>
          plugin.id === targetId ? { ...plugin, suspended: false, lastFailure: undefined } : plugin,
        );
        return yield* transition(registry, plugins, candidate);
      }),
    );
  const replaceSelf = replace;
  const installPlan = (
    hash: string,
    grantId: string,
    installOptions?: { readonly staged?: boolean },
  ) =>
    withMutationLock(
      Effect.gen(function* () {
        const artifact = yield* artifacts
          .read(hash)
          .pipe(Effect.mapError((error) => failure(error.message)));
        yield* authorize(artifact, grantId);
        const registry = yield* loadedPlan();
        const old = registry.plugins.find((plugin) => plugin.id === artifact.manifest.id);
        if (old && installOptions?.staged) {
          if (
            !old.enabled &&
            !old.removing &&
            old.revision.hash === artifact.hash &&
            old.revision.grantId === grantId
          ) {
            yield* artifactFor(old, old.revision);
            return;
          }
          return yield* failure("Staged installation conflicts with the installed plugin identity");
        }
        if (!old && registry.plugins.length >= MaxPlugins)
          return yield* failure("At most sixteen plugins may be installed");
        const revision: Revision = {
          hash: artifact.hash,
          grantId,
          name: artifact.manifest.name,
          version: artifact.manifest.version,
          capabilities: artifact.manifest.capabilities,
        };
        const enabled = old ? old.enabled : !installOptions?.staged && !options.safeMode;
        const plugin: StoredPlugin = {
          id: artifact.manifest.id,
          name: revision.name,
          version: revision.version,
          revision,
          ...(old ? { previous: old.revision } : {}),
          enabled,
          starting: false,
          failures: 0,
          suspended: false,
        };
        const plugins = [...registry.plugins.filter((entry) => entry.id !== plugin.id), plugin];
        let composition = registry.activePlan.composition;
        if (enabled && hasUi(artifact) && composition === undefined)
          composition = { layout: plugin.id, slots: [] };
        const candidate = yield* nextPlan(registry, {
          enabled: plugins.filter((entry) => entry.enabled).map((entry) => entry.id),
          ...(composition ? { composition } : {}),
          serviceBindings: registry.activePlan.serviceBindings,
        });
        yield* transition(registry, plugins, candidate);
      }),
    );
  const setEnabledPlan = (id: string, enabled: boolean) =>
    withMutationLock(
      Effect.gen(function* () {
        if (enabled && options.safeMode)
          return yield* failure("Plugins cannot be enabled in safe mode");
        const registry = yield* loadedPlan();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin) return yield* failure("Plugin is not installed");
        const plugins = registry.plugins.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                enabled,
                ...(enabled ? { suspended: false, lastFailure: undefined } : {}),
              }
            : entry,
        );
        let composition = registry.activePlan.composition;
        if (
          enabled &&
          !composition &&
          plugin.revision.capabilities.some(
            (cap) => cap === "ui.compose" || cap === "browser.full-control",
          )
        )
          composition = { layout: id, slots: [] };
        const candidate = yield* nextPlan(registry, {
          enabled: plugins.filter((entry) => entry.enabled).map((entry) => entry.id),
          ...(composition ? { composition } : {}),
          serviceBindings: registry.activePlan.serviceBindings,
        });
        yield* transition(registry, plugins, candidate);
      }),
    );
  const rollbackPlan = (id: string) =>
    withMutationLock(
      Effect.gen(function* () {
        const registry = yield* loadedPlan();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin?.previous) return yield* failure("Plugin has no previous version");
        const replacement = {
          ...applyRevision(plugin, plugin.previous),
          previous: plugin.revision,
          suspended: false,
          failures: 1,
          starting: false,
        };
        yield* transition(
          registry,
          registry.plugins.map((entry) => (entry.id === id ? replacement : entry)),
          yield* nextPlan(registry, inputOf(registry.activePlan)),
          "Rollback failed",
        );
      }),
    );
  const finishRemoval = Effect.fn("PluginManager.finishRemoval")(function* (
    registry: RegistryV2,
    id: string,
  ) {
    const plugin = registry.plugins.find((entry) => entry.id === id);
    if (!plugin?.removing || plugin.enabled || registry.activePlan.enabled.includes(id))
      return yield* failure("Plugin removal journal is invalid");
    const grantIds = new Set([
      plugin.revision.grantId,
      ...(plugin.previous ? [plugin.previous.grantId] : []),
    ]);
    const grants = yield* options.grants
      .list()
      .pipe(Effect.mapError(() => failure("Could not inspect plugin revision grants")));
    const owned = grants.filter((grant) => grantIds.has(grant.id));
    if (owned.some((grant) => grant.principal !== id || grant.profileId !== profileId))
      return yield* failure("Plugin revision grant does not belong to this plugin and profile");
    const next: RegistryV2 = {
      ...registry,
      plugins: registry.plugins.filter((entry) => entry.id !== id),
    };
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        for (const grant of owned)
          yield* options.grants
            .revoke(grant.id)
            .pipe(Effect.mapError(() => failure("Could not revoke plugin revision grant")));
        yield* pluginStorage.remove(id).pipe(Effect.mapError((error) => failure(error.message)));
        yield* save(next);
      }),
    );
    return next;
  });
  const uninstallPlan = (id: string) =>
    withMutationLock(
      Effect.gen(function* () {
        const registry = yield* loadedPlan();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin) return yield* failure("Plugin is not installed");
        const grantIds = new Set([
          plugin.revision.grantId,
          ...(plugin.previous ? [plugin.previous.grantId] : []),
        ]);
        const grants = yield* options.grants
          .list()
          .pipe(Effect.mapError(() => failure("Could not inspect plugin revision grants")));
        const owned = grants.filter((grant) => grantIds.has(grant.id));
        if (owned.some((grant) => grant.principal !== id || grant.profileId !== profileId))
          return yield* failure("Plugin revision grant does not belong to this plugin and profile");
        const candidate = yield* nextPlan(registry, {
          ...inputOf(registry.activePlan),
          enabled: registry.activePlan.enabled.filter((entry) => entry !== id),
        });
        // The disabled removal marker is promoted with the plan. Recovery can resume
        // cleanup after any crash, without confusing it with an intentional disable.
        const prospective = registry.plugins.map((entry) =>
          entry.id === id ? { ...entry, removing: true } : entry,
        );
        const promoted: RegistryV2 = {
          version: 2,
          plugins: mirror(prospective, candidate),
          activePlan: candidate,
        };
        const cleanup = finishRemoval(promoted, id).pipe(
          Effect.asVoid,
          Effect.tapError(() => poisonMutation),
        );
        yield* transition(registry, prospective, candidate, "Uninstall failed", cleanup);
      }),
    );
  const restorePlan = () =>
    options.safeMode
      ? Effect.void
      : withMutationLock(
          Effect.gen(function* () {
            let registry = yield* migrate(yield* load());
            for (const plugin of registry.plugins)
              if (plugin.removing) registry = yield* finishRemoval(registry, plugin.id);
            let desired = yield* preparePlan(registry.plugins, registry.activePlan, false);
            for (const id of desired.order) {
              const plugin = registry.plugins.find((entry) => entry.id === id)!;
              yield* artifactFor(plugin, plugin.revision).pipe(
                Effect.flatMap((artifact) => authorize(artifact, plugin.revision.grantId)),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    if (registry.pendingPlan) return yield* error;
                    registry = {
                      ...registry,
                      plugins: registry.plugins.map((entry) =>
                        entry.id === id
                          ? { ...entry, suspended: true, lastFailure: error.message }
                          : entry,
                      ),
                    };
                    yield* save(registry);
                  }),
                ),
              );
            }
            desired = yield* preparePlan(registry.plugins, registry.activePlan, true);
            yield* serviceBroker
              .reconfigure(desired.graph)
              .pipe(Effect.mapError((error) => failure(error.message)));
            serviceGraph = desired.graph;
            if (options.composition)
              yield* options.composition
                .reconfigure(desired.plan.composition)
                .pipe(Effect.mapError((error) => failure(error.message)));
            for (const id of desired.order) {
              if (!serviceGraph.order.includes(id) || running.has(id)) continue;
              yield* start(registry.plugins.find((entry) => entry.id === id)!).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    if (registry.pendingPlan) return yield* error;
                    registry = {
                      ...registry,
                      plugins: registry.plugins.map((entry) =>
                        entry.id === id
                          ? { ...entry, suspended: true, lastFailure: error.message }
                          : entry,
                      ),
                    };
                    yield* save(registry);
                    const next = yield* preparePlan(registry.plugins, registry.activePlan, true);
                    const affected = requiredDependentClosure(serviceGraph, new Set([id]));
                    for (const affectedId of affected) {
                      const record = running.get(affectedId);
                      if (record) record.expectedStop = true;
                    }
                    for (const affectedId of [...serviceGraph.order].reverse())
                      if (affected.has(affectedId)) yield* stop(affectedId);
                    yield* serviceBroker
                      .reconfigure(next.graph)
                      .pipe(Effect.mapError((error) => failure(error.message)));
                    serviceGraph = next.graph;
                  }),
                ),
              );
            }
            if (registry.pendingPlan) {
              if (options.composition && !(yield* options.composition.complete))
                return yield* failure("Previous plugin composition could not be restored");
              yield* save({
                version: 2,
                plugins: registry.plugins,
                activePlan: registry.activePlan,
              });
            }
          }).pipe(
            Effect.tapError(() =>
              poisonMutation.pipe(Effect.andThen(options.onRecoveryFailure ?? Effect.void)),
            ),
          ),
        );
  runtimeFailure = (id, generation) =>
    withMutationLock(
      Effect.gen(function* () {
        if (latestGeneration.get(id) !== generation) return;
        const raw = yield* load();
        if (raw.version === 1) return yield* failure("Legacy plugin worker requires restart");
        const plugin = raw.plugins.find((entry) => entry.id === id);
        if (!plugin?.enabled || raw.pendingPlan) return;
        const previous = yield* preparePlan(raw.plugins, raw.activePlan, false);
        const suspended: RegistryV2 = {
          ...raw,
          plugins: raw.plugins.map((entry) =>
            entry.id === id
              ? { ...entry, suspended: true, lastFailure: "Plugin host stopped" }
              : entry,
          ),
        };
        yield* save(suspended);
        const target = yield* preparePlan(suspended.plugins, suspended.activePlan, true);
        yield* reconfigure(previous, target, suspended.plugins, false);
        if (plugin.previous && (plugin.failures ?? 0) < 1) {
          const replacement = {
            ...applyRevision(plugin, plugin.previous),
            previous: plugin.revision,
            suspended: false,
            failures: 1,
            starting: false,
            lastFailure: "Previous revision restored after a crash",
          };
          yield* transition(
            suspended,
            suspended.plugins.map((entry) => (entry.id === id ? replacement : entry)),
            yield* nextPlan(suspended, inputOf(suspended.activePlan)),
          ).pipe(Effect.catch(() => Effect.void));
        }
      }).pipe(Effect.tapError(() => poisonMutation)),
    );
  // Safe mode keeps the existing bounded Version 1 repair path and never launches a worker.
  const choose = <A>(
    legacy: Effect.Effect<A, PluginManagerError>,
    current: Effect.Effect<A, PluginManagerError>,
  ) =>
    options.safeMode
      ? load().pipe(Effect.flatMap((registry) => (registry.version === 1 ? legacy : current)))
      : current;
  return {
    list,
    managementSnapshot,
    events: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.succeed({ event: "plugins.changed" as const, payload: {} }),
          Stream.fromSubscription(subscription),
        );
      }),
    ),
    inspectInstallation: (id) =>
      lock.withPermit(
        Effect.gen(function* () {
          const registry = yield* load();
          const plugin = registry.plugins.find((entry) => entry.id === id);
          return plugin
            ? {
                hash: plugin.revision.hash,
                grantId: plugin.revision.grantId,
                enabled: plugin.enabled,
                removing: plugin.removing === true,
                suspended: plugin.suspended === true,
              }
            : undefined;
        }),
      ),
    plan,
    applyPlan,
    replace,
    replaceSelf,
    install: (hash: string, grantId: string, config?: { readonly staged?: boolean }) =>
      choose(install(hash, grantId), installPlan(hash, grantId, config)),
    enable: (id: string) => choose(enable(id), setEnabledPlan(id, true)),
    disable: (id: string) => choose(disable(id), setEnabledPlan(id, false)),
    uninstall: (id: string) => choose(uninstall(id), uninstallPlan(id)),
    rollback: (id: string) => choose(rollback(id), rollbackPlan(id)),
    restore: () =>
      options.safeMode
        ? withMutationLock(
            Effect.gen(function* () {
              let registry = yield* load().pipe(Effect.catch(() => Effect.succeed(undefined)));
              if (!registry || registry.version === 1) return yield* restore();
              for (const plugin of registry.plugins)
                if (plugin.removing) registry = yield* finishRemoval(registry, plugin.id);
            }),
          )
        : restorePlan(),
  } satisfies PluginManager;
});
