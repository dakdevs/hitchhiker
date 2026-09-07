import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Capability, CapabilityGrant } from "@hitchhiker/core";
import {
  InstalledPluginPlanInputSchema,
  type InstalledPluginPlan,
  type InstalledPluginPlanInput,
  type ManagedGrantStoreApi,
} from "@hitchhiker/runtime";
import { Effect, Option, Predicate, Schema, Semaphore } from "effect";
import {
  DefaultTabModelPluginId,
  DefaultTabPinsPluginId,
  type DefaultPluginStateMigration,
  type DefaultPluginStateStorage,
  type DefaultTabModelState,
  type DefaultTabPinsState,
} from "./default-plugin-state-migration.ts";
import type { PluginArtifactStore } from "./plugin-artifacts.ts";
import type { PluginManager } from "./plugin-manager.ts";
import type { ProfileWriteLease } from "./profile-write-lease.ts";

const JournalId = "default-browser-v1";
const JournalVersion = 1;
const JournalLimit = 64 * 1024;
const coordinatorLocks = new Map<string, Semaphore.Semaphore>();
const poisonedProfiles = new Set<string>();
const ids = [
  "default-tab-model",
  "default-tab-pins",
  "default-browser-layout",
  "default-sidebar-tabs",
  "default-top-tabs",
] as const;
type DefaultPluginId = (typeof ids)[number];
type AbandonReason = "profile-customized" | "bootstrap-state-diverged";

const capabilities = {
  "default-tab-model": ["pages.list", "pages.manage", "storage.local"],
  "default-tab-pins": ["pages.list", "storage.local"],
  "default-browser-layout": ["ui.compose", "configuration.read"],
  "default-sidebar-tabs": [
    "ui.compose",
    "pages.list",
    "pages.manage",
    "storage.local",
    "configuration.read",
    "configuration.write",
    "plugins.read",
    "plugins.manage",
  ],
  "default-top-tabs": [
    "ui.compose",
    "pages.list",
    "pages.manage",
    "storage.local",
    "configuration.read",
    "configuration.write",
    "plugins.read",
    "plugins.manage",
  ],
} satisfies Readonly<Record<DefaultPluginId, readonly Capability[]>>;

// Previously published pending journals must finish with their frozen authority, never upgrade it.
const legacyCapabilities = {
  "default-tab-model": ["pages.list", "pages.manage", "storage.local"],
  "default-tab-pins": ["pages.list", "storage.local"],
  "default-browser-layout": ["ui.compose", "configuration.write"],
  "default-sidebar-tabs": [
    "ui.compose",
    "pages.list",
    "pages.manage",
    "storage.local",
    "configuration.write",
  ],
  "default-top-tabs": [
    "ui.compose",
    "pages.list",
    "pages.manage",
    "storage.local",
    "configuration.write",
  ],
} satisfies Readonly<Record<DefaultPluginId, readonly Capability[]>>;

export class DefaultPluginBootstrapError extends Schema.TaggedError<DefaultPluginBootstrapError>()(
  "DefaultPluginBootstrapError",
  { message: Schema.String },
) {}
const fail = (message: string) => new DefaultPluginBootstrapError({ message });

export interface DefaultPluginBundle {
  readonly packages: readonly { readonly manifest: unknown; readonly code: string }[];
  readonly plans: {
    readonly sidebar: InstalledPluginPlanInput;
    readonly top: InstalledPluginPlanInput;
  };
}

export interface DefaultPluginBootstrapOptions {
  readonly profileRoot: string;
  readonly lease: ProfileWriteLease;
  readonly manager: PluginManager;
  readonly artifacts: PluginArtifactStore;
  readonly grants: ManagedGrantStoreApi;
  readonly storage: DefaultPluginStateStorage;
  readonly seed: DefaultPluginStateMigration;
  readonly placement: "sidebar" | "top";
  /** Called only when an eligible profile has no bootstrap journal. */
  readonly loadBundle: Effect.Effect<DefaultPluginBundle, unknown>;
  readonly safeMode?: boolean;
  readonly developerPlugin?: boolean;
}

