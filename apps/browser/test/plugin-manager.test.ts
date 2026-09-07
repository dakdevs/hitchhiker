import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GrantStoreApi } from "@hitchhiker/runtime";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { createPluginManager } from "../src/plugin-manager.ts";

const baseManifest = {
  id: "manager-plugin",
  name: "Manager plugin",
  version: "1.0.0",
  capabilities: ["pages.list"],
};
const grants = {
  authenticateGrant: () => Effect.succeed({ principal: "manager-plugin", grant: {} }),
  authorizeGrant: () => Effect.succeed({ principal: "manager-plugin", grant: {} }),
} as unknown as GrantStoreApi;
const compositionGrants = (principals: Readonly<Record<string, string>>) =>
  ({
    authenticateGrant: (id: string) =>
      principals[id] === undefined
        ? Effect.fail(new Error("missing grant"))
        : Effect.succeed({ principal: principals[id], grant: {} }),
    authorizeGrant: (id: string) =>
      principals[id] === undefined
        ? Effect.fail(new Error("missing grant"))
        : Effect.succeed({ principal: principals[id], grant: {} }),
  }) as unknown as GrantStoreApi;
const uiManifest = (id: string) => ({
  ...baseManifest,
  id,
  name: id,
  capabilities: ["ui.compose"],
});

const withProfile = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-manager-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("installs durably and disables then re-enables within the manager scope", async () => {
  await withProfile(async (root) => {
    let launched = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const staged = yield* artifacts.stage({ manifest: baseManifest, code: "compiled" });
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (_artifact, _grant, ready) =>
              ready.pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    launched++;
                  }),
                ),
                Effect.andThen(Effect.never),
              ),
          });
          yield* manager.install(staged.hash, "grant-1");
          assert.deepEqual(yield* manager.list(), [
            {
              id: "manager-plugin",
              name: "Manager plugin",
              version: "1.0.0",
              hash: staged.hash,
              enabled: true,
              running: true,
              capabilities: ["pages.list"],
            },
          ]);
          yield* manager.disable("manager-plugin");
          assert.equal((yield* manager.list())[0].running, false);
          yield* manager.enable("manager-plugin");
          assert.equal((yield* manager.list())[0].running, true);
        }),
      ),
    );
    assert.equal(launched, 2);
  });
});

test("failed replacement preserves and restarts the known-good revision", async () => {
  await withProfile(async (root) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const one = yield* artifacts.stage({ manifest: baseManifest, code: "one" });
          const two = yield* artifacts.stage({
            manifest: { ...baseManifest, version: "2.0.0" },
            code: "two",
          });
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (artifact, _grant, ready) =>
              artifact.manifest.version === "2.0.0"
                ? Effect.fail("candidate failed")
                : ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* manager.install(one.hash, "grant-1");
          yield* manager.install(two.hash, "grant-1").pipe(Effect.flip);
          const [plugin] = yield* manager.list();
          assert.equal(plugin.version, "1.0.0");
          assert.equal(plugin.hash, one.hash);
          assert.equal(plugin.running, true);
          assert.match(plugin.lastFailure ?? "", /Activation failed/);
        }),
      ),
    );
  });
});

test("allows only one enabled UI owner", async () => {
  await withProfile(async (root) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const first = yield* artifacts.stage({
            manifest: { ...baseManifest, capabilities: ["ui.compose"] },
            code: "one",
          });
          const second = yield* artifacts.stage({
            manifest: {
              ...baseManifest,
              id: "other-plugin",
              name: "Other",
              capabilities: ["ui.compose"],
            },
            code: "two",
          });
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (_a, _g, ready) => ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* manager.install(first.hash, "grant-1");
          yield* manager.install(second.hash, "grant-1").pipe(Effect.flip);
          assert.equal((yield* manager.list()).length, 1);
        }),
      ),
    );
  });
});

