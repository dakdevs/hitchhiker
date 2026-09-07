import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import {
  makePluginComposition,
  type GrantStoreApi,
  type InstalledPluginPlanInput,
} from "@hitchhiker/runtime";
import { column, text, viewport } from "@hitchhiker/ui";
import {
  createPluginManager,
  type PluginManager,
  type PluginManagerOptions,
} from "../src/plugin-manager.ts";
import { createPluginManagement } from "../src/plugin-management.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";

const withProfile = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-plan-manager-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const path = (root: string) => join(root, "hitchhiker-plugins", "plugins.json");
const readRegistry = (root: string) =>
  Effect.promise(
    async () =>
      JSON.parse(await readFile(path(root), "utf8")) as {
        version: number;
        activePlan: InstalledPluginPlanInput & { revision: number };
        pendingPlan?: unknown;
        plugins: { id: string; revision: { hash: string } }[];
      },
  );
const grants = (denied: Set<string>) =>
  ({
    authenticateGrant: (id: string) =>
      denied.has(id)
        ? Effect.fail("revoked")
        : Effect.succeed({
            principal: id,
            grant: {
              id,
              principal: id,
              profileId: "default",
              capabilities: ["browser.full-control"],
              origins: [],
            },
          }),
    authorizeGrant: (id: string) =>
      denied.has(id)
        ? Effect.fail("revoked")
        : Effect.succeed({
            principal: id,
            grant: {
              id,
              principal: id,
              profileId: "default",
              capabilities: ["browser.full-control"],
              origins: [],
            },
          }),
    list: () => Effect.succeed([]),
    revoke: () => Effect.void,
  }) as unknown as GrantStoreApi;
const fixture = Effect.fn("test.planFixture")(function* (root: string) {
  const artifacts = yield* createPluginArtifactStore(root);
  const denied = new Set<string>();
  const active = new Map<string, number>();
  const launches = new Map<string, number[]>();
  const failures = new Set<string>();
  const waits = new Map<string, Deferred.Deferred<void>>();
  const entered = new Map<string, Deferred.Deferred<void>>();
  const crashes = new Map<string, Deferred.Deferred<void>>();
  let peak = 0;
  let recoveries = 0;
  let snapshotDuringActivation = false;
  let snapshotCalls = 0;
  let manager: PluginManager | undefined;
  const owners = new Set<string>();
  const session = yield* makePluginComposition({
    recipe: undefined,
    recovery: { root: text("recovery", "Recovery"), bindings: [] },
    commit: () => Effect.succeed(1),
  });
  const composition = {
    owners,
    complete: session.complete,
    reconfigure: (recipe: InstalledPluginPlanInput["composition"]) =>
      session.reconfigure(recipe).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            owners.clear();
            for (const id of session.owners()) owners.add(id);
          }),
        ),
      ),
  };
  const launch: PluginManagerOptions["launch"] = (artifact, _grant, ready, activation) =>
    Effect.gen(function* () {
      const id = artifact.manifest.id;
      const owner = { id, generation: activation.generation };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          active.set(id, activation.generation);
          launches.set(id, [...(launches.get(id) ?? []), activation.generation]);
          peak = Math.max(peak, active.size);
        }),
        () =>
          Effect.sync(() => {
            active.delete(id);
          }),
      );
      if (failures.has(id)) return yield* Effect.fail("fixture failed");
      if (entered.has(id)) yield* Deferred.succeed(entered.get(id)!, undefined);
      if (waits.has(id)) yield* Deferred.await(waits.get(id)!);
      if (artifact.manifest.capabilities.includes("ui.compose")) {
        yield* Effect.acquireRelease(session.activate(owner), () =>
          session.remove(owner).pipe(Effect.orDie),
        );
        if (id === "layout-plugin")
          yield* session.publishLayout(owner, {
            root: column("root", [column("area", [])]),
            bindings: [],
          });
        else
          yield* session.publishContribution(owner, "tabs", {
            root: viewport("page", "content"),
            bindings: [{ viewportId: "content", pageId: "retained-page" }],
          });
      }
      if (snapshotDuringActivation) {
        if (!manager) return yield* Effect.fail("manager fixture is not ready");
        snapshotCalls++;
        yield* manager.managementSnapshot();
      }
      yield* ready;
      const crash = crashes.get(id);
      if (crash) {
        yield* Deferred.await(crash);
        return yield* Effect.fail("fixture worker crashed");
      }
      yield* Effect.never;
    }).pipe(Effect.scoped);
  const options: PluginManagerOptions = {
    profileRoot: root,
    grants: grants(denied),
    composition,
    launch,
    onRecoveryFailure: Effect.sync(() => {
      recoveries++;
    }),
  };
  manager = yield* createPluginManager(options);
  const stage = Effect.fn("test.stagePlanPlugin")(function* (id: string, ui = false) {
    const artifact = yield* artifacts.stage({
      manifest: {
        id,
        name: id,
        version: "1.0.0",
        capabilities: ui ? ["ui.compose"] : [],
      },
      code: id,
    });
    yield* manager!.install(artifact.hash, id, { staged: true });
    return artifact;
  });
  return {
    manager,
    options,
    stage,
    denied,
    active,
    launches,
    failures,
    waits,
    entered,
    crashes,
    peak: () => peak,
    recoveries: () => recoveries,
    snapshotOnActivation: (enabled: boolean) => {
      snapshotDuringActivation = enabled;
    },
    snapshotCalls: () => snapshotCalls,
  };
});
const visible = (presenter: string): InstalledPluginPlanInput => ({
  enabled: ["model-plugin", "pins-plugin", "layout-plugin", presenter],
  composition: {
    layout: "layout-plugin",
    slots: [{ key: "area", contributions: [{ pluginId: presenter, id: "tabs" }] }],
  },
  serviceBindings: [],
});

