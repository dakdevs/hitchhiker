import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import {
  createGrantStore,
  GrantStoreError,
  LivePluginManifest,
  createPluginStorage,
  PluginStorageError,
  type InstalledPluginPlanInput,
  type PluginStorageAdapter,
} from "@hitchhiker/runtime";
import { Effect, Schema } from "effect";
import {
  DefaultTabModelPluginId,
  DefaultTabPinsPluginId,
  mapDefaultPluginState,
  type DefaultPluginStateStorage,
} from "../src/default-plugin-state-migration.ts";
import {
  runDefaultPluginBootstrap,
  type DefaultPluginBootstrapOptions,
  type DefaultPluginBundle,
} from "../src/default-plugin-bootstrap.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import {
  createPluginManager,
  PluginManagerError,
  type PluginManager,
} from "../src/plugin-manager.ts";
import { ProfileWriteLeaseError, type ProfileWriteLease } from "../src/profile-write-lease.ts";

const ids = [
  "default-tab-model",
  "default-tab-pins",
  "default-browser-layout",
  "default-sidebar-tabs",
  "default-top-tabs",
  "default-devtools",
  "default-extension-management",
] as const;
const caps = [
  ["pages.list", "pages.manage", "storage.local"],
  ["pages.list", "storage.local"],
  ["ui.compose", "configuration.read"],
  [
    "ui.compose",
    "pages.list",
    "pages.manage",
    "storage.local",
    "configuration.read",
    "configuration.write",
    "plugins.read",
    "plugins.manage",
  ],
  [
    "ui.compose",
    "pages.list",
    "pages.manage",
    "storage.local",
    "configuration.read",
    "configuration.write",
    "plugins.read",
    "plugins.manage",
  ],
  [
    "ui.compose",
    "devtools.manage",
    "pages.list",
    "pages.manage",
    "storage.local",
    "configuration.read",
  ],
  [
    "ui.compose",
    "extensions.read",
    "extensions.manage",
    "extensions.install",
    "configuration.read",
  ],
] as const;
const plan = (placement: "sidebar" | "top", version: 1 | 2 | 3 = 3): InstalledPluginPlanInput => {
  const presenter = `default-${placement}-tabs`;
  return {
    enabled: [
      "default-tab-model",
      "default-tab-pins",
      "default-browser-layout",
      presenter,
      ...(version >= 2 ? ["default-devtools"] : []),
      ...(version === 3 ? ["default-extension-management"] : []),
    ],
    composition: {
      layout: "default-browser-layout",
      slots: ["tabs", "toolbar", "content"].map((key) => ({
        key,
        contributions: [
          { pluginId: presenter, id: key },
          ...(version === 2 && key === "toolbar"
            ? [{ pluginId: "default-devtools", id: "toolbar" }]
            : []),
          ...(version === 3 && key === "toolbar"
            ? [
                { pluginId: "default-devtools", id: "toolbar" },
                {
                  pluginId: "default-extension-management",
                  id: "launcher",
                  optional: true as const,
                },
              ]
            : []),
          ...(version === 3 && key === "content"
            ? [
                { pluginId: presenter, id: "settings", optional: true as const },
                { pluginId: presenter, id: "plugins", optional: true as const },
                {
                  pluginId: "default-extension-management",
                  id: "main",
                  optional: true as const,
                },
              ]
            : []),
        ],
        ...(version === 3 && key === "content"
          ? { route: { fallback: { pluginId: presenter, id: "content" } } }
          : {}),
      })),
    },
    serviceBindings: [
      { consumer: presenter, dependency: "model", provider: "default-tab-model", service: "model" },
      { consumer: presenter, dependency: "pins", provider: "default-tab-pins", service: "pins" },
      {
        consumer: presenter,
        dependency: "layout",
        provider: "default-browser-layout",
        service: "layout",
      },
      ...(version >= 2
        ? [
            {
              consumer: "default-devtools",
              dependency: "model",
              provider: "default-tab-model",
              service: "model",
            },
            {
              consumer: "default-devtools",
              dependency: "layout",
              provider: "default-browser-layout",
              service: "layout",
            },
          ]
        : []),
    ],
  } satisfies InstalledPluginPlanInput;
};
const contract = (name: string) => ({ name, version: "1.0.0", digest: "a".repeat(64) });
const bundle: DefaultPluginBundle = {
  packages: ids.map((id, index) => ({
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      capabilities: caps[index],
      ...(id === "default-tab-model"
        ? { provides: [{ id: "model", contract: contract("model") }] }
        : {}),
      ...(id === "default-tab-pins"
        ? { provides: [{ id: "pins", contract: contract("pins") }] }
        : {}),
      ...(id === "default-browser-layout"
        ? { provides: [{ id: "layout", contract: contract("layout") }] }
        : {}),
      ...(id === "default-sidebar-tabs" || id === "default-top-tabs"
        ? {
            requires: [
              { id: "model", contract: contract("model") },
              { id: "pins", contract: contract("pins"), optional: true },
              { id: "layout", contract: contract("layout") },
            ],
          }
        : {}),
      ...(id === "default-devtools"
        ? {
            requires: [
              { id: "model", contract: contract("model") },
              { id: "layout", contract: contract("layout") },
            ],
          }
        : {}),
    },
    code: `/* ${id} */`,
  })),
  plans: { sidebar: plan("sidebar"), top: plan("top") },
};
const changedBundle: DefaultPluginBundle = {
  ...bundle,
  packages: bundle.packages.map((item, index) =>
    index === 0 ? { ...item, code: "/* changed application bundle */" } : item,
  ),
};

