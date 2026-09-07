import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { button, column, text, viewport, type Surface } from "@hitchhiker/ui";
import {
  makePluginComposition,
  PluginCompositionRecipeSchema,
} from "../src/composition-session.ts";
import { EngineError } from "../src/engine.ts";

const owner = (id: string, generation = 1) => ({ id, generation });
const layoutOwner = owner("layout-plugin");
const fragmentOwner = owner("fragment-plugin");
const pinnedOwner = owner("pinned-plugin");
const recovery: Surface = { root: text("recovery", "Recovery"), bindings: [] };
const layout: Surface = {
  root: column("root", [column("slot", [])]),
  bindings: [],
};
const fragment = (label = "Fragment"): Surface => ({
  root: button("control", label, "open"),
  bindings: [],
});
const fallback = (pageId: string): Surface => ({
  root: viewport("page", "view"),
  bindings: [{ viewportId: "view", pageId }],
});
const recipe = {
  layout: "layout-plugin",
  slots: [
    {
      key: "slot",
      contributions: [
        { pluginId: "fragment-plugin", id: "main" },
        { pluginId: "pinned-plugin", id: "pin" },
      ],
    },
  ],
};
const routeRecipe = {
  layout: "layout-plugin",
  slots: [
    {
      key: "slot",
      route: { fallback: { pluginId: "fragment-plugin", id: "main" } },
      contributions: [
        { pluginId: "fragment-plugin", id: "main" },
        { pluginId: "pinned-plugin", id: "pin", optional: true as const },
      ],
    },
  ],
};

const makeSession = (commit: (surface: Surface) => Effect.Effect<number, EngineError>) =>
  Effect.runPromise(makePluginComposition({ recipe, commit, recovery }));

test("failed commits and invalid publications leave the previous surface and routes intact", async () => {
  const committed: Surface[] = [];
  let fail = false;
  const session = await makeSession((surface) =>
    fail
      ? Effect.fail(new EngineError({ code: "native", message: "rejected" }))
      : Effect.sync(() => {
          committed.push(surface);
          return committed.length;
        }),
  );
  await Effect.runPromise(session.activate(layoutOwner));
  await Effect.runPromise(session.activate(fragmentOwner));
  await Effect.runPromise(session.publishLayout(layoutOwner, layout));
  await Effect.runPromise(session.publishContribution(fragmentOwner, "main", fragment()));
  const root = committed.at(-1)!.root;
  assert("children" in root);
  const slot = root.children[0]!;
  assert("children" in slot);
  const node = slot.children[0]!;
  assert.equal(node.kind, "button");
  const route = session.route({
    surfaceId: "main",
    revision: 1,
    nodeId: node!.key,
    event: "press",
    payload: { action: node.action },
  });
  assert.equal(route?.owner.id, fragmentOwner.id);

  fail = true;
  await assert.rejects(
    Effect.runPromise(session.publishContribution(fragmentOwner, "main", fragment("Updated"))),
  );
  await assert.rejects(
    Effect.runPromise(
      session.publishContribution(fragmentOwner, "main", { root: null, bindings: [] }),
    ),
  );
  assert.equal(
    session.route({
      surfaceId: "main",
      revision: 1,
      nodeId: node!.key,
      event: "press",
      payload: { action: node.action },
    })?.event.payload.action,
    "open",
  );
});

test("accepts only configured active publishers and invalidates stale generations", async () => {
  const session = await makeSession(() => Effect.succeed(1));
  await assert.rejects(Effect.runPromise(session.activate(owner("unconfigured-plugin"))));
  await Effect.runPromise(session.activate(layoutOwner));
  await Effect.runPromise(session.activate(fragmentOwner));
  await assert.rejects(Effect.runPromise(session.publishLayout(fragmentOwner, layout)));
  await assert.rejects(
    Effect.runPromise(session.publishContribution(fragmentOwner, "other", fragment())),
  );
  await assert.rejects(
    Effect.runPromise(session.publishContribution(owner("fragment-plugin", 2), "main", fragment())),
  );
  await Effect.runPromise(session.publishContribution(fragmentOwner, "main", fragment()));
  await Effect.runPromise(session.activate(owner("fragment-plugin", 2)));
  await assert.rejects(Effect.runPromise(session.activate(fragmentOwner)));
  await assert.rejects(
    Effect.runPromise(session.publishContribution(fragmentOwner, "main", fragment())),
  );
  assert.equal(await Effect.runPromise(session.remove(fragmentOwner)), 1);
  assert.equal(
    await Effect.runPromise(
      session.publishContribution(owner("fragment-plugin", 2), "main", fragment("Current")),
    ),
    1,
  );
  for (const key of ["\ud800", "😀".repeat(33)])
    await assert.rejects(
      Effect.runPromise(
        makePluginComposition({
          recipe: { ...recipe, slots: [{ ...recipe.slots[0]!, key }] },
          commit: () => Effect.succeed(1),
          recovery,
        }),
      ),
    );
});

