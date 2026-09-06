import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GrantStoreApi } from "@hitchhiker/runtime";
import { Deferred, Effect, Fiber } from "effect";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { createPluginManager } from "../src/plugin-manager.ts";

const manifest = {
  id: "cancellation-plugin",
  name: "Cancellation plugin",
  version: "1.0.0",
  capabilities: ["pages.list"],
};
const grants = {
  authenticateGrant: () => Effect.succeed({ principal: manifest.id, grant: {} }),
  authorizeGrant: () => Effect.succeed({ principal: manifest.id, grant: {} }),
} as unknown as GrantStoreApi;
const launch = (_artifact: unknown, _grant: string, ready: Effect.Effect<void>) =>
  ready.pipe(Effect.andThen(Effect.never));

// This test file runs in its own Node test process. Synchronize the built-in
// named export to pause actual registry I/O without adding a production hook.
for (const operation of ["initial", "update", "rollback", "enable", "disable"] as const) {
  test(
    `${operation} cancellation retains the mutation lock until registry rename settles`,
    { timeout: 10_000 },
    async () => {
      const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "hitchhiker-cancel-rename-")));
      const originalRename = fs.rename;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let armed = false;
      let gated = false;
      fs.rename = async (source, destination) => {
        if (armed && !gated && destination === join(root, "hitchhiker-plugins", "plugins.json")) {
          gated = true;
          entered.resolve();
          await release.promise;
        }
        return originalRename(source, destination);
      };
      syncBuiltinESMExports();
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const artifacts = yield* createPluginArtifactStore(root);
              const stable = yield* artifacts.stage({ manifest, code: "stable" });
              const candidate = yield* artifacts.stage({
                manifest: { ...manifest, version: "2.0.0" },
                code: "candidate",
              });
              const manager = yield* createPluginManager({ profileRoot: root, grants, launch });
              if (operation !== "initial") yield* manager.install(stable.hash, "grant");
              if (operation === "rollback") yield* manager.install(candidate.hash, "grant");
              if (operation === "enable") yield* manager.disable(manifest.id);
              const action =
                operation === "rollback"
                  ? manager.rollback(manifest.id)
                  : operation === "enable"
                    ? manager.enable(manifest.id)
                    : operation === "disable"
                      ? manager.disable(manifest.id)
                      : manager.install(
                          operation === "initial" ? stable.hash : candidate.hash,
                          "grant",
                        );
              try {
                armed = true;
                const mutation = yield* action.pipe(Effect.forkScoped);
                yield* Effect.promise(() => entered.promise).pipe(Effect.timeout(3_000));
                const interruption = yield* Fiber.interrupt(mutation).pipe(
                  Effect.forkScoped({ startImmediately: true }),
                );
                // Immediate observation is intentional: the real rename is still
                // blocked, so cancellation must not have completed or unlocked it.
                assert.equal(interruption.pollUnsafe(), undefined);
                yield* Effect.promise(() =>
                  fs.access(join(root, "hitchhiker-plugins", ".plugin-write-lock")),
                );
                const contender = yield* createPluginManager({ profileRoot: root, grants, launch });
                const failure = yield* contender.restore().pipe(Effect.flip);
                assert.match(failure.message, /mutation lock is held/);
                release.resolve();
                yield* Fiber.join(interruption).pipe(Effect.timeout(4_000));
                const [plugin] = yield* manager.list();
                assert.equal(plugin.hash, operation === "rollback" ? candidate.hash : stable.hash);
                if (operation === "rollback") assert.equal(plugin.previousVersion, "1.0.0");
                const active = operation === "update" || operation === "rollback";
                assert.equal(plugin.enabled, active);
                assert.equal(plugin.running, active);
                assert.equal(
                  (yield* Effect.promise(() => fs.readdir(join(root, "hitchhiker-plugins")))).some(
                    (name) => name.endsWith(".tmp") || name === ".plugin-write-lock",
                  ),
                  false,
                );
              } finally {
                release.resolve();
              }
            }),
          ),
        );
      } finally {
        release.resolve();
        fs.rename = originalRename;
        syncBuiltinESMExports();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
}