const lease = (profileRoot: string) => ({
  profileRoot,
  assertHeld: Effect.void,
  withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
});

interface Harness {
  readonly profileRoot: string;
  readonly manager: PluginManager;
  readonly artifacts: Effect.Success<ReturnType<typeof createPluginArtifactStore>>;
  readonly grants: Effect.Success<ReturnType<typeof createGrantStore>>;
  readonly storage: Effect.Success<ReturnType<typeof createPluginStorage>>;
  readonly input: DefaultPluginBootstrapOptions;
  readonly observed: { loads: number; launches: number };
}

const withHarness = async (
  name: string,
  placement: "sidebar" | "top",
  use: (harness: Harness) => Effect.Effect<void, unknown>,
) => {
  const profileRoot = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const grants = yield* createGrantStore({ directory: join(profileRoot, "grants") });
          const artifacts = yield* createPluginArtifactStore(profileRoot);
          const storage = yield* createPluginStorage({ profileRoot });
          const observed = { loads: 0, launches: 0 };
          const manager = yield* createPluginManager({
            profileRoot,
            grants,
            launch: (_artifact, _grant, ready) =>
              Effect.sync(() => {
                observed.launches++;
              }).pipe(Effect.andThen(ready), Effect.andThen(Effect.never)),
          });
          const input = {
            profileRoot,
            lease: lease(profileRoot),
            manager,
            artifacts,
            grants,
            storage,
            seed: mapDefaultPluginState(undefined, { pageIds: [], pageOrder: [] }),
            placement,
            loadBundle: Effect.sync(() => {
              observed.loads++;
              return bundle;
            }),
          } satisfies DefaultPluginBootstrapOptions;
          yield* use({ profileRoot, manager, artifacts, grants, storage, input, observed });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    );
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
};

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      assert.equal(exit._tag, "Failure");
    }),
  );
const journalText = (profileRoot: string) =>
  Effect.promise(() =>
    readFile(join(profileRoot, "hitchhiker-plugins", "default-bootstrap.json"), "utf8"),
  );
const injectedManagerError = () => new PluginManagerError({ message: "injected boundary" });

