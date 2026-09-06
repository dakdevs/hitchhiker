import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Effect, Fiber, Stream } from "effect";
import { EngineConnection } from "../src/engine.ts";
import { FrameDecoder } from "../src/framing.ts";

const fixture = fileURLToPath(new URL("./engine-fixture.mjs", import.meta.url));
const layer = EngineConnection.layer({
  executable: fixture,
  profileRoot: "/tmp/hitchhiker-transport-fixture",
  requestTimeoutMs: 150,
});

test("private transport routes concurrent responses, typed failures and actual fd3/fd4 frames", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineConnection;
      const ready = yield* engine.ready;
      assert.equal(ready.params.version, 1);
      const values = yield* Effect.all(
        [engine.request("echo", { value: "first" }), engine.request("echo", { value: "second" })],
        { concurrency: 2 },
      );
      assert.deepEqual(values, [{ value: "first" }, { value: "second" }]);
      const rejected = yield* engine.request("error").pipe(Effect.flip);
      assert.equal(rejected.code, "-32602");
      const raw = yield* engine.cdpEvents.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* engine.sendCdp({ id: 19, method: "Browser.getVersion" });
      assert.deepEqual(yield* Fiber.join(raw), [{ id: 19, result: { product: "Fixture/1.0" } }]);
      yield* engine.request("window.close");
      assert.equal(yield* engine.exit, 0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

test("request timeout releases capacity and engine death fails outstanding requests", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineConnection;
      yield* engine.ready;
      assert.equal((yield* engine.request("never").pipe(Effect.flip)).code, "timeout");
      assert.deepEqual(yield* engine.request("echo", { after: true }), { after: true });
      const waiting = yield* engine.request("never").pipe(Effect.flip, Effect.forkScoped);
      yield* engine.request("exit").pipe(Effect.flip);
      assert.ok(
        new Set(["exit", "host-read-closed", "cdp-read-closed", "cdp-write-closed"]).has(
          (yield* Fiber.join(waiting)).code,
        ),
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

test("event consumers can await host replies during a burst without blocking the transport", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineConnection;
      yield* engine.ready;
      const consumer = yield* engine.events.pipe(
        Stream.filter((event) => event.event === "fixture.event"),
        Stream.take(40),
        Stream.mapEffect((event) => engine.request("echo", event.params)),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* engine.request("burst");
      assert.equal((yield* Fiber.join(consumer).pipe(Effect.timeout(2000))).length, 40);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

test("malformed host output closes the logical connection rather than silently losing events", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineConnection;
      yield* engine.ready;
      const eventsClosed = yield* engine.events.pipe(Stream.runDrain, Effect.forkScoped);
      const cdpClosed = yield* engine.cdpEvents.pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal((yield* engine.request("malformed").pipe(Effect.flip)).code, "protocol");
      yield* Fiber.join(eventsClosed).pipe(Effect.timeout(1_000));
      yield* Fiber.join(cdpClosed).pipe(Effect.timeout(1_000));
      assert.equal((yield* engine.request("echo").pipe(Effect.flip)).code, "protocol");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

test("CDP pipe EOF stops the whole logical connection", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineConnection;
      yield* engine.ready;
      const cdpClosed = yield* engine.cdpEvents.pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* engine.request("close-cdp");
      yield* Fiber.join(cdpClosed).pipe(Effect.timeout(1_000));
      assert.equal((yield* engine.request("echo").pipe(Effect.flip)).code, "cdp-read-closed");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

test("rejects relative executables before spawning", async () => {
  const rejected = await Effect.runPromise(
    Effect.gen(function* () {
      yield* EngineConnection;
    }).pipe(
      Effect.provide(EngineConnection.layer({ executable: "host", profileRoot: "/tmp/profile" })),
      Effect.scoped,
      Effect.flip,
    ),
  );
  assert.equal(rejected.code, "configuration");
});

test("framing retains UTF-8 across reads and limits each complete or incomplete frame", () => {
  const decoder = new FrameDecoder(10, 12);
  const text = Buffer.from("日\nsecond\n");
  assert.deepEqual(decoder.push(text.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(text.subarray(2)), ["日", "second"]);
  decoder.finish();
  assert.throws(() => new FrameDecoder(10, 3).push(Buffer.from("1234\n")), /limit/);
  assert.throws(() => new FrameDecoder(10, 3).push(Buffer.from("1234")), /limit/);
  const partial = new FrameDecoder(0, 10);
  partial.push(Buffer.from("partial"));
  assert.throws(() => partial.finish(), /incomplete/);
});
