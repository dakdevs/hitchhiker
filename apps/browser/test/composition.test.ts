import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, Exit, Fiber, Stream } from "effect";
import type { EngineError, SurfaceEvent } from "@hitchhiker/runtime";
import { button, column } from "@hitchhiker/ui";
import { createBrowserComposition } from "../src/composition.ts";

const fixture = Effect.gen(function* () {
  const published: unknown[] = [];
  let handler: (event: SurfaceEvent) => Effect.Effect<void, EngineError> = () =>
    Effect.die("handler not registered");
  const composition = yield* createBrowserComposition({
    recipe: {
      layout: "layout-plugin",
      slots: [
        {
          key: "slot",
          contributions: [
            { pluginId: "left-plugin", id: "page" },
            { pluginId: "right-plugin", id: "page" },
          ],
        },
      ],
    },
    controller: {
      publishPluginSurface: (_owner, surface) => Effect.sync(() => published.push(surface)),
      recoverPluginSurface: () =>
        Effect.sync(() => published.push({ root: { label: "Manage plugins" }, bindings: [] })),
      registerPluginEventHandler: (_owner, next) =>
        Effect.sync(() => {
          handler = next;
        }),
    },
    onRecoveryFailure: Effect.die("unexpected recovery failure"),
  });
  const layout = { id: "layout-plugin", generation: 1 };
  const left = { id: "left-plugin", generation: 1 };
  const right = { id: "right-plugin", generation: 1 };
  for (const owner of [layout, left, right]) yield* composition.activate(owner);
  assert.match(JSON.stringify(published.at(-1)), /Manage plugins/);
  yield* composition.publishLayout(layout, {
    root: column("root", [column("slot", [])]),
    bindings: [],
  });
  for (const [owner, label] of [
    [left, "Left"],
    [right, "Right"],
  ] as const)
    yield* composition.publishContribution(owner, "page", {
      root: button("control", label, "select"),
      bindings: [],
    });
  const tree = JSON.parse(JSON.stringify(published.at(-1)));
  const emit = (index: number) => {
    const node = tree.root.children[0].children[index];
    return handler({
      surfaceId: "main",
      revision: published.length,
      event: "press",
      nodeId: node.key,
      payload: { action: node.action, source: node.label },
    });
  };
  return { composition, published, layout, left, right, emit };
});

test("early actions remain queued for their activation and release preserves other fragments", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { composition, published, layout, left, right, emit } = yield* fixture;
      // The worker has published UI, but has not finished activation or subscribed yet.
      yield* emit(0);
      yield* emit(1);
      const leftActions = yield* composition
        .events(left)
        .pipe(Stream.take(1), Stream.runCollect, Effect.timeout(1000));
      const rightActions = yield* composition
        .events(right)
        .pipe(Stream.take(1), Stream.runCollect, Effect.timeout(1000));
      assert.equal(leftActions[0]?.payload.payload.source, "Left");
      assert.equal(rightActions[0]?.payload.payload.source, "Right");
      for (const actions of [leftActions, rightActions]) {
        assert.equal(actions[0]?.payload.nodeId, "control");
        assert.equal(actions[0]?.payload.payload.action, "select");
      }
      yield* composition.release(left);
      assert.doesNotMatch(JSON.stringify(published.at(-1)), /"Left"/);
      assert.match(JSON.stringify(published.at(-1)), /"Right"/);
      yield* composition.publishContribution(left, "page", {
        root: button("control", "Back", "select"),
        bindings: [],
      });
      yield* composition.remove(layout);
      assert.match(JSON.stringify(published.at(-1)), /Manage plugins/);
      yield* composition.publishContribution(left, "page", {
        root: button("control", "Still queued", "select"),
        bindings: [],
      });
      assert.match(
        JSON.stringify(published.at(-1)),
        /Manage plugins/,
        "contributor-first repair must not hide management",
      );
    }).pipe(Effect.scoped),
  );
});

