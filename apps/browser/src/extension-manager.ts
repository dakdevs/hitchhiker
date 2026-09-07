import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Effect, Option, Schema, Semaphore } from "effect";
import { type EngineConnection } from "@hitchhiker/runtime";
import { type ExtensionArtifact, type ExtensionArtifactStore } from "./extension-artifacts.ts";
import { type ProfileWriteLease } from "./profile-write-lease.ts";

const RegistryFile = "extensions.json";
const RegistryLimit = 128 * 1024;
const MaxExtensions = 16;
const InstallationId = /^[a-f0-9]{32}$/;
const Digest = /^[a-f0-9]{64}$/;
const ChromiumId = /^[a-p]{32}$/;

export class ExtensionManagerError extends Schema.TaggedError<ExtensionManagerError>()(
  "ExtensionManagerError",
  { message: Schema.String, restartRequired: Schema.optional(Schema.Boolean) },
) {}

const failure = (message: string, restartRequired = false) =>
  new ExtensionManagerError({ message, ...(restartRequired ? { restartRequired: true } : {}) });

const State = Schema.Literals([
  "prepared",
  "installing",
  "enabled",
  "removing",
  "removed",
  "error",
]);
type ExtensionState = typeof State.Type;
const ErrorIntent = Schema.Literals(["install", "remove"]);
type ErrorIntent = typeof ErrorIntent.Type;
const Artifact = Schema.Struct({
  installationId: Schema.String.check(Schema.isPattern(InstallationId)),
  digest: Schema.String.check(Schema.isPattern(Digest)),
  expectedChromiumId: Schema.String.check(Schema.isPattern(ChromiumId)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  version: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  permissions: Schema.Array(Schema.String.check(Schema.isMaxLength(2048))).check(
    Schema.isMaxLength(256),
  ),
  host_permissions: Schema.Array(Schema.String.check(Schema.isMaxLength(2048))).check(
    Schema.isMaxLength(256),
  ),
  optional_permissions: Schema.Array(Schema.String.check(Schema.isMaxLength(2048))).check(
    Schema.isMaxLength(256),
  ),
  optional_host_permissions: Schema.Array(Schema.String.check(Schema.isMaxLength(2048))).check(
    Schema.isMaxLength(256),
  ),
});
type StoredArtifact = typeof Artifact.Type;
const OperationId = /^[a-f0-9]{32}$/;
const PublicSource = Schema.Struct({
  principal: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  grantId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  operationId: Schema.optional(Schema.String.check(Schema.isPattern(OperationId))),
});
const Source = Schema.Union([Schema.Literal("legacy-local"), PublicSource]);
const StoredV1 = Schema.Struct({
  artifact: Artifact,
  state: State,
  /** Number of replay attempts after a durable installing intent. */
  recoveryAttempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  chromiumId: Schema.optional(Schema.String.check(Schema.isPattern(ChromiumId))),
  error: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  errorIntent: Schema.optional(ErrorIntent),
});
const Stored = Schema.Struct({
  artifact: Artifact,
  source: Source,
  state: State,
  /** Number of replay attempts after a durable installing intent. */
  recoveryAttempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  chromiumId: Schema.optional(Schema.String.check(Schema.isPattern(ChromiumId))),
  error: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  errorIntent: Schema.optional(ErrorIntent),
});
type StoredExtension = typeof Stored.Type;
const RegistrySchema = Schema.Struct({
  version: Schema.Literal(2),
  extensions: Schema.Array(Stored).check(Schema.isMaxLength(MaxExtensions)),
});
const RegistryV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  extensions: Schema.Array(StoredV1).check(Schema.isMaxLength(MaxExtensions)),
});
type Registry = typeof RegistrySchema.Type;
const decodeRegistry = Schema.decodeUnknownOption(RegistrySchema, { onExcessProperty: "error" });
const decodeRegistryV1 = Schema.decodeUnknownOption(RegistryV1Schema, {
  onExcessProperty: "error",
});

