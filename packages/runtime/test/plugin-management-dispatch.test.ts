import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import type { Capability } from "@hitchhiker/core";
import { Effect, Exit } from "effect";
import { create, type GrantStoreApi } from "../src/grants.ts";
import { createPluginDispatcher } from "../src/plugin-dispatch.ts";
import type { PluginManagementApi, PluginManagementSnapshot } from "../src/plugin-management.ts";

const snapshot: PluginManagementSnapshot = {
  revision: 4,
  plugins: [
    {
      id: "presenter",
      name: "Presenter",
      version: "1.2.3",
      enabled: true,
      running: true,
      capabilities: ["plugins.read"],
      previousVersion: "1.2.2",
    },
  ],
};
const browser = {
  pages: Effect.succeed([]),
  open: () => Effect.succeed("one"),
  navigate: () => Effect.void,
  close: () => Effect.void,
  configuration: Effect.succeed({
    colorScheme: "system" as const,
    sleepAfterMs: 10_000,
    alwaysAwakeOrigins: [],
  }),
  configure: () => Effect.void,
  setTabPlacement: () => Effect.void,
};
const failure = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(Effect.exit, Effect.map(Exit.isFailure));

const withDispatcher = async (
  capabilities: readonly Capability[],
  management?: PluginManagementApi,
  run?: (
    dispatch: ReturnType<typeof createPluginDispatcher>,
    grants: GrantStoreApi,
    grantId: string,
    token: string,
  ) => Effect.Effect<unknown, unknown>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-management-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        const issued = yield* grants.issue({
          principal: "presenter",
          profileId: "default",
          capabilities,
          origins: [],
        });
        const dispatch = createPluginDispatcher({
          manifest: {
            id: "presenter",
            name: "Presenter",
            version: "1.2.3",
            capabilities,
          },
          profileId: "default",
          token: issued.token,
          grants,
          browser,
          publish: () => Effect.succeed(1),
          release: Effect.void,
          ...(management === undefined ? {} : { management }),
        });
        return yield* run ? run(dispatch, grants, issued.grant.id, issued.token) : Effect.void;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("plugin management separates read, manage, and install authority", async () => {
  const calls: string[] = [];
  const management: PluginManagementApi = {
    snapshot: () => Effect.sync(() => (calls.push("snapshot"), snapshot)),
    enable: (id) => Effect.sync(() => (calls.push(`enable:${id}`), snapshot)),
    disable: (id) => Effect.sync(() => (calls.push(`disable:${id}`), snapshot)),
    rollback: (id) => Effect.sync(() => (calls.push(`rollback:${id}`), snapshot)),
    uninstall: (id) => Effect.sync(() => (calls.push(`uninstall:${id}`), snapshot)),
    replaceSelf: (id, revision) =>
      Effect.sync(() => (calls.push(`replace:${id}:${revision}`), snapshot)),
  };
  await withDispatcher(["plugins.read"], management, (dispatch, grants, grantId) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* dispatch("plugins.snapshot", {}), snapshot);
      assert.equal(yield* failure(dispatch("plugins.enable", { id: "presenter" })), true);
      yield* grants.revoke(grantId);
      assert.equal(yield* failure(dispatch("plugins.snapshot", {})), true);
      assert.deepEqual(calls, ["snapshot"]);
    }),
  );
  await withDispatcher(["plugins.install"], management, (dispatch) =>
    Effect.gen(function* () {
      assert.equal(yield* failure(dispatch("plugins.snapshot", {})), true);
      assert.equal(yield* failure(dispatch("plugins.enable", { id: "presenter" })), true);
    }),
  );
  await withDispatcher(["plugins.manage"], management, (dispatch) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* dispatch("plugins.enable", { id: "presenter" }), snapshot);
      assert.deepEqual(
        yield* dispatch("plugins.replaceSelf", { targetId: "presenter", expectedRevision: 4 }),
        snapshot,
      );
    }),
  );
});

test("management requests and responses are bounded, exact, and fail closed without a port", async () => {
  await withDispatcher(["plugins.read", "plugins.manage"], undefined, (dispatch) =>
    Effect.gen(function* () {
      assert.equal(yield* failure(dispatch("plugins.snapshot", {})), true);
      assert.equal(yield* failure(dispatch("plugins.snapshot", { caller: "spoof" })), true);
      assert.equal(
        yield* failure(dispatch("plugins.enable", { id: "presenter", extra: true })),
        true,
      );
      assert.equal(
        yield* failure(
          dispatch("plugins.replaceSelf", { targetId: "presenter", expectedRevision: -1 }),
        ),
        true,
      );
    }),
  );
  const unsafe = {
    snapshot: () => Effect.succeed({ ...snapshot, credential: "secret" }),
    enable: () => Effect.succeed(snapshot),
    disable: () => Effect.succeed(snapshot),
    rollback: () => Effect.succeed(snapshot),
    uninstall: () => Effect.succeed(snapshot),
    replaceSelf: () => Effect.succeed(snapshot),
  } satisfies PluginManagementApi;
  await withDispatcher(["plugins.read"], unsafe, (dispatch) =>
    Effect.gen(function* () {
      assert.equal(yield* failure(dispatch("plugins.snapshot", {})), true);
    }),
  );
});