test("a stalled owner's inbox fails only that activation and another owner continues receiving events", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { composition, published, left, right, emit } = yield* fixture;
      for (let index = 0; index < 33; index++) yield* emit(0);
      assert.equal((yield* composition.failure(left).pipe(Effect.flip)).code, "composition");
      yield* emit(1);
      const rightActions = yield* composition
        .events(right)
        .pipe(Stream.take(1), Stream.runCollect, Effect.timeout(1000));
      assert.equal(rightActions[0]?.payload.payload.source, "Right");
      yield* composition.remove(left);
      assert.doesNotMatch(JSON.stringify(published.at(-1)), /"Left"/);
      assert.match(JSON.stringify(published.at(-1)), /"Right"/);
    }).pipe(Effect.scoped),
  );
});

test("interruption after an activation commit starts adopts its inbox before cancellation", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const published: unknown[] = [];
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      let blockCommits = false;
      let handler: (event: SurfaceEvent) => Effect.Effect<void, EngineError> = () =>
        Effect.die("handler not registered");
      const composition = yield* createBrowserComposition({
        recipe: {
          layout: "layout-plugin",
          slots: [
            {
              key: "slot",
              contributions: [{ pluginId: "left-plugin", id: "page" }],
            },
          ],
        },
        controller: {
          publishPluginSurface: (_owner, surface) =>
            (blockCommits
              ? Deferred.succeed(commitStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCommit)),
                )
              : Effect.void
            ).pipe(Effect.andThen(Effect.sync(() => published.push(surface)))),
          recoverPluginSurface: () =>
            Effect.sync(() => published.push({ root: { label: "Manage plugins" }, bindings: [] })),
          registerPluginEventHandler: (_owner, next) =>
            Effect.sync(() => {
              handler = next;
            }),
        },
        onRecoveryFailure: Effect.die("unexpected recovery failure"),
      });
      const layout = { id: "layout-plugin", generation: 1 };
      const oldLeft = { id: "left-plugin", generation: 1 };
      const nextLeft = { id: "left-plugin", generation: 2 };
      yield* composition.activate(layout);
      yield* composition.activate(oldLeft);
      yield* composition.publishLayout(layout, {
        root: column("root", [column("slot", [])]),
        bindings: [],
      });
      yield* composition.publishContribution(oldLeft, "page", {
        root: button("control", "Old", "select"),
        bindings: [],
      });

      blockCommits = true;
      const activation = yield* composition.activate(nextLeft).pipe(Effect.forkScoped);
      yield* Deferred.await(commitStarted);
      const interruption = yield* Fiber.interrupt(activation).pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.await(interruption);

      yield* composition.publishContribution(nextLeft, "page", {
        root: button("control", "New", "select"),
        bindings: [],
      });
      const tree = JSON.parse(JSON.stringify(published.at(-1)));
      const node = tree.root.children[0].children[0];
      yield* handler({
        surfaceId: "main",
        revision: published.length,
        event: "press",
        nodeId: node.key,
        payload: { action: node.action, source: node.label },
      });
      const actions = yield* composition
        .events(nextLeft)
        .pipe(Stream.take(1), Stream.runCollect, Effect.timeout(1_000));
      assert.equal(actions[0]?.payload.payload.source, "New");
      assert.equal((yield* composition.failure(oldLeft).pipe(Effect.flip)).code, "composition");
    }).pipe(Effect.scoped),
  );
});

test("live plan changes keep the stable owner view aligned after an interrupted commit", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let block = false;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const composition = yield* createBrowserComposition({
          recipe: { layout: "layout-plugin", slots: [] },
          controller: {
            publishPluginSurface: () => Effect.succeed(1),
            recoverPluginSurface: () =>
              (block
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void
              ).pipe(Effect.as(1)),
            registerPluginEventHandler: () => Effect.void,
          },
          onRecoveryFailure: Effect.die("unexpected recovery failure"),
        });
        const owners = composition.owners;
        block = true;
        const reconfiguring = yield* composition
          .reconfigure({
            layout: "layout-plugin",
            slots: [{ key: "slot", contributions: [{ pluginId: "left-plugin", id: "page" }] }],
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const interruption = yield* Fiber.interrupt(reconfiguring).pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(interruption);
        assert(Exit.isSuccess(yield* Fiber.await(reconfiguring)));
        assert.strictEqual(composition.owners, owners);
        assert.deepEqual([...owners].toSorted(), ["layout-plugin", "left-plugin"]);
        assert.equal(yield* composition.complete, false);
      }),
    ),
  );
});
