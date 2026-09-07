import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@hitchhiker/runtime";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import type {
  ExtensionManager,
  ExtensionOwner,
  ExtensionPreview,
  OwnedManagedExtension,
} from "../src/extension-manager.ts";
import { createExtensionInstallation } from "../src/extension-installation.ts";
import type { ExtensionUploadSnapshot, ExtensionUploadStore } from "../src/extension-upload.ts";
import { ExtensionUploadError } from "../src/extension-upload.ts";

const operationA = "a".repeat(32);
const operationB = "b".repeat(32);
const installationId = "c".repeat(32);
const digest = "d".repeat(64);
const chromiumId = "e".repeat(32);
const preview: ExtensionPreview = {
  installationId,
  digest,
  expectedChromiumId: chromiumId,
  name: "Uploaded extension",
  version: "1.0.0",
  permissions: ["storage"],
  host_permissions: ["https://example.test/*"],
  optional_permissions: [],
  optional_host_permissions: [],
};

type Record = OwnedManagedExtension & { principal: string; grantId: string };

const managed = (
  operationId: string,
  state: OwnedManagedExtension["state"],
  principal = "plugin-a",
  grantId = "grant-a",
): Record => ({
  operationId,
  installationId,
  digest,
  expectedChromiumId: chromiumId,
  name: preview.name,
  version: preview.version,
  permissions: preview.permissions,
  hostPermissions: preview.host_permissions,
  optionalPermissions: preview.optional_permissions,
  optionalHostPermissions: preview.optional_host_permissions,
  state,
  principal,
  grantId,
});

const makeUploadStore = (ids: string[] = [operationA, operationB]) => {
  const sessions = new Map<string, ExtensionUploadSnapshot>();
  let closes = 0;
  let expires = 0;
  const store: ExtensionUploadStore = {
    forOwner: (authorize) =>
      Effect.gen(function* () {
        const mine = new Set<string>();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closes += 1;
            for (const id of mine) sessions.delete(id);
          }),
        );
        const find = (id: string) => {
          const value = sessions.get(id);
          return value !== undefined && mine.has(id)
            ? Effect.succeed(value)
            : Effect.fail(new ExtensionUploadError({ message: "missing upload" }));
        };
        return {
          begin: () =>
            authorize.pipe(
              Effect.mapError(
                () => new ExtensionUploadError({ message: "upload is unauthorized" }),
              ),
              Effect.andThen(
                Effect.sync(() => {
                  const uploadId = ids.shift()!;
                  const value: ExtensionUploadSnapshot = {
                    uploadId,
                    state: "receiving",
                    completedFiles: 1,
                    totalBytes: 2,
                  };
                  sessions.set(uploadId, value);
                  mine.add(uploadId);
                  return value;
                }),
              ),
            ),
          beginFile: (id) =>
            authorize.pipe(
              Effect.mapError(
                () => new ExtensionUploadError({ message: "upload is unauthorized" }),
              ),
              Effect.andThen(find(id)),
            ),
          append: (id) =>
            authorize.pipe(
              Effect.mapError(
                () => new ExtensionUploadError({ message: "upload is unauthorized" }),
              ),
              Effect.andThen(find(id)),
            ),
          status: (id) =>
            authorize.pipe(
              Effect.mapError(
                () => new ExtensionUploadError({ message: "upload is unauthorized" }),
              ),
              Effect.andThen(find(id)),
            ),
          cancel: (id) =>
            authorize.pipe(
              Effect.mapError(
                () => new ExtensionUploadError({ message: "upload is unauthorized" }),
              ),
              Effect.andThen(find(id)),
              Effect.tap(() => Effect.sync(() => sessions.delete(id))),
              Effect.asVoid,
            ),
          consume: (id, operation) =>
            authorize.pipe(
              Effect.mapError(
                () => new ExtensionUploadError({ message: "upload is unauthorized" }),
              ),
              Effect.andThen(find(id)),
              Effect.flatMap(() => operation(`/private/${id}`)),
              Effect.ensuring(Effect.sync(() => sessions.delete(id))),
            ),
        };
      }),
    expire: () =>
      Effect.sync(() => {
        expires += 1;
      }),
  };
  return { store, sessions, closes: () => closes, expires: () => expires };
};