for (const placement of ["sidebar", "top"] satisfies readonly ("sidebar" | "top")[]) {
  test(`boots the exact ${placement} plan and stays completed after every default is removed`, () =>
    withHarness("hitchhiker-bootstrap-plan", placement, (harness) =>
      Effect.gen(function* () {
        yield* runDefaultPluginBootstrap(harness.input);
        assert.deepEqual(
          (yield* harness.manager.list()).map((item) => [item.id, item.enabled]),
          ids.map((id) => [id, plan(placement).enabled.includes(id)]),
        );
        assert.deepEqual(yield* harness.manager.plan(), { ...plan(placement), revision: 8 });
        const grants = yield* harness.grants.list();
        assert.equal(grants.length, 7);
        assert.deepEqual(
          [
            ...(grants.find((grant) => grant.principal === "default-extension-management")
              ?.capabilities ?? []),
          ].sort(),
          [
            "ui.compose",
            "extensions.read",
            "extensions.manage",
            "extensions.install",
            "configuration.read",
          ].sort(),
        );
        assert.equal(harness.observed.loads, 1);
        assert.equal(harness.observed.launches, 6);
        assert.deepEqual(JSON.parse(yield* journalText(harness.profileRoot)), {
          version: 3,
          id: "default-browser-v3",
          state: "completed",
          revision: 8,
        });

        yield* harness.manager.applyPlan(8, { enabled: [], serviceBindings: [] });
        for (const id of [...ids].reverse()) yield* harness.manager.uninstall(id);
        assert.deepEqual(yield* harness.manager.list(), []);
        yield* runDefaultPluginBootstrap(harness.input);
        assert.deepEqual(yield* harness.manager.list(), []);
        assert.equal(harness.observed.loads, 1);
      }),
    ));
}

test("rejects a V3 extension artifact with authority outside the frozen cohort", () =>
  withHarness("hitchhiker-bootstrap-extension-authority", "sidebar", (harness) =>
    Effect.gen(function* () {
      const packages = bundle.packages.map((item) =>
        (item.manifest as { id?: unknown }).id === "default-extension-management"
          ? {
              ...item,
              manifest: {
                ...(item.manifest as Record<string, unknown>),
                capabilities: [
                  "ui.compose",
                  "extensions.read",
                  "extensions.manage",
                  "extensions.install",
                  "configuration.read",
                  "plugins.manage",
                ],
              },
            }
          : item,
      );
      yield* expectFailure(
        runDefaultPluginBootstrap({
          ...harness.input,
          loadBundle: Effect.succeed({ ...bundle, packages }),
        }),
      );
      assert.deepEqual(yield* harness.manager.list(), []);
      assert.deepEqual(yield* harness.grants.list(), []);
      assert.equal(harness.observed.launches, 0);
    }),
  ));

test("resumes a fully checkpointed installed prefix without duplicate grants", () =>
  withHarness("hitchhiker-bootstrap-prefix", "sidebar", (harness) =>
    Effect.gen(function* () {
      let installs = 0;
      const interrupted = {
        ...harness.manager,
        install: (hash, grantId, options) =>
          Effect.suspend(() => {
            installs++;
            return installs === 3
              ? Effect.fail(injectedManagerError())
              : harness.manager.install(hash, grantId, options);
          }),
      } satisfies PluginManager;
      yield* expectFailure(runDefaultPluginBootstrap({ ...harness.input, manager: interrupted }));
      assert.deepEqual(
        (yield* harness.manager.list()).map((item) => item.id),
        ids.slice(0, 2),
      );
      assert.match(yield* journalText(harness.profileRoot), /"expectedRevision":2/);

      yield* runDefaultPluginBootstrap(harness.input);
      assert.equal((yield* harness.grants.list()).length, 7);
      assert.deepEqual((yield* harness.manager.plan()).enabled, plan("sidebar").enabled);
      assert.equal(harness.observed.launches, 6);
    }),
  ));

test("accepts an install-before-journal gap after the second artifact", () =>
  withHarness("hitchhiker-bootstrap-install-gap", "sidebar", (harness) =>
    Effect.gen(function* () {
      let installs = 0;
      const interrupted = {
        ...harness.manager,
        install: (hash, grantId, options) =>
          Effect.suspend(() => {
            installs++;
            const installed = harness.manager.install(hash, grantId, options);
            return installs === 2
              ? installed.pipe(Effect.andThen(Effect.fail(injectedManagerError())))
              : installed;
          }),
      } satisfies PluginManager;
      yield* expectFailure(runDefaultPluginBootstrap({ ...harness.input, manager: interrupted }));
      assert.equal((yield* harness.manager.plan()).revision, 2);
      assert.match(yield* journalText(harness.profileRoot), /"expectedRevision":1/);

      yield* runDefaultPluginBootstrap(harness.input);
      assert.match(yield* journalText(harness.profileRoot), /"state":"completed"/);
      assert.equal((yield* harness.grants.list()).length, 7);
    }),
  ));

