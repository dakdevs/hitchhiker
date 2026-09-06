import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Effect, Schema } from "effect";
import { LivePluginManifest, type LivePluginManifest as PluginManifest } from "@hitchhiker/runtime";

const ManifestFile = "hitchhiker.plugin.json";
const CodeFile = "plugin.js";
const ManifestLimit = 16 * 1024;
const CodeLimit = 512 * 1024;
const Hash = /^[a-f0-9]{64}$/;

export class PluginArtifactError extends Schema.TaggedError<PluginArtifactError>()(
  "PluginArtifactError",
  { message: Schema.String },
) {}

const failure = (message: string) => new PluginArtifactError({ message });
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const digest = (manifest: string, code: string) =>
  createHash("sha256").update(manifest).update("\n", "utf8").update(code, "utf8").digest("hex");

export interface PluginArtifact {
  readonly hash: string;
  readonly manifest: PluginManifest;
  readonly code: string;
}

export interface PluginArtifactStore {
  readonly stage: (input: {
    readonly manifest: unknown;
    readonly code: string;
  }) => Effect.Effect<PluginArtifact, PluginArtifactError>;
  readonly read: (hash: string) => Effect.Effect<PluginArtifact, PluginArtifactError>;
}

/** Data-only, immutable compiled-plugin artifacts scoped to one browser profile. */
export const createPluginArtifactStore = Effect.fn("PluginArtifacts.create")(function* (
  profileRoot: string,
) {
  if (!isAbsolute(profileRoot)) return yield* failure("Profile root must be absolute");
  const root = join(profileRoot, "hitchhiker-plugins", "artifacts");
  yield* Effect.tryPromise({
    try: () => mkdir(root, { recursive: true, mode: 0o700 }),
    catch: () => failure("Could not create plugin artifact store"),
  });
  const canonicalRoot = yield* Effect.tryPromise({
    try: async () => {
      const canonicalProfile = await realpath(profileRoot);
      const value = await realpath(root);
      if (value !== join(canonicalProfile, "hitchhiker-plugins", "artifacts"))
        throw new Error("Plugin store paths must not redirect to another profile");
      return value;
    },
    catch: () => failure("Could not resolve plugin artifact store"),
  });
  const ensureStoreRoot = Effect.tryPromise({
    try: async () => {
      if ((await realpath(canonicalRoot)) !== canonicalRoot) throw new Error("store was replaced");
      const info = await lstat(canonicalRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("store is not a directory");
    },
    catch: () => failure("Plugin artifact store is invalid"),
  });

  const decode = (manifest: unknown) =>
    Schema.decodeUnknownEffect(LivePluginManifest, { onExcessProperty: "error" })(manifest).pipe(
      Effect.mapError(() => failure("Plugin manifest is invalid")),
    );
  const readFileBounded = (directory: string, name: string, limit: number) =>
    Effect.tryPromise({
      try: async () => {
        const path = join(directory, name);
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error("not a regular file");
        const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await descriptor.stat();
          if (
            !stat.isFile() ||
            stat.dev !== before.dev ||
            stat.ino !== before.ino ||
            stat.size > limit
          )
            throw new Error("changed or oversized");
          const buffer = Buffer.alloc(limit + 1);
          let length = 0;
          while (length <= limit) {
            const { bytesRead } = await descriptor.read(buffer, length, limit + 1 - length, null);
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          if (length > limit) throw new Error("oversized");
          const after = await descriptor.stat();
          if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size)
            throw new Error("changed while reading");
          return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
        } finally {
          await descriptor.close();
        }
      },
      catch: () => failure("Plugin artifact file is invalid"),
    });
  const read = Effect.fn("PluginArtifacts.read")(function* (hash: string) {
    if (!Hash.test(hash)) return yield* failure("Plugin artifact hash is invalid");
    yield* ensureStoreRoot;
    const directory = join(canonicalRoot, hash);
    const parent = yield* Effect.tryPromise({
      try: () => realpath(join(directory, "..")),
      catch: () => failure("Plugin artifact does not exist"),
    });
    if (parent !== canonicalRoot) return yield* failure("Plugin artifact escapes its store");
    const info = yield* Effect.tryPromise({
      try: () => lstat(directory),
      catch: () => failure("Plugin artifact does not exist"),
    });
    if (!info.isDirectory() || info.isSymbolicLink())
      return yield* failure("Plugin artifact directory is invalid");
    const manifestText = yield* readFileBounded(directory, ManifestFile, ManifestLimit);
    const code = yield* readFileBounded(directory, CodeFile, CodeLimit);
    const raw = yield* Effect.try({
      try: () => JSON.parse(manifestText),
      catch: () => failure("Plugin manifest is not JSON"),
    });
    const manifest = yield* decode(raw);
    const normalizedManifest = canonical(manifest);
    if (manifestText !== normalizedManifest || digest(normalizedManifest, code) !== hash)
      return yield* failure("Plugin artifact hash does not match its contents");
    return { hash, manifest, code };
  });
  const stage = Effect.fn("PluginArtifacts.stage")(function* (input: {
    readonly manifest: unknown;
    readonly code: string;
  }) {
    if (typeof input.code !== "string") return yield* failure("Plugin code is invalid");
    yield* ensureStoreRoot;
    if (Buffer.byteLength(input.code, "utf8") > CodeLimit)
      return yield* failure("Plugin code exceeds 512 KiB");
    if (Buffer.from(input.code, "utf8").toString("utf8") !== input.code)
      return yield* failure("Plugin code contains an unpaired Unicode surrogate");
    const manifest = yield* decode(input.manifest);
    const manifestText = canonical(manifest);
    if (Buffer.byteLength(manifestText, "utf8") > ManifestLimit)
      return yield* failure("Plugin manifest exceeds 16 KiB");
    const hash = digest(manifestText, input.code);
    const target = join(canonicalRoot, hash);
    const targetExists = yield* Effect.tryPromise({
      try: async () => {
        try {
          await lstat(target);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      catch: () => failure("Could not inspect plugin artifact"),
    });
    // An existing name is immutable: validate it rather than replacing it.
    if (targetExists) return yield* read(hash);
    yield* Effect.tryPromise({
      try: async () => {
        if ((await readdir(canonicalRoot)).length >= 256)
          throw new Error("Plugin artifact store has reached its capacity");
        const temporary = await mkdtemp(join(canonicalRoot, ".stage-"));
        const write = async (name: string, content: string) => {
          const handle = await open(
            join(temporary, name),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            0o600,
          );
          try {
            await handle.writeFile(content, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
        };
        try {
          await write(ManifestFile, manifestText);
          await write(CodeFile, input.code);
          const tempDirectory = await open(temporary, constants.O_RDONLY);
          try {
            await tempDirectory.sync();
          } finally {
            await tempDirectory.close();
          }
          await rename(temporary, target);
          const rootDirectory = await open(canonicalRoot, constants.O_RDONLY);
          try {
            await rootDirectory.sync();
          } finally {
            await rootDirectory.close();
          }
        } catch (error) {
          await rm(temporary, { recursive: true, force: true });
          if (
            (error as NodeJS.ErrnoException).code !== "EEXIST" &&
            (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
          )
            throw error;
        }
      },
      catch: () => failure("Could not stage plugin artifact"),
    });
    return yield* read(hash);
  });
  return { stage, read } satisfies PluginArtifactStore;
});
