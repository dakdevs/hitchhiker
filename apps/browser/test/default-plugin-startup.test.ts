import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfiguration } from "@hitchhiker/core";
import { createDefaultInterface } from "@hitchhiker/default-interface";
import { Deferred, Effect, Fiber } from "effect";
import { startDefaultPluginInterface } from "../src/default-plugin-startup.ts";
import type { BrowserPersistence } from "../src/persistence.ts";

const persistence: BrowserPersistence = {
  configuration: defaultConfiguration,
  interfaceConfiguration: { tabPlacement: "top" },
  interfaceState: {
    ...createDefaultInterface("default"),
    selectedPageId: "second",
    pageOrder: ["second", "first"],
    pinnedPageIds: ["second"],
  },
  pages: [
    { id: "first", url: "https://first.test/", title: "First" },
    { id: "second", url: "https://second.test/", title: "Second" },
  ],
};

test("default startup waits for complete pages and durable bootstrap before retiring migration input", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const restored = yield* Deferred.make<void>();
      const promoted = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const calls: string[] = [];
      const startup = yield* Effect.forkChild(
        startDefaultPluginInterface({
          mode: "installed",
          persistence,
          controller: {
            restoredPageInventory: Deferred.await(restored).pipe(
              Effect.as({ pageIds: ["first", "second"], pageOrder: ["first", "second"] }),
            ),
            retireLegacyBootstrapSeed: () =>
              Effect.sync(() => {
                calls.push("retire");
              }),
          },
          bootstrap: (seed, placement) =>
            Effect.gen(function* () {
              assert.equal(placement, "top");
              assert.deepEqual(seed.model.pageOrder, ["second", "first"]);
              assert.deepEqual(seed.model.selection, { kind: "page", pageId: "second" });
              assert.deepEqual(seed.pins.pinnedPageIds, ["second"]);
              calls.push("bootstrap");
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(promoted);
            }),
        }),
      );
      yield* Effect.yieldNow;
      assert.deepEqual(calls, []);
      yield* Deferred.succeed(restored, undefined);
      yield* Deferred.await(started);
      assert.deepEqual(calls, ["bootstrap"]);
      yield* Deferred.succeed(promoted, undefined);
      yield* Fiber.join(startup);
      assert.deepEqual(calls, ["bootstrap", "retire"]);
    }).pipe(Effect.scoped, Effect.timeout(5_000)),
  ));

test("failed bootstrap preserves the migration source and bypass modes do no startup work", async () => {
  const calls: string[] = [];
  const options = {
    persistence,
    controller: {
      restoredPageInventory: Effect.sync(() => {
        calls.push("inventory");
        return { pageIds: ["first"], pageOrder: ["first"] };
      }),
      retireLegacyBootstrapSeed: () =>
        Effect.sync(() => {
          calls.push("retire");
        }),
    },
    bootstrap: () => Effect.fail(new Error("bootstrap failed")),
  };
  await assert.rejects(
    Effect.runPromise(startDefaultPluginInterface({ ...options, mode: "installed" })),
    /bootstrap failed/,
  );
  assert.deepEqual(calls, ["inventory"]);
  calls.length = 0;
  for (const mode of ["safe", "developer"] as const)
    await Effect.runPromise(startDefaultPluginInterface({ ...options, mode }));
  assert.deepEqual(calls, []);
});
