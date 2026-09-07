import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { createGrantStore, GrantStoreError } from "@hitchhiker/runtime";
import { Effect, Fiber } from "effect";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { createPluginManager } from "../src/plugin-manager.ts";

const manifest = {
  id: "removable-plugin",
  name: "Removable",
  version: "1.0.0",
  capabilities: ["pages.list"] as const,
};
const launch = (_artifact: unknown, _grant: string, ready: Effect.Effect<void>) =>
  ready.pipe(Effect.andThen(Effect.never));
const provision = Effect.fn("test.provision")(function* (root: string) {
  const grants = yield* createGrantStore({ directory: join(root, "grants") });
  const parent = yield* grants.issue({
    principal: "installer",
    profileId: "default",
    capabilities: ["plugins.install", "pages.list"],
    origins: [],
  });
  const child = yield* grants.delegate(parent.token, {
    principal: manifest.id,
    capabilities: manifest.capabilities,
  });
  const artifacts = yield* createPluginArtifactStore(root);
  const artifact = yield* artifacts.stage({ manifest, code: "one" });
  return { grants, parent, child, artifacts, artifact };
});
const inProfile = async (run: (root: string) => Promise<void>) => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "hitchhiker-uninstall-")));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

test("uninstall stops the worker, revokes both revisions, preserves peers and survives restart", async () => {
  await inProfile(async (root) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { grants, parent, child, artifacts, artifact } = yield* provision(root);
        const nextGrant = yield* grants.delegate(parent.token, {
          principal: manifest.id,
          capabilities: manifest.capabilities,
        });
        const peerGrant = yield* grants.delegate(parent.token, {
          principal: "peer-plugin",
          capabilities: manifest.capabilities,
        });
        const next = yield* artifacts.stage({
          manifest: { ...manifest, version: "2.0.0" },
          code: "two",
        });
        const peer = yield* artifacts.stage({
          manifest: { ...manifest, id: "peer-plugin" },
          code: "peer",
        });
        const active = new Set<string>();
        const launcher = (entry: typeof artifact, _grant: string, ready: Effect.Effect<void>) =>
          Effect.acquireUseRelease(
            Effect.sync(() => active.add(entry.manifest.id)),
            () => ready.pipe(Effect.andThen(Effect.never)),
            () => Effect.sync(() => active.delete(entry.manifest.id)),
          );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* createPluginManager({
              profileRoot: root,
              grants,
              launch: launcher,
            });
            yield* manager.install(artifact.hash, child.id);
            yield* manager.install(next.hash, nextGrant.id);
            yield* manager.install(peer.hash, peerGrant.id);
            yield* manager.uninstall(manifest.id);
            assert.deepEqual([...active], ["peer-plugin"]);
            assert.deepEqual(
              (yield* manager.list()).map((entry) => entry.id),
              ["peer-plugin"],
            );
            for (const grant of [child, nextGrant]) {
              yield* grants.authenticateGrant(grant.id, { profileId: "default" }).pipe(Effect.flip);
            }
            yield* grants.authenticate(parent.token, { profileId: "default" });
            yield* grants.authenticateGrant(peerGrant.id, { profileId: "default" });
            assert.equal((yield* artifacts.read(artifact.hash)).code, "one");
            assert.equal((yield* artifacts.read(next.hash)).code, "two");
            yield* manager.enable(manifest.id).pipe(Effect.flip);
            yield* manager.rollback(manifest.id).pipe(Effect.flip);
            yield* manager.uninstall(manifest.id).pipe(Effect.flip);
          }),
        );
        assert.equal(active.size, 0);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* createPluginManager({
              profileRoot: root,
              grants,
              launch: launcher,
            });
            yield* restarted.restore();
            assert.deepEqual([...active], ["peer-plugin"]);
            const fresh = yield* grants.delegate(parent.token, {
              principal: manifest.id,
              capabilities: manifest.capabilities,
            });
            yield* restarted.install(artifact.hash, fresh.id);
            assert(
              active.has(manifest.id),
              "explicit reinstall with fresh permission can run again",
            );
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});

