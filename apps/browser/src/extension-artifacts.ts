import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { Effect, Schema, Semaphore } from "effect";
import type { ProfileWriteLease } from "./profile-write-lease.ts";

const manifestFile = "manifest.json";
const defaultLimits = {
  manifestBytes: 1024 * 1024,
  fileBytes: 256 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  entries: 10_000,
  depth: 64,
  pathBytes: 4096,
  artifacts: 16,
} as const;
type Limits = { readonly [Key in keyof typeof defaultLimits]: number };
/** @internal Test-only lowered bounds; production callers must omit this argument. */
export type ExtensionArtifactTestLimits = Partial<Limits> & {
  /** @internal Test fault injection between copy and verification; never pass in production. */
  readonly beforePublish?: (stagedDirectory: string) => void | Promise<void>;
};
/** @internal Explicitly test-only factory inputs. Production code must use a real ProfileWriteLease. */
export type ExtensionArtifactStoreTestOptions = ExtensionArtifactTestLimits & {
  /** @internal Allows portable tests to exercise one-lease startup behavior. */
  readonly profileLease?: ProfileWriteLease;
};
const idPattern = /^[a-f0-9]{32}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export class ExtensionArtifactError extends Schema.TaggedError<ExtensionArtifactError>()(
  "ExtensionArtifactError",
  { message: Schema.String },
) {}

export interface ExtensionArtifact {
  readonly installationId: string;
  readonly digest: string;
  readonly expectedChromiumId: string;
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly permissions: readonly string[];
  readonly host_permissions: readonly string[];
  readonly optional_permissions: readonly string[];
  readonly optional_host_permissions: readonly string[];
}

export interface ExtensionArtifactStore {
  readonly stage: (
    sourceDirectory: string,
  ) => Effect.Effect<ExtensionArtifact, ExtensionArtifactError>;
  readonly read: (
    installationId: string,
    expectedDigest: string,
  ) => Effect.Effect<ExtensionArtifact, ExtensionArtifactError>;
  /**
   * Trusted manager-only disposal. The caller must prove this path was never handed to Chromium,
   * or that its engine is fully stopped. Uncertain load outcomes must retain the artifact.
   */
  readonly discardUnused: (
    installationId: string,
    expectedDigest: string,
  ) => Effect.Effect<void, ExtensionArtifactError>;
  /**
   * One startup-only collection pass before Chromium receives an artifact path.
   * Callers retain live registry IDs and separately name removable tombstones.
   * Returned IDs were deleted or were already absent; callers may prune only those.
   */
  readonly collectBeforeReplay: (
    retainedInstallationIds: readonly string[],
    removableInstallationIds: readonly string[],
  ) => Effect.Effect<readonly string[], ExtensionArtifactError>;
}

export interface ExtensionArtifactStoreOptions {
  /** The parent controller's kernel-held profile lease. */
  readonly profileLease: ProfileWriteLease;
}

type StatMark = readonly [bigint, bigint, bigint, bigint, bigint];
type TreeEntry = {
  readonly path: string;
  readonly type: "d" | "f";
  readonly size: bigint;
  readonly hash?: string;
};
type Manifest = Pick<
  ExtensionArtifact,
  | "name"
  | "version"
  | "permissions"
  | "host_permissions"
  | "optional_permissions"
  | "optional_host_permissions"
> & { readonly key?: string };
const ManifestSchema = Schema.Struct({
  manifest_version: Schema.Literal(3),
  name: Schema.String,
  version: Schema.String,
  key: Schema.optional(Schema.String),
  permissions: Schema.optional(Schema.Array(Schema.String)),
  host_permissions: Schema.optional(Schema.Array(Schema.String)),
  optional_permissions: Schema.optional(Schema.Array(Schema.String)),
  optional_host_permissions: Schema.optional(Schema.Array(Schema.String)),
});
const decodeManifestShape = Schema.decodeUnknownSync(ManifestSchema, {
  onExcessProperty: "preserve",
});
const recoveryStates = new WeakMap<ProfileWriteLease, "running" | "complete">();
const collectionStates = new WeakMap<ProfileWriteLease, "open" | "sealed">();
const fail = (message: string) => new ExtensionArtifactError({ message });
const mark = (info: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): StatMark => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs];
const sameMark = (one: StatMark, two: StatMark) =>
  one.every((value, index) => value === two[index]);