test("live four-worker plans retain compatible generations and restore a failed presenter", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        for (const id of [
          "model-plugin",
          "pins-plugin",
          "layout-plugin",
          "sidebar-plugin",
          "top-plugin",
          "bad-plugin",
        ])
          yield* f.stage(id, !["model-plugin", "pins-plugin"].includes(id));
        assert.equal(f.active.size, 0);
        const initial = yield* f.manager.plan();
        const sidebar = yield* f.manager.applyPlan(initial.revision, visible("sidebar-plugin"));
        const retained = new Map(f.active);
        const top = yield* f.manager.applyPlan(sidebar.revision, visible("top-plugin"));
        for (const id of ["model-plugin", "pins-plugin", "layout-plugin"])
          assert.equal(f.active.get(id), retained.get(id));
        assert.equal(f.active.has("sidebar-plugin"), false);
        const oldTop = f.active.get("top-plugin");
        f.failures.add("bad-plugin");
        assert(
          Exit.isFailure(
            yield* Effect.exit(f.manager.applyPlan(top.revision, visible("bad-plugin"))),
          ),
        );
        assert.deepEqual(yield* f.manager.plan(), top);
        for (const id of ["model-plugin", "pins-plugin", "layout-plugin"])
          assert.equal(f.active.get(id), retained.get(id));
        assert.notEqual(f.active.get("top-plugin"), oldTop);
        assert.equal(f.active.has("bad-plugin"), false);
        assert.equal((yield* readRegistry(root)).pendingPlan, undefined);
        assert.equal(f.peak(), 4);
        assert.equal(f.recoveries(), 0);
      }).pipe(Effect.scoped),
    ),
  );
});

