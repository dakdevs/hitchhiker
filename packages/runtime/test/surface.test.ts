import assert from "node:assert/strict";
import test from "node:test";
import { Context, Effect, Fiber, Layer, PubSub, Schema, Scope, Stream } from "effect";
import { row, text, type Surface, viewport } from "@hitchhiker/ui";
import { EngineConnection, type EngineEvent, type JsonObject } from "../src/engine.ts";
import { NativeSurface } from "../src/surface.ts";

interface RecordedRequest {
  readonly method: string;
  readonly params: unknown;
}

const mockEngine = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<EngineEvent>();
  const requests: RecordedRequest[] = [];
  const engine = EngineConnection.of({
    pid: 1,
    ready: Effect.succeed({ event: "host.ready", params: { version: 1 } }),
    exit: Effect.never,
    events: Stream.fromPubSub(events),
    cdpEvents: Stream.empty,
    request: (method, params = {}) =>
      Effect.sync(() => {
        requests.push({ method, params });
        return {};
      }),
    sendCdp: () => Effect.void,
  });
  return {
    requests,
    layer: Layer.succeed(EngineConnection, engine),
    emit: (params: JsonObject) => PubSub.publish(events, { event: "ui.event", params }),
  };
});

const withSurface = <A, E, R>(
  effect: (
    surface: NativeSurface["Service"],
    mock: Effect.Success<typeof mockEngine>,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
  Effect.gen(function* () {
    const mock = yield* mockEngine;
    const context = yield* Layer.build(NativeSurface.layer.pipe(Layer.provide(mock.layer)));
    const surface = Context.get(context, NativeSurface);
    return yield* effect(surface, mock);
  }).pipe(Effect.scoped);

const mainRoot = (value = "one") =>
  row("root", [text("copy", value), viewport("page-region", "main-page", { flex: 1 })]);

const mainSurface = (value = "one"): Surface => ({
  identity: "default",
  root: mainRoot(value),
  bindings: [{ viewportId: "main-page", pageId: "page-one" }],
});

const event = (
  revision: number,
  name: "press" | "input" | "viewport",
  nodeId: string,
  payload: Record<string, Schema.Json>,
): JsonObject => ({
  surfaceId: "main",
  revision,
  event: name,
  nodeId,
  payload,
});

test("commits trusted JSON and rejects bindings that do not name a declared viewport", async () => {
  await Effect.runPromise(
    withSurface((surface, mock) =>
      Effect.gen(function* () {
        assert.equal(yield* surface.commit(mainSurface()), 1);
        assert.deepEqual(
          mock.requests.map((request) => request.method),
          ["ui.commit", "viewports.set"],
        );
        assert.deepEqual(mock.requests[0]?.params, { revision: 1, root: mainRoot() });
        const rejected = yield* surface
          .commit({
            root: row("root", [text("copy", "invalid")]),
            bindings: [{ viewportId: "missing", pageId: "page-one" }],
          })
          .pipe(Effect.flip);
        assert.equal(rejected.code, "surface");
        assert.equal(mock.requests.length, 2);
      }),
    ),
  );
});

test("rejects malformed JavaScript component data before issuing engine commands", async () => {
  await Effect.runPromise(
    withSurface((surface, mock) =>
      Effect.gen(function* () {
        const malformed: readonly unknown[] = [
          { root: null, bindings: [] },
          {
            root: { key: "root", kind: "row", children: { not: "an array" } },
            bindings: [],
          },
          { root: { key: "bad-icon", kind: "icon", icon: "app:lucide-invented" }, bindings: [] },
        ];
        for (const candidate of malformed) {
          const rejected = yield* surface.commit(candidate as Surface).pipe(Effect.flip);
          assert.equal(rejected.code, "surface");
        }
        assert.deepEqual(mock.requests, []);
      }),
    ),
  );
});

test("accepts default-surface style objects whose undefined background is omitted from JSON", async () => {
  await Effect.runPromise(
    withSurface((surface, mock) =>
      Effect.gen(function* () {
        const root = row("root", [text("copy", "default")], { bg: undefined });
        assert.equal(yield* surface.commit({ identity: "default", root, bindings: [] }), 1);
        assert.deepEqual(mock.requests, [
          {
            method: "ui.commit",
            params: {
              revision: 1,
              root: {
                key: "root",
                kind: "row",
                children: [{ key: "copy", kind: "text", label: "default" }],
              },
            },
          },
        ]);
      }),
    ),
  );
});

test("only declared Native viewport geometry produces trusted page placements", async () => {
  await Effect.runPromise(
    withSurface((surface, mock) =>
      Effect.gen(function* () {
        yield* surface.commit(mainSurface());
        const delivered = yield* surface.events.pipe(
          Stream.filter((candidate) => candidate.event === "viewport"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* mock.emit(
          event(1, "viewport", "page-region", {
            viewportId: "unknown",
            x: 1,
            y: 1,
            width: 10,
            height: 10,
          }),
        );
        yield* mock.emit(
          event(1, "viewport", "page-region", {
            viewportId: "main-page",
            x: -1,
            y: 1,
            width: 10,
            height: 10,
          }),
        );
        yield* mock.emit(
          event(1, "viewport", "page-region", {
            viewportId: "main-page",
            x: 1.2,
            y: 3,
            width: 10.9,
            height: 5.9,
          }),
        );
        assert.equal((yield* Fiber.join(delivered)).length, 1);
        assert.deepEqual(mock.requests.at(-1), {
          method: "viewports.set",
          params: { viewports: [{ pageId: "page-one", x: 2, y: 3, width: 10, height: 5 }] },
        });
      }),
    ),
  );
});

test("stale presses are discarded after a redraw", async () => {
  await Effect.runPromise(
    withSurface((surface, mock) =>
      Effect.gen(function* () {
        yield* surface.commit({
          identity: "default",
          root: row("root", [text("copy", "one")]),
          bindings: [],
        });
        yield* surface.commit({
          identity: "default",
          root: row("root", [text("copy", "two")]),
          bindings: [],
        });
        const delivered = yield* surface.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* mock.emit(event(1, "press", "old", {}));
        yield* mock.emit(event(2, "press", "current", {}));
        const events = yield* Fiber.join(delivered);
        assert.equal(events.length, 1);
        assert.equal(events[0]?.nodeId, "current");
      }),
    ),
  );
});

test("queued input for the same field survives a controlled redraw", async () => {
  await Effect.runPromise(
    withSurface((surface, mock) =>
      Effect.gen(function* () {
        const first: Surface = {
          identity: "default",
          root: row("root", [{ key: "address", kind: "input", label: "Address", value: "a" }]),
          bindings: [],
        };
        const second: Surface = {
          ...first,
          root: row("root", [{ key: "address", kind: "input", label: "Address", value: "ab" }]),
        };
        yield* surface.commit(first);
        yield* surface.commit(second);
        const delivered = yield* surface.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* mock.emit(event(1, "input", "address", { value: "abc" }));
        const events = yield* Fiber.join(delivered);
        assert.equal(events[0]?.revision, 1);
        assert.deepEqual(events[0]?.payload, { value: "abc" });
      }),
    ),
  );
});

test("removed fields and changed surface identities discard stale input", async () => {
  await Effect.runPromise(
    withSurface((surface, mock) =>
      Effect.gen(function* () {
        const address = (identity: string, key: string): Surface => ({
          identity,
          root: row("root", [{ key, kind: "input", label: key, value: "" }]),
          bindings: [],
        });
        yield* surface.commit(address("one", "address"));
        yield* surface.commit(address("one", "other"));
        const afterRemoval = yield* surface.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* mock.emit(event(1, "input", "address", { value: "stale" }));
        yield* mock.emit(event(2, "press", "other", {}));
        assert.equal((yield* Fiber.join(afterRemoval))[0]?.nodeId, "other");

        yield* surface.commit(address("two", "other"));
        const afterIdentityChange = yield* surface.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* mock.emit(event(2, "input", "other", { value: "stale" }));
        yield* mock.emit(event(3, "press", "other", {}));
        const events = yield* Fiber.join(afterIdentityChange);
        assert.equal(events[0]?.revision, 3);
        assert.equal(events[0]?.event, "press");
      }),
    ),
  );
});

test("unchanged bindings keep placements during text-only redraws", async () => {
  await Effect.runPromise(
    withSurface((surface, mock) =>
      Effect.gen(function* () {
        yield* surface.commit(mainSurface("before"));
        const measured = yield* surface.events.pipe(
          Stream.filter((candidate) => candidate.event === "viewport"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* mock.emit(
          event(1, "viewport", "page-region", {
            viewportId: "main-page",
            x: 0,
            y: 0,
            width: 20,
            height: 20,
          }),
        );
        yield* Fiber.join(measured);
        yield* surface.commit(mainSurface("after"));
        const placements = mock.requests.filter((request) => request.method === "viewports.set");
        assert.deepEqual(placements, [
          { method: "viewports.set", params: { viewports: [] } },
          {
            method: "viewports.set",
            params: { viewports: [{ pageId: "page-one", x: 0, y: 0, width: 20, height: 20 }] },
          },
        ]);
      }),
    ),
  );
});
