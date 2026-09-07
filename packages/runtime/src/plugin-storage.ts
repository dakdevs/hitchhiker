import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { types } from "node:util";
import { Effect, Option, Schema, Scope, Semaphore } from "effect";

const MaxJsonBytes = 128 * 1024;
const MaxFileBytes = MaxJsonBytes + 1024;
const MaxDepth = 32;
const MaxNodes = 4_096;
const OwnerId = /^[a-z][a-z0-9-]{1,62}$/;

export class PluginStorageError extends Schema.TaggedError<PluginStorageError>()(
  "PluginStorageError",
  {
    code: Schema.Literals(["configuration", "conflict", "invalid", "persistence"]),
    message: Schema.String,
  },
) {}

const failure = (code: "configuration" | "conflict" | "invalid" | "persistence", message: string) =>
  new PluginStorageError({ code, message });

export interface PluginStorageSnapshot {
  readonly revision: number;
  readonly value: Schema.Json;
}

export interface PluginStorageAdapter {
  readonly read: () => Effect.Effect<PluginStorageSnapshot, PluginStorageError>;
  readonly write: (
    expectedRevision: number,
    value: unknown,
  ) => Effect.Effect<{ readonly revision: number }, PluginStorageError>;
}

export interface PluginStorage {
  /** Trusted host selection. Plugin IDs are never accepted by the worker wire protocol. */
  readonly forOwner: (pluginId: string) => Effect.Effect<PluginStorageAdapter, PluginStorageError>;
  /** Trusted manager cleanup for an uninstalled owner. */
  readonly remove: (pluginId: string) => Effect.Effect<void, PluginStorageError>;
}

interface JsonBudget {
  nodes: number;
  stringBytes: number;
  readonly seen: WeakSet<object>;
}

/** Copies only own data properties, so validation never invokes caller code. */
const portableJson = (input: unknown, depth: number, budget: JsonBudget): Schema.Json => {
  if (depth > MaxDepth || ++budget.nodes > MaxNodes)
    throw failure("invalid", "Plugin storage value exceeds structural limits");
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw failure("invalid", "Plugin storage value must be JSON");
    return input;
  }
  if (typeof input === "string") {
    if (!input.isWellFormed())
      throw failure("invalid", "Plugin storage strings must be well-formed Unicode");
    budget.stringBytes += Buffer.byteLength(input, "utf8");
    if (budget.stringBytes > MaxJsonBytes)
      throw failure("invalid", "Plugin storage value exceeds size limits");
    return input;
  }
  if (typeof input !== "object" || types.isProxy(input) || budget.seen.has(input))
    throw failure("invalid", "Plugin storage value must be JSON");
  budget.seen.add(input);

  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype)
      throw failure("invalid", "Plugin storage value must be JSON");
    const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
    const keys = Reflect.ownKeys(input);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      keys.length !== length + 1 ||
      keys.some((key) => typeof key !== "string")
    )
      throw failure("invalid", "Plugin storage value must be JSON");
    const output: Schema.Json[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw failure("invalid", "Plugin storage value must be JSON");
      output.push(portableJson(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(output);
  }

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw failure("invalid", "Plugin storage value must be JSON");
  const output: Record<string, Schema.Json> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !key.isWellFormed())
      throw failure("invalid", "Plugin storage keys must be well-formed Unicode");
    budget.stringBytes += Buffer.byteLength(key, "utf8");
    if (budget.stringBytes > MaxJsonBytes)
      throw failure("invalid", "Plugin storage value exceeds size limits");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw failure("invalid", "Plugin storage value must be JSON");
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: portableJson(descriptor.value, depth + 1, budget),
    });
  }
  return Object.freeze(output);
};

const decodeValue = Effect.fn("PluginStorage.decodeValue")(function* (
  input: unknown,
): Effect.fn.Return<{ readonly value: Schema.Json; readonly bytes: number }, PluginStorageError> {
  const value = yield* Effect.try({
    try: () => portableJson(input, 0, { nodes: 0, stringBytes: 0, seen: new WeakSet() }),
    catch: (error) =>
      error instanceof PluginStorageError
        ? error
        : failure("invalid", "Plugin storage value must be bounded JSON"),
  });
  yield* Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    Effect.mapError(() => failure("invalid", "Plugin storage value must be JSON")),
  );
  const encoded = yield* Effect.try({
    try: () => JSON.stringify(value),
    catch: () => failure("invalid", "Plugin storage value must be JSON"),
  });
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MaxJsonBytes)
    return yield* failure("invalid", "Plugin storage value exceeds 128 KiB");
  return Object.freeze({ value, bytes });
});