test("management replacement is guarded, preserves unrelated references, and uses normal plan validation", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        yield* f.stage("layout-plugin", true);
        yield* f.stage("caller-plugin", true);
        yield* f.stage("target-plugin", true);
        yield* f.stage("incompatible-plugin");
        f.snapshotOnActivation(true);
        const initial = yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
          enabled: ["caller-plugin", "layout-plugin"],
          composition: {
            layout: "layout-plugin",
            slots: [
              {
                key: "area",
                contributions: [{ pluginId: "caller-plugin", id: "tabs" }],
                route: { fallback: { pluginId: "caller-plugin", id: "tabs" } },
              },
            ],
          },
          serviceBindings: [],
        });
        const before = yield* Effect.promise(() => readFile(path(root), "utf8"));
        const layoutGeneration = f.active.get("layout-plugin");
        assert.match(
          (yield* f.manager
            .replaceSelf("caller-plugin", "target-plugin", initial.revision - 1)
            .pipe(Effect.flip)).message,
          /stale/,
        );
        assert.match(
          (yield* f.manager
            .replaceSelf("caller-plugin", "caller-plugin", initial.revision)
            .pipe(Effect.flip)).message,
          /disabled installed/,
        );
        assert.match(
          (yield* f.manager
            .replaceSelf("caller-plugin", "incompatible-plugin", initial.revision)
            .pipe(Effect.flip)).message,
          /UI plugins/,
        );
        assert.equal(yield* Effect.promise(() => readFile(path(root), "utf8")), before);
        assert.equal(f.active.get("layout-plugin"), layoutGeneration);
        const replaced = yield* f.manager.replaceSelf(
          "caller-plugin",
          "target-plugin",
          initial.revision,
        );
        assert.deepEqual(replaced, {
          revision: initial.revision + 1,
          enabled: ["target-plugin", "layout-plugin"],
          composition: {
            layout: "layout-plugin",
            slots: [
              {
                key: "area",
                contributions: [{ pluginId: "target-plugin", id: "tabs" }],
                route: { fallback: { pluginId: "target-plugin", id: "tabs" } },
              },
            ],
          },
          serviceBindings: [],
        });
        assert.equal(f.active.get("layout-plugin"), layoutGeneration);
        const snapshot = yield* f.manager.managementSnapshot();
        assert.equal(snapshot.revision, replaced.revision);
        assert.deepEqual(
          snapshot.plugins.map((plugin) => plugin.id),
          ["layout-plugin", "caller-plugin", "target-plugin", "incompatible-plugin"],
        );
        assert(snapshot.plugins.every((plugin) => !("hash" in plugin)));
        assert(f.snapshotCalls() >= 2);
      }).pipe(Effect.scoped),
    ),
  );
});

test("restart retains an uninstalled optional declaration and revalidates its reinstallation", async () => {
  await withProfile(async (root) => {
    const recipe = {
      layout: "layout-plugin",
      slots: [
        {
          key: "area",
          contributions: [{ pluginId: "panel-plugin", id: "tabs", optional: true as const }],
        },
      ],
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture(root);
          yield* f.stage("layout-plugin", true);
          yield* f.stage("panel-plugin", true);
          yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
            enabled: ["layout-plugin", "panel-plugin"],
            composition: recipe,
            serviceBindings: [],
          });
          yield* f.manager.uninstall("panel-plugin");
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture(root);
          yield* f.manager.restore();
          assert.deepEqual((yield* f.manager.plan()).composition, recipe);
          assert.deepEqual([...f.active.keys()], ["layout-plugin"]);
          yield* f.stage("panel-plugin", true);
          f.denied.add("panel-plugin");
          const before = yield* Effect.promise(() => readFile(path(root), "utf8"));
          assert(Exit.isFailure(yield* Effect.exit(f.manager.enable("panel-plugin"))));
          assert.equal(yield* Effect.promise(() => readFile(path(root), "utf8")), before);
          f.denied.delete("panel-plugin");
          yield* f.manager.enable("panel-plugin");
          assert.equal(f.active.has("panel-plugin"), true);
          assert.deepEqual((yield* f.manager.plan()).composition, recipe);
        }),
      ),
    );
  });
});