test("removing a fragment preserves other configured fragments and a missing layout uses recovery", async () => {
  const committed: Surface[] = [];
  const session = await makeSession((surface) =>
    Effect.sync(() => {
      committed.push(surface);
      return committed.length;
    }),
  );
  await Effect.runPromise(session.activate(fragmentOwner));
  await Effect.runPromise(session.publishContribution(fragmentOwner, "main", fragment()));
  await Effect.runPromise(session.activate(pinnedOwner));
  await Effect.runPromise(session.publishContribution(pinnedOwner, "pin", fragment("Pinned")));
  assert.deepEqual(committed.at(-1), recovery);
  await Effect.runPromise(session.activate(layoutOwner));
  await Effect.runPromise(session.publishLayout(layoutOwner, layout));
  assert.equal(committed.at(-1)?.root.kind, "column");
  await Effect.runPromise(session.remove(fragmentOwner));
  const root = committed.at(-1)!.root;
  assert("children" in root);
  const slot = root.children[0]!;
  assert("children" in slot);
  assert.equal(slot.children[0]?.kind, "button");
  assert.equal((slot.children[0] as { label: string }).label, "Pinned");
  await Effect.runPromise(session.remove(layoutOwner));
  assert.deepEqual(committed.at(-1), recovery);
});

test("cancellation after native commit begins completes route adoption", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void, never>();
        const release = yield* Deferred.make<number, EngineError>();
        const session = yield* makePluginComposition({
          recipe,
          recovery,
          commit: (surface) =>
            surface.root.kind === "column"
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.succeed(1),
        });
        yield* session.activate(layoutOwner);
        yield* session.activate(fragmentOwner);
        const publishing = yield* session
          .publishLayout(layoutOwner, layout)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const interruption = yield* Fiber.interrupt(publishing).pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, 4);
        yield* Fiber.await(interruption);
        assert(Exit.isSuccess(yield* Fiber.await(publishing)));
        assert.equal(yield* session.publishContribution(fragmentOwner, "main", fragment()), 4);
      }),
    ),
  );
});

test("withdrawal and release keep an activation reusable while removal rejects later publication", async () => {
  const surfaces: Surface[] = [];
  const session = await makeSession((surface) => Effect.sync(() => surfaces.push(surface)));
  await Effect.runPromise(session.activate(layoutOwner));
  await Effect.runPromise(session.activate(fragmentOwner));
  await Effect.runPromise(session.activate(pinnedOwner));
  await Effect.runPromise(session.publishLayout(layoutOwner, layout));
  await Effect.runPromise(session.publishContribution(fragmentOwner, "main", fragment("Main")));
  await Effect.runPromise(session.publishContribution(pinnedOwner, "pin", fragment("Pinned")));
  await Effect.runPromise(session.withdrawContribution(fragmentOwner, "main"));
  assert.doesNotMatch(JSON.stringify(surfaces.at(-1)), /"Main"/);
  assert.match(JSON.stringify(surfaces.at(-1)), /"Pinned"/);
  await Effect.runPromise(
    session.publishContribution(fragmentOwner, "main", fragment("Republished")),
  );
  await Effect.runPromise(session.release(fragmentOwner));
  assert.doesNotMatch(JSON.stringify(surfaces.at(-1)), /Republished/);
  assert.match(JSON.stringify(surfaces.at(-1)), /Pinned/);
  await Effect.runPromise(session.publishContribution(fragmentOwner, "main", fragment("Again")));
  await assert.rejects(
    Effect.runPromise(session.withdrawContribution(owner("fragment-plugin", 2), "main")),
  );
  await assert.rejects(Effect.runPromise(session.withdrawContribution(fragmentOwner, "pin")));
  await Effect.runPromise(session.remove(fragmentOwner));
  await assert.rejects(
    Effect.runPromise(session.publishContribution(fragmentOwner, "main", fragment())),
  );
});