export interface ManagedExtension {
  readonly installationId: string;
  readonly digest: string;
  readonly expectedChromiumId: string;
  readonly chromiumId?: string;
  readonly name: string;
  readonly version: string;
  readonly permissions: readonly string[];
  readonly hostPermissions: readonly string[];
  readonly optionalPermissions: readonly string[];
  readonly optionalHostPermissions: readonly string[];
  readonly state: ExtensionState;
  readonly errorIntent?: ErrorIntent;
  readonly status: string;
}
/** Immutable metadata shown in a native local permission review. No filesystem path is exposed. */
export type ExtensionPreview = Omit<ExtensionArtifact, "directory">;
export type OwnedManagedExtension = Omit<ManagedExtension, "status"> & {
  readonly operationId?: string;
};

export interface ExtensionOwner {
  readonly principal: string;
  readonly grantId: string;
  readonly authorize: Effect.Effect<void, unknown>;
}
export interface ExtensionManager {
  /** Stage a local directory and make its immutable permission review durable. */
  readonly previewLocal: (
    sourceDirectory: string,
    owner?: ExtensionOwner,
  ) => Effect.Effect<ExtensionPreview, ExtensionManagerError>;
  readonly prepareOwned: (
    sourceDirectory: string,
    owner: ExtensionOwner,
    operationId: string,
  ) => Effect.Effect<ExtensionPreview, ExtensionManagerError>;
  readonly listOwned: (
    owner: ExtensionOwner,
  ) => Effect.Effect<readonly OwnedManagedExtension[], ExtensionManagerError>;
  /** Trusted coordinator cleanup only; no public adapter may expose this. */
  readonly abandonPrepared: (
    installationId: string,
    digest: string,
    identity: { readonly principal: string; readonly grantId: string },
  ) => Effect.Effect<void, ExtensionManagerError>;
  /** Re-open a persisted, unsubmitted review without accepting a new local path. */
  readonly reviewPrepared: (
    installationId: string,
    digest: string,
    owner?: ExtensionOwner,
  ) => Effect.Effect<ExtensionPreview, ExtensionManagerError>;
  /** Explicit native confirmation only. The exact reviewed artifact identity is required. */
  readonly confirmInstall: (
    installationId: string,
    digest: string,
    owner?: ExtensionOwner,
  ) => Effect.Effect<void, ExtensionManagerError>;
  readonly cancelPreview: (
    installationId: string,
    digest: string,
    owner?: ExtensionOwner,
  ) => Effect.Effect<void, ExtensionManagerError>;
  readonly remove: (
    installationId: string,
    authorize?: Effect.Effect<void, unknown>,
  ) => Effect.Effect<void, ExtensionManagerError>;
  readonly list: () => Effect.Effect<readonly ManagedExtension[], ExtensionManagerError>;
  /** Must run after engine readiness and before persisted browser pages are restored. */
  readonly restoreBeforePages: () => Effect.Effect<void, ExtensionManagerError>;
  /** Called before browser-pipe ownership is irreversibly handed to raw CDP. */
  readonly enterReadOnly: () => Effect.Effect<void, ExtensionManagerError>;
  readonly isReadOnly: () => Effect.Effect<boolean, never>;
}

export interface ExtensionManagerOptions {
  readonly profileRoot: string;
  readonly lease: ProfileWriteLease;
  readonly engine: EngineConnection["Service"];
  readonly artifacts: ExtensionArtifactStore;
}