test("composition owners allow configured UI plugins while disabling removed or unconfigured owners", async () => {
  await withProfile(async (root) => {
    const grants = compositionGrants({
      "left-grant": "split-left",
      "right-grant": "split-right",
      "removed-grant": "split-removed",
      "outside-grant": "outside-plugin",
    });
    const artifacts = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* createPluginArtifactStore(root);
        return {
          left: yield* store.stage({ manifest: uiManifest("split-left"), code: "left" }),
          right: yield* store.stage({ manifest: uiManifest("split-right"), code: "right" }),
          removed: yield* store.stage({ manifest: uiManifest("split-removed"), code: "removed" }),
          outside: yield* store.stage({ manifest: uiManifest("outside-plugin"), code: "outside" }),
        };
      }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const launched: string[] = [];
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            compositionOwners: new Set(["split-left", "split-right", "split-removed"]),
            launch: (artifact, _grant, ready) =>
              ready.pipe(
                Effect.andThen(Effect.sync(() => launched.push(artifact.manifest.id))),
                Effect.andThen(Effect.never),
              ),
          });
          yield* manager.install(artifacts.left.hash, "left-grant");
          yield* manager.install(artifacts.right.hash, "right-grant");
          assert.deepEqual(launched, ["split-left", "split-right"]);
          assert.equal((yield* manager.list()).filter((plugin) => plugin.running).length, 2);

          assert(
            Exit.isFailure(
              yield* Effect.exit(manager.install(artifacts.outside.hash, "outside-grant")),
            ),
          );
          assert.equal(
            (yield* manager.list()).find((plugin) => plugin.id === "outside-plugin")?.enabled,
            false,
          );
          assert(Exit.isFailure(yield* Effect.exit(manager.enable("outside-plugin"))));

          yield* manager.install(artifacts.removed.hash, "removed-grant");
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const launched: string[] = [];
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            compositionOwners: new Set(["split-left", "split-right"]),
            launch: (artifact, _grant, ready) =>
              ready.pipe(
                Effect.andThen(Effect.sync(() => launched.push(artifact.manifest.id))),
                Effect.andThen(Effect.never),
              ),
          });
          yield* manager.restore();
          const plugins = yield* manager.list();
          assert.deepEqual(launched, ["split-left", "split-right"]);
          assert.equal(plugins.find((plugin) => plugin.id === "split-left")?.running, true);
          assert.equal(plugins.find((plugin) => plugin.id === "split-right")?.running, true);
          assert.equal(plugins.find((plugin) => plugin.id === "split-removed")?.enabled, false);
          assert.equal(plugins.find((plugin) => plugin.id === "split-removed")?.running, false);
        }),
      ),
    );
  });
});

test("restore starts durable enabled preferences in a fresh manager scope", async () => {
  await withProfile(async (root) => {
    let launches = 0;
    const stage = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* createPluginArtifactStore(root);
        return yield* artifacts.stage({ manifest: baseManifest, code: "durable" });
      }),
    );
    const launcher = (_artifact: unknown, _grant: string, ready: Effect.Effect<void>) =>
      ready.pipe(
        Effect.andThen(
          Effect.sync(() => {
            launches++;
          }),
        ),
        Effect.andThen(Effect.never),
      );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: launcher,
          });
          yield* manager.install(stage.hash, "grant-1");
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: launcher,
          });
          yield* manager.restore();
          assert.equal((yield* manager.list())[0].running, true);
        }),
      ),
    );
    assert.equal(launches, 2);
  });
});

test("manager shutdown preserves enabled plugins for the next manager restore", async () => {
  await withProfile(async (root) => {
    let launches = 0;
    const staged = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* createPluginArtifactStore(root);
        return yield* artifacts.stage({ manifest: baseManifest, code: "durable" });
      }),
    );
    const launcher = (_artifact: unknown, _grant: string, ready: Effect.Effect<void>) =>
      ready.pipe(
        Effect.andThen(
          Effect.sync(() => {
            launches++;
          }),
        ),
        Effect.andThen(Effect.never),
      );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: launcher,
          });
          yield* manager.install(staged.hash, "grant-1");
          const [plugin] = yield* manager.list();
          assert.equal(plugin.enabled, true);
          assert.equal(plugin.lastFailure, undefined);
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: launcher,
          });
          const [beforeRestore] = yield* manager.list();
          assert.equal(beforeRestore.enabled, true);
          assert.equal(beforeRestore.running, false);
          assert.equal(beforeRestore.lastFailure, undefined);
          yield* manager.restore();
          assert.equal((yield* manager.list())[0].running, true);
        }),
      ),
    );
    assert.equal(launches, 2);
  });
});