test("live reconfiguration retains remapped publications only after native commit", async () => {
  const surfaces: Surface[] = [];
  let rejectCommit = false;
  const liveLayout: Surface = {
    root: column("root", [column("left", []), column("right", [])]),
    bindings: [],
  };
  const initial = {
    layout: "layout-plugin",
    slots: [
      { key: "left", contributions: [{ pluginId: "fragment-plugin", id: "main" }] },
      { key: "right", contributions: [{ pluginId: "pinned-plugin", id: "pin" }] },
    ],
  };
  const swapped = {
    layout: "layout-plugin",
    slots: [
      { key: "left", contributions: [{ pluginId: "pinned-plugin", id: "pin" }] },
      { key: "right", contributions: [{ pluginId: "fragment-plugin", id: "main" }] },
    ],
  };
  const session = await Effect.runPromise(
    makePluginComposition({
      recipe: initial,
      recovery,
      commit: (surface) =>
        rejectCommit
          ? Effect.fail(new EngineError({ code: "native", message: "rejected" }))
          : Effect.sync(() => {
              surfaces.push(surface);
              return surfaces.length;
            }),
    }),
  );
  for (const publisher of [layoutOwner, fragmentOwner, pinnedOwner])
    await Effect.runPromise(session.activate(publisher));
  await Effect.runPromise(session.publishLayout(layoutOwner, liveLayout));
  await Effect.runPromise(session.publishContribution(fragmentOwner, "main", fragment("Main")));
  assert.equal(await Effect.runPromise(session.complete), false);
  await Effect.runPromise(session.publishContribution(pinnedOwner, "pin", fragment("Pinned")));
  assert.equal(await Effect.runPromise(session.complete), true);

  await Effect.runPromise(session.reconfigure(swapped));
  const root = surfaces.at(-1)!.root;
  assert("children" in root);
  const left = root.children[0]!;
  const right = root.children[1]!;
  assert("children" in left);
  assert("children" in right);
  assert.equal((left.children[0] as { label: string }).label, "Pinned");
  assert.equal((right.children[0] as { label: string }).label, "Main");
  const remapped = right.children[0]!;
  assert(remapped.kind === "button");
  const route = session.route({
    surfaceId: "main",
    revision: 1,
    nodeId: remapped.key,
    event: "press",
    payload: { action: remapped.action },
  });
  assert.deepEqual(route?.owner, fragmentOwner);

  rejectCommit = true;
  await assert.rejects(Effect.runPromise(session.reconfigure(initial)));
  assert.deepEqual(
    session.route({
      surfaceId: "main",
      revision: 1,
      nodeId: remapped.key,
      event: "press",
      payload: { action: remapped.action },
    })?.owner,
    fragmentOwner,
  );
  await assert.rejects(Effect.runPromise(session.reconfigure(undefined)));
  rejectCommit = false;
  for (const publisher of [layoutOwner, fragmentOwner, pinnedOwner])
    await Effect.runPromise(session.remove(publisher));
  await Effect.runPromise(session.reconfigure(undefined));
  assert.equal(await Effect.runPromise(session.complete), true);
  assert.deepEqual([...session.owners()], []);
  await assert.rejects(Effect.runPromise(session.activate(owner("fragment-plugin", 2))));
});

test("queued publications reauthorize against the plan committed ahead of them", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<number>();
        let gate = false;
        const session = yield* makePluginComposition({
          recipe: {
            layout: "layout-plugin",
            slots: [{ key: "slot", contributions: [{ pluginId: "fragment-plugin", id: "main" }] }],
          },
          recovery,
          commit: () =>
            gate
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.succeed(1),
        });
        yield* session.activate(layoutOwner);
        yield* session.activate(fragmentOwner);
        yield* session.publishLayout(layoutOwner, layout);
        yield* session.publishContribution(fragmentOwner, "main", fragment());
        gate = true;
        const reconfiguring = yield* session
          .reconfigure({
            layout: "fragment-plugin",
            slots: [{ key: "slot", contributions: [{ pluginId: "layout-plugin", id: "other" }] }],
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const staleLayout = yield* session
          .publishLayout(layoutOwner, layout)
          .pipe(Effect.forkScoped);
        const staleWithdrawal = yield* session
          .withdrawContribution(fragmentOwner, "main")
          .pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, 2);
        assert(Exit.isSuccess(yield* Fiber.await(reconfiguring)));
        assert(Exit.isFailure(yield* Fiber.await(staleLayout)));
        assert(Exit.isFailure(yield* Fiber.await(staleWithdrawal)));
      }),
    ),
  );
});