test("configuration.get accepts narrow read grants and remains compatible with write grants", async () => {
  for (const capability of ["configuration.read", "configuration.write"] as const)
    await withDispatcher([capability], undefined, (dispatch) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* dispatch("configuration.get", {}), {
          colorScheme: "system",
          sleepAfterMs: 10_000,
          alwaysAwakeOrigins: [],
        });
        assert.equal(yield* failure(dispatch("configuration.get", { extra: true })), true);
        assert.equal(yield* failure(dispatch("configuration.set", { configuration: {} })), true);
      }),
    );
});

test("malformed management commands never reach an available authorized port", async () => {
  let calls = 0;
  const invoke = () =>
    Effect.sync(() => {
      calls += 1;
      return snapshot;
    });
  const management: PluginManagementApi = {
    snapshot: invoke,
    enable: invoke,
    disable: invoke,
    rollback: invoke,
    uninstall: invoke,
    replaceSelf: invoke,
  };
  await withDispatcher(["plugins.read", "plugins.manage"], management, (dispatch) =>
    Effect.gen(function* () {
      for (const method of [
        "plugins.enable",
        "plugins.disable",
        "plugins.rollback",
        "plugins.uninstall",
      ]) {
        for (const params of [
          { id: "presenter", caller: "spoof" },
          { id: "presenter\n" },
          { id: "../target" },
          {},
        ])
          assert.equal(yield* failure(dispatch(method, params)), true);
      }
      for (const params of [
        { targetId: "presenter", expectedRevision: -1 },
        { targetId: "presenter", expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
        { targetId: "presenter", expectedRevision: 4, callerId: "spoof" },
      ])
        assert.equal(yield* failure(dispatch("plugins.replaceSelf", params)), true);
      assert.equal(yield* failure(dispatch("plugins.snapshot", { extra: true })), true);
      assert.equal(calls, 0);
    }),
  );
});

test("DevTools calls require declared profile-wide authority, validate exact inputs, and recheck revocation", async () => {
  const calls: string[] = [];
  const devtools = {
    status: (pageId: string) =>
      Effect.sync(
        () => (
          calls.push(`status:${pageId}`),
          { pageId, generation: 1, instance: 1, state: "open" as const }
        ),
      ),
    show: (pageId: string, inspectAt?: { readonly x: number; readonly y: number }) =>
      Effect.sync(
        () => (
          calls.push(`show:${pageId}:${inspectAt?.x ?? ""}`),
          { pageId, generation: 1, instance: 1, state: "opening" as const }
        ),
      ),
    close: (pageId: string) =>
      Effect.sync(
        () => (
          calls.push(`close:${pageId}`),
          { pageId, generation: 1, instance: 1, state: "closing" as const }
        ),
      ),
  };
  await withDispatcher(["devtools.manage"], undefined, (_dispatch, grants, grantId, token) => {
    const dispatch = createPluginDispatcher({
      manifest: {
        id: "presenter",
        name: "Presenter",
        version: "1.2.3",
        capabilities: ["devtools.manage"],
      },
      profileId: "default",
      token,
      grants,
      browser,
      publish: () => Effect.succeed(1),
      release: Effect.void,
      devtools,
    });
    return Effect.gen(function* () {
      assert.deepEqual(yield* dispatch("devtools.status", { pageId: "page" }), {
        pageId: "page",
        generation: 1,
        instance: 1,
        state: "open",
      });
      assert.deepEqual(
        yield* dispatch("devtools.show", { pageId: "page", inspectAt: { x: 2, y: 3 } }),
        { pageId: "page", generation: 1, instance: 1, state: "opening" },
      );
      assert.equal(
        yield* failure(dispatch("devtools.show", { pageId: "page", inspectAt: { x: -1, y: 0 } })),
        true,
      );
      assert.equal(
        yield* failure(dispatch("devtools.status", { pageId: "page", extra: true })),
        true,
      );
      yield* grants.revoke(grantId);
      assert.equal(yield* failure(dispatch("devtools.close", { pageId: "page" })), true);
      assert.deepEqual(calls, ["status:page", "show:page:2"]);
    });
  });
  await withDispatcher(["browser.full-control"], undefined, (_dispatch, grants, _grantId, token) =>
    Effect.gen(function* () {
      const dispatch = createPluginDispatcher({
        manifest: {
          id: "presenter",
          name: "Presenter",
          version: "1.2.3",
          capabilities: ["browser.full-control"],
        },
        profileId: "default",
        token,
        grants,
        browser,
        publish: () => Effect.succeed(1),
        release: Effect.void,
        devtools,
      });
      assert.deepEqual(yield* dispatch("devtools.close", { pageId: "page" }), {
        pageId: "page",
        generation: 1,
        instance: 1,
        state: "closing",
      });
      assert.equal(yield* failure(dispatch("devtools.status", { pageId: "page" })), false);
    }),
  );
});
