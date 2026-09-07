import {
  type ExtensionInstallationApi,
  type ExtensionInstallationSnapshot,
  type ExtensionManagementSummary,
} from "@hitchhiker/runtime";
import { Cause, Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect";
import type {
  ExtensionManager,
  ExtensionOwner,
  OwnedManagedExtension,
} from "./extension-manager.ts";
import type {
  ExtensionUploadOwner,
  ExtensionUploadSnapshot,
  ExtensionUploadStore,
} from "./extension-upload.ts";
import type { createNativeExtensionReview } from "./extension-review.ts";

const OperationId = /^[a-f0-9]{32}$/;
const MaxJobs = 32;
const terminal = new Set<ExtensionInstallationSnapshot["state"]>([
  "enabled",
  "canceled",
  "rejected",
  "error",
  "removed",
]);

class ExtensionInstallationError extends Error {
  readonly _tag = "ExtensionInstallationError";
}
const unavailable = () => new ExtensionInstallationError("Extension installation is unavailable");

type Review = ReturnType<typeof createNativeExtensionReview>;
type Job = {
  readonly operationId: string;
  readonly ownerToken: object;
  state: ExtensionInstallationSnapshot["state"];
  upload?: ExtensionInstallationSnapshot["upload"];
  extension?: ExtensionManagementSummary;
  error?: ExtensionInstallationSnapshot["error"];
  artifact?: { readonly installationId: string; readonly digest: string };
  fiber?: Fiber.Fiber<void, never>;
  canceling?: boolean;
};

const uploadProjection = (
  value: ExtensionUploadSnapshot,
): NonNullable<ExtensionInstallationSnapshot["upload"]> => ({
  completedFiles: value.completedFiles,
  totalBytes: value.totalBytes,
  ...(value.file === undefined ? {} : { file: { ...value.file } }),
});

const safeExtension = (entry: OwnedManagedExtension): ExtensionManagementSummary => {
  const { operationId: _operationId, ...extension } = entry;
  return extension;
};

const managedSnapshot = (entry: OwnedManagedExtension): ExtensionInstallationSnapshot => ({
  operationId: entry.operationId!,
  state:
    entry.state === "prepared"
      ? "awaiting_review"
      : entry.state === "enabled"
        ? "enabled"
        : entry.state === "removed"
          ? "removed"
          : entry.state === "error"
            ? "error"
            : "installing",
  extension: safeExtension(entry),
  ...(entry.state === "error" ? { error: "installation_failed" as const } : {}),
});

const jobSnapshot = (job: Job): ExtensionInstallationSnapshot => ({
  operationId: job.operationId,
  state: job.state,
  ...(job.upload === undefined ? {} : { upload: job.upload }),
  ...(job.extension === undefined ? {} : { extension: job.extension }),
  ...(job.error === undefined ? {} : { error: job.error }),
});

const mergeSnapshot = (
  job: Job | undefined,
  durable: OwnedManagedExtension | undefined,
): ExtensionInstallationSnapshot | undefined => {
  if (durable === undefined) return job === undefined ? undefined : jobSnapshot(job);
  const persisted = managedSnapshot(durable);
  if (job === undefined) return persisted;
  if (durable.state === "prepared" && (job.state === "reviewing" || job.state === "error"))
    return { ...jobSnapshot(job), extension: persisted.extension };
  return persisted;
};

export const createExtensionInstallation = Effect.fn("ExtensionInstallation.create")(
  function* (options: {
    readonly manager: Pick<
      ExtensionManager,
      | "prepareOwned"
      | "listOwned"
      | "reviewPrepared"
      | "confirmInstall"
      | "cancelPreview"
      | "abandonPrepared"
    >;
    readonly uploads: ExtensionUploadStore;
    readonly review: Review;
    readonly profileId: string;
    readonly onFailure: (error: unknown) => Effect.Effect<void>;
  }) {
    const applicationScope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const jobs = new Map<string, Job>();
    const synchronized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermit(effect);

    yield* Effect.forkIn(
      options.uploads.expire().pipe(
        Effect.catch((error) => options.onFailure(error)),
        Effect.delay(30_000),
        Effect.forever,
      ),
      applicationScope,
      { uninterruptible: false },
    );

    const evictTerminal = () => {
      for (const [operationId, job] of jobs) {
        if (jobs.size < MaxJobs) break;
        if (terminal.has(job.state)) jobs.delete(operationId);
      }
    };

    const forOwner = (owner: ExtensionOwner) =>
      Effect.gen(function* () {
        const ownerToken = {};
        let closed = false;
        let closing = false;
        const closeDone = yield* Deferred.make<void>();
        const authorize = Effect.suspend(() =>
          closed ? Effect.fail(unavailable()) : owner.authorize.pipe(Effect.mapError(unavailable)),
        );
        const boundOwner: ExtensionOwner = {
          principal: owner.principal,
          grantId: owner.grantId,
          authorize,
        };
        const uploadScope = yield* Scope.make();
        const upload = yield* options.uploads
          .forOwner(authorize)
          .pipe(Effect.provideService(Scope.Scope, uploadScope));

        const ownedJob = (operationId: string) => {
          const job = jobs.get(operationId);
          return job?.ownerToken === ownerToken ? job : undefined;
        };
        const requireOwnedJob = (operationId: string, expected?: Job["state"]) =>
          synchronized(
            Effect.suspend(() => {
              const job = OperationId.test(operationId) ? ownedJob(operationId) : undefined;
              return job !== undefined && (expected === undefined || job.state === expected)
                ? Effect.succeed(job)
                : Effect.fail(unavailable());
            }),
          );
        const durable = () => options.manager.listOwned(boundOwner);
        const durableFor = (entries: readonly OwnedManagedExtension[], operationId: string) =>
          entries.find((entry) => entry.operationId === operationId);
        const recordFailure = (
          operationId: string,
          error: ExtensionInstallationSnapshot["error"],
        ) =>
          synchronized(
            Effect.sync(() => {
              const job = ownedJob(operationId);
              if (job !== undefined && !terminal.has(job.state)) {
                job.state = "error";
                job.error = error;
                job.fiber = undefined;
              }
            }),
          );
        const handleFailure = (
          operationId: string,
          error: ExtensionInstallationSnapshot["error"],
          cause: Cause.Cause<unknown>,
        ) =>
          options
            .onFailure(Cause.squash(cause))
            .pipe(Effect.andThen(recordFailure(operationId, error)));
        const closeOwner = Effect.uninterruptible(
          Effect.suspend(() => {
            if (closing) return Deferred.await(closeDone);
            closing = true;
            closed = true;
            return Effect.gen(function* () {
              yield* Scope.close(uploadScope, Exit.void);
              const owned = yield* synchronized(
                Effect.sync(() => {
                  const values = [...jobs.values()].filter((job) => job.ownerToken === ownerToken);
                  for (const job of values) {
                    if (!terminal.has(job.state)) job.state = "canceled";
                  }
                  return values;
                }),
              );
              for (const job of owned) {
                if (job.fiber !== undefined) yield* Fiber.interrupt(job.fiber);
              }
              const discovered = yield* options.manager
                .listOwned(owner)
                .pipe(
                  Effect.catch((error) =>
                    options
                      .onFailure(error)
                      .pipe(Effect.as([] as readonly OwnedManagedExtension[])),
                  ),
                );
              for (const job of owned) {
                const persisted = discovered.find(
                  (entry) => entry.operationId === job.operationId && entry.state === "prepared",
                );
                const artifact =
                  job.artifact ??
                  (persisted === undefined
                    ? undefined
                    : { installationId: persisted.installationId, digest: persisted.digest });
                if (persisted !== undefined && persisted.state !== "prepared") continue;
                if (
                  persisted === undefined &&
                  (job.state === "enabled" || job.state === "removed" || job.state === "rejected")
                )
                  continue;
                if (artifact !== undefined) {
                  yield* options.manager
                    .abandonPrepared(artifact.installationId, artifact.digest, {
                      principal: owner.principal,
                      grantId: owner.grantId,
                    })
                    .pipe(Effect.catch((error) => options.onFailure(error)));
                }
              }
            }).pipe(Effect.ensuring(Deferred.succeed(closeDone, undefined)), Effect.asVoid);
          }),
        );

        yield* Effect.addFinalizer(() => closeOwner);
        yield* Effect.forkIn(
          authorize.pipe(
            Effect.delay(500),
            Effect.forever,
            Effect.catchCause(() => closeOwner),
          ),
          applicationScope,
          { uninterruptible: false },
        );

        const begin = () =>
          authorize.pipe(
            Effect.andThen(
              synchronized(
                Effect.gen(function* () {
                  evictTerminal();
                  if (jobs.size >= MaxJobs) return yield* Effect.fail(unavailable());
                  const value = yield* upload.begin();
                  const job: Job = {
                    operationId: value.uploadId,
                    ownerToken,
                    state: "receiving",
                    upload: uploadProjection(value),
                  };
                  jobs.set(value.uploadId, job);
                  return jobSnapshot(job);
                }),
              ),
            ),
          );

        const updateUpload = (
          operationId: string,
          operation: (
            upload: ExtensionUploadOwner,
          ) => Effect.Effect<ExtensionUploadSnapshot, unknown>,
        ) =>
          Effect.gen(function* () {
            yield* authorize;
            const before = yield* requireOwnedJob(operationId, "receiving");
            if (before.canceling) return yield* Effect.fail(unavailable());
            const value = yield* operation(upload);
            return yield* synchronized(
              Effect.suspend(() => {
                const job = ownedJob(operationId);
                if (job === undefined || job.state !== "receiving" || job.canceling)
                  return Effect.fail(unavailable());
                job.upload = uploadProjection(value);
                return Effect.succeed(jobSnapshot(job));
              }),
            );
          });

        const finish = (operationId: string) =>
          Effect.gen(function* () {
            yield* authorize;
            const task = upload
              .consume(operationId, (directory) =>
                options.manager.prepareOwned(directory, boundOwner, operationId),
              )
              .pipe(
                Effect.flatMap((artifact) =>
                  synchronized(
                    Effect.sync(() => {
                      const job = ownedJob(operationId);
                      if (job === undefined) return;
                      job.artifact = {
                        installationId: artifact.installationId,
                        digest: artifact.digest,
                      };
                      job.extension = undefined;
                      job.upload = undefined;
                      job.fiber = undefined;
                      if (job.state === "validating") job.state = "awaiting_review";
                    }),
                  ),
                ),
                Effect.catchCause((cause) =>
                  handleFailure(operationId, "validation_failed", cause),
                ),
              );
            return yield* Effect.uninterruptible(
              synchronized(
                Effect.gen(function* () {
                  const job = OperationId.test(operationId) ? ownedJob(operationId) : undefined;
                  if (job === undefined || job.state !== "receiving" || job.canceling)
                    return yield* Effect.fail(unavailable());
                  job.state = "validating";
                  const fiber = yield* Effect.forkIn(task, applicationScope, {
                    startImmediately: true,
                    uninterruptible: false,
                  });
                  job.fiber = fiber;
                  return jobSnapshot(job);
                }),
              ),
            );
          });

        const status = (operationId: string) =>
          Effect.gen(function* () {
            yield* authorize;
            if (!OperationId.test(operationId)) return yield* Effect.fail(unavailable());
            const local = yield* synchronized(Effect.sync(() => ownedJob(operationId)));
            if (local?.state === "receiving" && !local.canceling) {
              const refreshed = yield* Effect.exit(upload.status(operationId));
              if (refreshed._tag === "Failure") {
                yield* recordFailure(operationId, "expired");
                return yield* synchronized(Effect.sync(() => jobSnapshot(ownedJob(operationId)!)));
              }
              const value = refreshed.value;
              return yield* synchronized(
                Effect.suspend(() => {
                  const job = ownedJob(operationId);
                  if (job === undefined || job.state !== "receiving" || job.canceling)
                    return Effect.fail(unavailable());
                  job.upload = uploadProjection(value);
                  return Effect.succeed(jobSnapshot(job));
                }),
              );
            }
            const entries = yield* durable();
            const persisted = durableFor(entries, operationId);
            const job = yield* synchronized(Effect.sync(() => ownedJob(operationId)));
            const snapshot = mergeSnapshot(job, persisted);
            if (snapshot === undefined) return yield* Effect.fail(unavailable());
            return snapshot;
          });

        const list = () =>
          Effect.gen(function* () {
            yield* authorize;
            const entries = yield* durable();
            const ephemeral = yield* synchronized(
              Effect.sync(() => [...jobs.values()].filter((job) => job.ownerToken === ownerToken)),
            );
            const byId = new Map<string, ExtensionInstallationSnapshot>();
            for (const job of ephemeral) byId.set(job.operationId, jobSnapshot(job));
            for (const entry of entries) {
              if (entry.operationId === undefined) continue;
              const merged = mergeSnapshot(ownedJob(entry.operationId), entry);
              if (merged !== undefined) byId.set(entry.operationId, merged);
            }
            return [...byId.values()].slice(-MaxJobs);
          });

        const requestReview = (operationId: string) =>
          Effect.gen(function* () {
            yield* authorize;
            if (!OperationId.test(operationId)) return yield* Effect.fail(unavailable());
            const entries = yield* durable();
            const entry = durableFor(entries, operationId);
            if (
              entry === undefined ||
              (entry.state !== "prepared" &&
                !(entry.state === "error" && entry.errorIntent === "install"))
            )
              return yield* Effect.fail(unavailable());
            let confirming = false;
            const task = options.manager
              .reviewPrepared(entry.installationId, entry.digest, boundOwner)
              .pipe(
                Effect.flatMap((artifact) =>
                  options
                    .review({
                      requester: owner.principal,
                      profileId: options.profileId,
                      artifact,
                      authorize,
                    })
                    .pipe(Effect.map((approved) => ({ approved, artifact }))),
                ),
                Effect.flatMap(({ approved, artifact }) =>
                  approved
                    ? Effect.sync(() => {
                        confirming = true;
                      }).pipe(
                        Effect.andThen(
                          options.manager.confirmInstall(
                            artifact.installationId,
                            artifact.digest,
                            boundOwner,
                          ),
                        ),
                        Effect.andThen(
                          synchronized(
                            Effect.sync(() => {
                              const job = ownedJob(operationId);
                              if (job !== undefined) {
                                job.state = "enabled";
                                job.extension = undefined;
                                job.fiber = undefined;
                              }
                            }),
                          ),
                        ),
                      )
                    : options.manager
                        .cancelPreview(artifact.installationId, artifact.digest, boundOwner)
                        .pipe(
                          Effect.andThen(
                            synchronized(
                              Effect.sync(() => {
                                const job = ownedJob(operationId);
                                if (job !== undefined) {
                                  job.state = "rejected";
                                  job.extension = undefined;
                                  job.fiber = undefined;
                                }
                              }),
                            ),
                          ),
                        ),
                ),
                Effect.catchCause((cause) =>
                  handleFailure(
                    operationId,
                    confirming ? "installation_failed" : "review_failed",
                    cause,
                  ),
                ),
              );
            return yield* Effect.uninterruptible(
              synchronized(
                Effect.gen(function* () {
                  const existing = jobs.get(operationId);
                  if (existing !== undefined && existing.ownerToken !== ownerToken)
                    return yield* Effect.fail(unavailable());
                  let job = existing;
                  if (job === undefined) {
                    evictTerminal();
                    if (jobs.size >= MaxJobs) return yield* Effect.fail(unavailable());
                    job = {
                      operationId,
                      ownerToken,
                      state: "awaiting_review",
                      artifact: { installationId: entry.installationId, digest: entry.digest },
                      extension: undefined,
                    };
                    jobs.set(operationId, job);
                  }
                  if (job.state !== "awaiting_review" && job.state !== "error")
                    return yield* Effect.fail(unavailable());
                  job.state = "reviewing";
                  job.error = undefined;
                  job.artifact = { installationId: entry.installationId, digest: entry.digest };
                  job.extension = undefined;
                  const fiber = yield* Effect.forkIn(task, applicationScope, {
                    startImmediately: true,
                    uninterruptible: false,
                  });
                  job.fiber = fiber;
                  return jobSnapshot(job);
                }),
              ),
            );
          });

        const cancel = (operationId: string) =>
          Effect.gen(function* () {
            yield* authorize;
            if (!OperationId.test(operationId)) return yield* Effect.fail(unavailable());
            const initial = yield* synchronized(
              Effect.suspend(() => {
                const job = ownedJob(operationId);
                if (job === undefined) return Effect.succeed(undefined);
                if (terminal.has(job.state) && job.state !== "error" && job.state !== "enabled")
                  return Effect.succeed(job);
                job.canceling = true;
                return Effect.succeed(job);
              }),
            );
            if (
              initial !== undefined &&
              terminal.has(initial.state) &&
              initial.state !== "error" &&
              initial.state !== "enabled"
            )
              return jobSnapshot(initial);
            if (initial?.state === "receiving") {
              const stopped = yield* Effect.exit(upload.cancel(operationId));
              if (stopped._tag === "Failure") {
                yield* options.onFailure(Cause.squash(stopped.cause));
                return yield* synchronized(
                  Effect.sync(() => {
                    const job = ownedJob(operationId)!;
                    job.state = "error";
                    job.error = "unavailable";
                    job.canceling = false;
                    return jobSnapshot(job);
                  }),
                );
              }
              return yield* synchronized(
                Effect.sync(() => {
                  const job = ownedJob(operationId)!;
                  job.state = "canceled";
                  job.canceling = false;
                  job.upload = undefined;
                  return jobSnapshot(job);
                }),
              );
            }
            if (initial?.fiber !== undefined) yield* Fiber.interrupt(initial.fiber);
            let entries = yield* durable();
            let entry = durableFor(entries, operationId);
            if (entry?.state === "prepared") {
              const result = yield* Effect.exit(
                options.manager.abandonPrepared(entry.installationId, entry.digest, {
                  principal: owner.principal,
                  grantId: owner.grantId,
                }),
              );
              if (result._tag === "Failure") yield* options.onFailure(Cause.squash(result.cause));
              entries = yield* durable();
              entry = durableFor(entries, operationId);
            }
            if (entry !== undefined) {
              const persisted = managedSnapshot(entry);
              yield* synchronized(
                Effect.sync(() => {
                  const job = ownedJob(operationId);
                  if (job !== undefined) {
                    job.state = persisted.state;
                    job.extension = undefined;
                    job.error = persisted.error;
                    job.canceling = false;
                    job.fiber = undefined;
                  }
                }),
              );
              return persisted;
            }
            if (initial === undefined) {
              return yield* synchronized(
                Effect.gen(function* () {
                  const existing = jobs.get(operationId);
                  if (existing !== undefined) return yield* Effect.fail(unavailable());
                  evictTerminal();
                  if (jobs.size >= MaxJobs) return yield* Effect.fail(unavailable());
                  const job: Job = { operationId, ownerToken, state: "canceled" };
                  jobs.set(operationId, job);
                  return jobSnapshot(job);
                }),
              );
            }
            return yield* synchronized(
              Effect.sync(() => {
                const job = ownedJob(operationId)!;
                job.state = "canceled";
                job.error = undefined;
                job.extension = undefined;
                job.canceling = false;
                job.fiber = undefined;
                return jobSnapshot(job);
              }),
            );
          });

        return {
          begin,
          beginFile: (operationId, path, size) =>
            updateUpload(operationId, (value) => value.beginFile(operationId, path, size)),
          append: (operationId, offset, dataBase64) =>
            updateUpload(operationId, (value) => value.append(operationId, offset, dataBase64)),
          finish,
          status,
          list,
          requestReview,
          cancel,
        } satisfies ExtensionInstallationApi;
      });

    return { forOwner };
  },
);

export type ExtensionInstallation = Effect.Success<ReturnType<typeof createExtensionInstallation>>;