for (const changed of ["artifact", "grant", "extra-plugin"] satisfies readonly string[]) {
  test(`abandons a pending bootstrap with a changed ${changed}`, () =>
    withHarness(`hitchhiker-bootstrap-diverged-${changed}`, "sidebar", (harness) =>
      Effect.gen(function* () {
        let installs = 0;
        const stopAfterFirst = {
          ...harness.manager,
          install: (hash, grantId, options) =>
            Effect.suspend(() => {
              installs++;
              return installs === 2
                ? Effect.fail(injectedManagerError())
                : harness.manager.install(hash, grantId, options);
            }),
        } satisfies PluginManager;
        yield* expectFailure(
          runDefaultPluginBootstrap({ ...harness.input, manager: stopAfterFirst }),
        );

        let manager = harness.manager;
        if (changed === "artifact" || changed === "grant") {
          manager = {
            ...harness.manager,
            inspectInstallation: (id) =>
              harness.manager.inspectInstallation(id).pipe(
                Effect.map((installation) =>
                  installation && id === ids[0]
                    ? {
                        ...installation,
                        ...(changed === "artifact"
                          ? { hash: "f".repeat(64) }
                          : { grantId: "changed-grant" }),
                      }
                    : installation,
                ),
              ),
          } satisfies PluginManager;
        } else {
          const artifact = yield* harness.artifacts.stage({
            manifest: {
              id: "extra-plugin",
              name: "extra-plugin",
              version: "1.0.0",
              capabilities: [],
            },
            code: "/* extra */",
          });
          const grant = yield* harness.grants.ensureManaged("test/extra-plugin", {
            principal: "extra-plugin",
            profileId: "default",
            capabilities: [],
            origins: [],
          });
          yield* harness.manager.install(artifact.hash, grant.id, { staged: true });
        }

        yield* runDefaultPluginBootstrap({ ...harness.input, manager });
        assert.match(yield* journalText(harness.profileRoot), /"state":"abandoned"/);
        const count = (yield* harness.manager.list()).length;
        yield* runDefaultPluginBootstrap(harness.input);
        assert.equal((yield* harness.manager.list()).length, count);
        assert.equal(harness.observed.launches, 0);
      }),
    ));
}

test("checkpoints model storage before a pins failure and resumes only the missing owner", () =>
  withHarness("hitchhiker-bootstrap-storage-checkpoint", "sidebar", (harness) =>
    Effect.gen(function* () {
      const failingPins: DefaultPluginStateStorage = {
        forOwner: (id) =>
          harness.storage.forOwner(id).pipe(
            Effect.map((owner) =>
              id === DefaultTabPinsPluginId
                ? {
                    ...owner,
                    write: () =>
                      Effect.fail(
                        new PluginStorageError({
                          code: "persistence",
                          message: "injected pins write failure",
                        }),
                      ),
                  }
                : owner,
            ),
          ),
      };
      yield* expectFailure(runDefaultPluginBootstrap({ ...harness.input, storage: failingPins }));
      assert.match(
        yield* journalText(harness.profileRoot),
        /"storagePresent":\{"model":true,"pins":false\}/,
      );
      const model = yield* harness.storage.forOwner(DefaultTabModelPluginId);
      assert.equal((yield* model.read()).revision, 1);
      assert.equal(harness.observed.launches, 0);

      yield* runDefaultPluginBootstrap(harness.input);
      const pins = yield* harness.storage.forOwner(DefaultTabPinsPluginId);
      assert.equal((yield* model.read()).revision, 1);
      assert.equal((yield* pins.read()).revision, 1);
      assert.equal(harness.observed.launches, 6);
    }),
  ));