const planFor = (placement: "sidebar" | "top"): InstalledPluginPlanInput => {
  const presenter = `default-${placement}-tabs`;
  return {
    enabled: [DefaultTabModelPluginId, DefaultTabPinsPluginId, "default-browser-layout", presenter],
    composition: {
      layout: "default-browser-layout",
      slots: ["tabs", "toolbar", "content"].map((key) => ({
        key,
        contributions: [{ pluginId: presenter, id: key }],
      })),
    },
    serviceBindings: [
      {
        consumer: presenter,
        dependency: "model",
        provider: DefaultTabModelPluginId,
        service: "model",
      },
      {
        consumer: presenter,
        dependency: "pins",
        provider: DefaultTabPinsPluginId,
        service: "pins",
      },
      {
        consumer: presenter,
        dependency: "layout",
        provider: "default-browser-layout",
        service: "layout",
      },
    ],
  } satisfies InstalledPluginPlanInput;
};

const PageIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/));
const PageIdsSchema = Schema.Array(PageIdSchema).check(Schema.isMaxLength(128), Schema.isUnique());
const SeedSchema = Schema.Struct({
  model: Schema.Struct({
    version: Schema.Literal(1),
    pagesRevision: Schema.Literal(0),
    selection: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("new-page") }),
      Schema.Struct({ kind: Schema.Literal("page"), pageId: PageIdSchema }),
    ]).annotate({ parseOptions: { onExcessProperty: "error" } }),
    pageOrder: PageIdsSchema,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  pins: Schema.Struct({
    version: Schema.Literal(1),
    pagesRevision: Schema.Literal(0),
    pinnedPageIds: PageIdsSchema,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const CapabilitySchema = Schema.Literals([
  "pages.list",
  "pages.manage",
  "ui.compose",
  "configuration.read",
  "configuration.write",
  "plugins.read",
  "plugins.manage",
  "storage.local",
]);
const DefaultPluginIdSchema = Schema.Literals(ids);
const RevisionSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const DescriptorSchema = Schema.Struct({
  id: DefaultPluginIdSchema,
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  capabilities: Schema.Array(CapabilitySchema).check(Schema.isMaxLength(8), Schema.isUnique()),
  grantKey: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const PendingSchema = Schema.Struct({
  version: Schema.Literal(JournalVersion),
  id: Schema.Literal(JournalId),
  state: Schema.Literal("pending"),
  placement: Schema.Literals(["sidebar", "top"]),
  artifacts: Schema.Array(DescriptorSchema).check(Schema.isMaxLength(ids.length)),
  plan: InstalledPluginPlanInputSchema,
  seed: SeedSchema,
  expectedRevision: RevisionSchema,
  installedPrefix: Schema.Array(DefaultPluginIdSchema).check(Schema.isMaxLength(ids.length)),
  storagePresent: Schema.Struct({ model: Schema.Boolean, pins: Schema.Boolean }).annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const JournalSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(JournalVersion),
    id: Schema.Literal(JournalId),
    state: Schema.Literal("completed"),
    revision: RevisionSchema,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    version: Schema.Literal(JournalVersion),
    id: Schema.Literal(JournalId),
    state: Schema.Literal("abandoned"),
    reason: Schema.Literals(["profile-customized", "bootstrap-state-diverged"]),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  PendingSchema,
]).annotate({ parseOptions: { onExcessProperty: "error" } });

type Journal = typeof JournalSchema.Type;
type Pending = typeof PendingSchema.Type;
type Descriptor = typeof DescriptorSchema.Type;

const decodeSeed = Schema.decodeUnknownOption(SeedSchema, { onExcessProperty: "error" });
const decodeJournalSchema = Schema.decodeUnknownOption(JournalSchema, {
  onExcessProperty: "error",
});
const BundleManifestSchema = Schema.Struct({
  id: DefaultPluginIdSchema,
  capabilities: Schema.Array(CapabilitySchema),
});
const decodeBundleManifest = Schema.decodeUnknownOption(BundleManifestSchema);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const sameMembers = <A extends string>(left: readonly A[], right: readonly A[]) =>
  left.length === right.length && left.every((value) => right.includes(value));
const journalPath = (root: string) => join(root, "hitchhiker-plugins", "default-bootstrap.json");
const isMissing = (error: unknown) =>
  Predicate.isObject(error) && "code" in error && error.code === "ENOENT";

const decodeJournal = (value: unknown): Journal | undefined => {
  const decoded = decodeJournalSchema(value);
  if (Option.isNone(decoded)) return undefined;
  const journal = decoded.value;
  if (journal.state === "completed")
    return journal.revision === ids.length + 1 ? journal : undefined;
  if (journal.state === "abandoned") return journal;
  if (
    journal.artifacts.length !== ids.length ||
    !journal.artifacts.every(
      (descriptor, index) =>
        descriptor.id === ids[index] &&
        descriptor.grantKey === `default-bootstrap/1/${descriptor.id}`,
    ) ||
    ![capabilities, legacyCapabilities].some((cohort) =>
      journal.artifacts.every((descriptor) => same(descriptor.capabilities, cohort[descriptor.id])),
    ) ||
    !same(journal.plan, planFor(journal.placement)) ||
    journal.expectedRevision !== journal.installedPrefix.length ||
    !journal.installedPrefix.every((id, index) => id === ids[index]) ||
    ((journal.storagePresent.model || journal.storagePresent.pins) &&
      journal.installedPrefix.length !== ids.length) ||
    (journal.storagePresent.pins && !journal.storagePresent.model)
  )
    return undefined;
  return journal;
};

const validateJournalDirectory = async (root: string, directory: string) => {
  const [rootPath, named, directoryPath] = await Promise.all([
    realpath(root),
    lstat(directory),
    realpath(directory),
  ]);
  if (
    !named.isDirectory() ||
    named.isSymbolicLink() ||
    (named.mode & 0o077) !== 0 ||
    directoryPath !== join(rootPath, "hitchhiker-plugins")
  )
    throw fail("Bootstrap journal directory is invalid");
  return { dev: named.dev, ino: named.ino };
};

const readJournal = (root: string) =>
  Effect.tryPromise({
    try: async (): Promise<Journal | undefined> => {
      const path = journalPath(root);
      const directory = dirname(path);
      let directoryIdentity: { readonly dev: number; readonly ino: number };
      try {
        directoryIdentity = await validateJournalDirectory(root, directory);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      let named;
      try {
        named = await lstat(path);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1 ||
        (named.mode & 0o077) !== 0 ||
        named.size > JournalLimit
      )
        throw fail("Bootstrap journal is invalid");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.dev !== named.dev ||
          before.ino !== named.ino ||
          before.size !== named.size ||
          before.size > JournalLimit
        )
          throw fail("Bootstrap journal is invalid");
        const bytes = Buffer.alloc(JournalLimit + 1);
        let length = 0;
        while (length < bytes.length) {
          const part = await file.read(bytes, length, bytes.length - length, null);
          if (part.bytesRead === 0) break;
          length += part.bytesRead;
        }
        const [after, current, currentDirectory, directoryPath, rootPath] = await Promise.all([
          file.stat(),
          lstat(path),
          lstat(directory),
          realpath(directory),
          realpath(root),
        ]);
        if (
          length > JournalLimit ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.nlink !== 1 ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          !currentDirectory.isDirectory() ||
          currentDirectory.isSymbolicLink() ||
          currentDirectory.dev !== directoryIdentity.dev ||
          currentDirectory.ino !== directoryIdentity.ino ||
          directoryPath !== join(rootPath, "hitchhiker-plugins")
        )
          throw fail("Bootstrap journal changed while reading");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
        const raw: unknown = JSON.parse(text);
        const journal = decodeJournal(raw);
        if (!journal) throw fail("Bootstrap journal is invalid");
        return journal;
      } finally {
        await file.close();
      }
    },
    catch: (error) =>
      error instanceof DefaultPluginBootstrapError
        ? error
        : fail("Could not read bootstrap journal"),
  });

const writeJournal = (root: string, lease: ProfileWriteLease, journal: Journal) => {
  let commitUncertain = false;
  let writeCompleted = false;
  return lease
    .withWrite(
      Effect.uninterruptible(
        Effect.tryPromise({
          try: async () => {
            if (poisonedProfiles.has(root)) throw fail("Bootstrap journal requires restart");
            const serialized = JSON.stringify(journal);
            if (Buffer.byteLength(serialized, "utf8") > JournalLimit)
              throw fail("Bootstrap journal exceeds 64 KiB");
            const path = journalPath(root);
            const directory = dirname(path);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const directoryIdentity = await validateJournalDirectory(root, directory);
            try {
              const existing = await lstat(path);
              if (
                !existing.isFile() ||
                existing.isSymbolicLink() ||
                existing.nlink !== 1 ||
                (existing.mode & 0o077) !== 0
              )
                throw fail("Bootstrap journal is invalid");
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
            let temporary = join(
              directory,
              `.default-bootstrap-${process.pid}-${crypto.randomUUID()}`,
            );
            try {
              const file = await open(
                temporary,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
              );
              try {
                await file.writeFile(serialized, "utf8");
                await file.sync();
              } finally {
                await file.close();
              }
              const beforeRename = await lstat(directory);
              if (
                !beforeRename.isDirectory() ||
                beforeRename.isSymbolicLink() ||
                beforeRename.dev !== directoryIdentity.dev ||
                beforeRename.ino !== directoryIdentity.ino
              )
                throw fail("Bootstrap journal directory changed");
              commitUncertain = true;
              await rename(temporary, path);
              temporary = "";
              const committed = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const stat = await committed.stat();
                if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
                  throw fail("Bootstrap journal is invalid");
              } finally {
                await committed.close();
              }
              const directoryFile = await open(
                directory,
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
              );
              try {
                const current = await directoryFile.stat();
                if (
                  !current.isDirectory() ||
                  current.dev !== directoryIdentity.dev ||
                  current.ino !== directoryIdentity.ino
                )
                  throw fail("Bootstrap journal directory changed");
                await directoryFile.sync();
              } finally {
                await directoryFile.close();
              }
              writeCompleted = true;
            } finally {
              if (temporary !== "") await rm(temporary, { force: true });
            }
          },
          catch: (error) => {
            if (commitUncertain) poisonedProfiles.add(root);
            return error instanceof DefaultPluginBootstrapError
              ? error
              : fail("Could not write bootstrap journal");
          },
        }),
      ),
    )
    .pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (writeCompleted) poisonedProfiles.add(root);
        }),
      ),
    );
};