const makeManager = (
  options: {
    records?: Map<string, Record>;
    prepareGate?: Deferred.Deferred<void>;
    confirmStarted?: Deferred.Deferred<void>;
    confirmGate?: Deferred.Deferred<void>;
  } = {},
) => {
  const records = options.records ?? new Map<string, Record>();
  const owned = (owner: ExtensionOwner) =>
    owner.authorize.pipe(
      Effect.as(
        [...records.values()].filter(
          (entry) => entry.principal === owner.principal && entry.grantId === owner.grantId,
        ),
      ),
    );
  const manager: Pick<
    ExtensionManager,
    | "prepareOwned"
    | "listOwned"
    | "reviewPrepared"
    | "confirmInstall"
    | "cancelPreview"
    | "abandonPrepared"
  > = {
    prepareOwned: (_directory, owner, operationId) =>
      (options.prepareGate === undefined ? Effect.void : Deferred.await(options.prepareGate)).pipe(
        Effect.andThen(owner.authorize),
        Effect.tap(() =>
          Effect.sync(() =>
            records.set(
              operationId,
              managed(operationId, "prepared", owner.principal, owner.grantId),
            ),
          ),
        ),
        Effect.as(preview),
      ) as never,
    listOwned: (owner) => owned(owner) as never,
    reviewPrepared: (_id, _digest, owner) =>
      (owner === undefined ? Effect.fail(new Error("owner required")) : owner.authorize).pipe(
        Effect.as(preview),
      ) as never,
    confirmInstall: (_id, _digest, owner) => {
      if (owner === undefined) return Effect.fail(new Error("owner required")) as never;
      return owner.authorize.pipe(
        Effect.andThen(
          Effect.uninterruptible(
            Effect.sync(() => {
              const entry = [...records.values()].find(
                (value) => value.principal === owner.principal && value.grantId === owner.grantId,
              )!;
              records.set(entry.operationId!, { ...entry, state: "installing" });
            }).pipe(
              Effect.andThen(
                options.confirmStarted === undefined
                  ? Effect.void
                  : Deferred.succeed(options.confirmStarted, undefined),
              ),
              Effect.andThen(
                options.confirmGate === undefined
                  ? Effect.void
                  : Deferred.await(options.confirmGate),
              ),
              Effect.andThen(
                Effect.sync(() => {
                  const entry = [...records.values()].find(
                    (value) =>
                      value.principal === owner.principal && value.grantId === owner.grantId,
                  )!;
                  records.set(entry.operationId!, { ...entry, state: "enabled" });
                }),
              ),
            ),
          ),
        ),
      ) as never;
    },
    cancelPreview: (_id, _digest, owner) =>
      (owner === undefined ? Effect.fail(new Error("owner required")) : owner.authorize).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const [id, entry] of records)
              if (entry.principal === owner!.principal && entry.grantId === owner!.grantId)
                records.delete(id);
          }),
        ),
        Effect.asVoid,
      ) as never,
    abandonPrepared: (_id, _digest, identity) =>
      Effect.sync(() => {
        for (const [id, entry] of records)
          if (
            entry.state === "prepared" &&
            entry.principal === identity.principal &&
            entry.grantId === identity.grantId
          )
            records.delete(id);
      }) as never,
  };
  return { manager, records };
};

const owner = (authorize: Effect.Effect<void, unknown> = Effect.void): ExtensionOwner => ({
  principal: "plugin-a",
  grantId: "grant-a",
  authorize,
});

test("finish and review return promptly while validation and native approval remain pending", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const prepareGate = yield* Deferred.make<void>();
        const decision = yield* Deferred.make<boolean>();
        const uploads = makeUploadStore();
        const backend = makeManager({ prepareGate });
        const coordinator = yield* createExtensionInstallation({
          manager: backend.manager,
          uploads: uploads.store,
          profileId: "profile-a",
          review: () => Deferred.await(decision),
          onFailure: () => Effect.void,
        });
        const api = yield* coordinator.forOwner(owner());
        const started = yield* api.begin();
        assert.equal((yield* api.finish(started.operationId)).state, "validating");
        yield* Deferred.succeed(prepareGate, undefined);
        yield* Effect.yieldNow;
        assert.equal((yield* api.status(started.operationId)).state, "awaiting_review");
        assert.equal((yield* api.requestReview(started.operationId)).state, "reviewing");
        yield* Deferred.succeed(decision, true);
        yield* Effect.yieldNow;
        const result = yield* api.status(started.operationId);
        assert.equal(result.state, "enabled");
        assert.equal("operationId" in result.extension!, false);
      }),
    ),
  );
});

