import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { button, column, text, type Surface } from "@hitchhiker/ui";
import { makePluginComposition } from "../src/composition-session.ts";
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
