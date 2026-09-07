import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Clock, Effect, FileSystem } from "effect";
import { create, type GrantIssue } from "../src/grants.ts";

const key = "default-bootstrap/1/default-tab-model";
const request: GrantIssue = {
  principal: "default-tab-model",
  profileId: "default",
  capabilities: ["pages.list", "storage.local"],
  origins: [],
};
const withDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-managed-grants-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("managed grants converge across instances and restart without adopting unmanaged authority or rewriting", async () => {
  await withDirectory(async (directory) => {
    const managed = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* create({ directory });
        const second = yield* create({ directory });
        const unmanaged = yield* first.issue(request);
        const grants = yield* Effect.all(
          [first.ensureManaged(key, request), second.ensureManaged(key, request)],
          { concurrency: 2 },
        );
        assert.equal(grants[0].id, grants[1].id);
        assert.notEqual(grants[0].id, unmanaged.grant.id);
        assert.equal((yield* first.list()).length, 2);
        assert.equal("token" in grants[0], false);
        assert.equal("managedKey" in grants[0], false);
        return grants[0];
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    const before = await readFile(join(directory, "grants.json"), "utf8");
    const inode = (await stat(join(directory, "grants.json"))).ino;
    await Effect.runPromise(
      Effect.gen(function* () {
        const restarted = yield* create({ directory });
        assert.deepEqual(
          yield* restarted.ensureManaged(key, {
            ...request,
            capabilities: [...request.capabilities].reverse(),
          }),
          managed,
        );
        assert.equal(
          (yield* restarted.authorizeGrant(managed.id, {
            profileId: "default",
            capability: "storage.local",
          })).principal,
          request.principal,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    assert.equal(await readFile(join(directory, "grants.json"), "utf8"), before);
    assert.equal((await stat(join(directory, "grants.json"))).ino, inode);
  });
});

test("managed grant retry recovers a durable write whose final acknowledgement failed", async () => {
  await withDirectory(async (directory) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let injected = false;
        const interrupted = yield* create({ directory }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            chmod: (path, mode) => {
              if (path === join(directory, "grants.json") && !injected) {
                injected = true;
                // write() has already renamed the private file at this point.
                return fs.chmod(join(directory, "missing-for-injected-failure"), mode);
              }
              return fs.chmod(path, mode);
            },
          }),
        );
        const error = yield* interrupted.ensureManaged(key, request).pipe(Effect.flip);
        assert.equal(error.code, "persistence");
        assert.equal(injected, true);
        const restarted = yield* create({ directory });
        const before = yield* restarted.list();
        assert.equal(before.length, 1);
        assert.deepEqual(yield* restarted.ensureManaged(key, request), before[0]);
        assert.equal((yield* restarted.list()).length, 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});

test("managed keys reject changed requests, invalid keys and revoked or expired authority", async () => {
  await withDirectory(async (directory) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* create({ directory });
        const grant = yield* store.ensureManaged(key, request);
        const before = yield* Effect.promise(() =>
          readFile(join(directory, "grants.json"), "utf8"),
        );
        for (const changed of [
          { ...request, principal: "another-plugin" },
          { ...request, profileId: "another-profile" },
          { ...request, capabilities: ["pages.manage"] as const },
          { ...request, origins: ["https://example.test"] },
          { ...request, expiresAt: 1 },
        ])
          assert.equal(
            (yield* store.ensureManaged(key, changed).pipe(Effect.flip)).code,
            "managed-conflict",
          );
        for (const invalid of ["", "x".repeat(129), "invalid\nkey", "invalid\n"])
          assert.equal(
            (yield* store.ensureManaged(invalid, request).pipe(Effect.flip)).code,
            "invalid-grant",
          );
        assert.equal(
          (yield* store.ensureManaged("expired", { ...request, expiresAt: 0 }).pipe(Effect.flip))
            .code,
          "denied",
        );
        assert.equal(
          yield* Effect.promise(() => readFile(join(directory, "grants.json"), "utf8")),
          before,
        );
        yield* store.revoke(grant.id);
        assert.equal((yield* store.ensureManaged(key, request).pipe(Effect.flip)).code, "denied");
        assert.equal((yield* store.list()).length, 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});

test("duplicate managed keys and managed delegation records reject the whole store without repair", async () => {
  await withDirectory(async (directory) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* create({ directory });
        yield* store.ensureManaged(key, request);
        yield* store.issue({ ...request, principal: "peer" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    const path = join(directory, "grants.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    for (const corrupted of [
      {
        ...original,
        grants: original.grants.map((entry: object) => ({ ...entry, managedKey: key })),
      },
      {
        ...original,
        grants: original.grants.map((entry: object, index: number) =>
          index === 0 ? { ...entry, parentId: original.grants[1].grant.id } : entry,
        ),
      },
    ]) {
      const bytes = JSON.stringify(corrupted);
      await writeFile(path, bytes);
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* create({ directory });
          assert.equal(
            (yield* store.ensureManaged(key, request).pipe(Effect.flip)).code,
            "invalid-store",
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      assert.equal(await readFile(path, "utf8"), bytes);
    }
  });
});

test("an expired managed grant is never renewed by replay", async () => {
  await withDirectory(async (directory) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const at = <A, E>(time: number, effect: Effect.Effect<A, E>) =>
          effect.pipe(
            Effect.provideService(Clock.Clock, {
              currentTimeMillisUnsafe: () => time,
              currentTimeMillis: Effect.succeed(time),
              currentTimeNanosUnsafe: () => BigInt(time) * 1_000_000n,
              currentTimeNanos: Effect.succeed(BigInt(time) * 1_000_000n),
              monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
              monotonicTimeNanos: clock.monotonicTimeNanos,
              sleep: (duration) => clock.sleep(duration),
            }),
          );
        const store = yield* create({ directory });
        const expiring = { ...request, expiresAt: 1 };
        const grant = yield* at(0, store.ensureManaged(key, expiring));
        const before = yield* Effect.promise(() =>
          readFile(join(directory, "grants.json"), "utf8"),
        );
        const inode = yield* Effect.promise(() => stat(join(directory, "grants.json")));
        assert.equal(
          (yield* at(2, store.ensureManaged(key, expiring)).pipe(Effect.flip)).code,
          "denied",
        );
        assert.deepEqual(yield* store.list(), [grant]);
        assert.equal(
          yield* Effect.promise(() => readFile(join(directory, "grants.json"), "utf8")),
          before,
        );
        assert.equal(
          (yield* Effect.promise(() => stat(join(directory, "grants.json")))).ino,
          inode.ino,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});