const abandon = (options: DefaultPluginBootstrapOptions, reason: AbandonReason) =>
  writeJournal(options.profileRoot, options.lease, {
    version: JournalVersion,
    id: JournalId,
    state: "abandoned",
    reason,
  });

const validBundle = (bundle: DefaultPluginBundle) =>
  bundle.packages.length === ids.length &&
  bundle.packages.every((item, index) => {
    const manifest = decodeBundleManifest(item.manifest);
    return (
      Option.isSome(manifest) &&
      manifest.value.id === ids[index] &&
      same(manifest.value.capabilities, capabilities[manifest.value.id]) &&
      typeof item.code === "string"
    );
  }) &&
  same(bundle.plans.sidebar, planFor("sidebar")) &&
  same(bundle.plans.top, planFor("top"));

const verifyFrozenArtifacts = Effect.fn("DefaultPluginBootstrap.verifyArtifacts")(function* (
  artifacts: PluginArtifactStore,
  descriptors: readonly Descriptor[],
) {
  for (const descriptor of descriptors) {
    const artifact = yield* artifacts
      .read(descriptor.hash)
      .pipe(Effect.mapError((error) => fail(error.message)));
    if (
      artifact.hash !== descriptor.hash ||
      artifact.manifest.id !== descriptor.id ||
      !same(artifact.manifest.capabilities, descriptor.capabilities)
    )
      return yield* fail("Frozen default artifact is invalid");
  }
});