const storedArtifact = (artifact: ExtensionArtifact): StoredArtifact => ({
  installationId: artifact.installationId,
  digest: artifact.digest,
  expectedChromiumId: artifact.expectedChromiumId,
  name: artifact.name,
  version: artifact.version,
  permissions: [...artifact.permissions],
  host_permissions: [...artifact.host_permissions],
  optional_permissions: [...artifact.optional_permissions],
  optional_host_permissions: [...artifact.optional_host_permissions],
});
const preview = (artifact: ExtensionArtifact): ExtensionPreview => ({
  installationId: artifact.installationId,
  digest: artifact.digest,
  expectedChromiumId: artifact.expectedChromiumId,
  name: artifact.name,
  version: artifact.version,
  permissions: artifact.permissions,
  host_permissions: artifact.host_permissions,
  optional_permissions: artifact.optional_permissions,
  optional_host_permissions: artifact.optional_host_permissions,
});
const display = (stored: StoredExtension): ManagedExtension => ({
  installationId: stored.artifact.installationId,
  digest: stored.artifact.digest,
  expectedChromiumId: stored.artifact.expectedChromiumId,
  ...(stored.chromiumId === undefined ? {} : { chromiumId: stored.chromiumId }),
  name: stored.artifact.name,
  version: stored.artifact.version,
  permissions: stored.artifact.permissions,
  hostPermissions: stored.artifact.host_permissions,
  optionalPermissions: stored.artifact.optional_permissions,
  optionalHostPermissions: stored.artifact.optional_host_permissions,
  state: stored.state,
  ...(stored.errorIntent === undefined ? {} : { errorIntent: stored.errorIntent }),
  status:
    stored.error ??
    (stored.state === "prepared"
      ? "Ready for local permission review"
      : stored.state === "enabled"
        ? "Enabled"
        : stored.state === "removed"
          ? "Removed"
          : stored.state === "removing"
            ? "Removal is pending"
            : stored.state === "installing"
              ? "Installation is being recovered"
              : "Needs attention"),
});
const replace = (registry: Registry, entry: StoredExtension): Registry => ({
  version: 2,
  extensions: [
    ...registry.extensions.filter(
      (item) => item.artifact.installationId !== entry.artifact.installationId,
    ),
    entry,
  ],
});
const definitelyRejected = (error: { readonly code: string }) =>
  error.code === "extension-rejected";

/**
 * Durable desired-state policy for profile-owned unpacked MV3 artifacts. This
 * manager deliberately has no API for arbitrary paths after previewLocal.
 */