test("a CAS conflict that rereads revision zero never promotes or launches workers", () =>
  withHarness("hitchhiker-bootstrap-cas-zero", "sidebar", (harness) =>
    Effect.gen(function* () {
      const stillZero = {
        read: () => Effect.succeed({ revision: 0, value: null }),
        write: () =>
          Effect.fail(
            new PluginStorageError({ code: "conflict", message: "injected zero CAS conflict" }),
          ),
      } satisfies PluginStorageAdapter;
      const conflictedStorage: DefaultPluginStateStorage = {
        forOwner: (id) =>
          id === DefaultTabModelPluginId ? Effect.succeed(stillZero) : harness.storage.forOwner(id),
      };
      let promotions = 0;
      const observedManager = {
        ...harness.manager,
        applyPlan: (revision, candidate) => {
          promotions++;
          return harness.manager.applyPlan(revision, candidate);
        },
      } satisfies PluginManager;

      yield* expectFailure(
        runDefaultPluginBootstrap({
          ...harness.input,
          manager: observedManager,
          storage: conflictedStorage,
        }),
      );
      assert.equal(promotions, 0);
      assert.equal(harness.observed.launches, 0);
      assert.deepEqual(yield* harness.manager.plan(), {
        enabled: [],
        serviceBindings: [],
        revision: 7,
      });
      assert.match(yield* journalText(harness.profileRoot), /"state":"pending"/);
    }),
  ));

test("recovers a promotion-before-terminal-marker gap", () =>
  withHarness("hitchhiker-bootstrap-promotion-gap", "top", (harness) =>
    Effect.gen(function* () {
      const interrupted = {
        ...harness.manager,
        applyPlan: (revision, candidate) =>
          harness.manager
            .applyPlan(revision, candidate)
            .pipe(Effect.andThen(Effect.fail(injectedManagerError()))),
      } satisfies PluginManager;
      yield* expectFailure(runDefaultPluginBootstrap({ ...harness.input, manager: interrupted }));
      assert.deepEqual(yield* harness.manager.plan(), { ...plan("top"), revision: 8 });
      assert.match(yield* journalText(harness.profileRoot), /"state":"pending"/);

      yield* runDefaultPluginBootstrap(harness.input);
      assert.match(yield* journalText(harness.profileRoot), /"state":"completed"/);
      assert.equal((yield* harness.manager.plan()).revision, 8);
      assert.equal((yield* harness.grants.list()).length, 7);
    }),
  ));

test("checks enabled installation grant identities before closing a promotion gap", () =>
  withHarness("hitchhiker-bootstrap-promotion-identity", "sidebar", (harness) =>
    Effect.gen(function* () {
      const interrupted = {
        ...harness.manager,
        applyPlan: (revision, candidate) =>
          harness.manager
            .applyPlan(revision, candidate)
            .pipe(Effect.andThen(Effect.fail(injectedManagerError()))),
      } satisfies PluginManager;
      yield* expectFailure(runDefaultPluginBootstrap({ ...harness.input, manager: interrupted }));
      const changedGrant = {
        ...harness.manager,
        inspectInstallation: (id) =>
          harness.manager
            .inspectInstallation(id)
            .pipe(
              Effect.map((installation) =>
                installation && id === DefaultTabModelPluginId
                  ? { ...installation, grantId: "changed-after-promotion" }
                  : installation,
              ),
            ),
      } satisfies PluginManager;
      yield* runDefaultPluginBootstrap({ ...harness.input, manager: changedGrant });
      assert.match(yield* journalText(harness.profileRoot), /"state":"abandoned"/);
    }),
  ));

test("uses the frozen profile artifacts when the application bundle changes while pending", () =>
  withHarness("hitchhiker-bootstrap-frozen-bundle", "sidebar", (harness) =>
    Effect.gen(function* () {
      const interrupted = {
        ...harness.manager,
        install: () => Effect.fail(injectedManagerError()),
      } satisfies PluginManager;
      yield* expectFailure(runDefaultPluginBootstrap({ ...harness.input, manager: interrupted }));
      let reloads = 0;
      yield* runDefaultPluginBootstrap({
        ...harness.input,
        loadBundle: Effect.sync(() => {
          reloads++;
          return changedBundle;
        }),
      });
      assert.equal(reloads, 0);
      assert.equal(harness.observed.loads, 1);
      const installed = yield* harness.manager.inspectInstallation(ids[0]);
      assert(installed);
      assert.equal((yield* harness.artifacts.read(installed.hash)).code, bundle.packages[0]?.code);
    }),
  ));