test("a second port cannot inspect or take over a live operation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const decision = yield* Deferred.make<boolean>();
        const uploads = makeUploadStore();
        const backend = makeManager({
          records: new Map([[operationA, managed(operationA, "prepared")]]),
        });
        const coordinator = yield* createExtensionInstallation({
          manager: backend.manager,
          uploads: uploads.store,
          profileId: "profile-a",
          review: () => Deferred.await(decision),
          onFailure: () => Effect.void,
        });
        const first = yield* coordinator.forOwner(owner());
        const second = yield* coordinator.forOwner(owner());
        assert.equal((yield* first.requestReview(operationA)).state, "reviewing");
        assert.equal((yield* Effect.exit(second.requestReview(operationA)))._tag, "Failure");
        const foreign = yield* coordinator.forOwner({
          principal: "plugin-b",
          grantId: "grant-b",
          authorize: Effect.void,
        });
        assert.equal((yield* Effect.exit(foreign.status(operationA)))._tag, "Failure");
      }),
    ),
  );
});

test("native denial removes only the prepared artifact and exposes a safe rejected status", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const records = new Map([[operationA, managed(operationA, "prepared")]]);
        const backend = makeManager({ records });
        const coordinator = yield* createExtensionInstallation({
          manager: backend.manager,
          uploads: makeUploadStore().store,
          profileId: "profile-a",
          review: () => Effect.succeed(false),
          onFailure: () => Effect.void,
        });
        const api = yield* coordinator.forOwner(owner());
        yield* api.requestReview(operationA);
        yield* Effect.yieldNow;
        const result = yield* api.status(operationA);
        assert.equal(result.state, "rejected");
        assert.equal(result.extension, undefined);
        assert.equal(records.size, 0);
      }),
    ),
  );
});

test("cancel waits for an admitted installation and returns its durable enabled state", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const confirmStarted = yield* Deferred.make<void>();
        const confirmGate = yield* Deferred.make<void>();
        const records = new Map([[operationA, managed(operationA, "prepared")]]);
        const backend = makeManager({ records, confirmStarted, confirmGate });
        const coordinator = yield* createExtensionInstallation({
          manager: backend.manager,
          uploads: makeUploadStore().store,
          profileId: "profile-a",
          review: () => Effect.succeed(true),
          onFailure: () => Effect.void,
        });
        const api = yield* coordinator.forOwner(owner());
        yield* api.requestReview(operationA);
        yield* Deferred.await(confirmStarted);
        const cancellation = yield* Effect.forkChild(api.cancel(operationA));
        yield* Effect.yieldNow;
        assert.equal(records.get(operationA)!.state, "installing");
        yield* Deferred.succeed(confirmGate, undefined);
        const result = yield* Fiber.join(cancellation);
        assert.equal(result.state, "enabled");
        assert.equal(records.get(operationA)!.state, "enabled");
      }),
    ),
  );
});

test("revocation closes receiving uploads and restarted ports recover exact persisted operations", async () => {
  let allowed = true;
  const authorization = Effect.suspend(() =>
    allowed ? Effect.void : Effect.fail(new Error("revoked")),
  );
  const app = await Effect.runPromise(Scope.make());
  const port = await Effect.runPromise(Scope.make());
  const uploads = makeUploadStore();
  const records = new Map([[operationB, managed(operationB, "prepared")]]);
  const backend = makeManager({ records });
  const coordinator = await Effect.runPromise(
    createExtensionInstallation({
      manager: backend.manager,
      uploads: uploads.store,
      profileId: "profile-a",
      review: () => Effect.never,
      onFailure: () => Effect.void,
    }).pipe(Effect.provideService(Scope.Scope, app)),
  );
  const api = await Effect.runPromise(
    coordinator.forOwner(owner(authorization)).pipe(Effect.provideService(Scope.Scope, port)),
  );
  await Effect.runPromise(api.begin());
  assert.equal((await Effect.runPromise(api.status(operationB))).state, "awaiting_review");
  allowed = false;
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(Effect.runPromise(api.list()));
  assert.equal(uploads.sessions.size, 0);
  assert.equal(uploads.closes(), 1);
  await Effect.runPromise(Scope.close(port, Exit.void));
  await Effect.runPromise(Scope.close(app, Exit.void));
});