const wellFormed = (value: string) => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (
        ++index >= value.length ||
        value.charCodeAt(index) < 0xdc00 ||
        value.charCodeAt(index) > 0xdfff
      )
        return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};
const pathBuffer = (directory: string | Buffer, name: Buffer) =>
  Buffer.concat([
    Buffer.isBuffer(directory) ? directory : Buffer.from(directory),
    Buffer.from("/"),
    name,
  ]);
const segment = (name: Buffer) => {
  const value = utf8.decode(name);
  if (!value || value === "." || value === ".." || value.includes("\0") || value.includes("/"))
    throw new Error("invalid path segment");
  if (!wellFormed(value)) throw new Error("invalid UTF-16 path segment");
  return value;
};
const validVersion = (version: string) => {
  // Chromium permits one to four components, 0..65535; nonzero values cannot lead with zero.
  const parts = version.split(".");
  return (
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every(
      (part) => /^\d+$/.test(part) && Number(part) <= 65535 && (part === "0" || part[0] !== "0"),
    )
  );
};
const decodeChromiumKey = (key: string) => {
  if (!key || Buffer.byteLength(key, "utf8") > 100 * 1024)
    throw new Error("manifest key is invalid");
  let encoded = key;
  if (encoded.startsWith("-----BEGIN")) {
    // Chromium 144's ParsePEMKeyBytes accepts whitespace only for a BEGIN...KEY PEM envelope.
    const compact = encoded.replace(/[\t\n\f\r ]+/g, "");
    const payloadStart = compact.indexOf("KEY-----", "-----BEGIN".length);
    const footer = compact.lastIndexOf("-----END");
    if (payloadStart < 0 || footer < 0 || payloadStart + "KEY-----".length >= footer)
      throw new Error("manifest key PEM is invalid");
    encoded = compact.slice(payloadStart + "KEY-----".length, footer);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error("manifest key is not strict base64");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw new Error("manifest key is invalid");
  return bytes;
};
const chromiumId = (directory: string, key?: string) => {
  const bytes = key === undefined ? Buffer.from(directory, "utf8") : decodeChromiumKey(key);
  return createHash("sha256")
    .update(bytes)
    .digest()
    .subarray(0, 16)
    .toString("hex")
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
};
const strings = (value: unknown, field: string): readonly string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (item) => typeof item !== "string" || !wellFormed(item) || Buffer.byteLength(item) > 2048,
    )
  )
    throw new Error(`${field} must be a string array`);
  return Object.freeze([...value]);
};
const validJsonStrings = (value: unknown): boolean => {
  if (typeof value === "string") return wellFormed(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(validJsonStrings);
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).every(([key, item]) => wellFormed(key) && validJsonStrings(item))
  );
};
const decodeManifest = (bytes: Buffer, limits: Limits): Manifest => {
  if (bytes.length > limits.manifestBytes) throw new Error("manifest too large");
  const raw = JSON.parse(utf8.decode(bytes)) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !validJsonStrings(raw))
    throw new Error("invalid manifest");
  const object = decodeManifestShape(raw);
  if (!object.name || !wellFormed(object.name) || Buffer.byteLength(object.name) > 1024)
    throw new Error("manifest must be MV3 with a name");
  if (!validVersion(object.version) || !wellFormed(object.version))
    throw new Error("manifest version is invalid");
  if (object.key !== undefined && !wellFormed(object.key))
    throw new Error("manifest key is invalid");
  return {
    name: object.name,
    version: object.version,
    permissions: strings(object.permissions, "permissions"),
    host_permissions: strings(object.host_permissions, "host_permissions"),
    optional_permissions: strings(object.optional_permissions, "optional_permissions"),
    optional_host_permissions: strings(
      object.optional_host_permissions,
      "optional_host_permissions",
    ),
    key: object.key,
  };
};