test("optional composition declarations survive disable and uninstall, while a required fallback cannot be disabled", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        yield* f.stage("layout-plugin", true);
        yield* f.stage("panel-plugin", true);
        const optional = yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
          enabled: ["layout-plugin", "panel-plugin"],
          composition: {
            layout: "layout-plugin",
            slots: [
              {
                key: "area",
                contributions: [{ pluginId: "panel-plugin", id: "tabs", optional: true }],
              },
            ],
          },
          serviceBindings: [],
        });
        yield* f.manager.disable("panel-plugin");
        assert.deepEqual((yield* f.manager.plan()).composition, optional.composition);
        yield* f.manager.uninstall("panel-plugin");
        assert.deepEqual((yield* f.manager.plan()).composition, optional.composition);
        assert.equal(
          (yield* f.manager.managementSnapshot()).plugins.some((p) => p.id === "panel-plugin"),
          false,
        );
      }).pipe(Effect.scoped),
    ),
  );

  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        yield* f.stage("layout-plugin", true);
        yield* f.stage("panel-plugin", true);
        const active = yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
          enabled: ["layout-plugin", "panel-plugin"],
          composition: {
            layout: "layout-plugin",
            slots: [
              {
                key: "area",
                contributions: [{ pluginId: "panel-plugin", id: "tabs" }],
                route: { fallback: { pluginId: "panel-plugin", id: "tabs" } },
              },
            ],
          },
          serviceBindings: [],
        });
        const before = yield* Effect.promise(() => readFile(path(root), "utf8"));
        assert.match(
          (yield* f.manager.disable("panel-plugin").pipe(Effect.flip)).message,
          /Required/,
        );
        assert.match(
          (yield* f.manager.uninstall("panel-plugin").pipe(Effect.flip)).message,
          /Required/,
        );
        assert.deepEqual(yield* f.manager.plan(), active);
        assert.equal(yield* Effect.promise(() => readFile(path(root), "utf8")), before);
      }).pipe(Effect.scoped),
    ),
  );
});

test("a failed explicit optional activation rolls back to its declared placeholder", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        yield* f.stage("layout-plugin", true);
        yield* f.stage("panel-plugin", true);
        const placeholder = {
          layout: "layout-plugin",
          slots: [
            {
              key: "area",
              contributions: [{ pluginId: "panel-plugin", id: "tabs", optional: true as const }],
            },
          ],
        };
        const old = yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
          enabled: ["layout-plugin"],
          composition: placeholder,
          serviceBindings: [],
        });
        f.failures.add("panel-plugin");
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              f.manager.applyPlan(old.revision, {
                enabled: ["layout-plugin", "panel-plugin"],
                composition: placeholder,
                serviceBindings: [],
              }),
            ),
          ),
        );
        assert.deepEqual(yield* f.manager.plan(), old);
        assert.equal(f.active.has("panel-plugin"), false);
        assert.equal((yield* readRegistry(root)).pendingPlan, undefined);
      }).pipe(Effect.scoped),
    ),
  );
});

test("a sidebar replacement admitted through its management port survives the caller stop", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* createPluginArtifactStore(root);
        const application = yield* Scope.make();
        const port = yield* createPluginManagement().pipe(
          Effect.provideService(Scope.Scope, application),
        );
        const trigger = yield* Deferred.make<void>();
        const topStarted = yield* Deferred.make<void>();
        const active = new Map<string, number>();
        let activeRevision = 0;
        const launch: PluginManagerOptions["launch"] = (artifact, _grant, ready, activation) =>
          Effect.gen(function* () {
            const id = artifact.manifest.id;
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                active.set(id, activation.generation);
              }),
              () =>
                Effect.sync(() => {
                  active.delete(id);
                }),
            );
            yield* ready;
            if (id === "top-plugin") yield* Deferred.succeed(topStarted, undefined);
            if (id === "sidebar-plugin") {
              yield* Deferred.await(trigger);
              yield* port
                .forPlugin("sidebar-plugin", () => true)
                .replaceSelf("top-plugin", activeRevision);
            }
            yield* Effect.never;
          }).pipe(Effect.scoped);
        const manager = yield* createPluginManager({
          profileRoot: root,
          grants: grants(new Set()),
          launch,
        });
        yield* port.bind(manager);
        for (const id of ["model-plugin", "pins-plugin", "sidebar-plugin", "top-plugin"]) {
          const artifact = yield* artifacts.stage({
            manifest: { id, name: id, version: "1.0.0", capabilities: [] },
            code: id,
          });
          yield* manager.install(artifact.hash, id, { staged: true });
        }
        const initial = yield* manager.applyPlan((yield* manager.plan()).revision, {
          enabled: ["model-plugin", "pins-plugin", "sidebar-plugin"],
          serviceBindings: [],
        });
        activeRevision = initial.revision;
        const retained = new Map(active);
        yield* Deferred.succeed(trigger, undefined);
        yield* Deferred.await(topStarted).pipe(Effect.timeout(5_000));
        const committed = yield* manager.plan();
        assert.deepEqual(committed.enabled, ["model-plugin", "pins-plugin", "top-plugin"]);
        assert.equal(active.has("sidebar-plugin"), false);
        assert.equal(active.get("model-plugin"), retained.get("model-plugin"));
        assert.equal(active.get("pins-plugin"), retained.get("pins-plugin"));
        assert(active.has("top-plugin"));
        yield* Scope.close(application, Exit.void).pipe(Effect.timeout(5_000));
      }).pipe(Effect.scoped),
    ),
  );
});

