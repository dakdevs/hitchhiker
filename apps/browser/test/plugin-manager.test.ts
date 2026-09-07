import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityGrant } from "@hitchhiker/core";
import type { GrantStoreApi } from "@hitchhiker/runtime";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { createPluginManager, type PluginManager } from "../src/plugin-manager.ts";
import type { InstalledPluginPlanInput } from "@hitchhiker/runtime";

const baseManifest = {
  id: "manager-plugin",
  name: "Manager plugin",
  version: "1.0.0",
  capabilities: ["pages.list"],
};
const fakeGrant = (id: string, principal: string): CapabilityGrant => ({
  id,
  principal,
  profileId: "default",
  capabilities: ["browser.full-control"],
  origins: [],
});
const grants = {
  authenticateGrant: () =>
    Effect.succeed({ principal: "manager-plugin", grant: fakeGrant("grant-1", "manager-plugin") }),
  authorizeGrant: () =>
    Effect.succeed({ principal: "manager-plugin", grant: fakeGrant("grant-1", "manager-plugin") }),
} as unknown as GrantStoreApi;
const compositionGrants = (principals: Readonly<Record<string, string>>) =>
  ({
    authenticateGrant: (id: string) =>
      principals[id] === undefined
        ? Effect.fail(new Error("missing grant"))
        : Effect.succeed({ principal: principals[id], grant: fakeGrant(id, principals[id]) }),
    authorizeGrant: (id: string) =>
      principals[id] === undefined
        ? Effect.fail(new Error("missing grant"))
        : Effect.succeed({ principal: principals[id], grant: fakeGrant(id, principals[id]) }),
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

/** Admit a staged cohort through the durable V2 plan, never manager startup options. */
const apply = (manager: PluginManager, candidate: InstalledPluginPlanInput) =>
  manager.plan().pipe(Effect.flatMap(({ revision }) => manager.applyPlan(revision, candidate)));

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
          yield* manager.install(staged.hash, "grant-1", { staged: true });
          assert.equal((yield* manager.list())[0]?.enabled, false);
          yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
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
          yield* manager.install(one.hash, "grant-1", { staged: true });
          yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
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

test("a UI cohort is staged and admitted only by a complete replacement plan", async () => {
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
            grants: compositionGrants({ "grant-1": "manager-plugin", "grant-2": "other-plugin" }),
            launch: (_a, _g, ready) => ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* manager.install(first.hash, "grant-1", { staged: true });
          yield* manager.install(second.hash, "grant-2", { staged: true });
          assert.deepEqual(
            (yield* manager.list()).map((plugin) => plugin.enabled),
            [false, false],
          );
          yield* apply(manager, {
            enabled: ["manager-plugin", "other-plugin"],
            composition: {
              layout: "manager-plugin",
              slots: [{ key: "main", contributions: [{ pluginId: "other-plugin", id: "panel" }] }],
            },
            serviceBindings: [],
          });
          assert((yield* manager.list()).every((plugin) => plugin.running));
        }),
      ),
    );
  });
});

test("restore honors the persisted V2 UI plan instead of startup composition owners", async () => {
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
            launch: (artifact, _grant, ready) =>
              ready.pipe(
                Effect.andThen(Effect.sync(() => launched.push(artifact.manifest.id))),
                Effect.andThen(Effect.never),
              ),
          });
          yield* manager.install(artifacts.left.hash, "left-grant", { staged: true });
          yield* manager.install(artifacts.right.hash, "right-grant", { staged: true });
          yield* manager.install(artifacts.removed.hash, "removed-grant", { staged: true });
          yield* manager.install(artifacts.outside.hash, "outside-grant", { staged: true });
          yield* apply(manager, {
            enabled: ["split-left", "split-right"],
            composition: {
              layout: "split-left",
              slots: [{ key: "right", contributions: [{ pluginId: "split-right", id: "panel" }] }],
            },
            serviceBindings: [],
          });
          assert.deepEqual(launched, ["split-left", "split-right"]);
          assert(Exit.isFailure(yield* Effect.exit(manager.disable("split-left"))));
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
          assert.equal(plugins.find((plugin) => plugin.id === "outside-plugin")?.running, false);
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
          yield* manager.install(stage.hash, "grant-1", { staged: true });
          yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
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
          yield* manager.install(staged.hash, "grant-1", { staged: true });
          yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
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

test("a failed new staged install leaves no disabled registry entry", async () => {
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
            launch: launcher,
          });
          assert(
            Exit.isFailure(
              yield* Effect.exit(manager.install(staged.hash, "missing-grant", { staged: true })),
            ),
          );
          assert.deepEqual(yield* manager.list(), []);
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
          yield* manager.install(stable.hash, "grant-1", { staged: true });
          yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
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
          yield* manager.install(stable.hash, "grant-1", { staged: true });
          yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
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
            yield* manager.install(stable.hash, "grant-1", { staged: true });
            yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
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
          yield* manager.install(stable.hash, "grant-1", { staged: true });
          yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
          yield* manager.install(candidate.hash, "grant-1").pipe(Effect.flip);
          const [plugin] = yield* manager.list();
          assert.equal(plugin.hash, stable.hash);
          assert.equal(plugin.running, true);
        }),
      ),
    );
  });
});