test("composition retains bounded generation tombstones across live plans", async () => {
  const session = await Effect.runPromise(
    makePluginComposition({ recipe: undefined, recovery, commit: () => Effect.succeed(1) }),
  );
  for (let index = 0; index < 256; index++) {
    const id = `owner-${index}`;
    await Effect.runPromise(session.reconfigure({ layout: id, slots: [] }));
    await Effect.runPromise(session.activate(owner(id)));
    await Effect.runPromise(session.remove(owner(id)));
  }
  await Effect.runPromise(session.reconfigure({ layout: "owner-256", slots: [] }));
  await assert.rejects(
    Effect.runPromise(session.activate(owner("owner-256"))),
    /restart is required/,
  );
  await Effect.runPromise(session.reconfigure({ layout: "owner-0", slots: [] }));
  await Effect.runPromise(session.activate(owner("owner-0", 2)));
});

test("selectable routes commit one published owner, fall back atomically, and tolerate stale hides", async () => {
  const surfaces: Surface[] = [];
  let reject = false;
  const session = await Effect.runPromise(
    makePluginComposition({
      recipe: routeRecipe,
      recovery,
      commit: (surface) =>
        reject
          ? Effect.fail(new EngineError({ code: "native", message: "rejected" }))
          : Effect.sync(() => {
              surfaces.push(surface);
              return surfaces.length;
            }),
    }),
  );
  for (const publisher of [layoutOwner, fragmentOwner, pinnedOwner])
    await Effect.runPromise(session.activate(publisher));
  await Effect.runPromise(session.publishLayout(layoutOwner, layout));
  await Effect.runPromise(
    session.publishContribution(fragmentOwner, "main", fallback("first-page")),
  );
  assert.equal(await Effect.runPromise(session.complete), true);
  await assert.rejects(Effect.runPromise(session.showRoute(pinnedOwner, "pin")));
  await Effect.runPromise(session.publishContribution(pinnedOwner, "pin", fragment("Route")));
  assert.doesNotMatch(JSON.stringify(surfaces.at(-1)), /Route/);
  await Effect.runPromise(session.showRoute(pinnedOwner, "pin"));
  assert.match(JSON.stringify(surfaces.at(-1)), /Route/);
  assert.equal(surfaces.at(-1)!.bindings.length, 0);
  await Effect.runPromise(
    session.publishContribution(fragmentOwner, "main", fallback("updated-page")),
  );
  assert.equal(surfaces.at(-1)!.bindings.length, 0);
  const routeRoot = surfaces.at(-1)!.root;
  assert("children" in routeRoot);
  const routeSlot = routeRoot.children[0]!;
  assert("children" in routeSlot);
  const selected = routeSlot.children[0]!;
  assert(selected.kind === "button");
  const selectedEvent = {
    surfaceId: "main" as const,
    revision: 1,
    nodeId: selected.key,
    event: "press" as const,
    payload: { action: selected.action },
  };
  assert.deepEqual(session.route(selectedEvent)?.owner, pinnedOwner);

  reject = true;
  await assert.rejects(Effect.runPromise(session.hideRoute(pinnedOwner, "pin")));
  assert.match(JSON.stringify(surfaces.at(-1)), /Route/);
  assert.deepEqual(session.route(selectedEvent)?.owner, pinnedOwner);
  reject = false;
  await Effect.runPromise(session.hideRoute(pinnedOwner, "pin"));
  assert.equal(surfaces.at(-1)!.bindings[0]?.pageId, "updated-page");

  await assert.rejects(Effect.runPromise(session.showRoute(fragmentOwner, "unknown")));
  await assert.rejects(Effect.runPromise(session.showRoute(owner("fragment-plugin", 2), "main")));

  await Effect.runPromise(session.showRoute(pinnedOwner, "pin"));
  const current = owner("pinned-plugin", 2);
  await Effect.runPromise(session.activate(current));
  await Effect.runPromise(session.publishContribution(current, "pin", fragment("Route 2")));
  await Effect.runPromise(session.showRoute(current, "pin"));
  const revision = await Effect.runPromise(session.hideRoute(pinnedOwner, "pin"));
  assert.equal(revision, surfaces.length);
  assert.match(JSON.stringify(surfaces.at(-1)), /Route 2/);

  await Effect.runPromise(
    session.reconfigure({
      layout: "layout-plugin",
      slots: [
        {
          key: "slot",
          route: { fallback: { pluginId: "fragment-plugin", id: "main" } },
          contributions: [
            { pluginId: "fragment-plugin", id: "main" },
            { pluginId: "pinned-plugin", id: "pin-2", optional: true as const },
          ],
        },
      ],
    }),
  );
  assert.equal(surfaces.at(-1)!.bindings[0]?.pageId, "updated-page");
  await Effect.runPromise(session.publishContribution(current, "pin-2", fragment("Route 3")));
  await Effect.runPromise(session.showRoute(current, "pin-2"));
  await Effect.runPromise(session.remove(current));
  assert.equal(surfaces.at(-1)!.bindings[0]?.pageId, "updated-page");
});