test("six-worker plans are admitted, while a seventh and failed replacement preserve the live plan", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        for (const id of [
          "first-plugin",
          "second-plugin",
          "third-plugin",
          "fourth-plugin",
          "fifth-plugin",
          "sixth-plugin",
          "bad-plugin",
        ])
          yield* f.stage(id);
        const initial = yield* f.manager.plan();
        const current = yield* f.manager.applyPlan(initial.revision, {
          enabled: [
            "first-plugin",
            "second-plugin",
            "third-plugin",
            "fourth-plugin",
            "fifth-plugin",
            "sixth-plugin",
          ],
          serviceBindings: [],
        });
        assert.equal(f.active.size, 6);
        assert.equal(f.peak(), 6);
        const before = yield* Effect.promise(() => readFile(path(root), "utf8"));
        const retained = new Map(f.active);
        const attempt = {
          enabled: [
            "first-plugin",
            "second-plugin",
            "third-plugin",
            "fourth-plugin",
            "fifth-plugin",
            "sixth-plugin",
            "bad-plugin",
          ],
          serviceBindings: [],
        };
        assert.match(
          (yield* f.manager.applyPlan(current.revision - 1, attempt).pipe(Effect.flip)).message,
          /stale/,
        );
        assert.match(
          (yield* f.manager.applyPlan(current.revision, attempt).pipe(Effect.flip)).message,
          /6/,
        );
        assert.deepEqual(yield* f.manager.plan(), current);
        assert.equal(yield* Effect.promise(() => readFile(path(root), "utf8")), before);
        assert.deepEqual(f.active, retained);
        f.failures.add("bad-plugin");
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              f.manager.applyPlan(current.revision, {
                enabled: [
                  "first-plugin",
                  "second-plugin",
                  "third-plugin",
                  "fourth-plugin",
                  "fifth-plugin",
                  "bad-plugin",
                ],
                serviceBindings: [],
              }),
            ),
          ),
        );
        assert.equal(yield* Effect.promise(() => readFile(path(root), "utf8")), before);
        assert.deepEqual(yield* f.manager.plan(), current);
        assert.equal(f.active.size, 6);
        assert.equal(f.active.has("bad-plugin"), false);
        for (const id of [
          "first-plugin",
          "second-plugin",
          "third-plugin",
          "fourth-plugin",
          "fifth-plugin",
        ])
          assert.equal(f.active.get(id), retained.get(id));
        assert.equal(f.active.has("sixth-plugin"), true);
        assert.equal((yield* readRegistry(root)).pendingPlan, undefined);
        assert.equal(f.peak(), 6);
      }).pipe(Effect.scoped),
    ),
  );
});