test(
  "failed recovery prevents further plugin mutations until restart",
  { timeout: 10_000 },
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "hitchhiker-cancel-recovery-")));
    const originalRename = fs.rename;
    let failWrites = false;
    let writes = 0;
    fs.rename = async (source, destination) => {
      if (failWrites && destination === join(root, "hitchhiker-plugins", "plugins.json")) {
        writes++;
        if (writes === 1) await originalRename(source, destination);
        throw new Error("injected persistence failure");
      }
      return originalRename(source, destination);
    };
    syncBuiltinESMExports();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const artifacts = yield* createPluginArtifactStore(root);
            const stable = yield* artifacts.stage({ manifest, code: "stable" });
            const candidate = yield* artifacts.stage({
              manifest: { ...manifest, version: "2.0.0" },
              code: "candidate",
            });
            const manager = yield* createPluginManager({ profileRoot: root, grants, launch });
            yield* manager.install(stable.hash, "grant");
            failWrites = true;
            yield* manager.install(candidate.hash, "grant").pipe(Effect.flip);
            assert.equal(writes, 2, "failed promotion must attempt durable recovery");
            failWrites = false;
            const denied = yield* manager.disable(manifest.id).pipe(Effect.flip);
            assert.match(denied.message, /restart required/);
            assert.equal(writes, 2);
            const restarted = yield* createPluginManager({ profileRoot: root, grants, launch });
            yield* restarted.restore();
            const [plugin] = yield* restarted.list();
            assert.equal(plugin.hash, stable.hash);
            assert.equal(plugin.running, true);
          }),
        ),
      );
    } finally {
      fs.rename = originalRename;
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("failed disable persistence prevents subsequent mutations", { timeout: 10_000 }, async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "hitchhiker-disable-persistence-")),
  );
  const originalRename = fs.rename;
  let failWrites = false;
  fs.rename = async (source, destination) => {
    if (failWrites && destination === join(root, "hitchhiker-plugins", "plugins.json"))
      throw new Error("injected persistence failure");
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const stable = yield* artifacts.stage({ manifest, code: "stable" });
          const manager = yield* createPluginManager({ profileRoot: root, grants, launch });
          yield* manager.install(stable.hash, "grant");
          failWrites = true;
          yield* manager.disable(manifest.id).pipe(Effect.flip);
          failWrites = false;
          const denied = yield* manager.enable(manifest.id).pipe(Effect.flip);
          assert.match(denied.message, /restart required/);
          assert.equal((yield* manager.list())[0].running, false);
        }),
      ),
    );
  } finally {
    fs.rename = originalRename;
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "failed crash recovery persistence prevents subsequent mutations",
  { timeout: 10_000 },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "hitchhiker-crash-persistence-")),
    );
    const originalRename = fs.rename;
    const attempted = Promise.withResolvers<void>();
    let failWrites = false;
    fs.rename = async (source, destination) => {
      if (failWrites && destination === join(root, "hitchhiker-plugins", "plugins.json")) {
        attempted.resolve();
        throw new Error("injected persistence failure");
      }
      return originalRename(source, destination);
    };
    syncBuiltinESMExports();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const crash = yield* Deferred.make<void>();
            const artifacts = yield* createPluginArtifactStore(root);
            const stable = yield* artifacts.stage({ manifest, code: "stable" });
            const manager = yield* createPluginManager({
              profileRoot: root,
              grants,
              launch: (_artifact, _grant, ready) =>
                ready.pipe(
                  Effect.andThen(Deferred.await(crash)),
                  Effect.andThen(Effect.fail("injected host exit")),
                ),
            });
            yield* manager.install(stable.hash, "grant");
            failWrites = true;
            yield* Deferred.succeed(crash, undefined);
            yield* Effect.promise(() => attempted.promise).pipe(Effect.timeout(3_000));
            failWrites = false;
            const denied = yield* manager.enable(manifest.id).pipe(Effect.flip);
            assert.match(denied.message, /restart required/);
            assert.equal((yield* manager.list())[0].running, false);
          }),
        ),
      );
    } finally {
      fs.rename = originalRename;
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
