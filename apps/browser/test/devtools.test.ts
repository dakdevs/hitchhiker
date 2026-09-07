import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, Exit, PubSub, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  EngineConnection,
  EngineError,
  type DevToolsStatus,
  type EngineEvent,
} from "@hitchhiker/runtime";
import { createDevToolsController } from "../src/devtools.ts";

const fixture = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<EngineEvent>();
  const closed = yield* Deferred.make<void>();
  const pages = new Map<string, DevToolsStatus>(
    ["first", "second"].map((pageId) => [
      pageId,
      { pageId, generation: 1, instance: 0, state: "closed" },
    ]),
  );
  const leases = new Map<string, string>();
  const calls: { readonly method: string; readonly pageId: string }[] = [];
  const protectedStates: DevToolsStatus[] = [];
  let loseShowReply = false;
  const Params = Schema.Struct({
    pageId: Schema.String,
    expectedGeneration: Schema.optional(Schema.Number),
    expectedInstance: Schema.optional(Schema.Number),
    leaseId: Schema.optional(Schema.String),
    expectedLeaseId: Schema.optional(Schema.String),
    inspectAt: Schema.optional(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  });
  const engine = EngineConnection.of({
    pid: 1,
    ready: Effect.succeed({ event: "host.ready", params: { devTools: true } }),
    exit: Effect.never,
    events: Stream.fromPubSub(events),
    request: (method, input) =>
      Effect.gen(function* () {
        const params = yield* Schema.decodeUnknownEffect(Params)(input).pipe(
          Effect.mapError(
            () => new EngineError({ code: "invalid", message: "Invalid fixture request" }),
          ),
        );
        calls.push({ method, pageId: params.pageId });
        const current = pages.get(params.pageId);
        if (!current) return yield* new EngineError({ code: "-32001", message: "Unknown page" });
        if (
          (params.expectedGeneration !== undefined &&
            current.generation !== params.expectedGeneration) ||
          (params.expectedInstance !== undefined && current.instance !== params.expectedInstance) ||
          (params.expectedLeaseId !== undefined &&
            leases.get(params.pageId) !== params.expectedLeaseId)
        )
          return yield* new EngineError({ code: "-32005", message: "Inspector identity changed" });
        if (method === "devtools.status") return { ...current };
        if (method === "devtools.show") {
          assert.ok(params.leaseId);
          const next = {
            ...current,
            instance: current.instance + (current.state === "closed" ? 1 : 0),
            state: "open" as const,
          };
          pages.set(params.pageId, next);
          leases.set(params.pageId, params.leaseId);
          if (loseShowReply)
            return yield* new EngineError({
              code: "timeout",
              message: "Lost show acknowledgement",
            });
          return { ...next };
        }
        assert.equal(method, "devtools.close");
        const next = { ...current, state: "closed" as const };
        pages.set(params.pageId, next);
        leases.delete(params.pageId);
        yield* Deferred.succeed(closed, undefined);
        return { ...next };
      }),
    openCdpSession: () => Effect.die("unused managed CDP session"),
    claimRawCdp: Effect.die("Unused"),
    loadUnpacked: () => Effect.die("Unused"),
    uninstall: () => Effect.die("Unused"),
  });
  const devtools = yield* createDevToolsController({
    engine,
    protect: (status) =>
      Effect.sync(() => {
        protectedStates.push(status);
      }),
  });
  return {
    devtools,
    engine,
    pages,
    leases,
    events,
    closed,
    calls,
    protectedStates,
    loseReply: () => {
      loseShowReply = true;
    },
  };
});

const closeScope = (scope: Scope.Scope) => Scope.close(scope, Exit.void);

test("inspector cleanup follows the latest owner and rejects calls after scope closure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture;
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const first = yield* f.devtools
        .forOwner(Effect.void)
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      const second = yield* f.devtools
        .forOwner(Effect.void)
        .pipe(Effect.provideService(Scope.Scope, secondScope));
      yield* first.show("first", { x: 12, y: 34 });
      const focused = yield* second.show("first");
      assert.equal(focused.instance, 1);
      yield* closeScope(firstScope);
      assert.equal(f.pages.get("first")?.state, "open");
      assert.equal((yield* Effect.exit(first.show("first")))._tag, "Failure");
      yield* closeScope(secondScope);
      assert.equal(f.pages.get("first")?.state, "closed");
    }).pipe(Effect.scoped, Effect.timeout(5_000)),
  ));

test("manual inspector recreation cannot be closed by a stale plugin owner", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture;
      const ownerScope = yield* Scope.make();
      const api = yield* f.devtools
        .forOwner(Effect.void)
        .pipe(Effect.provideService(Scope.Scope, ownerScope));
      yield* api.show("first");
      f.pages.set("first", { pageId: "first", generation: 1, instance: 2, state: "open" });
      f.leases.delete("first");
      yield* closeScope(ownerScope);
      assert.equal(f.pages.get("first")?.state, "open");
      assert.equal(f.pages.get("first")?.instance, 2);
    }).pipe(Effect.scoped, Effect.timeout(5_000)),
  ));

test("a lost show reply closes only its owned target and preserves other inspectors", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture;
      const api = yield* f.devtools.forOwner(Effect.void);
      yield* api.show("first");
      f.loseReply();
      assert.equal((yield* Effect.exit(api.show("second")))._tag, "Failure");
      assert.equal(f.pages.get("first")?.state, "open");
      assert.equal(f.pages.get("second")?.state, "closed");
    }).pipe(Effect.scoped, Effect.timeout(5_000)),
  ));

test("quiet grant revocation closes owned inspectors and rejects further calls", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture;
      let allowed = true;
      const api = yield* f.devtools.forOwner(
        Effect.suspend(() => (allowed ? Effect.void : Effect.fail("revoked"))),
      );
      yield* api.show("first");
      allowed = false;
      yield* TestClock.adjust(501);
      yield* Deferred.await(f.closed);
      assert.equal(f.pages.get("first")?.state, "closed");
      assert.equal((yield* Effect.exit(api.status("first")))._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test("denied callers and unsupported hosts never send a DevTools mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture;
      const denied = yield* f.devtools.forOwner(Effect.fail("denied"));
      assert.equal((yield* Effect.exit(denied.show("first")))._tag, "Failure");
      assert.deepEqual(f.calls, []);
      const unsupported = yield* createDevToolsController({
        engine: { ...f.engine, ready: Effect.succeed({ event: "host.ready", params: {} }) },
        protect: () => Effect.void,
      });
      const api = yield* unsupported.forOwner(Effect.void);
      assert.equal((yield* Effect.exit(api.show("first")))._tag, "Failure");
      assert.deepEqual(f.calls, []);
    }).pipe(Effect.scoped, Effect.timeout(5_000)),
  ));