test("cancelling a pending activation restores the old plan and retains an untouched worker", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        for (const id of ["steady-plugin", "old-plugin", "waiting-plugin"]) yield* f.stage(id);
        const old = yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
          enabled: ["steady-plugin", "old-plugin"],
          serviceBindings: [],
        });
        const steadyGeneration = f.active.get("steady-plugin");
        const oldGeneration = f.active.get("old-plugin");
        const entered = yield* Deferred.make<void>();
        f.entered.set("waiting-plugin", entered);
        f.waits.set("waiting-plugin", yield* Deferred.make<void>());
        const change = yield* f.manager
          .applyPlan(old.revision, {
            enabled: ["steady-plugin", "waiting-plugin"],
            serviceBindings: [],
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered).pipe(Effect.timeout(3_000));
        const pending = yield* readRegistry(root);
        assert.deepEqual(pending.activePlan, old);
        assert(pending.pendingPlan);
        yield* Fiber.interrupt(change);
        assert.deepEqual(yield* f.manager.plan(), old);
        assert.equal((yield* readRegistry(root)).pendingPlan, undefined);
        assert.equal(f.active.get("steady-plugin"), steadyGeneration);
        assert.notEqual(f.active.get("old-plugin"), oldGeneration);
        assert.equal(f.active.has("waiting-plugin"), false);
      }).pipe(Effect.scoped),
    ),
  );
});

test("failed runtime rollback preserves the recovery journal and poisons mutations", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        yield* f.stage("old-plugin");
        yield* f.stage("bad-plugin");
        const old = yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
          enabled: ["old-plugin"],
          serviceBindings: [],
        });
        f.failures.add("old-plugin");
        f.failures.add("bad-plugin");
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              f.manager.applyPlan(old.revision, { enabled: ["bad-plugin"], serviceBindings: [] }),
            ),
          ),
        );
        const pending = yield* readRegistry(root);
        assert.deepEqual(pending.activePlan, old);
        assert(pending.pendingPlan);
        assert.equal(f.recoveries(), 1);
        assert.match(
          (yield* f.manager.enable("old-plugin").pipe(Effect.flip)).message,
          /restart required/,
        );
      }).pipe(Effect.scoped),
    ),
  );
});

test("startup restores the active plan before clearing a pending candidate and ignores legacy files", async () => {
  await withProfile(async (root) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        yield* f.stage("old-plugin");
        yield* f.stage("new-plugin");
        const old = yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
          enabled: ["old-plugin"],
          serviceBindings: [],
        });
        const registry = yield* readRegistry(root);
        yield* Effect.promise(() =>
          writeFile(
            path(root),
            JSON.stringify({
              ...registry,
              pendingPlan: {
                candidate: {
                  revision: old.revision + 1,
                  enabled: ["new-plugin"],
                  serviceBindings: [],
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
    );
    // Failed recovery must retain the journal without turning a required old worker
    // into a suspension that a subsequent restart can silently skip.
    for (const fault of ["activation", "authority"]) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const f = yield* fixture(root);
          if (fault === "activation") f.failures.add("old-plugin");
          else f.denied.add("old-plugin");
          const before = yield* Effect.promise(() => readFile(path(root), "utf8"));
          assert(Exit.isFailure(yield* Effect.exit(f.manager.restore())));
          assert.equal(f.recoveries(), 1);
          assert.equal(yield* Effect.promise(() => readFile(path(root), "utf8")), before);
          assert.match(
            (yield* f.manager.enable("old-plugin").pipe(Effect.flip)).message,
            /restart required/,
          );
        }).pipe(Effect.scoped),
      );
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        let legacyReads = 0;
        const manager = yield* createPluginManager({
          ...f.options,
          readLegacyPlan: Effect.sync(() => {
            legacyReads++;
            throw new Error("must not read old files");
          }),
        });
        yield* manager.restore();
        assert.equal(legacyReads, 0);
        assert.equal(f.active.has("old-plugin"), true);
        assert.equal(f.active.has("new-plugin"), false);
        assert.equal((yield* readRegistry(root)).pendingPlan, undefined);
      }).pipe(Effect.scoped),
    );
  });
});