test("poisons an uncertain journal write reported by the lease until restart", () =>
  withHarness("hitchhiker-bootstrap-journal-poison", "sidebar", (harness) =>
    Effect.gen(function* () {
      let writes = 0;
      const uncertainLease: ProfileWriteLease = {
        profileRoot: harness.profileRoot,
        assertHeld: Effect.void,
        withWrite: (operation) =>
          Effect.suspend(() => {
            writes++;
            return writes === 1
              ? operation.pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProfileWriteLeaseError({ message: "injected post-write failure" }),
                    ),
                  ),
                )
              : operation;
          }),
      };
      yield* expectFailure(runDefaultPluginBootstrap({ ...harness.input, lease: uncertainLease }));
      assert.match(yield* journalText(harness.profileRoot), /"state":"pending"/);
      assert.deepEqual(yield* harness.manager.list(), []);
      assert.equal((yield* harness.grants.list()).length, 0);

      yield* expectFailure(runDefaultPluginBootstrap(harness.input));
      assert.deepEqual(yield* harness.manager.list(), []);
      assert.equal(harness.observed.loads, 1);
    }),
  ));

test("rejects malformed, incoherent, public, and symlinked journals", () =>
  withHarness("hitchhiker-bootstrap-journal", "sidebar", (harness) =>
    Effect.gen(function* () {
      const path = join(harness.profileRoot, "hitchhiker-plugins", "default-bootstrap.json");
      yield* Effect.promise(() =>
        writeFile(
          path,
          JSON.stringify({ id: "default-browser-v1", state: "completed", revision: 6 }),
          { mode: 0o600 },
        ),
      );
      yield* expectFailure(runDefaultPluginBootstrap(harness.input));

      yield* Effect.promise(() => rm(path));
      let installs = 0;
      const stopAtThird = {
        ...harness.manager,
        install: (hash, grantId, options) =>
          Effect.suspend(() => {
            installs++;
            return installs === 3
              ? Effect.fail(injectedManagerError())
              : harness.manager.install(hash, grantId, options);
          }),
      } satisfies PluginManager;
      yield* expectFailure(runDefaultPluginBootstrap({ ...harness.input, manager: stopAtThird }));
      const coherent = yield* journalText(harness.profileRoot);
      const incoherent = coherent.replace('"expectedRevision":2', '"expectedRevision":1');
      assert.notEqual(incoherent, coherent);
      yield* Effect.promise(() => writeFile(path, incoherent));
      yield* expectFailure(runDefaultPluginBootstrap(harness.input));

      yield* Effect.promise(() => chmod(path, 0o644));
      yield* expectFailure(runDefaultPluginBootstrap(harness.input));

      const target = join(harness.profileRoot, "journal-target.json");
      yield* Effect.promise(async () => {
        await rm(path);
        await writeFile(target, coherent, { mode: 0o600 });
        await symlink(target, path);
      });
      yield* expectFailure(runDefaultPluginBootstrap(harness.input));
    }),
  ));

test("customized profiles become terminal without loading a bundle", () =>
  withHarness("hitchhiker-bootstrap-customized", "sidebar", (harness) =>
    Effect.gen(function* () {
      const artifact = yield* harness.artifacts.stage({
        manifest: {
          id: "existing-plugin",
          name: "existing-plugin",
          version: "1.0.0",
          capabilities: [],
        },
        code: "/* existing */",
      });
      const grant = yield* harness.grants.ensureManaged("test/existing-plugin", {
        principal: "existing-plugin",
        profileId: "default",
        capabilities: [],
        origins: [],
      });
      yield* harness.manager.install(artifact.hash, grant.id, { staged: true });
      yield* runDefaultPluginBootstrap(harness.input);
      assert.equal(harness.observed.loads, 0);
      assert.match(yield* journalText(harness.profileRoot), /"reason":"profile-customized"/);
    }),
  ));

test("safe and developer modes do not load bundles or touch the journal", () =>
  withHarness("hitchhiker-bootstrap-disabled", "sidebar", (harness) =>
    Effect.gen(function* () {
      yield* runDefaultPluginBootstrap({ ...harness.input, safeMode: true });
      yield* runDefaultPluginBootstrap({ ...harness.input, developerPlugin: true });
      assert.equal(harness.observed.loads, 0);
      const exists = yield* Effect.promise(async () => {
        try {
          await access(join(harness.profileRoot, "hitchhiker-plugins", "default-bootstrap.json"));
          return true;
        } catch {
          return false;
        }
      });
      assert.equal(exists, false);
    }),
  ));

