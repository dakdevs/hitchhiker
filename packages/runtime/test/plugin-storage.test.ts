import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Exit, Fiber, Scope } from "effect";
import {
  createPluginStorage,
  type PluginStorage,
  type PluginStorageError,
} from "../src/plugin-storage.ts";

const makeProfile = () => mkdtemp(join(tmpdir(), "hitchhiker-plugin-storage-"));

const withStore = <A>(
  profileRoot: string,
  use: (store: PluginStorage) => Effect.Effect<A, unknown, Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* createPluginStorage({ profileRoot });
        return yield* use(store);
      }),
    ),
  );

const expectCode = <A>(
  effect: Effect.Effect<A, PluginStorageError>,
  code: PluginStorageError["code"],
) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    assert.equal(error.code, code);
  });

test("storage persists across scopes, isolates owners, and removes only the selected owner", async () => {
  const profileRoot = await makeProfile();
  try {
    await withStore(profileRoot, (store) =>
      Effect.gen(function* () {
        const first = yield* store.forOwner("first-plugin");
        const second = yield* store.forOwner("second-plugin");
        assert.deepEqual(yield* first.read(), { revision: 0, value: null });
        assert.deepEqual(yield* second.read(), { revision: 0, value: null });
        assert.deepEqual(yield* first.write(0, { pinned: ["page-1"], enabled: true }), {
          revision: 1,
        });
        yield* expectCode(first.write(0, null), "conflict");
        assert.deepEqual(yield* second.write(0, [1, "two", false]), { revision: 1 });
      }),
    );

    await withStore(profileRoot, (store) =>
      Effect.gen(function* () {
        const first = yield* store.forOwner("first-plugin");
        const second = yield* store.forOwner("second-plugin");
        assert.deepEqual(yield* first.read(), {
          revision: 1,
          value: { pinned: ["page-1"], enabled: true },
        });
        assert.deepEqual(yield* second.read(), { revision: 1, value: [1, "two", false] });
        assert.deepEqual(yield* first.write(1, { pinned: [] }), { revision: 2 });
        yield* store.remove("first-plugin");
        yield* store.remove("first-plugin");
        assert.deepEqual(yield* first.read(), { revision: 0, value: null });
        assert.deepEqual(yield* second.read(), { revision: 1, value: [1, "two", false] });
      }),
    );

    const file = join(profileRoot, "hitchhiker-plugins", "storage", "second-plugin.json");
    assert.equal((await stat(file)).mode & 0o077, 0);
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
});

test("CAS is serialized across live store instances", async () => {
  const profileRoot = await makeProfile();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const leftStore = yield* createPluginStorage({ profileRoot });
          const rightStore = yield* createPluginStorage({ profileRoot });
          const left = yield* leftStore.forOwner("shared-plugin");
          const right = yield* rightStore.forOwner("shared-plugin");
          const result = yield* Effect.all(
            [left.write(0, { writer: "left" }), right.write(0, { writer: "right" })].map((write) =>
              write.pipe(
                Effect.as("written" as const),
                Effect.catch((error) => Effect.succeed(error.code)),
              ),
            ),
            { concurrency: "unbounded" },
          );
          assert.deepEqual([...result].sort(), ["conflict", "written"]);
          const snapshot = yield* left.read();
          assert.equal(snapshot.revision, 1);
          assert(
            JSON.stringify(snapshot.value) === '{"writer":"left"}' ||
              JSON.stringify(snapshot.value) === '{"writer":"right"}',
          );
        }),
      ),
    );
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
});