test("uninstall deduplicates shared revision grants and accepts already revoked grants", async () => {
  await inProfile(async (root) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { grants, child, artifacts, artifact } = yield* provision(root);
        const revoked: string[] = [];
        const manager = yield* createPluginManager({
          profileRoot: root,
          grants: {
            ...grants,
            revoke: (id) =>
              Effect.sync(() => revoked.push(id)).pipe(Effect.andThen(grants.revoke(id))),
          },
          launch,
        });
        yield* manager.install(artifact.hash, child.id);
        const next = yield* artifacts.stage({
          manifest: { ...manifest, version: "2.0.0" },
          code: "two",
        });
        yield* manager.install(next.hash, child.id);
        yield* manager.disable(manifest.id);
        yield* grants.revoke(child.id);
        yield* manager.uninstall(manifest.id);
        assert.deepEqual(revoked, [child.id]);
        assert.deepEqual(yield* manager.list(), []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});

for (const revision of ["revision", "previous"] as const) {
  test(`a foreign ${revision} grant rejects removal before stopping or revoking anything`, async () => {
    await inProfile(async (root) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { grants, parent, child, artifacts, artifact } = yield* provision(root);
          let stopped = false;
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (_artifact, _grant, ready) =>
              launch(_artifact, _grant, ready).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    stopped = true;
                  }),
                ),
              ),
          });
          yield* manager.install(artifact.hash, child.id);
          const next = yield* artifacts.stage({
            manifest: { ...manifest, version: "2.0.0" },
            code: "two",
          });
          yield* manager.install(next.hash, child.id);
          stopped = false;
          yield* Effect.promise(async () => {
            const path = join(root, "hitchhiker-plugins", "plugins.json");
            const registry = JSON.parse(await fs.readFile(path, "utf8"));
            registry.plugins[0][revision].grantId = parent.grant.id;
            await fs.writeFile(path, JSON.stringify(registry));
          });
          const error = yield* manager.uninstall(manifest.id).pipe(Effect.flip);
          assert.match(error.message, /does not belong/);
          assert.equal(stopped, false);
          assert.equal((yield* manager.list())[0].running, true);
          yield* grants.authenticate(parent.token, { profileId: "default" });
          yield* grants.authenticateGrant(child.id, { profileId: "default" });
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    });
  });
}