test("preserves terminal V1/V2 journals and rejects a version and id mismatch", () =>
  withHarness("hitchhiker-bootstrap-v1-terminal", "sidebar", (harness) =>
    Effect.gen(function* () {
      const path = join(harness.profileRoot, "hitchhiker-plugins", "default-bootstrap.json");
      yield* Effect.promise(() =>
        writeFile(
          path,
          JSON.stringify({
            version: 1,
            id: "default-browser-v1",
            state: "completed",
            revision: 6,
          }),
          { mode: 0o600 },
        ),
      );
      yield* runDefaultPluginBootstrap(harness.input);
      assert.equal(harness.observed.loads, 0);
      assert.deepEqual(yield* harness.manager.list(), []);
      assert.deepEqual(yield* harness.grants.list(), []);

      yield* Effect.promise(() =>
        writeFile(
          path,
          JSON.stringify({
            version: 2,
            id: "default-browser-v2",
            state: "completed",
            revision: 7,
          }),
          { mode: 0o600 },
        ),
      );
      yield* runDefaultPluginBootstrap(harness.input);
      assert.equal(harness.observed.loads, 0);
      assert.deepEqual(yield* harness.manager.list(), []);
      assert.deepEqual(yield* harness.grants.list(), []);

      yield* Effect.promise(() =>
        writeFile(
          path,
          JSON.stringify({
            version: 2,
            id: "default-browser-v2",
            state: "abandoned",
            reason: "profile-customized",
          }),
          { mode: 0o600 },
        ),
      );
      yield* runDefaultPluginBootstrap(harness.input);
      assert.equal(harness.observed.loads, 0);
      assert.deepEqual(yield* harness.grants.list(), []);

      yield* Effect.promise(() =>
        writeFile(
          path,
          JSON.stringify({
            version: 1,
            id: "default-browser-v2",
            state: "completed",
            revision: 6,
          }),
          { mode: 0o600 },
        ),
      );
      yield* expectFailure(runDefaultPluginBootstrap(harness.input));
    }),
  ));

test("resumes a V2 cohort without loading V3 artifacts or adding extension authority", () =>
  withHarness("hitchhiker-bootstrap-v2-current", "sidebar", (harness) =>
    Effect.gen(function* () {
      yield* expectFailure(
        runDefaultPluginBootstrap({
          ...harness.input,
          grants: {
            ...harness.grants,
            ensureManaged: () =>
              Effect.fail(new GrantStoreError({ code: "injected", message: "injected boundary" })),
          },
        }),
      );
      const pending = JSON.parse(yield* journalText(harness.profileRoot));
      pending.version = 2;
      pending.id = "default-browser-v2";
      pending.artifacts = pending.artifacts.slice(0, 6);
      pending.artifacts.forEach((artifact: { id: string; grantKey: string }) => {
        artifact.grantKey = `default-bootstrap/2/${artifact.id}`;
      });
      pending.plan = plan("sidebar", 2);
      pending.expectedRevision = 0;
      pending.installedPrefix = [];
      yield* Effect.promise(() =>
        writeFile(
          join(harness.profileRoot, "hitchhiker-plugins", "default-bootstrap.json"),
          JSON.stringify(pending),
        ),
      );

      yield* runDefaultPluginBootstrap({
        ...harness.input,
        loadBundle: Effect.die("must not load V3 bundle"),
      });
      assert.deepEqual(yield* harness.manager.plan(), { ...plan("sidebar", 2), revision: 7 });
      assert.equal((yield* harness.grants.list()).length, 6);
      assert.equal(harness.observed.launches, 5);
      assert.equal(
        (yield* harness.manager.list()).some(
          (plugin) => plugin.id === "default-extension-management",
        ),
        false,
      );
    }),
  ));