const ensureManagedGrants = Effect.fn("DefaultPluginBootstrap.ensureGrants")(function* (
  grants: ManagedGrantStoreApi,
  descriptors: readonly Descriptor[],
) {
  const ensured: CapabilityGrant[] = [];
  for (const descriptor of descriptors) {
    const grant = yield* grants
      .ensureManaged(descriptor.grantKey, {
        principal: descriptor.id,
        profileId: "default",
        capabilities: descriptor.capabilities,
        origins: [],
      })
      .pipe(Effect.mapError((error) => fail(error.message)));
    if (
      grant.principal !== descriptor.id ||
      grant.profileId !== "default" ||
      grant.origins.length !== 0 ||
      grant.expiresAt !== undefined ||
      grant.revokedAt !== undefined ||
      !sameMembers(grant.capabilities, descriptor.capabilities)
    )
      return yield* fail("Managed default grant is invalid");
    ensured.push(grant);
  }
  return ensured;
});

const installationsMatch = Effect.fn("DefaultPluginBootstrap.inspectInstallations")(function* (
  manager: PluginManager,
  pending: Pending,
  grants: readonly CapabilityGrant[],
  count: number,
  enabled: ReadonlySet<string>,
) {
  const listed = yield* manager.list().pipe(Effect.mapError((error) => fail(error.message)));
  if (
    listed.length !== count ||
    listed.some(
      (plugin, index) =>
        plugin.id !== ids[index] ||
        plugin.hash !== pending.artifacts[index]?.hash ||
        plugin.enabled !== enabled.has(plugin.id) ||
        plugin.removing === true,
    )
  )
    return false;
  for (let index = 0; index < count; index++) {
    const descriptor = pending.artifacts[index];
    const grant = grants[index];
    if (!descriptor || !grant) return false;
    const installation = yield* manager
      .inspectInstallation(descriptor.id)
      .pipe(Effect.mapError((error) => fail(error.message)));
    if (
      !installation ||
      installation.hash !== descriptor.hash ||
      installation.grantId !== grant.id ||
      installation.enabled !== enabled.has(descriptor.id) ||
      installation.removing ||
      installation.suspended
    )
      return false;
  }
  return true;
});

