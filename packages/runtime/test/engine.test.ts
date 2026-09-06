import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Effect, Fiber, Schema, Scope, Stream } from "effect";
import { EngineConnection } from "../src/engine.ts";
import { FrameDecoder } from "../src/framing.ts";

const fixture = fileURLToPath(new URL("./engine-fixture.mjs", import.meta.url));
const layer = EngineConnection.layer({
  executable: fixture,
  profileRoot: "/tmp/hitchhiker-transport-fixture",
  extensionManagement: false,
  requestTimeoutMs: 150,
});

test("private transport routes concurrent responses, typed failures and actual fd3/fd4 frames", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineConnection;
      const ready = yield* engine.ready;
      assert.equal(ready.params.version, 1);
      assert.equal(
        (ready.params.args as Schema.Json[]).includes("--enable-unsafe-extension-debugging"),
        false,
      );
      assert.equal(
        (yield* engine.loadUnpacked("/tmp/disabled").pipe(Effect.flip)).code,
        "extension-disabled",
      );
      const values = yield* Effect.all(
        [engine.request("echo", { value: "first" }), engine.request("echo", { value: "second" })],
        { concurrency: 2 },
      );
      assert.deepEqual(values, [{ value: "first" }, { value: "second" }]);
      const rejected = yield* engine.request("error").pipe(Effect.flip);
      assert.equal(rejected.code, "-32602");
      const cdp = yield* engine.claimRawCdp;
      const raw = yield* cdp.events.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* cdp.send({ id: 19, method: "Browser.getVersion" });
      assert.deepEqual(yield* Fiber.join(raw), [{ id: 19, result: { product: "Fixture/1.0" } }]);
      yield* engine.request("window.close");
      assert.equal(yield* engine.exit, 0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

const withExtensionEngine = async (
  run: (
    engine: EngineConnection["Service"],
    artifacts: Readonly<Record<string, string>>,
  ) => Effect.Effect<void, unknown, Scope.Scope>,
) => {
  const profileRoot = await mkdtemp(join(tmpdir(), "hitchhiker-extension-transport-"));
  const root = join(profileRoot, "hitchhiker-extensions", "artifacts");
  const artifacts: Record<string, string> = {};
  await mkdir(root, { recursive: true });
  for (const prefix of ["a", "b", "c", "d", "e", "f", "g"]) {
    const installationId = prefix === "g" ? `ab${"a".repeat(30)}` : prefix.repeat(32);
    const path = join(root, installationId);
    await mkdir(path);
    artifacts[prefix] = await realpath(path);
  }
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineConnection;
        yield* engine.ready;
        yield* run(engine, artifacts).pipe(
          Effect.ensuring(engine.request("window.close").pipe(Effect.catch(() => Effect.void))),
        );
      }).pipe(
        Effect.provide(
          EngineConnection.layer({
            executable: fixture,
            profileRoot,
            extensionManagement: true,
            requestTimeoutMs: 150,
          }),
        ),
        Effect.scoped,
      ),
    );
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
};

test("extension management is typed, bounded to profile artifacts, and exclusive with raw CDP", async () => {
  await withExtensionEngine((engine, artifacts) =>
    Effect.gen(function* () {
      const ready = yield* engine.ready;
      assert.equal(
        (ready.params.args as Schema.Json[]).includes("--enable-unsafe-extension-debugging"),
        true,
      );
      assert.equal(yield* engine.loadUnpacked(artifacts.a), "a".repeat(32));
      const rejected = yield* engine.loadUnpacked(artifacts.b).pipe(Effect.flip);
      assert.equal(rejected.code, "extension-rejected");
      assert.equal(rejected.message.includes(artifacts.b), false);
      yield* engine.uninstall("a".repeat(32));
      assert.equal(
        (yield* engine.loadUnpacked("/tmp/not-an-artifact").pipe(Effect.flip)).code,
        "extension-path",
      );

      const pending = yield* engine.loadUnpacked(artifacts.f).pipe(Effect.forkScoped);
      yield* Effect.sleep(10);
      assert.equal((yield* engine.claimRawCdp.pipe(Effect.flip)).code, "cdp-owned");
      assert.equal(yield* Fiber.join(pending), "a".repeat(32));
      const cdp = yield* engine.claimRawCdp;
      assert.equal((yield* engine.claimRawCdp.pipe(Effect.flip)).code, "cdp-owned");
      assert.equal(
        (yield* cdp.send({ id: 2_147_483_647, method: "Browser.getVersion" }).pipe(Effect.flip))
          .code,
        "cdp-reserved-id",
      );
      assert.equal(
        (yield* cdp
          .send({ id: 31, method: "Extensions.uninstall", params: { id: "a".repeat(32) } })
          .pipe(Effect.flip)).code,
        "cdp-reserved-method",
      );
      assert.equal((yield* engine.uninstall("a".repeat(32)).pipe(Effect.flip)).code, "cdp-owned");
    }),
  );
});

test("malformed and timed-out extension results poison raw handoff and drain late replies", async () => {
  await withExtensionEngine((engine, artifacts) =>
    Effect.gen(function* () {
      assert.equal(
        (yield* engine.loadUnpacked(artifacts.c).pipe(Effect.flip)).code,
        "extension-uncertain",
      );
      assert.equal((yield* engine.claimRawCdp.pipe(Effect.flip)).code, "extension-uncertain");
    }),
  );
  await withExtensionEngine((engine, artifacts) =>
    Effect.gen(function* () {
      assert.equal(
        (yield* engine.loadUnpacked(artifacts.g).pipe(Effect.flip)).code,
        "extension-uncertain",
      );
      assert.equal((yield* engine.claimRawCdp.pipe(Effect.flip)).code, "extension-uncertain");
    }),
  );
  await withExtensionEngine((engine, artifacts) =>
    Effect.gen(function* () {
      assert.equal(
        (yield* engine.loadUnpacked(artifacts.e).pipe(Effect.flip)).code,
        "extension-uncertain",
      );
      yield* Effect.sleep(300);
      assert.equal((yield* engine.claimRawCdp.pipe(Effect.flip)).code, "extension-uncertain");
    }),
  );
});

test("engine shutdown fails a pending extension command without handing off the pipe", async () => {
  await withExtensionEngine((engine, artifacts) =>
    Effect.gen(function* () {
      const pending = yield* engine.loadUnpacked(artifacts.d).pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.sleep(25);
      yield* engine.request("close-cdp");
      assert.equal((yield* Fiber.join(pending)).code, "cdp-read-closed");
      assert.equal((yield* engine.claimRawCdp.pipe(Effect.flip)).code, "cdp-read-closed");
    }),
  );
});

test("interrupting a sent extension request prevents raw handoff until restart", async () => {
  await withExtensionEngine((engine, artifacts) =>
    Effect.gen(function* () {
      const pending = yield* engine.loadUnpacked(artifacts.d).pipe(Effect.forkScoped);
      yield* Effect.sleep(25);
      yield* Fiber.interrupt(pending);
      assert.equal((yield* engine.claimRawCdp.pipe(Effect.flip)).code, "extension-uncertain");
    }),
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
      const cdp = yield* engine.claimRawCdp;
      const cdpClosed = yield* cdp.events.pipe(Stream.runDrain, Effect.forkScoped);
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
      const cdp = yield* engine.claimRawCdp;
      const cdpClosed = yield* cdp.events.pipe(Stream.runDrain, Effect.forkScoped);
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
      Effect.provide(
        EngineConnection.layer({
          executable: "host",
          profileRoot: "/tmp/profile",
          extensionManagement: false,
        }),
      ),
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