test("V1 migration validates before writing and a safe-mode writer cannot race into V2", async () => {
  await withProfile(async (root) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        yield* f.stage("old-plugin");
        yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
          enabled: ["old-plugin"],
          serviceBindings: [],
        });
      }).pipe(Effect.scoped),
    );
    const persisted = JSON.parse(await readFile(path(root), "utf8"));
    // Version 1 has no suspension/removal fields or plan envelope.
    const plugins = persisted.plugins.map(
      ({
        suspended: _suspended,
        removing: _removing,
        ...plugin
      }: {
        suspended?: boolean;
        removing?: boolean;
        [key: string]: unknown;
      }) => plugin,
    );
    const legacy = JSON.stringify({ version: 1, plugins });
    await writeFile(path(root), legacy);
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        const invalid = yield* createPluginManager({
          ...f.options,
          readLegacyPlan: Effect.succeed({
            composition: { layout: "missing-layout", slots: [] },
            serviceBindings: [],
          }),
        });
        assert(Exit.isFailure(yield* Effect.exit(invalid.plan())));
        assert.equal(yield* Effect.promise(() => readFile(path(root), "utf8")), legacy);
        const safe = yield* createPluginManager({ ...f.options, safeMode: true });
        const normal = yield* createPluginManager(f.options);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const original = fs.mkdir;
        let armed = true;
        fs.mkdir = new Proxy(original, {
          apply(target, receiver, args) {
            if (armed && args[0] === join(root, "hitchhiker-plugins", ".plugin-write-lock")) {
              armed = false;
              entered.resolve();
              return release.promise.then(() => Reflect.apply(target, receiver, args));
            }
            return Reflect.apply(target, receiver, args);
          },
        });
        syncBuiltinESMExports();
        try {
          const stale = yield* safe.disable("old-plugin").pipe(Effect.forkScoped);
          yield* Effect.promise(() => entered.promise).pipe(Effect.timeout(3_000));
          const migrated = yield* normal.plan();
          assert.deepEqual(migrated.enabled, ["old-plugin"]);
          const before = yield* Effect.promise(() => readFile(path(root), "utf8"));
          release.resolve();
          assert.match((yield* Fiber.join(stale).pipe(Effect.flip)).message, /changed; retry/);
          assert.equal(yield* Effect.promise(() => readFile(path(root), "utf8")), before);
          assert.equal((yield* readRegistry(root)).version, 2);
          assert.equal(f.active.size, 0);
        } finally {
          release.resolve();
          fs.mkdir = original;
          syncBuiltinESMExports();
        }
      }).pipe(Effect.scoped),
    );
  });
});

test("independent manager replaces a presenter, rejects stale or revoked candidates, and rolls back failure", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        for (const id of ["layout-plugin", "source-plugin", "target-plugin", "bad-plugin"])
          yield* f.stage(id, true);
        yield* f.stage("settings-plugin");
        const initial = yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
          enabled: ["source-plugin", "layout-plugin", "settings-plugin"],
          composition: {
            layout: "layout-plugin",
            slots: [
              {
                key: "area",
                route: { fallback: { pluginId: "source-plugin", id: "tabs" } },
                contributions: [{ pluginId: "source-plugin", id: "tabs" }],
              },
            ],
          },
          serviceBindings: [],
        });
        const port = yield* createPluginManagement();
        yield* port.bind(f.manager);
        const settingsGeneration = f.active.get("settings-plugin");
        const layoutGeneration = f.active.get("layout-plugin");
        const api = port.forPlugin(
          "settings-plugin",
          () => f.active.get("settings-plugin") === settingsGeneration,
        );
        const before = yield* Effect.promise(() => readFile(path(root), "utf8"));
        for (const args of [
          ["source-plugin", "target-plugin", initial.revision - 1],
          ["target-plugin", "source-plugin", initial.revision],
          ["source-plugin", "source-plugin", initial.revision],
          ["source-plugin", "missing-plugin", initial.revision],
        ] as const)
          assert(Exit.isFailure(yield* Effect.exit(api.replace(args[0], args[1], args[2]))));
        f.denied.add("target-plugin");
        assert(
          Exit.isFailure(
            yield* Effect.exit(api.replace("source-plugin", "target-plugin", initial.revision)),
          ),
        );
        f.denied.clear();
        assert.equal(yield* Effect.promise(() => readFile(path(root), "utf8")), before);
        f.failures.add("bad-plugin");
        assert(
          Exit.isFailure(
            yield* Effect.exit(api.replace("source-plugin", "bad-plugin", initial.revision)),
          ),
        );
        assert(
          f.launches.has("bad-plugin"),
          "rollback test must reach failing candidate activation",
        );
        assert.deepEqual(yield* f.manager.plan(), initial);
        assert(f.active.has("source-plugin"));
        assert(!f.active.has("bad-plugin"));
        const result = yield* api.replace("source-plugin", "target-plugin", initial.revision);
        assert.equal(result.revision, initial.revision + 1);
        const plan = yield* f.manager.plan();
        assert.deepEqual(plan.enabled, ["target-plugin", "layout-plugin", "settings-plugin"]);
        assert.equal(plan.composition?.slots[0]?.route?.fallback.pluginId, "target-plugin");
        assert.equal(plan.composition?.slots[0]?.contributions[0]?.pluginId, "target-plugin");
        assert.equal(f.active.get("settings-plugin"), settingsGeneration);
        assert.equal(f.active.get("layout-plugin"), layoutGeneration);
        assert(!f.active.has("source-plugin"));
        assert.equal(f.peak(), 3);
      }).pipe(Effect.scoped),
    ),
  );
});