const isEmptyPlan = (plan: InstalledPluginPlan, revision: number) =>
  plan.revision === revision &&
  plan.enabled.length === 0 &&
  plan.composition === undefined &&
  plan.serviceBindings.length === 0;
const isTargetPlan = (plan: InstalledPluginPlan, pending: Pending, revision: number) =>
  same(plan, { ...pending.plan, revision });

const storagePresence = Effect.fn("DefaultPluginBootstrap.inspectStorage")(function* (
  storage: DefaultPluginStateStorage,
) {
  const model = yield* storage.forOwner(DefaultTabModelPluginId);
  const pins = yield* storage.forOwner(DefaultTabPinsPluginId);
  return { model: (yield* model.read()).revision > 0, pins: (yield* pins.read()).revision > 0 };
});

const seedOwner = Effect.fn("DefaultPluginBootstrap.seedOwner")(function* (
  storage: DefaultPluginStateStorage,
  id: string,
  value: DefaultTabModelState | DefaultTabPinsState,
) {
  const owner = yield* storage.forOwner(id);
  const before = yield* owner.read();
  if (before.revision !== 0) return;
  let revision: number | undefined;
  let conflict = false;
  yield* owner.write(0, value).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        revision = result.revision;
      }),
    ),
    Effect.catch((error) => {
      if (error.code !== "conflict") return Effect.fail(error);
      conflict = true;
      return Effect.void;
    }),
  );
  if (!conflict) {
    if (revision === undefined || revision <= 0)
      return yield* fail("Default plugin storage stayed empty");
    return;
  }
  const after = yield* owner.read();
  if (after.revision === 0) return yield* fail("Default plugin storage CAS conflict");
});