test("partial revocation records pending removal and startup finishes cleanup", async () => {
  await inProfile(async (root) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { grants, parent, child, artifacts, artifact } = yield* provision(root);
        const nextGrant = yield* grants.delegate(parent.token, {
          principal: manifest.id,
          capabilities: manifest.capabilities,
        });
        const next = yield* artifacts.stage({
          manifest: { ...manifest, version: "2.0.0" },
          code: "two",
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* createPluginManager({
              profileRoot: root,
              grants: {
                ...grants,
                revoke: (id) =>
                  id === nextGrant.id
                    ? Effect.fail(new GrantStoreError({ code: "persistence", message: "injected" }))
                    : grants.revoke(id),
              },
              launch,
            });
            yield* manager.install(artifact.hash, child.id);
            yield* manager.install(next.hash, nextGrant.id);
            yield* manager.uninstall(manifest.id).pipe(Effect.flip);
            const [entry] = yield* manager.list();
            assert.equal(entry.enabled, false);
            assert.equal(entry.running, false);
            assert.equal(entry.previousVersion, "1.0.0");
            yield* grants.authenticateGrant(child.id, { profileId: "default" }).pipe(Effect.flip);
            assert.match(
              (yield* manager.enable(manifest.id).pipe(Effect.flip)).message,
              /restart required/,
            );
          }),
        );
        const restarted = yield* createPluginManager({ profileRoot: root, grants, launch });
        assert.equal((yield* restarted.list())[0].removing, true);
        yield* restarted.restore();
        assert.deepEqual(yield* restarted.list(), []);
        yield* grants.authenticateGrant(nextGrant.id, { profileId: "default" }).pipe(Effect.flip);
        yield* grants.authenticate(parent.token, { profileId: "default" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});

for (const gate of ["stop", "pending-write", "promotion-write", "remove-write"] as const) {
  test(
    `uninstall cancellation at ${gate} respects the promotion commit point and mutation lock`,
    { timeout: 10_000 },
    async () => {
      await inProfile(async (root) => {
        const originalRename = fs.rename;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let armed = false;
        let writes = 0;
        fs.rename = async (source, destination) => {
          if (armed && destination === join(root, "hitchhiker-plugins", "plugins.json")) {
            writes++;
            if (
              (gate === "pending-write" && writes === 1) ||
              (gate === "promotion-write" && writes === 2) ||
              (gate === "remove-write" && writes === 3)
            ) {
              entered.resolve();
              await release.promise;
            }
          }
          return originalRename(source, destination);
        };
        syncBuiltinESMExports();
        try {
          await Effect.runPromise(
            Effect.gen(function* () {
              const { grants, child, artifact } = yield* provision(root);
              const manager = yield* createPluginManager({
                profileRoot: root,
                grants,
                launch: (_artifact, _grant, ready) =>
                  launch(_artifact, _grant, ready).pipe(
                    Effect.ensuring(
                      Effect.promise(async () => {
                        if (gate === "stop" && armed) {
                          entered.resolve();
                          await release.promise;
                        }
                      }),
                    ),
                  ),
              });
              yield* manager.install(artifact.hash, child.id);
              try {
                armed = true;
                const removal = yield* manager.uninstall(manifest.id).pipe(Effect.forkScoped);
                yield* Effect.promise(() => entered.promise).pipe(Effect.timeout(3_000));
                const interrupt = yield* Fiber.interrupt(removal).pipe(
                  Effect.forkScoped({ startImmediately: true }),
                );
                assert.equal(interrupt.pollUnsafe(), undefined);
                const contender = yield* createPluginManager({ profileRoot: root, grants, launch });
                assert.match(
                  (yield* contender.restore().pipe(Effect.flip)).message,
                  /mutation lock is held/,
                );
                release.resolve();
                yield* Fiber.join(interrupt).pipe(Effect.timeout(3_000));
                if (gate === "stop" || gate === "pending-write") {
                  const [entry] = yield* manager.list();
                  assert.equal(entry.enabled, true);
                  assert.equal(entry.running, true);
                  yield* grants.authenticateGrant(child.id, { profileId: "default" });
                  // Recovery completed before releasing the lock, so a retry can finish.
                  armed = false;
                  yield* manager.uninstall(manifest.id);
                }
                assert.deepEqual(yield* manager.list(), []);
                yield* grants
                  .authenticateGrant(child.id, { profileId: "default" })
                  .pipe(Effect.flip);
                const restarted = yield* createPluginManager({ profileRoot: root, grants, launch });
                yield* restarted.restore();
                assert.deepEqual(yield* restarted.list(), []);
              } finally {
                release.resolve();
              }
            }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
          );
        } finally {
          release.resolve();
          fs.rename = originalRename;
          syncBuiltinESMExports();
        }
      });
    },
  );
}

for (const failAt of [1, 2, 3] as const) {
  test(`uninstall registry write ${failAt} failure stops mutation and preserves durable retry state`, async () => {
    await inProfile(async (root) => {
      const originalRename = fs.rename;
      let armed = false;
      let writes = 0;
      fs.rename = async (source, destination) => {
        if (
          armed &&
          destination === join(root, "hitchhiker-plugins", "plugins.json") &&
          ++writes === failAt
        )
          throw new Error("injected rename failure");
        return originalRename(source, destination);
      };
      syncBuiltinESMExports();
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const { grants, child, artifact } = yield* provision(root);
            yield* Effect.scoped(
              Effect.gen(function* () {
                const manager = yield* createPluginManager({ profileRoot: root, grants, launch });
                yield* manager.install(artifact.hash, child.id);
                armed = true;
                yield* manager.uninstall(manifest.id).pipe(Effect.flip);
                armed = false;
                const [entry] = yield* manager.list();
                assert.equal(entry.enabled, failAt < 3);
                assert.equal(entry.running, failAt < 3);
                if (failAt < 3) {
                  yield* grants.authenticateGrant(child.id, { profileId: "default" });
                  yield* manager.uninstall(manifest.id);
                  assert.deepEqual(yield* manager.list(), []);
                } else {
                  yield* grants
                    .authenticateGrant(child.id, { profileId: "default" })
                    .pipe(Effect.flip);
                  assert.match(
                    (yield* manager.uninstall(manifest.id).pipe(Effect.flip)).message,
                    /restart required/,
                  );
                }
              }),
            );
            const restarted = yield* createPluginManager({
              profileRoot: root,
              grants,
              launch,
              safeMode: true,
            });
            if (failAt === 3) {
              assert.equal((yield* restarted.list())[0]?.removing, true);
              yield* restarted.restore();
            }
            assert.deepEqual(yield* restarted.list(), []);
          }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        );
      } finally {
        fs.rename = originalRename;
        syncBuiltinESMExports();
      }
    });
  });
}

test("uninstall accepts absent revision grants without revoking another grant", async () => {
  await inProfile(async (root) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { grants, parent, child, artifacts, artifact } = yield* provision(root);
        let revocations = 0;
        const manager = yield* createPluginManager({
          profileRoot: root,
          grants: {
            ...grants,
            revoke: (id) =>
              Effect.sync(() => {
                revocations++;
              }).pipe(Effect.andThen(grants.revoke(id))),
          },
          launch,
        });
        yield* manager.install(artifact.hash, child.id);
        const next = yield* artifacts.stage({
          manifest: { ...manifest, version: "2.0.0" },
          code: "two",
        });
        yield* manager.install(next.hash, child.id);
        yield* manager.disable(manifest.id);
        yield* Effect.promise(async () => {
          const path = join(root, "grants", "grants.json");
          const state = JSON.parse(await fs.readFile(path, "utf8"));
          state.grants = state.grants.filter(
            (entry: { grant: { id: string } }) => entry.grant.id !== child.id,
          );
          await fs.writeFile(path, JSON.stringify(state));
        });
        yield* grants.authenticateGrant(child.id, { profileId: "default" }).pipe(Effect.flip);
        yield* manager.uninstall(manifest.id);
        assert.deepEqual(yield* manager.list(), []);
        assert.equal(revocations, 0);
        yield* grants.authenticate(parent.token, { profileId: "default" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});