/** Bounded, profile-owned copies for Chromium's unpacked-MV3 loader. */
const makeExtensionArtifactStore = Effect.fn("ExtensionArtifacts.make")(function* (
  profileLease: ProfileWriteLease,
  testLimits?: ExtensionArtifactTestLimits,
) {
  const profileRoot = profileLease.profileRoot;
  if (!isAbsolute(profileRoot)) return yield* fail("Profile root must be absolute");
  const root = join(profileRoot, "hitchhiker-extensions", "artifacts");
  const { beforePublish, ...limitOverrides } = testLimits ?? {};
  const limits: Limits = { ...defaultLimits, ...limitOverrides };
  const semaphore = yield* Semaphore.make(1);
  const canonical = yield* profileLease
    .withWrite(
      Effect.tryPromise({
        try: async () => {
          await mkdir(profileRoot, { recursive: true, mode: 0o700 });
          const profile = await realpath(profileRoot);
          const extensionRoot = join(profile, "hitchhiker-extensions");
          await mkdir(extensionRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          const extensionInfo = await lstat(extensionRoot, { bigint: true });
          if (!extensionInfo.isDirectory() || extensionInfo.isSymbolicLink())
            throw new Error("extension root redirected");
          await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          const resolved = await realpath(root);
          if (resolved !== join(profile, "hitchhiker-extensions", "artifacts"))
            throw new Error("store redirected");
          const identity = await lstat(resolved, { bigint: true });
          if (!identity.isDirectory() || identity.isSymbolicLink())
            throw new Error("store is not a directory");
          return { profile, root: resolved, dev: identity.dev, ino: identity.ino };
        },
        catch: () => fail("Could not create extension artifact store"),
      }),
    )
    .pipe(Effect.mapError(() => fail("Could not create extension artifact store")));
  const canonicalRoot = canonical.root;
  const checkRoot = async () => {
    const resolved = await realpath(canonicalRoot);
    const info = await lstat(resolved, { bigint: true });
    if (
      resolved !== canonicalRoot ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== BigInt(process.getuid!()) ||
      (info.mode & 0o077n) !== 0n ||
      canonical.dev !== info.dev ||
      canonical.ino !== info.ino ||
      relative(canonical.profile, resolved).startsWith("..")
    )
      throw new Error("invalid store root");
  };
  const scan = async (
    directory: string,
    copyTo?: string,
  ): Promise<{ entries: TreeEntry[]; manifest: Manifest }> => {
    const rootInfo = await lstat(directory, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      throw new Error("source is not a directory");
    const rootMark = mark(rootInfo);
    let count = 0;
    let total = 0n;
    let observedTotal = 0;
    let manifest: Manifest | undefined;
    const entries: TreeEntry[] = [];
    const visit = async (
      source: string | Buffer,
      target: string | undefined,
      relativePath: string,
      depth: number,
    ): Promise<void> => {
      if (depth > limits.depth) throw new Error("tree too deep");
      const before = await lstat(source, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("directory changed");
      const beforeMark = mark(before);
      if (target && depth > 0) await mkdir(target, { mode: 0o700 });
      entries.push({ path: relativePath, type: "d", size: 0n });
      const names = await readdir(source, { encoding: "buffer" });
      names.sort(Buffer.compare);
      for (const rawName of names) {
        const name = segment(rawName);
        const childRelative = relativePath ? `${relativePath}/${name}` : name;
        if (Buffer.byteLength(childRelative) > limits.pathBytes) throw new Error("path too long");
        if (++count > limits.entries) throw new Error("too many entries");
        const child = pathBuffer(source, rawName);
        const childTarget = target && join(target, name);
        const info = await lstat(child, { bigint: true });
        if (info.isSymbolicLink()) throw new Error("symlink rejected");
        if (info.isDirectory()) {
          await visit(child, childTarget, childRelative, depth + 1);
          continue;
        }
        if (!info.isFile()) throw new Error("special file rejected");
        if (
          info.size > BigInt(limits.fileBytes) ||
          (total += info.size) > BigInt(limits.totalBytes)
        )
          throw new Error("file limit exceeded");
        const beforeFile = mark(info);
        const handle = await open(child, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat({ bigint: true });
          if (!opened.isFile() || !sameMark(beforeFile, mark(opened)))
            throw new Error("file replaced");
          const output = target
            ? await open(
                childTarget!,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
              )
            : undefined;
          const hash = createHash("sha256");
          const chunks: Buffer[] = [];
          let size = 0;
          const buffer = Buffer.allocUnsafe(64 * 1024);
          try {
            for (;;) {
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
              if (!bytesRead) break;
              const chunk = Buffer.from(buffer.subarray(0, bytesRead));
              hash.update(chunk);
              size += bytesRead;
              observedTotal += bytesRead;
              if (size > limits.fileBytes || observedTotal > limits.totalBytes)
                throw new Error("file grew beyond limit");
              if (childRelative === manifestFile) {
                if (size > limits.manifestBytes) throw new Error("manifest too large");
                chunks.push(chunk);
              }
              if (output) {
                let offset = 0;
                while (offset < chunk.length) {
                  const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
                  if (bytesWritten <= 0) throw new Error("short output write");
                  offset += bytesWritten;
                }
              }
            }
            if (output) await output.sync();
          } finally {
            await output?.close();
          }
          const afterFile = await handle.stat({ bigint: true });
          if (size !== Number(opened.size) || !sameMark(mark(opened), mark(afterFile)))
            throw new Error("file changed during read");
          if (childRelative === manifestFile)
            manifest = decodeManifest(Buffer.concat(chunks), limits);
          entries.push({
            path: childRelative,
            type: "f",
            size: opened.size,
            hash: hash.digest("hex"),
          });
        } finally {
          await handle.close();
        }
      }
      const after = await lstat(source, { bigint: true });
      if (!sameMark(beforeMark, mark(after))) throw new Error("directory changed during scan");
      if (target) {
        const directoryHandle = await open(target, constants.O_RDONLY);
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    };
    await visit(directory, copyTo, "", 0);
    const afterRoot = await lstat(directory, { bigint: true });
    if (!sameMark(rootMark, mark(afterRoot)) || !manifest)
      throw new Error("source changed or has no manifest");
    return { entries, manifest };
  };
  const digest = (entries: readonly TreeEntry[]) => {
    const hash = createHash("sha256");
    hash.update("hitchhiker-extension-artifact-v1\0");
    for (const entry of [...entries].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
    )) {
      for (const part of [entry.path, entry.type, entry.size.toString(), entry.hash ?? ""]) {
        const bytes = Buffer.from(part);
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(bytes.length));
        hash.update(length);
        hash.update(bytes);
      }
    }
    return hash.digest("hex");
  };
  const withLock = async <Value>(run: () => Promise<Value>): Promise<Value> => {
    await checkRoot();
    const lock = join(canonicalRoot, ".lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      throw new Error("extension artifact store is busy");
    }
    try {
      return await run();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  };
  const removePublished = async (installationId: string) => {
    const target = join(canonicalRoot, installationId);
    if (relative(canonicalRoot, target) !== installationId) throw new Error("path escaped");
    const info = await lstat(target, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("artifact is not a private directory");
    const trash = join(canonicalRoot, `.trash-${installationId}`);
    await rename(target, trash);
    const rootHandle = await open(canonicalRoot, constants.O_RDONLY);
    try {
      await rootHandle.sync();
    } finally {
      await rootHandle.close();
    }
    await rm(trash, { recursive: true });
    const after = await open(canonicalRoot, constants.O_RDONLY);
    try {
      await after.sync();
    } finally {
      await after.close();
    }
  };
  const recoverScratch = async () => {
    await checkRoot();
    const entries = await readdir(canonicalRoot, { encoding: "buffer" });
    let changed = false;
    for (const rawName of entries) {
      let name: string;
      try {
        name = utf8.decode(rawName);
      } catch {
        continue;
      }
      if (name !== ".lock" && !/^\.(?:stage|trash)-[a-f0-9]{32}$/.test(name)) continue;
      const candidate = join(canonicalRoot, name);
      const info = await lstat(candidate, { bigint: true });
      // A private controller can only leave directories with these names. Do not
      // turn an unexpected link or file into a deletion primitive during recovery.
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("invalid private recovery entry");
      await rm(candidate, { recursive: true, force: true });
      changed = true;
    }
    if (changed) {
      const handle = await open(canonicalRoot, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  };
  const read = Effect.fn("ExtensionArtifacts.read")(function* (
    installationId: string,
    expectedDigest: string,
  ) {
    if (!idPattern.test(installationId) || !digestPattern.test(expectedDigest))
      return yield* fail("Invalid extension artifact identity");
    yield* profileLease
      .withWrite(
        Effect.tryPromise({
          try: checkRoot,
          catch: () => fail("Extension artifact store is invalid"),
        }),
      )
      .pipe(Effect.mapError(() => fail("Extension artifact store is invalid")));
    const directory = join(canonicalRoot, installationId);
    const artifact = yield* profileLease
      .withWrite(
        Effect.tryPromise({
          try: async () => {
            if (relative(canonicalRoot, directory) !== installationId)
              throw new Error("path escaped");
            const scanned = await scan(directory);
            const actual = digest(scanned.entries);
            if (actual !== expectedDigest) throw new Error("digest mismatch");
            const { key, ...metadata } = scanned.manifest;
            return Object.freeze({
              installationId,
              digest: actual,
              expectedChromiumId: chromiumId(directory, key),
              directory,
              ...metadata,
            });
          },
          catch: () => fail("Extension artifact is invalid"),
        }),
      )
      .pipe(Effect.mapError(() => fail("Extension artifact is invalid")));
    return artifact satisfies ExtensionArtifact;
  });
  const stage = Effect.fn("ExtensionArtifacts.stage")(function* (sourceDirectory: string) {
    if (!isAbsolute(sourceDirectory))
      return yield* fail("Extension source directory must be absolute");
    collectionStates.set(profileLease, "sealed");
    return yield* profileLease
      .withWrite(
        Effect.uninterruptible(
          Semaphore.withPermits(
            semaphore,
            1,
          )(
            Effect.tryPromise({
              try: async () => {
                return await withLock(async () => {
                  const published = (await readdir(canonicalRoot)).filter((name) =>
                    idPattern.test(name),
                  );
                  if (published.length >= limits.artifacts)
                    throw new Error("extension artifact store is full");
                  const installationId = randomBytes(16).toString("hex");
                  const temporary = join(canonicalRoot, `.stage-${installationId}`);
                  const target = join(canonicalRoot, installationId);
                  await mkdir(temporary, { mode: 0o700 });
                  try {
                    const first = await scan(sourceDirectory, temporary);
                    if (first.manifest.key !== undefined) decodeChromiumKey(first.manifest.key);
                    const firstDigest = digest(first.entries);
                    await beforePublish?.(temporary);
                    const second = await scan(sourceDirectory);
                    const staged = await scan(temporary);
                    if (
                      firstDigest !== digest(second.entries) ||
                      firstDigest !== digest(staged.entries)
                    )
                      throw new Error("source changed before publish");
                    const tempHandle = await open(temporary, constants.O_RDONLY);
                    try {
                      await tempHandle.sync();
                    } finally {
                      await tempHandle.close();
                    }
                    await rename(temporary, target);
                    const rootHandle = await open(canonicalRoot, constants.O_RDONLY);
                    try {
                      await rootHandle.sync();
                    } finally {
                      await rootHandle.close();
                    }
                    const { key, ...metadata } = first.manifest;
                    return Object.freeze({
                      installationId,
                      digest: firstDigest,
                      expectedChromiumId: chromiumId(target, key),
                      directory: target,
                      ...metadata,
                    });
                  } catch (error) {
                    await rm(temporary, { recursive: true, force: true });
                    throw error;
                  }
                });
              },
              catch: (error) =>
                fail(
                  `Could not stage extension artifact: ${error instanceof Error ? error.message : "unknown failure"}`,
                ),
            }),
          ),
        ),
      )
      .pipe(Effect.mapError(() => fail("Could not stage extension artifact")));
  });
  const discardUnused = Effect.fn("ExtensionArtifacts.discardUnused")(function* (
    installationId: string,
    expectedDigest: string,
  ) {
    if (!idPattern.test(installationId) || !digestPattern.test(expectedDigest))
      return yield* fail("Invalid extension artifact identity");
    collectionStates.set(profileLease, "sealed");
    yield* profileLease
      .withWrite(
        Effect.uninterruptible(
          Semaphore.withPermits(
            semaphore,
            1,
          )(
            Effect.tryPromise({
              try: async () =>
                withLock(async () => {
                  const artifact = await Effect.runPromise(read(installationId, expectedDigest));
                  const target = join(canonicalRoot, installationId);
                  if (
                    artifact.directory !== target ||
                    relative(canonicalRoot, target) !== installationId
                  )
                    throw new Error("path escaped");
                  await removePublished(installationId);
                }),
              catch: () => fail("Could not discard unused extension artifact"),
            }),
          ),
        ),
      )
      .pipe(Effect.mapError(() => fail("Could not discard unused extension artifact")));
  });
  const collectBeforeReplay = Effect.fn("ExtensionArtifacts.collectBeforeReplay")(function* (
    retainedInstallationIds: readonly string[],
    removableInstallationIds: readonly string[],
  ) {
    if (
      retainedInstallationIds.length + removableInstallationIds.length > limits.artifacts ||
      retainedInstallationIds.some((id) => !idPattern.test(id)) ||
      removableInstallationIds.some((id) => !idPattern.test(id)) ||
      new Set([...retainedInstallationIds, ...removableInstallationIds]).size !==
        retainedInstallationIds.length + removableInstallationIds.length
    )
      return yield* fail("Invalid retained extension artifact identities");
    if (collectionStates.get(profileLease) !== undefined)
      return yield* fail("Extension artifact collection is no longer safe in this controller");
    // Seal before I/O. A failed pass cannot be retried after another operation
    // may have exposed a freshly staged path to Chromium.
    collectionStates.set(profileLease, "sealed");
    const retained = new Set(retainedInstallationIds);
    const removable = new Set(removableInstallationIds);
    return yield* profileLease
      .withWrite(
        Effect.uninterruptible(
          Semaphore.withPermits(
            semaphore,
            1,
          )(
            Effect.tryPromise({
              try: async () =>
                withLock(async () => {
                  const collected: string[] = [];
                  const entries = await readdir(canonicalRoot, { encoding: "buffer" });
                  const observed = new Set<string>();
                  for (const rawName of entries) {
                    let installationId: string;
                    try {
                      installationId = utf8.decode(rawName);
                    } catch {
                      continue;
                    }
                    if (!idPattern.test(installationId)) continue;
                    observed.add(installationId);
                    if (retained.has(installationId)) continue;
                    // Retain malformed/non-directory lookalikes rather than broadening
                    // startup cleanup beyond directories published by this store.
                    const candidate = join(canonicalRoot, installationId);
                    const info = await lstat(candidate, { bigint: true });
                    if (!info.isDirectory() || info.isSymbolicLink()) continue;
                    await removePublished(installationId);
                    if (removable.has(installationId)) collected.push(installationId);
                  }
                  // A tombstone whose artifact was removed just before the
                  // registry save is safe to prune once this fresh engine has
                  // proved it did not auto-load extensions.
                  for (const installationId of removable)
                    if (!observed.has(installationId)) collected.push(installationId);
                  return Object.freeze(collected);
                }),
              catch: () => fail("Could not collect unreferenced extension artifacts"),
            }),
          ),
        ),
      )
      .pipe(Effect.mapError(() => fail("Could not collect unreferenced extension artifacts")));
  });
  const recoveryState = recoveryStates.get(profileLease);
  if (recoveryState === "running")
    return yield* fail("Extension artifact store initialization is already running");
  if (recoveryState === undefined) {
    recoveryStates.set(profileLease, "running");
    yield* profileLease
      .withWrite(
        Effect.tryPromise({
          try: recoverScratch,
          catch: () => fail("Could not recover private extension staging files"),
        }),
      )
      .pipe(
        Effect.tap(() => Effect.sync(() => recoveryStates.set(profileLease, "complete"))),
        Effect.tapError(() => Effect.sync(() => recoveryStates.delete(profileLease))),
        Effect.mapError(() => fail("Could not recover private extension staging files")),
      );
  }
  return { stage, read, discardUnused, collectBeforeReplay } satisfies ExtensionArtifactStore;
});

/** Production factory. Artifact lifetime is bound to the controller's kernel-held profile lease. */
export const createExtensionArtifactStore = Effect.fn("ExtensionArtifacts.create")(function* (
  options: ExtensionArtifactStoreOptions,
) {
  return yield* makeExtensionArtifactStore(options.profileLease);
});

/** @internal Portable tests only; production callers must use createExtensionArtifactStore. */
export const createExtensionArtifactStoreForTest = Effect.fn("ExtensionArtifacts.createForTest")(
  function* (profileRoot: string, testLimits?: ExtensionArtifactStoreTestOptions) {
    const { profileLease, ...limits } = testLimits ?? {};
    const lease =
      profileLease ??
      ({
        profileRoot,
        assertHeld: Effect.void,
        withWrite: <A, E, R>(operation: Effect.Effect<A, E, R>) => operation,
      } satisfies ProfileWriteLease);
    return yield* makeExtensionArtifactStore(lease, limits);
  },
);