test("configured layout owners without UI authority fail install and restore", async () => {
  await withProfile(async (root) => {
    const layout = { ...baseManifest, id: "split-layout", name: "Split layout" };
    const layoutGrants = compositionGrants({ "layout-grant": "split-layout" });
    const staged = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* createPluginArtifactStore(root);
        return yield* artifacts.stage({ manifest: layout, code: "layout" });
      }),
    );
    const launcher = (_artifact: unknown, _grant: string, ready: Effect.Effect<void>) =>
      ready.pipe(Effect.andThen(Effect.never));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants: layoutGrants,
            compositionOwners: new Set(["split-layout"]),
            launch: launcher,
          });
          assert(Exit.isFailure(yield* Effect.exit(manager.install(staged.hash, "layout-grant"))));
          const [plugin] = yield* manager.list();
          assert.equal(plugin.enabled, false);
          assert.equal(plugin.running, false);
          assert.equal(plugin.lastFailure, "Activation failed");
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants: layoutGrants,
            launch: launcher,
          });
          yield* manager.enable("split-layout");
          assert.equal((yield* manager.list())[0].enabled, true);
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants: layoutGrants,
            compositionOwners: new Set(["split-layout"]),
            launch: launcher,
          });
          yield* manager.restore();
          const [plugin] = yield* manager.list();
          assert.equal(plugin.enabled, false);
          assert.equal(plugin.running, false);
          assert.match(plugin.lastFailure ?? "", /must declare ui\.compose/);
        }),
      ),
    );
  });
});

test("a post-promotion host crash rolls back only once", async () => {
  await withProfile(async (root) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const stable = yield* artifacts.stage({ manifest: baseManifest, code: "stable" });
          const candidate = yield* artifacts.stage({
            manifest: { ...baseManifest, version: "2.0.0" },
            code: "candidate",
          });
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (artifact, _grant, ready) =>
              artifact.manifest.version === "2.0.0"
                ? ready.pipe(
                    Effect.andThen(Effect.sleep(350)),
                    Effect.andThen(Effect.fail("crash")),
                  )
                : ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* manager.install(stable.hash, "grant-1");
          yield* manager.install(candidate.hash, "grant-1");
          yield* Effect.sleep(700);
          const [plugin] = yield* manager.list();
          assert.equal(plugin.hash, stable.hash);
          assert.equal(plugin.running, true);
        }),
      ),
    );
  });
});

test("cancelling an update stops its candidate and restores the known-good process", async () => {
  await withProfile(async (root) => {
    let stableStarts = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const stable = yield* artifacts.stage({ manifest: baseManifest, code: "stable" });
          const candidate = yield* artifacts.stage({
            manifest: { ...baseManifest, version: "2.0.0" },
            code: "candidate",
          });
          const candidateStarted = yield* Deferred.make<void>();
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (artifact, _grant, ready) =>
              artifact.manifest.version === "2.0.0"
                ? Deferred.succeed(candidateStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.sync(() => {
                    stableStarts++;
                  }).pipe(Effect.andThen(ready), Effect.andThen(Effect.never)),
          });
          yield* manager.install(stable.hash, "grant-1");
          const update = yield* manager.install(candidate.hash, "grant-1").pipe(Effect.forkScoped);
          yield* Deferred.await(candidateStarted);
          yield* Fiber.interrupt(update);
          const [plugin] = yield* manager.list();
          assert.equal(plugin.hash, stable.hash);
          assert.equal(plugin.version, "1.0.0");
          assert.equal(plugin.running, true);
          assert.equal(stableStarts, 2, "interruption restores the previous revision only once");
        }),
      ),
    );
  });
});

test(
  "cancelling while stopping an update restores the prior revision",
  { timeout: 10_000 },
  async () => {
    await withProfile(async (root) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const artifacts = yield* createPluginArtifactStore(root);
            const stable = yield* artifacts.stage({ manifest: baseManifest, code: "stable" });
            const candidate = yield* artifacts.stage({
              manifest: { ...baseManifest, version: "2.0.0" },
              code: "candidate",
            });
            const stopping = yield* Deferred.make<void>();
            const releaseStop = yield* Deferred.make<void>();
            let stableStarts = 0;
            const manager = yield* createPluginManager({
              profileRoot: root,
              grants,
              launch: (artifact, _grant, ready) =>
                artifact.manifest.version === "2.0.0"
                  ? Effect.never
                  : Effect.gen(function* () {
                      yield* ready;
                      stableStarts++;
                      const first = stableStarts === 1;
                      yield* Effect.never.pipe(
                        Effect.ensuring(
                          first
                            ? Deferred.succeed(stopping, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseStop)),
                              )
                            : Effect.void,
                        ),
                      );
                    }),
            });
            yield* manager.install(stable.hash, "grant-1");
            try {
              const update = yield* manager
                .install(candidate.hash, "grant-1")
                .pipe(Effect.forkScoped);
              yield* Deferred.await(stopping).pipe(Effect.timeout(2_000));
              const interrupted = yield* Fiber.interrupt(update).pipe(
                Effect.forkScoped({ startImmediately: true }),
              );
              yield* Deferred.succeed(releaseStop, undefined);
              yield* Fiber.join(interrupted).pipe(Effect.timeout(3_000));
              const [plugin] = yield* manager.list();
              assert.equal(plugin.hash, stable.hash);
              assert.equal(plugin.running, true);
              assert.equal(stableStarts, 2);
            } finally {
              yield* Deferred.succeed(releaseStop, undefined);
            }
          }),
        ),
      );
    });
  },
);