test("a crash after fallback suspends the enabled preference without oscillating", async () => {
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
                    Effect.andThen(() =>
                      stableLaunches === 1 || stableLaunches > 2 ? Effect.never : Effect.sleep(350),
                    ),
                    Effect.andThen(Effect.fail("crash")),
                  )
                : ready.pipe(
                    Effect.andThen(Effect.sleep(350)),
                    Effect.andThen(Effect.fail("crash")),
                  ),
          });
          yield* manager.install(stable.hash, "grant-1", { staged: true });
          yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
          yield* manager.install(candidate.hash, "grant-1");
          yield* Effect.sleep(1_150);
          const [plugin] = yield* manager.list();
          assert.equal(plugin.hash, stable.hash);
          assert.equal(plugin.enabled, true);
          assert.equal(plugin.running, false);
          yield* manager.enable("manager-plugin");
          assert.equal((yield* manager.list())[0]?.running, true);
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
          let oldFails = false;
          const manager = yield* createPluginManager({
            profileRoot: root,
            grants,
            launch: (artifact, _grant, ready) =>
              artifact.manifest.version === "1.0.0" && oldFails
                ? Effect.fail("old revision cannot start")
                : ready.pipe(Effect.andThen(Effect.never)),
          });
          yield* manager.install(one.hash, "grant-1", { staged: true });
          yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
          yield* manager.install(two.hash, "grant-1");
          oldFails = true;
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
          : Effect.succeed({
              principal: "manager-plugin",
              grant: fakeGrant("grant-1", "manager-plugin"),
            }),
      authorizeGrant: () =>
        revoked
          ? Effect.fail("revoked")
          : Effect.succeed({
              principal: "manager-plugin",
              grant: fakeGrant("grant-1", "manager-plugin"),
            }),
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
          const sharedGrants = compositionGrants({
            "grant-1": "manager-plugin",
            "grant-2": "second-plugin",
          });
          const a = yield* createPluginManager({
            profileRoot: root,
            grants: sharedGrants,
            launch: launcher,
          });
          const b = yield* createPluginManager({
            profileRoot: root,
            grants: sharedGrants,
            launch: launcher,
          });
          yield* Effect.forEach(
            [a.install(first.hash, "grant-1"), b.install(second.hash, "grant-2")],
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

test("failed update with a revoked rollback grant preserves the old enabled preference and poisons recovery", async () => {
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
          yield* manager.install(stable.hash, "old", { staged: true });
          yield* apply(manager, { enabled: ["manager-plugin"], serviceBindings: [] });
          yield* manager.install(candidate.hash, "new").pipe(Effect.flip);
          const [plugin] = yield* manager.list();
          assert.equal(plugin.hash, stable.hash);
          assert.equal(plugin.enabled, true);
          assert.equal(plugin.running, false);
          assert(Exit.isFailure(yield* Effect.exit(manager.disable("manager-plugin"))));
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
            " ".repeat(256 * 1024 + 1),
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

test("exact staged retries preserve the plan and reject changed grants, artifacts or enabled identities", async () => {
  await withProfile(async (profileRoot) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* createPluginArtifactStore(profileRoot);
        const first = yield* artifacts.stage({ manifest: baseManifest, code: "first" });
        const replacement = yield* artifacts.stage({ manifest: baseManifest, code: "replacement" });
        let launches = 0;
        const manager = yield* createPluginManager({
          profileRoot,
          grants,
          launch: (_artifact, _grant, ready) =>
            Effect.sync(() => {
              launches++;
            }).pipe(Effect.andThen(ready), Effect.andThen(Effect.never)),
        });
        yield* manager.install(first.hash, "first-grant", { staged: true });
        const plan = yield* manager.plan();
        const path = join(profileRoot, "hitchhiker-plugins", "plugins.json");
        const bytes = yield* Effect.promise(() => readFile(path, "utf8"));
        assert.equal(yield* manager.inspectInstallation("missing-plugin"), undefined);
        assert.deepEqual(yield* manager.inspectInstallation(baseManifest.id), {
          hash: first.hash,
          grantId: "first-grant",
          enabled: false,
          removing: false,
          suspended: false,
        });
        assert.equal(Object.hasOwn((yield* manager.list())[0], "grantId"), false);
        yield* manager.install(first.hash, "first-grant", { staged: true });
        assert.deepEqual(yield* manager.plan(), plan);
        assert.equal(yield* Effect.promise(() => readFile(path, "utf8")), bytes);
        assert.equal(launches, 0);
        for (const [hash, grant] of [
          [replacement.hash, "first-grant"],
          [first.hash, "another-grant"],
        ])
          assert.match(
            (yield* manager.install(hash, grant, { staged: true }).pipe(Effect.flip)).message,
            /conflicts/,
          );
        assert.equal(yield* Effect.promise(() => readFile(path, "utf8")), bytes);
        yield* manager.enable(baseManifest.id);
        const enabled = yield* manager.plan();
        assert.deepEqual(yield* manager.inspectInstallation(baseManifest.id), {
          hash: first.hash,
          grantId: "first-grant",
          enabled: true,
          removing: false,
          suspended: false,
        });
        assert.equal(launches, 1);
        assert.match(
          (yield* manager.install(first.hash, "first-grant", { staged: true }).pipe(Effect.flip))
            .message,
          /conflicts/,
        );
        assert.deepEqual(yield* manager.plan(), enabled);
        assert.equal(launches, 1);
      }).pipe(Effect.scoped),
    );
  });
});