test("an admitted write finishes durably when its caller is interrupted", async () => {
  const profileRoot = await makeProfile();
  try {
    await withStore(profileRoot, (store) =>
      Effect.gen(function* () {
        const owner = yield* store.forOwner("cancel-plugin");
        const value = { payload: "x".repeat(120 * 1024) };
        const fiber = yield* Effect.forkScoped(owner.write(0, value));
        // Let the child pass synchronous validation and acquire the shared write permit.
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        assert.deepEqual(yield* owner.read(), { revision: 1, value });
        const directory = join(profileRoot, "hitchhiker-plugins", "storage");
        const entries = yield* Effect.promise(() =>
          import("node:fs/promises").then((fs) => fs.readdir(directory)),
        );
        assert.deepEqual(entries, ["cancel-plugin.json"]);
      }),
    );
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
});

test("writes reject unsafe JSON, excess structure, size, and revisions without mutation", async () => {
  const profileRoot = await makeProfile();
  try {
    await withStore(profileRoot, (store) =>
      Effect.gen(function* () {
        const owner = yield* store.forOwner("bounded-plugin");
        let getterCalled = false;
        const accessor = Object.defineProperty({}, "secret", {
          enumerable: true,
          get: () => {
            getterCalled = true;
            return "secret";
          },
        });
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        const nested = (levels: number) => {
          let value: unknown = null;
          for (let index = 0; index < levels; index++) value = { next: value };
          return value;
        };
        const boundary = yield* store.forOwner("boundary-plugin");
        assert.deepEqual(yield* boundary.write(0, nested(32)), { revision: 1 });
        assert.deepEqual(
          yield* boundary.write(
            1,
            Array.from({ length: 4_095 }, () => null),
          ),
          { revision: 2 },
        );
        assert.deepEqual(yield* boundary.write(2, "x".repeat(128 * 1024 - 2)), { revision: 3 });

        yield* expectCode(owner.write(0, accessor), "invalid");
        assert.equal(getterCalled, false);
        yield* expectCode(owner.write(0, cycle), "invalid");
        yield* expectCode(owner.write(0, nested(33)), "invalid");
        yield* expectCode(
          owner.write(
            0,
            Array.from({ length: 4_096 }, () => null),
          ),
          "invalid",
        );
        yield* expectCode(owner.write(0, "x".repeat(128 * 1024 + 1)), "invalid");
        yield* expectCode(owner.write(Number.MAX_SAFE_INTEGER, null), "invalid");
        yield* expectCode(owner.write(-1, null), "invalid");
        yield* expectCode(owner.write(0, new Proxy({}, {})), "invalid");
        assert.deepEqual(yield* owner.read(), { revision: 0, value: null });
      }),
    );
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
});

test("owner paths, symbolic links, hard links, and oversized files are rejected", async () => {
  const profileRoot = await makeProfile();
  try {
    await withStore(profileRoot, (store) =>
      Effect.gen(function* () {
        yield* expectCode(store.forOwner("../escape"), "invalid");
        yield* expectCode(store.forOwner("a"), "invalid");
        yield* expectCode(store.remove("other/plugin"), "invalid");

        const directory = join(profileRoot, "hitchhiker-plugins", "storage");
        const outside = join(profileRoot, "outside.json");
        const body = JSON.stringify({ version: 1, revision: 1, value: { outside: true } });
        yield* Effect.promise(async () => {
          await writeFile(outside, body, { mode: 0o600 });
          await chmod(outside, 0o600);
          await symlink(outside, join(directory, "linked-plugin.json"));
        });
        const symbolic = yield* store.forOwner("linked-plugin");
        yield* expectCode(symbolic.read(), "persistence");
        yield* expectCode(symbolic.write(0, null), "persistence");
        yield* expectCode(store.remove("linked-plugin"), "persistence");
        assert.equal(yield* Effect.promise(() => readFile(outside, "utf8")), body);
        yield* Effect.promise(() => rm(join(directory, "linked-plugin.json")));

        yield* Effect.promise(() => link(outside, join(directory, "hardlink-plugin.json")));
        const hardlink = yield* store.forOwner("hardlink-plugin");
        yield* expectCode(hardlink.read(), "persistence");
        yield* expectCode(store.remove("hardlink-plugin"), "persistence");
        assert.equal(yield* Effect.promise(() => readFile(outside, "utf8")), body);

        yield* Effect.promise(() =>
          writeFile(join(directory, "large-plugin.json"), Buffer.alloc(128 * 1024 + 1_025), {
            mode: 0o600,
          }),
        );
        const large = yield* store.forOwner("large-plugin");
        yield* expectCode(large.read(), "persistence");
      }),
    );
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
});

test("storage directories cannot redirect through links and adapters close with their scope", async () => {
  const profileRoot = await makeProfile();
  const outside = await makeProfile();
  try {
    await mkdir(join(profileRoot, "hitchhiker-plugins"));
    await symlink(outside, join(profileRoot, "hitchhiker-plugins", "storage"));
    const linkedDirectory = await Effect.runPromise(
      Effect.exit(Effect.scoped(createPluginStorage({ profileRoot }))),
    );
    assert(Exit.isFailure(linkedDirectory));

    await rm(join(profileRoot, "hitchhiker-plugins"), { recursive: true, force: true });
    const adapter = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* createPluginStorage({ profileRoot });
          return yield* store.forOwner("closed-plugin");
        }),
      ),
    );
    assert(Exit.isFailure(await Effect.runPromise(Effect.exit(adapter.read()))));
    assert(Exit.isFailure(await Effect.runPromise(Effect.exit(adapter.write(0, null)))));
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
