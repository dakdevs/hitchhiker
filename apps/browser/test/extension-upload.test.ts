import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Deferred, Effect, Fiber, Scope } from "effect";
import {
  createExtensionUploadStore,
  type ExtensionUploadOwner,
  type ExtensionUploadStore,
} from "../src/extension-upload.ts";
import type { ProfileWriteLease } from "../src/profile-write-lease.ts";

const lease = (profileRoot: string): ProfileWriteLease => ({
  profileRoot,
  assertHeld: Effect.void,
  withWrite: (operation) => operation,
});
const useStore = <A>(
  profile: string,
  use: (
    store: ExtensionUploadStore,
    owner: ExtensionUploadOwner,
  ) => Effect.Effect<A, unknown, Scope.Scope>,
  limits: {
    testIdleMs?: number;
    testAbsoluteMs?: number;
    testMaxEntries?: number;
    testMaxFileBytes?: number;
    testMaxTotalBytes?: number;
    testMaxManifestBytes?: number;
  } = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* createExtensionUploadStore({
          profileLease: lease(profile),
          ...limits,
        });
        const owner = yield* store.forOwner(Effect.void);
        return yield* use(store, owner);
      }),
    ),
  );
const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64");

const profile = async () => realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-upload-")));

test("uploads binary chunks with replay acknowledgement and removes its private directory after consume", async () => {
  const root = await profile();
  try {
    const bytes = Buffer.from([0, 255, 14, 10, 128, 3]);
    const observed = await useStore(root, (store, owner) =>
      Effect.gen(function* () {
        const upload = yield* owner.begin();
        yield* owner.beginFile(upload.uploadId, "manifest.json", bytes.length);
        const first = bytes.subarray(0, 3);
        const accepted = yield* owner.append(upload.uploadId, 0, b64(first));
        assert.equal(accepted.file?.offset, first.length);
        const replay = yield* owner.append(upload.uploadId, 0, b64(first));
        assert.equal(replay.file?.offset, first.length);
        const finalOffset = first.length;
        const finalBytes = bytes.subarray(finalOffset);
        yield* owner.append(upload.uploadId, finalOffset, b64(finalBytes));
        yield* owner.append(upload.uploadId, finalOffset, b64(finalBytes));
        yield* Effect.flip(owner.append(upload.uploadId, finalOffset + 1, b64(finalBytes)));
        const response = yield* owner.consume(upload.uploadId, (directory) =>
          Effect.tryPromise({
            try: () => readFile(join(directory, "manifest.json")),
            catch: () => new Error("read failed"),
          }),
        );
        assert.deepEqual(response, bytes);
        return upload.uploadId;
      }),
    );
    await assert.rejects(lstat(join(root, "hitchhiker-extension-uploads", observed)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects traversal, symlink parents, malformed chunks, and host paths never enter snapshots", async () => {
  const root = await profile();
  const outside = await profile();
  try {
    await useStore(root, (store, owner) =>
      Effect.gen(function* () {
        const upload = yield* owner.begin();
        for (const path of [
          "../manifest.json",
          "/manifest.json",
          "a\\b",
          "a//b",
          "a/../b",
          "a\u0000b",
        ])
          yield* Effect.flip(owner.beginFile(upload.uploadId, path, 1));
        yield* owner.beginFile(upload.uploadId, "safe.bin", 1);
        yield* Effect.flip(owner.append(upload.uploadId, 0, "not base64!"));
        yield* Effect.flip(owner.append(upload.uploadId, 0, b64(Buffer.alloc(65_537))));
        yield* owner.append(upload.uploadId, 0, b64("x"));
        const json = JSON.stringify(yield* owner.status(upload.uploadId));
        assert.equal(json.includes(root), false);
        assert.equal(json.includes("directory"), false);

        const directory = join(root, "hitchhiker-extension-uploads", upload.uploadId);
        yield* Effect.promise(() => symlink(outside, join(directory, "nested")));
        yield* Effect.flip(owner.beginFile(upload.uploadId, "nested/file", 1));
        return undefined;
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("enforces owner isolation, cancellation and failed-consume cleanup", async () => {
  const root = await profile();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* createExtensionUploadStore({ profileLease: lease(root) });
          const first = yield* store.forOwner(Effect.void);
          const second = yield* store.forOwner(Effect.void);
          const upload = yield* first.begin();
          yield* Effect.flip(second.status(upload.uploadId));
          yield* Effect.flip(second.cancel(upload.uploadId));
          yield* first.cancel(upload.uploadId);
          yield* Effect.flip(first.status(upload.uploadId));

          const failed = yield* first.begin();
          yield* first.beginFile(failed.uploadId, "manifest.json", 0);
          const directory = join(root, "hitchhiker-extension-uploads", failed.uploadId);
          yield* Effect.flip(second.consume(failed.uploadId, () => Effect.void));
          const callbackExit = yield* first
            .consume(failed.uploadId, () => {
              throw new Error("manager refused synchronously");
            })
            .pipe(Effect.exit);
          assert.equal(callbackExit._tag, "Failure");
          yield* Effect.promise(() =>
            lstat(directory).then(
              () => Promise.reject(new Error("upload directory remained")),
              () => undefined,
            ),
          );
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("limits the profile to one live upload, rechecks authorization, and counts implicit directories", async () => {
  const root = await profile();
  try {
    let checks = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const profileLease = lease(root);
          const store = yield* createExtensionUploadStore({
            profileLease,
            testMaxEntries: 3,
          });
          yield* Effect.flip(createExtensionUploadStore({ profileLease }));
          const first = yield* store.forOwner(Effect.void);
          const second = yield* store.forOwner(Effect.void);
          const upload = yield* first.begin();
          yield* Effect.flip(second.begin());
          yield* first.beginFile(upload.uploadId, "one/a", 0);
          yield* first.beginFile(upload.uploadId, "one/b", 0);
          yield* Effect.flip(first.beginFile(upload.uploadId, "one/c", 0));

          const changed = yield* store.forOwner(
            Effect.try({
              try: () => {
                checks += 1;
                if (checks === 2) throw new Error("grant revoked while queued");
              },
              catch: (error) => error,
            }),
          );
          yield* first.cancel(upload.uploadId);
          yield* Effect.flip(changed.begin());
          assert.equal(checks, 2);
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not cancel or expire a consuming upload while its trusted callback is running", async () => {
  const root = await profile();
  try {
    await useStore(root, (store, owner) =>
      Effect.gen(function* () {
        const upload = yield* owner.begin();
        yield* owner.beginFile(upload.uploadId, "manifest.json", 0);
        let authorized = true;
        const changed = yield* store.forOwner(
          Effect.suspend(() =>
            authorized ? Effect.void : Effect.fail(new Error("grant revoked while awaiting lock")),
          ),
        );
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const running = yield* owner
          .consume(upload.uploadId, (directory) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(directory),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Effect.promise(() =>
          lstat(join(root, "hitchhiker-extension-uploads", upload.uploadId)).then(() => undefined),
        );
        assert.equal((yield* owner.status(upload.uploadId)).state, "consuming");
        const cancelled = yield* Effect.flip(owner.cancel(upload.uploadId)).pipe(Effect.forkScoped);
        const swept = yield* store.expire().pipe(Effect.forkScoped);
        const queuedAfterOuterAuthorization = yield* Effect.flip(changed.begin()).pipe(
          Effect.forkScoped,
        );
        authorized = false;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        yield* Fiber.join(cancelled);
        yield* Fiber.join(queuedAfterOuterAuthorization);
        yield* Fiber.join(swept);
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces manifest, file, aggregate, and current-file retry bounds", async () => {
  const root = await profile();
  try {
    await useStore(
      root,
      (_store, owner) =>
        Effect.gen(function* () {
          const upload = yield* owner.begin();
          yield* Effect.flip(owner.beginFile(upload.uploadId, "manifest.json", 5));
          yield* Effect.flip(owner.beginFile(upload.uploadId, "large.bin", 6));
          yield* owner.beginFile(upload.uploadId, "a.bin", 5);
          yield* owner.beginFile(upload.uploadId, "a.bin", 5);
          yield* owner.append(upload.uploadId, 0, b64("abcde"));
          yield* Effect.flip(owner.beginFile(upload.uploadId, "b.bin", 2));
        }),
      { testMaxManifestBytes: 4, testMaxFileBytes: 5, testMaxTotalBytes: 6 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a retained owner port closes with its scope", async () => {
  const root = await profile();
  let retained: ExtensionUploadOwner | undefined;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* createExtensionUploadStore({ profileLease: lease(root) });
          retained = yield* store.forOwner(Effect.void);
        }),
      ),
    );
    assert.ok(retained);
    await assert.rejects(Effect.runPromise(retained.begin()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expiration and root tampering reject stale uploads without following links", async () => {
  const root = await profile();
  const outside = await profile();
  try {
    await useStore(
      root,
      (store, owner) =>
        Effect.gen(function* () {
          const upload = yield* owner.begin();
          yield* store.expire();
          yield* Effect.flip(owner.status(upload.uploadId));
          const uploadRoot = join(root, "hitchhiker-extension-uploads");
          const original = yield* Effect.promise(() => lstat(uploadRoot, { bigint: true }));
          yield* Effect.promise(() => rm(uploadRoot, { recursive: true }));
          yield* Effect.promise(() => symlink(outside, uploadRoot));
          const replacement = yield* Effect.promise(() => lstat(uploadRoot, { bigint: true }));
          assert.notEqual(replacement.ino, original.ino);
          assert.equal(replacement.isSymbolicLink(), true);
          yield* Effect.flip(owner.begin());
        }),
      { testIdleMs: 0 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