test("a failed review remains cancelable and cancellation abandons its prepared record", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const records = new Map([[operationA, managed(operationA, "prepared")]]);
        const backend = makeManager({ records });
        const coordinator = yield* createExtensionInstallation({
          manager: backend.manager,
          uploads: makeUploadStore().store,
          profileId: "profile-a",
          review: () =>
            Effect.fail(new EngineError({ code: "review", message: "review unavailable" })),
          onFailure: () => Effect.void,
        });
        const api = yield* coordinator.forOwner(owner());
        yield* api.requestReview(operationA);
        yield* Effect.yieldNow;
        assert.equal((yield* api.status(operationA)).state, "error");
        assert.equal((yield* api.cancel(operationA)).state, "canceled");
        assert.equal(records.size, 0);
      }),
    ),
  );
});

test("status refreshes expired uploads and durable removal over an old enabled job", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const uploads = makeUploadStore([operationA]);
        const records = new Map<string, Record>();
        const backend = makeManager({ records });
        const coordinator = yield* createExtensionInstallation({
          manager: backend.manager,
          uploads: uploads.store,
          profileId: "profile-a",
          review: () => Effect.succeed(true),
          onFailure: () => Effect.void,
        });
        const api = yield* coordinator.forOwner(owner());
        yield* api.begin();
        uploads.sessions.delete(operationA);
        const expired = yield* api.status(operationA);
        assert.equal(expired.state, "error");
        assert.equal(expired.error, "expired");

        records.set(operationB, managed(operationB, "prepared"));
        yield* api.requestReview(operationB);
        yield* Effect.yieldNow;
        assert.equal((yield* api.status(operationB)).state, "enabled");
        records.set(operationB, { ...records.get(operationB)!, state: "removed" });
        assert.equal((yield* api.status(operationB)).state, "removed");
        assert.equal((yield* api.cancel(operationB)).state, "removed");
      }),
    ),
  );
});

test("global ephemeral admission is bounded at 32 live jobs", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ids = Array.from({ length: 33 }, (_, index) => index.toString(16).padStart(32, "0"));
        const coordinator = yield* createExtensionInstallation({
          manager: makeManager().manager,
          uploads: makeUploadStore(ids).store,
          profileId: "profile-a",
          review: () => Effect.succeed(false),
          onFailure: () => Effect.void,
        });
        const api = yield* coordinator.forOwner(owner());
        for (let index = 0; index < 32; index++) yield* api.begin();
        assert.equal((yield* Effect.exit(api.begin()))._tag, "Failure");
      }),
    ),
  );
});

test("closing an owner waits for its prompt to stop and abandons only its prepared record", async () => {
  const app = await Effect.runPromise(Scope.make());
  const port = await Effect.runPromise(Scope.make());
  const records = new Map([
    [operationA, managed(operationA, "prepared")],
    [operationB, managed(operationB, "enabled")],
  ]);
  const coordinator = await Effect.runPromise(
    createExtensionInstallation({
      manager: makeManager({ records }).manager,
      uploads: makeUploadStore().store,
      profileId: "profile-a",
      review: () => Effect.never,
      onFailure: () => Effect.void,
    }).pipe(Effect.provideService(Scope.Scope, app)),
  );
  const api = await Effect.runPromise(
    coordinator.forOwner(owner()).pipe(Effect.provideService(Scope.Scope, port)),
  );
  await Effect.runPromise(api.requestReview(operationA));
  await Effect.runPromise(Scope.close(port, Exit.void));
  assert.equal(records.has(operationA), false);
  assert.equal(records.get(operationB)!.state, "enabled");
  await Effect.runPromise(Scope.close(app, Exit.void));
});