test("route selection requires a live fallback and fallback loss clears selection atomically", async () => {
  const surfaces: Surface[] = [];
  let reject = false;
  const session = await Effect.runPromise(
    makePluginComposition({
      recipe: routeRecipe,
      recovery,
      commit: (surface) =>
        reject
          ? Effect.fail(new EngineError({ code: "native", message: "rejected" }))
          : Effect.sync(() => {
              surfaces.push(surface);
              return surfaces.length;
            }),
    }),
  );
  for (const publisher of [layoutOwner, fragmentOwner, pinnedOwner])
    await Effect.runPromise(session.activate(publisher));
  await Effect.runPromise(session.publishLayout(layoutOwner, layout));
  await Effect.runPromise(session.publishContribution(pinnedOwner, "pin", fragment("Route")));
  assert.match(JSON.stringify(surfaces.at(-1)), /Recovery/);
  await assert.rejects(
    Effect.runPromise(session.showRoute(pinnedOwner, "pin")),
    /fallback is not published/,
  );

  const publishFallback = (current: typeof fragmentOwner, pageId: string) =>
    Effect.runPromise(session.publishContribution(current, "main", fallback(pageId)));
  const show = async () => {
    await Effect.runPromise(session.showRoute(pinnedOwner, "pin"));
    assert.match(JSON.stringify(surfaces.at(-1)), /Route/);
    assert.equal(surfaces.at(-1)!.bindings.length, 0);
  };
  const assertRestoredFallback = (pageId: string) => {
    assert.equal(surfaces.at(-1)!.bindings[0]?.pageId, pageId);
    assert.doesNotMatch(JSON.stringify(surfaces.at(-1)), /Route/);
  };

  await publishFallback(fragmentOwner, "withdraw-page");
  await show();
  const selected = surfaces.at(-1);
  reject = true;
  await assert.rejects(Effect.runPromise(session.withdrawContribution(fragmentOwner, "main")));
  assert.strictEqual(surfaces.at(-1), selected);
  reject = false;
  await Effect.runPromise(session.withdrawContribution(fragmentOwner, "main"));
  assert.match(JSON.stringify(surfaces.at(-1)), /Recovery/);
  await publishFallback(fragmentOwner, "after-withdraw");
  assertRestoredFallback("after-withdraw");

  await show();
  await Effect.runPromise(session.release(fragmentOwner));
  assert.match(JSON.stringify(surfaces.at(-1)), /Recovery/);
  await publishFallback(fragmentOwner, "after-release");
  assertRestoredFallback("after-release");

  await show();
  const secondFallback = owner("fragment-plugin", 2);
  await Effect.runPromise(session.activate(secondFallback));
  assert.match(JSON.stringify(surfaces.at(-1)), /Recovery/);
  await publishFallback(secondFallback, "after-generation");
  assertRestoredFallback("after-generation");

  await show();
  await Effect.runPromise(session.remove(secondFallback));
  assert.match(JSON.stringify(surfaces.at(-1)), /Recovery/);
  const thirdFallback = owner("fragment-plugin", 3);
  await Effect.runPromise(session.activate(thirdFallback));
  await publishFallback(thirdFallback, "after-remove");
  assertRestoredFallback("after-remove");
});