test("a health-window crash is rejected before promotion", async () => {
  await withProfile(async (root) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const stable = yield* artifacts.stage({ manifest: baseManifest, code: "stable" });
          const candidate = yield* artifacts.stage({
            manifest: { ...baseManifest, version: "2.0.0" },
            code: "candidate",
          });
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (artifact, _grant, ready) =>
              artifact.manifest.version === "2.0.0"
                ? ready.pipe(
                    Effect.andThen(Effect.sleep(100)),
                    Effect.andThen(Effect.fail("health crash")),
                  )
                : ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* manager.install(stable.hash, "grant-1");
          yield* manager.install(candidate.hash, "grant-1").pipe(Effect.flip);
          const [plugin] = yield* manager.list();
          assert.equal(plugin.hash, stable.hash);
          assert.equal(plugin.running, true);
        }),
      ),
    );
  });
});

test("a crash after rollback disables instead of oscillating and does not escalate the app", async () => {
  await withProfile(async (root) => {
    let escalations = 0;
    let stableLaunches = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const stable = yield* artifacts.stage({ manifest: baseManifest, code: "stable" });
          const candidate = yield* artifacts.stage({
            manifest: { ...baseManifest, version: "2.0.0" },
            code: "candidate",
          });
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            onRecoveryFailure: Effect.sync(() => {
              escalations++;
            }),
            launch: (artifact, _grant, ready) =>
              artifact.manifest.version === "1.0.0"
                ? ready.pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        stableLaunches++;
                      }),
                    ),
                    Effect.andThen(() => (stableLaunches === 1 ? Effect.never : Effect.sleep(350))),
                    Effect.andThen(Effect.fail("crash")),
                  )
                : ready.pipe(
                    Effect.andThen(Effect.sleep(350)),
                    Effect.andThen(Effect.fail("crash")),
                  ),
          });
          yield* manager.install(stable.hash, "grant-1");
          yield* manager.install(candidate.hash, "grant-1");
          yield* Effect.sleep(1_150);
          const [plugin] = yield* manager.list();
          assert.equal(plugin.hash, stable.hash);
          assert.equal(plugin.enabled, false);
          assert.equal(plugin.running, false);
        }),
      ),
    );
    assert.equal(escalations, 0);
  });
});

test("manual rollback restores the current revision when its replacement cannot start", async () => {
  await withProfile(async (root) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const one = yield* artifacts.stage({ manifest: baseManifest, code: "one" });
          const two = yield* artifacts.stage({
            manifest: { ...baseManifest, name: "Manager two", version: "2.0.0" },
            code: "two",
          });
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (artifact, _grant, ready) =>
              artifact.manifest.version === "1.0.0"
                ? Effect.fail("old revision cannot start")
                : ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* manager.install(one.hash, "grant-1").pipe(Effect.flip);
          const initial = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (_artifact, _grant, ready) => ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* initial.enable("manager-plugin");
          yield* manager.install(two.hash, "grant-1");
          yield* manager.rollback("manager-plugin").pipe(Effect.flip);
          const [plugin] = yield* manager.list();
          assert.equal(plugin.hash, two.hash);
          assert.equal(plugin.name, "Manager two");
          assert.equal(plugin.version, "2.0.0");
          assert.equal(plugin.running, true);
        }),
      ),
    );
  });
});

