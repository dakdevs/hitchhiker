import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Capability } from "@hitchhiker/core";
import type { GrantStoreApi } from "@hitchhiker/runtime";
import { Clock, Deferred, Effect, Fiber, Option, Schema, Semaphore } from "effect";
import { createPluginArtifactStore, type PluginArtifact } from "./plugin-artifacts.ts";

const RegistryName = "plugins.json";
const MutationLockName = ".plugin-write-lock";
const MaxPlugins = 16;
const MaxRunning = 4;
const RegistryLimit = 32 * 1024;
const MutationLockTimeoutMs = 1_000;
const MutationLockRetryMs = 25;
const Hash = /^[a-f0-9]{64}$/;

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
  "plugins.install",
  "browser.full-control",
  "cdp.connect",
]);

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
  readonly failures?: number;
  readonly lastFailure?: string;
}
interface Registry {
  readonly version: 1;
  readonly plugins: readonly StoredPlugin[];
}

export interface ManagedPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hash: string;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly capabilities: readonly Capability[];
  readonly previousVersion?: string;
  readonly lastFailure?: string;
}
export interface PluginManager {
  readonly list: () => Effect.Effect<readonly ManagedPlugin[], PluginManagerError>;
  readonly install: (hash: string, grantId: string) => Effect.Effect<void, PluginManagerError>;
  readonly enable: (id: string) => Effect.Effect<void, PluginManagerError>;
  readonly disable: (id: string) => Effect.Effect<void, PluginManagerError>;
  readonly uninstall: (id: string) => Effect.Effect<void, PluginManagerError>;
  readonly rollback: (id: string) => Effect.Effect<void, PluginManagerError>;
  readonly restore: () => Effect.Effect<void, PluginManagerError>;
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
  ) => Effect.Effect<void, unknown>;
  readonly safeMode?: boolean;
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
  "plugins.install",
  "browser.full-control",
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
  failures: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  lastFailure: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
});
const RegistrySchema = Schema.Struct({
  version: Schema.Literal(1),
  plugins: Schema.Array(StoredPluginSchema).check(Schema.isMaxLength(MaxPlugins)),
});
const decodeRegistry = Schema.decodeUnknownOption(RegistrySchema, { onExcessProperty: "error" });

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
  const managerScope = yield* Effect.scope;
  let nextGeneration = 0;
  const running = new Map<
    string,
    {
      readonly generation: number;
      expectedStop: boolean;
      readonly stop: () => Effect.Effect<void>;
    }
  >();
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
    if (text === "") return { version: 1, plugins: [] };
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
    return decoded.value;
  });
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
      version: 1,
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
            : effect,
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
      const authorized = yield* options.grants
        .authorizeGrant(grantId, { profileId, capability })
        .pipe(Effect.mapError(() => failure("Plugin grant does not allow declared capabilities")));
      if (authorized.principal !== artifact.manifest.id)
        return yield* failure("Plugin grant principal does not match manifest");
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
        yield* active.stop().pipe(Effect.catch(() => Effect.void));
      }),
    );
  const stop = (id: string) => stopGeneration(id);
  const start = Effect.fn("PluginManager.start")(function* (
    plugin: StoredPlugin,
  ): Effect.fn.Return<void, PluginManagerError> {
    if (options.safeMode) return;
    if (running.size >= MaxRunning) return yield* failure("At most four plugins may run");
    const artifact = yield* artifactFor(plugin, plugin.revision);
    yield* authorize(artifact, plugin.revision.grantId);
    const ready = yield* Deferred.make<void, PluginManagerError>();
    const generation = ++nextGeneration;
    const launched = options
      .launch(artifact, plugin.revision.grantId, Deferred.succeed(ready, undefined))
      .pipe(Effect.catch(() => Deferred.fail(ready, failure("Plugin host stopped"))));
    const fiber = yield* launched.pipe(
      Effect.mapError(() => failure("Plugin host stopped")),
      Effect.ensuring(
        Effect.sync(() => {
          if (running.get(plugin.id)?.generation === generation) running.delete(plugin.id);
        }),
      ),
      (effect) => Effect.forkIn(effect, managerScope),
    );
    const record = {
      generation,
      expectedStop: false,
      stop: () => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    };
    running.set(plugin.id, record);
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
  const activate = Effect.fn("PluginManager.activate")(function* (
    registry: Registry,
    plugin: StoredPlugin,
    failures = 0,
  ): Effect.fn.Return<void, PluginManagerError> {
    if (plugin.enabled && running.has(plugin.id)) return;
    const candidate = yield* artifactFor(plugin, plugin.revision);
    if (hasUi(candidate)) {
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
    yield* put(registry, starting);
    yield* start(starting);
    const fresh = yield* load();
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
      const fresh = yield* load();
      if (!old) {
        const current = fresh.plugins.find((entry) => entry.id === candidate.id) ?? candidate;
        yield* put(fresh, { ...current, enabled: false, starting: false, lastFailure: reason });
        return;
      }
      const recovered = { ...old, starting: false, lastFailure: reason };
      yield* put(fresh, recovered);
      if (recovered.enabled && !options.safeMode)
        yield* start(recovered).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* stop(recovered.id);
              yield* put(yield* load(), {
                ...recovered,
                enabled: false,
                starting: false,
                lastFailure: error.message,
              });
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
        const active = running.get(id);
        if (active && active.generation !== failedGeneration) return;
        if (active?.generation === failedGeneration) running.delete(id);
        const registry = yield* load();
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
                const fresh = yield* load();
                yield* put(fresh, {
                  ...recovered,
                  enabled: false,
                  starting: false,
                  lastFailure: error.message,
                });
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
      }).pipe(Effect.tapError(() => poisonMutation)),
    );
  const restore = () =>
    options.safeMode
      ? Effect.void
      : withMutationLock(
          Effect.gen(function* () {
            const initial = yield* load();
            for (const entry of initial.plugins) {
              const registry = yield* load();
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
              yield* start(recovered).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    const fresh = yield* load();
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
          }).pipe(Effect.tapError(() => poisonMutation)),
        );
  const list = () =>
    lock.withPermit(
      Effect.gen(function* () {
        const registry = yield* load();
        return yield* Effect.forEach(registry.plugins, (plugin) =>
          Effect.succeed({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            hash: plugin.revision.hash,
            enabled: plugin.enabled,
            running: running.has(plugin.id),
            capabilities: plugin.revision.capabilities,
            ...(plugin.previous ? { previousVersion: plugin.previous.version } : {}),
            ...(plugin.lastFailure ? { lastFailure: plugin.lastFailure } : {}),
          } satisfies ManagedPlugin),
        );
      }),
    );
  const install = (hash: string, grantId: string) =>
    withMutationLock(
      Effect.gen(function* () {
        const artifact = yield* artifacts
          .read(hash)
          .pipe(Effect.mapError((error) => failure(error.message)));
        yield* authorize(artifact, grantId);
        const registry = yield* load();
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
        yield* recoverMutation(
          old,
          candidate,
          "Activation failed",
          Effect.gen(function* () {
            if (old?.enabled) yield* stop(old.id);
            yield* put(registry, candidate);
            if (!candidate.enabled) return;
            yield* activate(
              {
                version: 1,
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
        const registry = yield* load();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin) return yield* failure("Plugin is not installed");
        const candidate = { ...plugin, enabled: true };
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
        const registry = yield* load();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin) return yield* failure("Plugin is not installed");
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* stop(id);
            yield* put(registry, { ...plugin, enabled: false, starting: false });
          }).pipe(Effect.tapError(() => poisonMutation)),
        );
      }),
    );
  const uninstall = (id: string) =>
    withMutationLock(
      Effect.gen(function* () {
        const registry = yield* load();
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
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* stop(id);
            // Retain revision grant IDs in disabled state until revocation succeeds.
            yield* put(registry, { ...plugin, enabled: false, starting: false });
            for (const grant of owned) {
              yield* options.grants
                .revoke(grant.id)
                .pipe(Effect.mapError(() => failure("Could not revoke removed plugin grants")));
            }
            yield* save({
              version: 1,
              plugins: registry.plugins.filter((entry) => entry.id !== id),
            });
          }).pipe(Effect.tapError(() => poisonMutation)),
        );
      }),
    );
  const rollback = (id: string) =>
    withMutationLock(
      Effect.gen(function* () {
        const registry = yield* load();
        const plugin = registry.plugins.find((entry) => entry.id === id);
        if (!plugin || !plugin.previous) return yield* failure("Plugin has no previous version");
        const next = {
          ...applyRevision(plugin, plugin.previous),
          previous: plugin.revision,
          starting: plugin.enabled,
        };
        yield* recoverMutation(
          plugin,
          next,
          "Rollback failed",
          Effect.gen(function* () {
            yield* stop(id);
            yield* put(registry, next);
            if (!next.enabled) return;
            yield* activate(
              {
                version: 1,
                plugins: [...registry.plugins.filter((entry) => entry.id !== id), next],
              },
              next,
            );
          }),
        );
      }),
    );
  return { list, install, enable, disable, uninstall, rollback, restore } satisfies PluginManager;
});