test("route reconfiguration clears changed fallbacks and normalizes a selected fallback", async () => {
  const surfaces: Surface[] = [];
  const initial = {
    layout: "layout-plugin",
    slots: [
      {
        key: "slot",
        route: { fallback: { pluginId: "fragment-plugin", id: "main" } },
        contributions: [
          { pluginId: "fragment-plugin", id: "main" },
          { pluginId: "fragment-plugin", id: "alternate", optional: true as const },
          { pluginId: "pinned-plugin", id: "pin", optional: true as const },
        ],
      },
    ],
  };
  const session = await Effect.runPromise(
    makePluginComposition({
      recipe: initial,
      recovery,
      commit: (surface) =>
        Effect.sync(() => {
          surfaces.push(surface);
          return surfaces.length;
        }),
    }),
  );
  for (const publisher of [layoutOwner, fragmentOwner, pinnedOwner])
    await Effect.runPromise(session.activate(publisher));
  await Effect.runPromise(session.publishLayout(layoutOwner, layout));
  await Effect.runPromise(session.publishContribution(fragmentOwner, "main", fallback("main")));
  await Effect.runPromise(
    session.publishContribution(fragmentOwner, "alternate", fallback("alternate")),
  );
  await Effect.runPromise(session.publishContribution(pinnedOwner, "pin", fragment("Route")));
  await Effect.runPromise(session.showRoute(pinnedOwner, "pin"));

  await Effect.runPromise(
    session.reconfigure({
      ...initial,
      slots: [
        {
          ...initial.slots[0]!,
          route: { fallback: { pluginId: "fragment-plugin", id: "alternate" } },
          contributions: [
            { pluginId: "fragment-plugin", id: "main", optional: true as const },
            { pluginId: "fragment-plugin", id: "alternate" },
            { pluginId: "pinned-plugin", id: "pin", optional: true as const },
          ],
        },
      ],
    }),
  );
  assert.equal(surfaces.at(-1)!.bindings[0]?.pageId, "alternate");
  assert.doesNotMatch(JSON.stringify(surfaces.at(-1)), /Route/);

  await Effect.runPromise(session.showRoute(pinnedOwner, "pin"));
  await Effect.runPromise(
    session.reconfigure({
      ...initial,
      slots: [
        {
          ...initial.slots[0]!,
          route: { fallback: { pluginId: "pinned-plugin", id: "pin" } },
          contributions: [
            { pluginId: "fragment-plugin", id: "main", optional: true as const },
            { pluginId: "fragment-plugin", id: "alternate", optional: true as const },
            { pluginId: "pinned-plugin", id: "pin" },
          ],
        },
      ],
    }),
  );
  const commits = surfaces.length;
  assert.match(JSON.stringify(surfaces.at(-1)), /Route/);
  assert.equal(await Effect.runPromise(session.hideRoute(pinnedOwner, "pin")), commits);
  assert.equal(surfaces.length, commits);
});

test("route recipes require a declared required fallback and optional entries do not gate completion", async () => {
  const invalidRoute = {
    layout: "layout-plugin",
    slots: [
      {
        key: "slot",
        route: { fallback: { pluginId: "fragment-plugin", id: "main" } },
        contributions: [{ pluginId: "fragment-plugin", id: "main", optional: true as const }],
      },
    ],
  };
  await assert.rejects(
    Effect.runPromise(
      makePluginComposition({ recipe: invalidRoute, recovery, commit: () => Effect.succeed(1) }),
    ),
  );
  await assert.rejects(
    Effect.runPromise(
      makePluginComposition({
        recipe: {
          ...invalidRoute,
          slots: [
            {
              ...invalidRoute.slots[0]!,
              contributions: [{ pluginId: "fragment-plugin", id: "other" }],
            },
          ],
        },
        recovery,
        commit: () => Effect.succeed(1),
      }),
    ),
  );
  const optional = {
    layout: "layout-plugin",
    slots: [
      {
        key: "slot",
        route: { fallback: { pluginId: "fragment-plugin", id: "main" } },
        contributions: [
          { pluginId: "fragment-plugin", id: "main" },
          { pluginId: "pinned-plugin", id: "pin", optional: true as const },
        ],
      },
    ],
  };
  const session = await Effect.runPromise(
    makePluginComposition({ recipe: optional, recovery, commit: () => Effect.succeed(1) }),
  );
  await Effect.runPromise(session.activate(layoutOwner));
  await Effect.runPromise(session.activate(fragmentOwner));
  await Effect.runPromise(session.publishLayout(layoutOwner, layout));
  await Effect.runPromise(session.publishContribution(fragmentOwner, "main", fragment()));
  assert.equal(await Effect.runPromise(session.complete), true);
});

test("legacy recipe decoding retains its exact shape", async () => {
  const legacy = {
    layout: "layout-plugin",
    slots: [{ key: "slot", contributions: [{ pluginId: "fragment-plugin", id: "main" }] }],
  };
  assert.deepEqual(
    await Effect.runPromise(Schema.decodeUnknownEffect(PluginCompositionRecipeSchema)(legacy)),
    legacy,
  );
});