const Persisted = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  value: Schema.Json,
});
const decodePersisted = Schema.decodeUnknownOption(Persisted, { onExcessProperty: "error" });

interface Identity {
  readonly dev: number;
  readonly ino: number;
}

interface SharedLock {
  readonly semaphore: Semaphore.Semaphore;
  references: number;
}

const locks = new Map<string, SharedLock>();

const sharedLock = (path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const current = locks.get(path);
      if (current) {
        current.references++;
        return current;
      }
      const created = { semaphore: Semaphore.makeUnsafe(1), references: 1 };
      locks.set(path, created);
      return created;
    }),
    (entry) =>
      Effect.sync(() => {
        entry.references--;
        if (entry.references === 0 && locks.get(path) === entry) locks.delete(path);
      }),
  );

const sameIdentity = (left: Identity, right: Identity) =>
  left.dev === right.dev && left.ino === right.ino;

/**
 * Durable storage for installed plugins. The browser's profile write lease is
 * the cross-process writer boundary; this store serializes all in-process instances.
 */
export const createPluginStorage = Effect.fn("PluginStorage.create")(function* (options: {
  readonly profileRoot: string;
}): Effect.fn.Return<PluginStorage, PluginStorageError, Scope.Scope> {
  if (!isAbsolute(options.profileRoot))
    return yield* failure("configuration", "Plugin storage profile root must be absolute");

  const prepared = yield* Effect.tryPromise({
    try: async () => {
      const profileRoot = await realpath(options.profileRoot);
      const profile = await lstat(profileRoot);
      if (!profile.isDirectory() || profile.isSymbolicLink()) throw new Error("invalid profile");
      const plugins = join(profileRoot, "hitchhiker-plugins");
      try {
        const info = await lstat(plugins);
        if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(plugins)) !== plugins)
          throw new Error("invalid plugin directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(plugins, { mode: 0o700 });
      }
      const pluginsCreated = await lstat(plugins);
      if (
        !pluginsCreated.isDirectory() ||
        pluginsCreated.isSymbolicLink() ||
        (await realpath(plugins)) !== plugins
      )
        throw new Error("invalid plugin directory");
      const directory = join(plugins, "storage");
      try {
        const info = await lstat(directory);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (await realpath(directory)) !== directory
        )
          throw new Error("invalid storage directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(directory, { mode: 0o700 });
      }
      const directoryCreated = await lstat(directory);
      if (
        !directoryCreated.isDirectory() ||
        directoryCreated.isSymbolicLink() ||
        (await realpath(directory)) !== directory
      )
        throw new Error("invalid storage directory");
      await chmod(plugins, 0o700);
      await chmod(directory, 0o700);
      const pluginsInfo = await lstat(plugins);
      const directoryInfo = await lstat(directory);
      return {
        profileRoot,
        profile: { dev: profile.dev, ino: profile.ino },
        plugins,
        pluginsIdentity: { dev: pluginsInfo.dev, ino: pluginsInfo.ino },
        directory,
        directoryIdentity: { dev: directoryInfo.dev, ino: directoryInfo.ino },
      };
    },
    catch: () => failure("persistence", "Could not create private plugin storage"),
  });
  const shared = yield* sharedLock(prepared.directory);
  let active = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      active = false;
    }),
  );

  const ensureStore = async () => {
    const [profile, plugins, directory, resolvedPlugins, resolvedDirectory] = await Promise.all([
      lstat(prepared.profileRoot),
      lstat(prepared.plugins),
      lstat(prepared.directory),
      realpath(prepared.plugins),
      realpath(prepared.directory),
    ]);
    if (
      !profile.isDirectory() ||
      profile.isSymbolicLink() ||
      !sameIdentity(profile, prepared.profile) ||
      !plugins.isDirectory() ||
      plugins.isSymbolicLink() ||
      !sameIdentity(plugins, prepared.pluginsIdentity) ||
      resolvedPlugins !== prepared.plugins ||
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !sameIdentity(directory, prepared.directoryIdentity) ||
      resolvedDirectory !== prepared.directory
    )
      throw new Error("plugin storage was replaced");
  };

  const pathFor = (pluginId: string) => join(prepared.directory, `${pluginId}.json`);
  const readOwner = async (pluginId: string): Promise<PluginStorageSnapshot> => {
    await ensureStore();
    const path = pathFor(pluginId);
    let named;
    try {
      named = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return Object.freeze({ revision: 0, value: null });
      throw error;
    }
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1 ||
      (named.mode & 0o077) !== 0 ||
      named.size > MaxFileBytes
    )
      throw new Error("invalid plugin storage file");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.dev !== named.dev ||
        before.ino !== named.ino ||
        before.size !== named.size ||
        before.size > MaxFileBytes
      )
        throw new Error("invalid plugin storage file");
      const bytes = Buffer.alloc(MaxFileBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const part = await file.read(bytes, length, bytes.length - length, null);
        if (part.bytesRead === 0) break;
        length += part.bytesRead;
      }
      const after = await file.stat();
      const current = await lstat(path);
      if (
        length > MaxFileBytes ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      )
        throw new Error("plugin storage changed during read");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      const parsed: unknown = JSON.parse(text);
      const decoded = decodePersisted(parsed);
      if (Option.isNone(decoded)) throw new Error("invalid plugin storage data");
      const value = portableJson(decoded.value.value, 0, {
        nodes: 0,
        stringBytes: 0,
        seen: new WeakSet(),
      });
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > MaxJsonBytes)
        throw new Error("oversized plugin storage value");
      return Object.freeze({ revision: decoded.value.revision, value });
    } finally {
      await file.close();
    }
  };

  const read = (pluginId: string) =>
    Effect.suspend(() =>
      active
        ? shared.semaphore.withPermit(
            Effect.tryPromise({
              try: () => readOwner(pluginId),
              catch: () => failure("persistence", "Could not read plugin storage"),
            }),
          )
        : Effect.fail(failure("persistence", "Plugin storage is no longer available")),
    );

  const write = (pluginId: string, expectedRevision: number, input: unknown) =>
    Effect.gen(function* () {
      if (!active) return yield* failure("persistence", "Plugin storage is no longer available");
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        expectedRevision >= Number.MAX_SAFE_INTEGER
      )
        return yield* failure("invalid", "Plugin storage revision is invalid");
      const decoded = yield* decodeValue(input);
      return yield* shared.semaphore.withPermit(
        Effect.uninterruptible(
          Effect.tryPromise({
            try: async () => {
              const current = await readOwner(pluginId);
              if (current.revision !== expectedRevision)
                throw failure("conflict", "Plugin storage revision changed");
              const revision = expectedRevision + 1;
              const body = JSON.stringify({ version: 1, revision, value: decoded.value });
              const path = pathFor(pluginId);
              const temporary = join(
                prepared.directory,
                `.${pluginId}.${process.pid}.${crypto.randomUUID()}.tmp`,
              );
              let renamed = false;
              try {
                const file = await open(
                  temporary,
                  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                  0o600,
                );
                try {
                  await file.writeFile(body, "utf8");
                  await file.sync();
                } finally {
                  await file.close();
                }
                await ensureStore();
                await rename(temporary, path);
                renamed = true;
                const directory = await open(
                  prepared.directory,
                  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                );
                try {
                  await directory.sync();
                } finally {
                  await directory.close();
                }
                return { revision };
              } finally {
                if (!renamed) await rm(temporary, { force: true });
              }
            },
            catch: (error) =>
              error instanceof PluginStorageError
                ? error
                : failure("persistence", "Could not write plugin storage"),
          }),
        ),
      );
    });

  const forOwner = (pluginId: string) =>
    Effect.suspend(() => {
      if (!active)
        return Effect.fail(failure("persistence", "Plugin storage is no longer available"));
      if (!OwnerId.test(pluginId))
        return Effect.fail(failure("invalid", "Plugin storage owner is invalid"));
      return Effect.succeed(
        Object.freeze({
          read: () => read(pluginId),
          write: (expectedRevision: number, value: unknown) =>
            write(pluginId, expectedRevision, value),
        }),
      );
    });

  const remove = (pluginId: string) => {
    if (!OwnerId.test(pluginId))
      return Effect.fail(failure("invalid", "Plugin storage owner is invalid"));
    return Effect.suspend(() =>
      active
        ? shared.semaphore.withPermit(
            Effect.uninterruptible(
              Effect.tryPromise({
                try: async () => {
                  await ensureStore();
                  const path = pathFor(pluginId);
                  try {
                    const info = await lstat(path);
                    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
                      throw new Error("invalid plugin storage file");
                    await rm(path);
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
                    throw error;
                  }
                  const directory = await open(
                    prepared.directory,
                    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                  );
                  try {
                    await directory.sync();
                  } finally {
                    await directory.close();
                  }
                },
                catch: () => failure("persistence", "Could not remove plugin storage"),
              }),
            ),
          )
        : Effect.fail(failure("persistence", "Plugin storage is no longer available")),
    );
  };

  return Object.freeze({ forOwner, remove });
});