test("management invalidations subscribe before initial delivery and coalesce settled mutations", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        const initial = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const events: unknown[] = [];
        const listener = yield* f.manager.events.pipe(
          Stream.take(2),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (events.length === 1) {
                yield* Deferred.succeed(initial, undefined);
                yield* Deferred.await(release);
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(initial);
        yield* f.stage("observed-plugin");
        yield* f.manager.enable("observed-plugin");
        yield* f.manager.disable("observed-plugin");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(listener).pipe(Effect.timeout(2_000));
        assert.deepEqual(events, [
          { event: "plugins.changed", payload: {} },
          { event: "plugins.changed", payload: {} },
        ]);
        const snapshot = yield* f.manager.managementSnapshot();
        assert.equal(snapshot.plugins[0]?.enabled, false);
        assert.equal(snapshot.plugins[0]?.running, false);

        const ready = yield* Deferred.make<void>();
        const enabled = yield* Deferred.make<void>();
        const removed = yield* Deferred.make<void>();
        let reads = 0;
        yield* f.manager.events.pipe(
          Stream.runForEach(() =>
            Effect.gen(function* () {
              const current = yield* f.manager.managementSnapshot();
              reads++;
              if (reads === 1) yield* Deferred.succeed(ready, undefined);
              else if (current.plugins.length === 0) yield* Deferred.succeed(removed, undefined);
              else if (current.plugins[0]?.running) yield* Deferred.succeed(enabled, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        yield* f.manager.enable("observed-plugin");
        yield* Deferred.await(enabled).pipe(Effect.timeout(2_000));
        yield* f.manager.uninstall("observed-plugin");
        yield* Deferred.await(removed).pipe(Effect.timeout(2_000));
        assert.equal(f.active.size, 0);
        assert.equal(reads, 3, "one settled invalidation per enable/removal transaction");
      }).pipe(Effect.scoped),
    ),
  );
});

test("unexpected worker termination invalidates inventory and retains unrelated activation", async () => {
  await withProfile((root) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture(root);
        const crash = yield* Deferred.make<void>();
        f.crashes.set("crashing-plugin", crash);
        yield* f.stage("crashing-plugin");
        yield* f.stage("retained-plugin");
        yield* f.manager.applyPlan((yield* f.manager.plan()).revision, {
          enabled: ["crashing-plugin", "retained-plugin"],
          serviceBindings: [],
        });
        const retained = f.active.get("retained-plugin");
        const subscribed = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        yield* f.manager.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              assert.deepEqual(event, { event: "plugins.changed", payload: {} });
              const current = yield* f.manager.managementSnapshot();
              const crashed = current.plugins.find((plugin) => plugin.id === "crashing-plugin");
              if (crashed?.running) yield* Deferred.succeed(subscribed, undefined);
              if (crashed && !crashed.running && crashed.lastFailure !== undefined)
                yield* Deferred.succeed(stopped, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed).pipe(Effect.timeout(2_000));
        yield* Deferred.succeed(crash, undefined);
        yield* Deferred.await(stopped).pipe(Effect.timeout(3_000));
        assert.equal(f.active.get("retained-plugin"), retained);
        assert(!f.active.has("crashing-plugin"));
      }).pipe(Effect.scoped),
    ),
  );
});