export const createExtensionManager = Effect.fn("ExtensionManager.create")(function* (
  options: ExtensionManagerOptions,
) {
  if (!isAbsolute(options.profileRoot)) return yield* failure("Profile root must be absolute");
  if (options.profileRoot !== options.lease.profileRoot)
    return yield* failure("Extension manager must use the controller's canonical profile lease");
  const requestedDirectory = join(options.profileRoot, "hitchhiker-extensions");
  const directory = yield* options.lease.withWrite(
    Effect.tryPromise({
      try: async (): Promise<string> => {
        await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
        const named = await lstat(requestedDirectory, { bigint: true });
        if (
          !named.isDirectory() ||
          named.isSymbolicLink() ||
          named.uid !== BigInt(process.getuid!())
        )
          throw new Error("invalid registry directory");
        const fd = await open(
          requestedDirectory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const before = await fd.stat({ bigint: true });
          if (
            !before.isDirectory() ||
            before.dev !== named.dev ||
            before.ino !== named.ino ||
            before.uid !== BigInt(process.getuid!())
          )
            throw new Error("changed registry directory");
          await fd.chmod(0o700);
          const after = await fd.stat({ bigint: true });
          const current = await lstat(requestedDirectory, { bigint: true });
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            current.dev !== before.dev ||
            current.ino !== before.ino ||
            (after.mode & 0o777n) !== 0o700n
          )
            throw new Error("changed registry directory");
        } finally {
          await fd.close();
        }
        const resolved = await realpath(requestedDirectory);
        if (resolved !== requestedDirectory) throw new Error("redirected registry");
        return resolved;
      },
      catch: () => failure("Could not create the extension registry directory"),
    }),
  );
  const registryPath = join(directory, RegistryFile);
  const serial = yield* Semaphore.make(1);
  let readOnly = false;
  let uncertain = false;
  let restored = false;

  const ensureDirectory = Effect.tryPromise({
    try: async () => {
      const [info, resolved] = await Promise.all([
        lstat(directory, { bigint: true }),
        realpath(directory),
      ]);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        resolved !== directory ||
        info.uid !== BigInt(process.getuid!()) ||
        (info.mode & 0o777n) !== 0o700n
      )
        throw new Error("invalid registry directory");
    },
    catch: () => failure("Extension registry is invalid"),
  });
  const load = Effect.fn("ExtensionManager.load")(function* () {
    yield* ensureDirectory;
    const text = yield* Effect.tryPromise({
      try: async () => {
        try {
          const named = await lstat(registryPath, { bigint: true });
          if (
            !named.isFile() ||
            named.isSymbolicLink() ||
            named.size > BigInt(RegistryLimit) ||
            named.uid !== BigInt(process.getuid!()) ||
            named.nlink !== 1n ||
            (named.mode & 0o777n) !== 0o600n
          )
            throw new Error("invalid registry");
          const fd = await open(registryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const before = await fd.stat({ bigint: true });
            if (
              !before.isFile() ||
              before.dev !== named.dev ||
              before.ino !== named.ino ||
              before.size > BigInt(RegistryLimit) ||
              before.uid !== BigInt(process.getuid!()) ||
              before.nlink !== 1n ||
              (before.mode & 0o777n) !== 0o600n
            )
              throw new Error("changed registry");
            const buffer = Buffer.alloc(Number(before.size) + 1);
            let bytesRead = 0;
            while (bytesRead < buffer.length) {
              const result = await fd.read(buffer, bytesRead, buffer.length - bytesRead, null);
              if (result.bytesRead === 0) break;
              bytesRead += result.bytesRead;
            }
            const after = await fd.stat({ bigint: true });
            if (
              bytesRead > RegistryLimit ||
              after.dev !== before.dev ||
              after.ino !== before.ino ||
              after.size !== before.size ||
              after.mtimeNs !== before.mtimeNs ||
              after.ctimeNs !== before.ctimeNs ||
              after.nlink !== 1n ||
              after.uid !== BigInt(process.getuid!()) ||
              (after.mode & 0o777n) !== 0o600n
            )
              throw new Error("changed registry");
            return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
          } finally {
            await fd.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      catch: () => failure("Extension registry is invalid"),
    });
    if (text === undefined) return { version: 2, extensions: [] } satisfies Registry;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () => failure("Extension registry is invalid"),
    });
    const decoded = decodeRegistry(parsed);
    const legacy = decodeRegistryV1(parsed);
    const registry = Option.isSome(decoded)
      ? decoded.value
      : Option.isSome(legacy)
        ? {
            version: 2 as const,
            extensions: legacy.value.extensions.map((entry) => ({
              ...entry,
              source: "legacy-local" as const,
            })),
          }
        : undefined;
    const operationKeys =
      registry?.extensions.flatMap((entry) =>
        entry.source !== "legacy-local" && entry.source.operationId !== undefined
          ? [
              JSON.stringify([
                entry.source.principal,
                entry.source.grantId,
                entry.source.operationId,
              ]),
            ]
          : [],
      ) ?? [];
    if (
      !registry ||
      new Set(registry.extensions.map((item) => item.artifact.installationId)).size !==
        registry.extensions.length ||
      new Set(operationKeys).size !== operationKeys.length
    )
      return yield* failure("Extension registry is invalid");
    return registry;
  });
  const save = (registry: Registry) =>
    Effect.tryPromise({
      try: async () => {
        const text = JSON.stringify(registry);
        if (Buffer.byteLength(text, "utf8") > RegistryLimit) throw new Error("registry too large");
        await ensureDirectory.pipe(Effect.runPromise);
        const temporary = `${registryPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        const fd = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await fd.writeFile(text, "utf8");
          await fd.chmod(0o600);
          await fd.sync();
        } finally {
          await fd.close();
        }
        try {
          await rename(temporary, registryPath);
          const root = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            await root.sync();
          } finally {
            await root.close();
          }
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
      },
      catch: () => failure("Could not persist extension registry"),
    });
  function leaseError<A>(
    effect: Effect.Effect<
      A,
      ExtensionManagerError | import("./profile-write-lease.ts").ProfileWriteLeaseError
    >,
  ) {
    return effect.pipe(
      Effect.mapError((error) =>
        error instanceof ExtensionManagerError ? error : failure(error.message),
      ),
    );
  }
  function command<A>(operation: Effect.Effect<A, ExtensionManagerError>) {
    return leaseError(
      Semaphore.withPermits(
        serial,
        1,
      )(
        options.lease.withWrite(
          Effect.suspend(() =>
            readOnly || uncertain
              ? Effect.fail(
                  failure(
                    readOnly
                      ? "Extension management is read-only while raw CDP is active"
                      : "Extension state is uncertain; restart before further changes",
                    uncertain,
                  ),
                )
              : operation,
          ),
        ),
      ),
    );
  }
  /** Once Chromium may have acted, an unwritten registry is an unsafe ambiguity. */
  function persistAfterBrowser<A>(operation: Effect.Effect<A, ExtensionManagerError>) {
    return operation.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          uncertain = true;
        }).pipe(
          Effect.andThen(
            Effect.fail(failure(`Extension state could not be persisted: ${error.message}`, true)),
          ),
        ),
      ),
    );
  }
  const lookup = (registry: Registry, installationId: string, digest?: string) => {
    const entry = registry.extensions.find(
      (item) => item.artifact.installationId === installationId,
    );
    if (!entry || (digest !== undefined && entry.artifact.digest !== digest)) return undefined;
    return entry;
  };
  const decodePublicSource = Schema.decodeUnknownOption(PublicSource, {
    onExcessProperty: "error",
  });
  const ownerSource = (owner: ExtensionOwner | undefined) =>
    owner === undefined
      ? Option.none()
      : decodePublicSource({ principal: owner.principal, grantId: owner.grantId });
  const access = (entry: StoredExtension, owner: ExtensionOwner | undefined) => {
    if (entry.source === "legacy-local") return owner === undefined;
    const source = ownerSource(owner);
    return (
      Option.isSome(source) &&
      entry.source.principal === source.value.principal &&
      entry.source.grantId === source.value.grantId
    );
  };
  const authorizeOwner = (owner: ExtensionOwner | undefined) =>
    owner === undefined
      ? Effect.void
      : owner.authorize.pipe(
          Effect.mapError(() => failure("Extension installation is not authorized")),
        );
  const verifyArtifact = (entry: StoredExtension) =>
    options.artifacts.read(entry.artifact.installationId, entry.artifact.digest).pipe(
      Effect.mapError((error) => failure(`Extension artifact is unavailable: ${error.message}`)),
      Effect.flatMap((artifact) =>
        artifact.expectedChromiumId === entry.artifact.expectedChromiumId
          ? Effect.succeed(artifact)
          : Effect.fail(failure("Extension artifact identity changed")),
      ),
    );

  const previewLocal = (sourceDirectory: string, owner?: ExtensionOwner, operationId?: string) =>
    command(
      Effect.gen(function* () {
        // Validate the durable registry before copying an untrusted tree.
        const registry = yield* load();
        if (registry.extensions.length >= MaxExtensions)
          return yield* failure("The extension registry is full");
        const source = ownerSource(owner);
        if (
          (owner !== undefined && Option.isNone(source)) ||
          (operationId !== undefined && (!OperationId.test(operationId) || owner === undefined))
        )
          return yield* failure("Invalid extension owner");
        if (
          Option.isSome(source) &&
          operationId !== undefined &&
          registry.extensions.some(
            (entry) =>
              entry.source !== "legacy-local" &&
              entry.source.principal === source.value.principal &&
              entry.source.grantId === source.value.grantId &&
              entry.source.operationId === operationId,
          )
        )
          return yield* failure("That extension operation already exists");
        yield* authorizeOwner(owner);
        const artifact = yield* options.artifacts
          .stage(sourceDirectory)
          .pipe(Effect.mapError((error) => failure(error.message)));
        yield* authorizeOwner(owner).pipe(
          Effect.catch((error) =>
            options.artifacts.discardUnused(artifact.installationId, artifact.digest).pipe(
              Effect.mapError(() => error),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        const entry: StoredExtension = {
          artifact: storedArtifact(artifact),
          source: Option.isSome(source)
            ? { ...source.value, ...(operationId === undefined ? {} : { operationId }) }
            : "legacy-local",
          state: "prepared",
          recoveryAttempts: 0,
        };
        yield* save(replace(registry, entry)).pipe(
          Effect.catch((error) =>
            options.artifacts.discardUnused(artifact.installationId, artifact.digest).pipe(
              Effect.mapError((discardError) =>
                failure(
                  `Could not persist extension review and cleanup failed: ${discardError.message}`,
                ),
              ),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        return preview(artifact);
      }),
    );
  const prepareOwned = (sourceDirectory: string, owner: ExtensionOwner, operationId: string) => {
    const source = ownerSource(owner);
    if (Option.isNone(source) || typeof operationId !== "string" || !OperationId.test(operationId))
      return Effect.fail(failure("Invalid extension owner"));
    return previewLocal(sourceDirectory, owner, operationId);
  };
  const ownedDisplay = (entry: StoredExtension): OwnedManagedExtension => {
    const { status: _status, ...safe } = display(entry);
    return {
      ...safe,
      ...(entry.source !== "legacy-local" && entry.source.operationId !== undefined
        ? { operationId: entry.source.operationId }
        : {}),
    };
  };
  const listOwned = (owner: ExtensionOwner) =>
    leaseError(
      Semaphore.withPermits(
        serial,
        1,
      )(
        options.lease.withWrite(
          Effect.gen(function* () {
            const source = ownerSource(owner);
            if (Option.isNone(source)) return yield* failure("Invalid extension owner");
            yield* authorizeOwner(owner);
            const registry = yield* load();
            yield* authorizeOwner(owner);
            return registry.extensions
              .filter(
                (entry) =>
                  entry.source !== "legacy-local" &&
                  entry.source.principal === source.value.principal &&
                  entry.source.grantId === source.value.grantId,
              )
              .map(ownedDisplay);
          }),
        ),
      ),
    );
  // Trusted coordinator-only cleanup for a never-admitted prepared record. It intentionally
  // accepts no live authorization effect: a revoked owner must still lose its pending artifact.
  const abandonPrepared = (
    installationId: string,
    digest: string,
    identity: { readonly principal: string; readonly grantId: string },
  ) =>
    command(
      Effect.gen(function* () {
        const source = decodePublicSource(identity);
        if (!InstallationId.test(installationId) || !Digest.test(digest) || Option.isNone(source))
          return yield* failure("Invalid extension identity");
        const registry = yield* load();
        const entry = lookup(registry, installationId, digest);
        if (
          !entry ||
          entry.state !== "prepared" ||
          entry.source === "legacy-local" ||
          entry.source.principal !== source.value.principal ||
          entry.source.grantId !== source.value.grantId
        )
          return yield* failure("Only the exact public prepared record may be abandoned");
        yield* save({
          version: 2,
          extensions: registry.extensions.filter((item) => item !== entry),
        });
        yield* options.artifacts
          .discardUnused(installationId, digest)
          .pipe(Effect.mapError((error) => failure(error.message)));
      }),
    );
  const reviewPrepared = (installationId: string, digest: string, owner?: ExtensionOwner) =>
    command(
      Effect.gen(function* () {
        if (!InstallationId.test(installationId) || !Digest.test(digest))
          return yield* failure("Invalid extension identity");
        const entry = lookup(yield* load(), installationId, digest);
        if (
          !entry ||
          !access(entry, owner) ||
          (entry.state !== "prepared" &&
            !(entry.state === "error" && entry.errorIntent === "install"))
        )
          return yield* failure("That extension is not awaiting a local install review");
        yield* authorizeOwner(owner);
        const artifact = yield* verifyArtifact(entry);
        yield* authorizeOwner(owner);
        return preview(artifact);
      }),
    );
  const confirmInstall = (installationId: string, digest: string, owner?: ExtensionOwner) =>
    command(
      Effect.gen(function* () {
        if (!InstallationId.test(installationId) || !Digest.test(digest))
          return yield* failure("Invalid extension identity");
        const registry = yield* load();
        const entry = lookup(registry, installationId, digest);
        if (
          !entry ||
          !access(entry, owner) ||
          (entry.state !== "prepared" &&
            !(entry.state === "error" && entry.errorIntent === "install"))
        )
          return yield* failure("That reviewed extension is no longer ready to install");
        const artifact = yield* verifyArtifact(entry);
        yield* authorizeOwner(owner);
        const installing: StoredExtension = {
          ...entry,
          state: "installing",
          recoveryAttempts: 0,
          error: undefined,
          errorIntent: undefined,
        };
        yield* save(replace(registry, installing));
        const actual = yield* options.engine.loadUnpacked(artifact.directory).pipe(
          Effect.catch((error) => {
            if (definitelyRejected(error)) {
              const rejected: StoredExtension = {
                ...installing,
                state: "error",
                errorIntent: "install",
                error: "Chromium rejected the extension installation",
              };
              return save(replace(registry, rejected)).pipe(
                Effect.andThen(Effect.fail(failure(rejected.error!))),
              );
            }
            return Effect.sync(() => {
              uncertain = true;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  failure(`Extension install outcome is uncertain: ${error.message}`, true),
                ),
              ),
            );
          }),
        );
        if (actual !== entry.artifact.expectedChromiumId) {
          uncertain = true;
          return yield* failure(
            "Chromium returned an unexpected extension identity; restart before further changes",
            true,
          );
        }
        yield* persistAfterBrowser(
          save(
            replace(installing ? replace(registry, installing) : registry, {
              ...installing,
              state: "enabled",
              chromiumId: actual,
              error: undefined,
            }),
          ),
        );
      }),
    );
  const cancelPreview = (installationId: string, digest: string, owner?: ExtensionOwner) =>
    command(
      Effect.gen(function* () {
        if (!InstallationId.test(installationId) || !Digest.test(digest))
          return yield* failure("Invalid extension identity");
        const registry = yield* load();
        const entry = lookup(registry, installationId, digest);
        if (!entry || !access(entry, owner) || entry.state !== "prepared")
          return yield* failure("Only an unsubmitted permission review can be cancelled");
        yield* authorizeOwner(owner);
        yield* save({
          version: 2,
          extensions: registry.extensions.filter((item) => item !== entry),
        });
        // Registry removal is the durable decision. If cleanup fails or the
        // controller crashes here, store-owned orphan collection handles it before
        // a future replay; this record must never become reviewable again.
        yield* options.artifacts
          .discardUnused(installationId, digest)
          .pipe(
            Effect.mapError((error) =>
              failure(
                `Permission review was cancelled but artifact cleanup is pending: ${error.message}`,
              ),
            ),
          );
      }),
    );
  const remove = (installationId: string, authorize: Effect.Effect<void, unknown> = Effect.void) =>
    command(
      Effect.gen(function* () {
        if (!InstallationId.test(installationId))
          return yield* failure("Invalid extension identity");
        const registry = yield* load();
        const entry = lookup(registry, installationId);
        if (!entry || entry.state === "removed")
          return yield* failure("Extension is not installed");
        if (entry.state === "prepared")
          return yield* failure("Cancel the unsubmitted permission review instead");
        // Recheck caller authority after waiting for both the manager and profile lease.
        // Once admitted, the lease preserves the durable removal transaction on cancellation.
        yield* authorize.pipe(
          Effect.mapError(() => failure("Extension removal is not authorized")),
        );
        const removing: StoredExtension = {
          ...entry,
          state: "removing",
          error: undefined,
          errorIntent: undefined,
        };
        yield* save(replace(registry, removing));
        const id = entry.chromiumId ?? entry.artifact.expectedChromiumId;
        yield* options.engine.uninstall(id).pipe(
          Effect.catch((error) => {
            if (definitelyRejected(error)) {
              const rejected: StoredExtension = {
                ...removing,
                state: "error",
                errorIntent: "remove",
                error: "Chromium rejected the extension removal",
              };
              return save(replace(registry, rejected)).pipe(
                Effect.andThen(Effect.fail(failure(rejected.error!))),
              );
            }
            return Effect.sync(() => {
              uncertain = true;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  failure(`Extension removal outcome is uncertain: ${error.message}`, true),
                ),
              ),
            );
          }),
        );
        yield* persistAfterBrowser(
          save(
            replace(replace(registry, removing), {
              ...removing,
              state: "removed",
              error: undefined,
            }),
          ),
        );
      }),
    );
  const list = () =>
    leaseError(
      Semaphore.withPermits(
        serial,
        1,
      )(
        options.lease.withWrite(
          load().pipe(Effect.map((registry) => registry.extensions.map(display))),
        ),
      ),
    );
  const restoreProgram = Effect.gen(function* () {
    let latest = yield* load();
    // This runs only after a fresh engine is ready and before any artifact
    // path is loaded. Pinned CEF does not auto-load unpacked extensions, so a
    // durable remove intent has no active worker in this engine to unload.
    // Converge it before the artifact store collects the tombstone.
    if (
      latest.extensions.some(
        (entry) =>
          entry.state === "removing" || (entry.state === "error" && entry.errorIntent === "remove"),
      )
    ) {
      latest = {
        version: 2,
        extensions: latest.extensions.map((entry) =>
          entry.state === "removing" || (entry.state === "error" && entry.errorIntent === "remove")
            ? {
                ...entry,
                state: "removed" as const,
                error: undefined,
                errorIntent: undefined,
              }
            : entry,
        ),
      };
      yield* save(latest);
    }
    // A fresh engine has not received any artifact path yet. The store owns
    // collection so artifacts are never traversed or deleted here.
    const collected = yield* options.artifacts
      .collectBeforeReplay(
        latest.extensions
          .filter((entry) => entry.state !== "removed")
          .map((entry) => entry.artifact.installationId),
        latest.extensions
          .filter((entry) => entry.state === "removed")
          .map((entry) => entry.artifact.installationId),
      )
      .pipe(
        Effect.mapError((error) =>
          failure(`Could not prepare extension artifacts: ${error.message}`),
        ),
      );
    const collectedIds = new Set(collected);
    if (
      latest.extensions.some(
        (entry) => entry.state === "removed" && collectedIds.has(entry.artifact.installationId),
      )
    ) {
      latest = {
        version: 2,
        extensions: latest.extensions.filter(
          (entry) => entry.state !== "removed" || !collectedIds.has(entry.artifact.installationId),
        ),
      };
      yield* save(latest);
    }
    // Snapshot IDs only; `latest` is updated after every durable transition.
    for (const installationId of latest.extensions.map((entry) => entry.artifact.installationId)) {
      const entry = lookup(latest, installationId);
      if (!entry) continue;
      if (entry.state === "installing" && entry.recoveryAttempts >= 1) {
        latest = replace(latest, {
          ...entry,
          state: "error",
          errorIntent: "install",
          error:
            "Installation could not be confirmed after recovery; explicit local retry is required",
        });
        yield* save(latest);
        continue;
      }
      if (
        entry.state !== "enabled" &&
        !(entry.state === "installing" && entry.recoveryAttempts === 0)
      )
        continue;
      const verified = yield* verifyArtifact(entry).pipe(
        Effect.map((artifact) => ({ ok: true as const, artifact })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (!verified.ok) {
        latest = replace(latest, {
          ...entry,
          state: "error",
          errorIntent: "install",
          error: verified.error.message,
        });
        yield* save(latest);
        continue;
      }
      const artifact = verified.artifact;
      // Both recovery and ordinary enabled replay become a durable submitting
      // intent before Chromium can observe the artifact path.
      const submitting: StoredExtension = {
        ...entry,
        state: "installing",
        recoveryAttempts: entry.state === "installing" ? 1 : 0,
        error: undefined,
      };
      latest = replace(latest, submitting);
      yield* save(latest);
      const loaded = yield* options.engine.loadUnpacked(artifact.directory).pipe(
        Effect.map((id) => ({ ok: true as const, id })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (!loaded.ok) {
        if (definitelyRejected(loaded.error)) {
          latest = replace(latest, {
            ...submitting,
            state: "error",
            errorIntent: "install",
            error: "Chromium rejected the extension restore",
          });
          yield* save(latest);
          continue;
        }
        uncertain = true;
        return yield* failure(
          `Extension restore outcome is uncertain: ${loaded.error.message}`,
          true,
        );
      }
      const actual = loaded.id;
      if (actual !== entry.artifact.expectedChromiumId) {
        uncertain = true;
        return yield* failure("Extension restore returned an unexpected identity", true);
      }
      latest = replace(latest, {
        ...submitting,
        state: "enabled",
        chromiumId: actual,
        error: undefined,
      });
      yield* persistAfterBrowser(save(latest));
    }
  });
  const restoreBeforePages = () =>
    command(
      Effect.suspend(() =>
        restored
          ? Effect.fail(failure("Extension startup recovery has already run"))
          : Effect.sync(() => {
              restored = true;
            }).pipe(Effect.andThen(restoreProgram)),
      ),
    );
  const enterReadOnly = () =>
    leaseError(
      Semaphore.withPermits(
        serial,
        1,
      )(
        options.lease.withWrite(
          Effect.suspend(() =>
            uncertain
              ? Effect.fail(
                  failure("Extension state is uncertain; restart before raw CDP handoff", true),
                )
              : Effect.sync(() => {
                  readOnly = true;
                }),
          ),
        ),
      ),
    );
  const isReadOnly = () => Effect.sync(() => readOnly);
  return {
    previewLocal,
    prepareOwned,
    listOwned,
    abandonPrepared,
    reviewPrepared,
    confirmInstall,
    cancelPreview,
    remove,
    list,
    restoreBeforePages,
    enterReadOnly,
    isReadOnly,
  } satisfies ExtensionManager;
});