/** Serial, profile-lease-bound migration from the legacy browser surface to five managed plugins. */
export const runDefaultPluginBootstrap = (options: DefaultPluginBootstrapOptions) => {
  const lock = coordinatorLocks.get(options.profileRoot) ?? Semaphore.makeUnsafe(1);
  coordinatorLocks.set(options.profileRoot, lock);
  return lock.withPermits(1)(
    Effect.gen(function* () {
      if (options.safeMode || options.developerPlugin) return;
      if (!isAbsolute(options.profileRoot) || options.profileRoot !== options.lease.profileRoot)
        return yield* fail("Bootstrap profile does not match its write lease");
      if (poisonedProfiles.has(options.profileRoot))
        return yield* fail("Bootstrap journal requires restart");
      yield* options.lease.assertHeld.pipe(Effect.mapError((error) => fail(error.message)));
      yield* options.manager
        .restore()
        .pipe(Effect.mapError((error) => fail(`Manager recovery failed: ${error.message}`)));

      let journal = yield* readJournal(options.profileRoot);
      if (journal?.state === "completed" || journal?.state === "abandoned") return;

      if (!journal) {
        const [currentPlan, installed] = yield* Effect.all([
          options.manager.plan(),
          options.manager.list(),
        ]).pipe(Effect.mapError((error) => fail(error.message)));
        if (!isEmptyPlan(currentPlan, 0) || installed.length !== 0) {
          yield* abandon(options, "profile-customized");
          return;
        }
        const decodedSeed = decodeSeed(options.seed);
        if (Option.isNone(decodedSeed)) return yield* fail("Default plugin seed is invalid");
        const bundle = yield* options.loadBundle.pipe(
          Effect.mapError(() => fail("Could not load default plugin bundle")),
        );
        if (!validBundle(bundle)) return yield* fail("Default plugin bundle is invalid");
        const staged = yield* Effect.forEach(bundle.packages, (item) =>
          options.artifacts.stage(item).pipe(Effect.mapError((error) => fail(error.message))),
        );
        const artifacts = staged.flatMap((artifact, index) => {
          const id = ids[index];
          return id
            ? [
                {
                  id,
                  hash: artifact.hash,
                  capabilities: capabilities[id],
                  grantKey: `default-bootstrap/1/${id}`,
                },
              ]
            : [];
        });
        const pending = decodeJournal({
          version: JournalVersion,
          id: JournalId,
          state: "pending",
          placement: options.placement,
          artifacts,
          plan: bundle.plans[options.placement],
          seed: decodedSeed.value,
          expectedRevision: 0,
          installedPrefix: [],
          storagePresent: { model: false, pins: false },
        });
        if (!pending || pending.state !== "pending")
          return yield* fail("Default plugin bundle produced an invalid journal");
        journal = pending;
        yield* writeJournal(options.profileRoot, options.lease, journal).pipe(
          Effect.mapError((error) => fail(error.message)),
        );
      }

      if (journal.state !== "pending")
        return yield* fail("Bootstrap journal state changed unexpectedly");
      yield* verifyFrozenArtifacts(options.artifacts, journal.artifacts);
      const grants = yield* ensureManagedGrants(options.grants, journal.artifacts);
      const disabled = new Set<string>();
      let current = yield* options.manager
        .plan()
        .pipe(Effect.mapError((error) => fail(error.message)));

      if (isTargetPlan(current, journal, journal.expectedRevision + 1)) {
        const presence = yield* storagePresence(options.storage).pipe(
          Effect.mapError(() => fail("Could not inspect default plugin storage")),
        );
        if (
          journal.installedPrefix.length !== ids.length ||
          !journal.storagePresent.model ||
          !journal.storagePresent.pins ||
          !presence.model ||
          !presence.pins ||
          !(yield* installationsMatch(
            options.manager,
            journal,
            grants,
            ids.length,
            new Set(journal.plan.enabled),
          ))
        ) {
          yield* abandon(options, "bootstrap-state-diverged");
          return;
        }
        yield* writeJournal(options.profileRoot, options.lease, {
          version: JournalVersion,
          id: JournalId,
          state: "completed",
          revision: current.revision,
        }).pipe(Effect.mapError((error) => fail(error.message)));
        return;
      }

      if (
        journal.installedPrefix.length < ids.length &&
        isEmptyPlan(current, journal.expectedRevision + 1)
      ) {
        const nextLength = journal.installedPrefix.length + 1;
        if (!(yield* installationsMatch(options.manager, journal, grants, nextLength, disabled))) {
          yield* abandon(options, "bootstrap-state-diverged");
          return;
        }
        journal = {
          ...journal,
          expectedRevision: current.revision,
          installedPrefix: ids.slice(0, nextLength),
        };
        yield* writeJournal(options.profileRoot, options.lease, journal).pipe(
          Effect.mapError((error) => fail(error.message)),
        );
      } else if (!isEmptyPlan(current, journal.expectedRevision)) {
        yield* abandon(options, "bootstrap-state-diverged");
        return;
      }

      if (
        !(yield* installationsMatch(
          options.manager,
          journal,
          grants,
          journal.installedPrefix.length,
          disabled,
        ))
      ) {
        yield* abandon(options, "bootstrap-state-diverged");
        return;
      }

      for (let index = journal.installedPrefix.length; index < journal.artifacts.length; index++) {
        const descriptor = journal.artifacts[index];
        const grant = grants[index];
        if (!descriptor || !grant) return yield* fail("Bootstrap journal is invalid");
        const beforeInstall = yield* options.manager
          .plan()
          .pipe(Effect.mapError((error) => fail(error.message)));
        if (!isEmptyPlan(beforeInstall, journal.expectedRevision)) {
          yield* abandon(options, "bootstrap-state-diverged");
          return;
        }
        yield* options.manager
          .install(descriptor.hash, grant.id, { staged: true })
          .pipe(Effect.mapError((error) => fail(error.message)));
        const afterInstall = yield* options.manager
          .plan()
          .pipe(Effect.mapError((error) => fail(error.message)));
        if (
          !isEmptyPlan(afterInstall, journal.expectedRevision + 1) ||
          !(yield* installationsMatch(options.manager, journal, grants, index + 1, disabled))
        ) {
          yield* abandon(options, "bootstrap-state-diverged");
          return;
        }
        journal = {
          ...journal,
          expectedRevision: afterInstall.revision,
          installedPrefix: ids.slice(0, index + 1),
        };
        yield* writeJournal(options.profileRoot, options.lease, journal).pipe(
          Effect.mapError((error) => fail(error.message)),
        );
      }

      const beforeStorage = yield* storagePresence(options.storage).pipe(
        Effect.mapError(() => fail("Could not inspect default plugin storage")),
      );
      if (
        (journal.storagePresent.model && !beforeStorage.model) ||
        (journal.storagePresent.pins && !beforeStorage.pins)
      ) {
        yield* abandon(options, "bootstrap-state-diverged");
        return;
      }
      if (!journal.storagePresent.model) {
        yield* seedOwner(options.storage, DefaultTabModelPluginId, journal.seed.model).pipe(
          Effect.mapError(() => fail("Could not seed default model storage")),
        );
        journal = { ...journal, storagePresent: { ...journal.storagePresent, model: true } };
        yield* writeJournal(options.profileRoot, options.lease, journal).pipe(
          Effect.mapError((error) => fail(error.message)),
        );
      }
      if (!journal.storagePresent.pins) {
        yield* seedOwner(options.storage, DefaultTabPinsPluginId, journal.seed.pins).pipe(
          Effect.mapError(() => fail("Could not seed default pin storage")),
        );
        journal = { ...journal, storagePresent: { ...journal.storagePresent, pins: true } };
        yield* writeJournal(options.profileRoot, options.lease, journal).pipe(
          Effect.mapError((error) => fail(error.message)),
        );
      }

      current = yield* options.manager.plan().pipe(Effect.mapError((error) => fail(error.message)));
      const afterStorage = yield* storagePresence(options.storage).pipe(
        Effect.mapError(() => fail("Could not inspect default plugin storage")),
      );
      if (
        !isEmptyPlan(current, journal.expectedRevision) ||
        !afterStorage.model ||
        !afterStorage.pins ||
        !(yield* installationsMatch(options.manager, journal, grants, ids.length, disabled))
      ) {
        yield* abandon(options, "bootstrap-state-diverged");
        return;
      }

      const promoted = yield* options.manager
        .applyPlan(journal.expectedRevision, journal.plan)
        .pipe(Effect.mapError((error) => fail(error.message)));
      if (
        !isTargetPlan(promoted, journal, journal.expectedRevision + 1) ||
        !(yield* installationsMatch(
          options.manager,
          journal,
          grants,
          ids.length,
          new Set(journal.plan.enabled),
        ))
      ) {
        yield* abandon(options, "bootstrap-state-diverged");
        return;
      }
      yield* writeJournal(options.profileRoot, options.lease, {
        version: JournalVersion,
        id: JournalId,
        state: "completed",
        revision: promoted.revision,
      }).pipe(Effect.mapError((error) => fail(error.message)));
    }),
  );
};
