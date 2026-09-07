import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { createPluginManagement, type PluginManagement } from "../src/plugin-management.ts";

type Backend = Parameters<PluginManagement["bind"]>[0];
const backend = (overrides: Partial<Backend> = {}): Backend => ({
  managementSnapshot: () => Effect.succeed({ revision: 2, plugins: [] }),
  enable: () => Effect.void,
  disable: () => Effect.void,
  rollback: () => Effect.void,
  uninstall: () => Effect.void,
  replaceSelf: () => Effect.succeed({ revision: 2, enabled: [], serviceBindings: [] }),
  ...overrides,
});
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.timeout(5_000)));

test("management ports fail closed before binding, reject rebinding and close with their owner", async () => {
  const api = await run(
    Effect.gen(function* () {
      const port = yield* createPluginManagement();
      const api = port.forPlugin("presenter", () => true);
      assert.equal((yield* Effect.exit(api.snapshot()))._tag, "Failure");
      assert.equal((yield* Effect.exit(api.enable("target")))._tag, "Failure");
      yield* port.bind(backend());
      assert.equal((yield* Effect.exit(port.bind(backend())))._tag, "Failure");
      assert.deepEqual(yield* api.snapshot(), { revision: 2, plugins: [] });
      return api;
    }),
  );
  await assert.rejects(Effect.runPromise(api.snapshot()), /unavailable/);
  await assert.rejects(Effect.runPromise(api.enable("target")), /unavailable/);
});

test("an admitted replacement survives caller cancellation and retains its bound identity", () =>
  run(
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      let revision = 2;
      const port = yield* createPluginManagement();
      yield* port.bind(
        backend({
          managementSnapshot: () => Effect.succeed({ revision, plugins: [] }),
          replaceSelf: (caller, target, expected) =>
            Effect.gen(function* () {
              assert.deepEqual([caller, target, expected], ["sidebar", "top", 2]);
              yield* Deferred.succeed(admitted, undefined);
              yield* Deferred.await(release);
              revision = 3;
              yield* Deferred.succeed(committed, undefined);
              return { revision, enabled: ["top"], serviceBindings: [] };
            }),
        }),
      );
      const api = port.forPlugin("sidebar", () => true);
      const caller = yield* Effect.forkChild(api.replaceSelf("top", 2));
      yield* Deferred.await(admitted);
      yield* Fiber.interrupt(caller);
      assert.equal(revision, 2);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(committed);
      assert.equal((yield* api.snapshot()).revision, 3);
    }),
  ));

test("application shutdown interrupts admitted operations instead of leaking detached work", () =>
  run(
    Effect.gen(function* () {
      const application = yield* Scope.make();
      const port = yield* createPluginManagement().pipe(
        Effect.provideService(Scope.Scope, application),
      );
      const started = yield* Deferred.make<void>();
      let stopped = false;
      yield* port.bind(
        backend({
          disable: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  stopped = true;
                }),
              ),
            ),
        }),
      );
      const api = port.forPlugin("presenter", () => true);
      const caller = yield* Effect.forkChild(api.disable("target"));
      yield* Deferred.await(started);
      yield* Scope.close(application, Exit.void);
      assert.equal(stopped, true);
      assert.equal((yield* Fiber.await(caller))._tag, "Failure");
      assert.equal((yield* Effect.exit(api.snapshot()))._tag, "Failure");
    }),
  ));

test("canceled reply waiters cannot create an unbounded management queue", () =>
  run(
    Effect.gen(function* () {
      const port = yield* createPluginManagement();
      const full = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      let started = 0;
      let completed = 0;
      yield* port.bind(
        backend({
          enable: () =>
            Effect.gen(function* () {
              started += 1;
              if (started === 16) yield* Deferred.succeed(full, undefined);
              yield* Deferred.await(release);
              completed += 1;
              if (completed === 16) yield* Deferred.succeed(drained, undefined);
            }),
        }),
      );
      const api = port.forPlugin("presenter", () => true);
      const callers = yield* Effect.forEach(Array.from({ length: 16 }), () =>
        Effect.forkChild(api.enable("target")),
      );
      yield* Deferred.await(full);
      yield* Effect.forEach(callers, Fiber.interrupt);
      assert.equal((yield* Effect.exit(api.enable("target")))._tag, "Failure");
      assert.equal(started, 16);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(drained);
      yield* api.enable("target");
      assert.equal(completed, 17);
    }),
  ));

test("activation may inspect state but cannot queue mutations before readiness or after stopping", () =>
  run(
    Effect.gen(function* () {
      const port = yield* createPluginManagement();
      let active = false;
      let calls = 0;
      yield* port.bind(
        backend({
          enable: () =>
            Effect.sync(() => {
              calls += 1;
            }),
        }),
      );
      const api = port.forPlugin("presenter", () => active);
      assert.equal((yield* api.snapshot()).revision, 2);
      assert.equal((yield* Effect.exit(api.enable("target")))._tag, "Failure");
      active = true;
      yield* api.enable("target");
      active = false;
      assert.equal((yield* Effect.exit(api.enable("target")))._tag, "Failure");
      assert.equal(calls, 1);
    }),
  ));
