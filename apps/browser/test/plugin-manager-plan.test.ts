import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Deferred, Effect, Exit, Fiber } from "effect";
import {
  makePluginComposition,
  type GrantStoreApi,
  type InstalledPluginPlanInput,
} from "@hitchhiker/runtime";
import { column, text, viewport } from "@hitchhiker/ui";
import { createPluginManager, type PluginManagerOptions } from "../src/plugin-manager.ts";
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
      denied.has(id) ? Effect.fail("revoked") : Effect.succeed({ principal: id, grant: {} }),
    authorizeGrant: (id: string) =>
      denied.has(id) ? Effect.fail("revoked") : Effect.succeed({ principal: id, grant: {} }),
  }) as unknown as GrantStoreApi;
const fixture = Effect.fn("test.planFixture")(function* (root: string) {
  const artifacts = yield* createPluginArtifactStore(root);
  const denied = new Set<string>();
  const active = new Map<string, number>();
  const launches = new Map<string, number[]>();
  const failures = new Set<string>();
  const waits = new Map<string, Deferred.Deferred<void>>();
  const entered = new Map<string, Deferred.Deferred<void>>();
  let peak = 0;
  let recoveries = 0;
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
      yield* ready;
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
  const manager = yield* createPluginManager(options);
  const stage = Effect.fn("test.stagePlanPlugin")(function* (id: string, ui = false) {
    const artifact = yield* artifacts.stage({
      manifest: { id, name: id, version: "1.0.0", capabilities: ui ? ["ui.compose"] : [] },
      code: id,
    });
    yield* manager.install(artifact.hash, id, { staged: true });
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
    peak: () => peak,
    recoveries: () => recoveries,
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

test("stale, over-capacity and revoked plans have no durable or worker side effects", async () => {
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
        ])
          yield* f.stage(id);
        const initial = yield* f.manager.plan();
        const current = yield* f.manager.applyPlan(initial.revision, {
          enabled: ["first-plugin"],
          serviceBindings: [],
        });
        const before = yield* Effect.promise(() => readFile(path(root), "utf8"));
        const generation = f.active.get("first-plugin");
        const attempt = {
          enabled: [
            "first-plugin",
            "second-plugin",
            "third-plugin",
            "fourth-plugin",
            "fifth-plugin",
          ],
          serviceBindings: [],
        };
        assert.match(
          (yield* f.manager.applyPlan(current.revision - 1, attempt).pipe(Effect.flip)).message,
          /stale/,
        );
        assert.match(
          (yield* f.manager.applyPlan(current.revision, attempt).pipe(Effect.flip)).message,
          /four/,
        );
        f.denied.add("second-plugin");
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              f.manager.applyPlan(current.revision, {
                enabled: ["first-plugin", "second-plugin"],
                serviceBindings: [],
              }),
            ),
          ),
        );
        assert.equal(yield* Effect.promise(() => readFile(path(root), "utf8")), before);
        assert.equal(f.active.get("first-plugin"), generation);
        assert.equal(f.active.size, 1);
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