test("revoked durable grants deny a restart and safe mode never reports a running plugin", async () => {
  await withProfile(async (root) => {
    let revoked = false;
    const mutableGrants = {
      authenticateGrant: () =>
        revoked
          ? Effect.fail("revoked")
          : Effect.succeed({ principal: "manager-plugin", grant: {} }),
      authorizeGrant: () =>
        revoked
          ? Effect.fail("revoked")
          : Effect.succeed({ principal: "manager-plugin", grant: {} }),
    } as unknown as GrantStoreApi;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const staged = yield* artifacts.stage({ manifest: baseManifest, code: "compiled" });
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants: mutableGrants,
            launch: (_artifact, _grant, ready) => ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* manager.install(staged.hash, "grant-1");
          yield* manager.disable("manager-plugin");
          revoked = true;
          yield* manager.enable("manager-plugin").pipe(Effect.flip);
          assert.equal((yield* manager.list())[0].enabled, false);
          const safe = yield* createPluginManager({
            profileRoot: root,
            grants: mutableGrants,
            safeMode: true,
            launch: (_artifact, _grant, ready) => ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* safe.restore();
          assert.equal((yield* safe.list())[0].running, false);
        }),
      ),
    );
  });
});

test("cross-manager writers preserve both durable registry entries and reject symlinked registries", async () => {
  await withProfile(async (root) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const first = yield* artifacts.stage({ manifest: baseManifest, code: "one" });
          const second = yield* artifacts.stage({
            manifest: { ...baseManifest, id: "second-plugin", name: "Second" },
            code: "two",
          });
          const launcher = (_artifact: unknown, _grant: string, ready: Effect.Effect<void>) =>
            ready.pipe(Effect.andThen(Effect.never));
          const a = yield* createPluginManager({ profileRoot: root, grants, launch: launcher });
          const secondGrants = {
            authenticateGrant: () => Effect.succeed({ principal: "second-plugin", grant: {} }),
            authorizeGrant: () => Effect.succeed({ principal: "second-plugin", grant: {} }),
          } as unknown as GrantStoreApi;
          const b = yield* createPluginManager({
            profileRoot: root,
            grants: secondGrants,
            launch: launcher,
          });
          yield* Effect.forEach(
            [a.install(first.hash, "grant-1"), b.install(second.hash, "grant-1")],
            (effect) => effect,
            { concurrency: "unbounded" },
          );
          assert.equal((yield* a.list()).length, 2);
          yield* a.disable("manager-plugin");
          yield* a.disable("second-plugin");
        }),
      ),
    );
    const registry = join(root, "hitchhiker-plugins", "plugins.json");
    await rm(registry);
    await symlink(join(root, "outside.json"), registry);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (_artifact, _grant, ready) => ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* manager.list().pipe(Effect.flip);
        }),
      ),
    );
  });
});

test("failed update disables the previous revision when its grant was revoked during activation", async () => {
  await withProfile(async (root) => {
    let oldRevoked = false;
    const boundGrants = {
      ...grants,
      authenticateGrant: (id: string) =>
        id === "old" && oldRevoked
          ? Effect.fail("revoked")
          : grants.authenticateGrant(id, { profileId: "default" }),
    } as unknown as GrantStoreApi;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* createPluginArtifactStore(root);
          const stable = yield* artifacts.stage({ manifest: baseManifest, code: "stable" });
          const candidate = yield* artifacts.stage({
            manifest: { ...baseManifest, version: "2.0.0" },
            code: "candidate",
          });
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants: boundGrants,
            launch: (artifact, _grant, ready) =>
              artifact.manifest.version === "2.0.0"
                ? Effect.sync(() => {
                    oldRevoked = true;
                  }).pipe(Effect.andThen(Effect.fail("bad activation")))
                : ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* manager.install(stable.hash, "old");
          yield* manager.install(candidate.hash, "new").pipe(Effect.flip);
          const [plugin] = yield* manager.list();
          assert.equal(plugin.hash, stable.hash);
          assert.equal(plugin.enabled, false);
          assert.equal(plugin.running, false);
        }),
      ),
    );
  });
});

test("safe-mode recovery bypasses malformed, excess-field and oversized registry data", async () => {
  await withProfile(async (root) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            safeMode: true,
            launch: () => Effect.die("safe mode must not launch"),
          });
          for (const data of [
            "broken-json",
            JSON.stringify({ version: 1, plugins: [], token: "must-not-survive" }),
            " ".repeat(32769),
          ]) {
            yield* Effect.promise(() =>
              writeFile(join(root, "hitchhiker-plugins", "plugins.json"), data),
            );
            yield* manager.restore();
            yield* manager.list().pipe(Effect.flip);
          }
        }),
      ),
    );
  });
});