test("resumes a V1 current-capability cohort without loading the V3 bundle", () =>
  withHarness("hitchhiker-bootstrap-v1-current", "top", (harness) =>
    Effect.gen(function* () {
      yield* expectFailure(
        runDefaultPluginBootstrap({
          ...harness.input,
          grants: {
            ...harness.grants,
            ensureManaged: () =>
              Effect.fail(new GrantStoreError({ code: "injected", message: "injected boundary" })),
          },
        }),
      );
      const pending = JSON.parse(yield* journalText(harness.profileRoot));
      pending.version = 1;
      pending.id = "default-browser-v1";
      pending.artifacts = pending.artifacts.slice(0, 5);
      pending.artifacts.forEach((artifact: { id: string; grantKey: string }) => {
        artifact.grantKey = `default-bootstrap/1/${artifact.id}`;
      });
      pending.plan = plan("top", 1);
      pending.expectedRevision = 0;
      pending.installedPrefix = [];
      yield* Effect.promise(() =>
        writeFile(
          join(harness.profileRoot, "hitchhiker-plugins", "default-bootstrap.json"),
          JSON.stringify(pending),
        ),
      );
      yield* runDefaultPluginBootstrap({
        ...harness.input,
        loadBundle: Effect.die("must not reload"),
      });
      assert.match(yield* journalText(harness.profileRoot), /"state":"completed"/);
      assert.deepEqual(yield* harness.manager.plan(), { ...plan("top", 1), revision: 6 });
      assert.equal((yield* harness.grants.list()).length, 5);
      assert.equal(harness.observed.launches, 4);
    }),
  ));

test("resumes a V1 frozen capability cohort without upgrading its managed grants", () =>
  withHarness("hitchhiker-bootstrap-legacy-authority", "sidebar", (harness) =>
    Effect.gen(function* () {
      yield* expectFailure(
        runDefaultPluginBootstrap({
          ...harness.input,
          grants: {
            ...harness.grants,
            ensureManaged: () =>
              Effect.fail(new GrantStoreError({ code: "injected", message: "injected boundary" })),
          },
        }),
      );
      const pending = JSON.parse(yield* journalText(harness.profileRoot));
      const previous = [
        ["pages.list", "pages.manage", "storage.local"],
        ["pages.list", "storage.local"],
        ["ui.compose", "configuration.write"],
        ["ui.compose", "pages.list", "pages.manage", "storage.local", "configuration.write"],
        ["ui.compose", "pages.list", "pages.manage", "storage.local", "configuration.write"],
      ] as const;
      pending.version = 1;
      pending.id = "default-browser-v1";
      pending.artifacts = pending.artifacts.slice(0, previous.length);
      pending.plan = plan("sidebar", 1);
      for (const [index, item] of bundle.packages.slice(0, previous.length).entries()) {
        const manifest = yield* Schema.decodeUnknownEffect(LivePluginManifest)(item.manifest);
        const artifact = yield* harness.artifacts.stage({
          manifest: { ...manifest, capabilities: previous[index] },
          code: item.code,
        });
        pending.artifacts[index].hash = artifact.hash;
        pending.artifacts[index].capabilities = previous[index];
        pending.artifacts[index].grantKey = `default-bootstrap/1/${artifact.manifest.id}`;
        if (index < 3) {
          const grant = yield* harness.grants.ensureManaged(pending.artifacts[index].grantKey, {
            principal: artifact.manifest.id,
            profileId: "default",
            origins: [],
            capabilities: artifact.manifest.capabilities,
          });
          yield* harness.manager.install(artifact.hash, grant.id, { staged: true });
        }
      }
      pending.expectedRevision = 3;
      pending.installedPrefix = ids.slice(0, 3);
      yield* Effect.promise(() =>
        writeFile(
          join(harness.profileRoot, "hitchhiker-plugins", "default-bootstrap.json"),
          JSON.stringify(pending),
        ),
      );
      yield* runDefaultPluginBootstrap({
        ...harness.input,
        loadBundle: Effect.die("must not reload"),
      });
      assert.match(yield* journalText(harness.profileRoot), /"state":"completed"/);
      assert.equal(harness.observed.loads, 1);
      for (const [index, id] of ids.slice(0, previous.length).entries()) {
        const grant = (yield* harness.grants.list()).find((entry) => entry.principal === id);
        assert(grant);
        assert.deepEqual([...grant.capabilities].sort(), [...previous[index]!].sort());
      }
    }),
  ));
