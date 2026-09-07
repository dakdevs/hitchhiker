import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Deferred, Effect, Fiber, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { EngineConnection } from "../src/engine.ts";
import { FrameDecoder } from "../src/framing.ts";

const fixture = fileURLToPath(new URL("./engine-fixture.mjs", import.meta.url));
const hungFixture = fileURLToPath(new URL("./engine-hung-fixture.mjs", import.meta.url));
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
      const received = yield* engine.events.pipe(
        Stream.filter((event) => event.event === "extension.received"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const pending = yield* engine
        .loadUnpacked(artifacts.d)
        .pipe(Effect.provide(TestClock.layer()), Effect.flip, Effect.forkScoped);
      yield* Fiber.join(received);
      yield* engine.request("close-cdp");
      assert.equal((yield* Fiber.join(pending)).code, "cdp-read-closed");
      assert.equal((yield* engine.claimRawCdp.pipe(Effect.flip)).code, "cdp-read-closed");
    }),
  );
});

test("interrupting a sent extension request prevents raw handoff until restart", async () => {
  await withExtensionEngine((engine, artifacts) =>
    Effect.gen(function* () {
      const received = yield* engine.events.pipe(
        Stream.filter((event) => event.event === "extension.received"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const pending = yield* engine
        .loadUnpacked(artifacts.d)
        .pipe(Effect.provide(TestClock.layer()), Effect.forkScoped);
      yield* Fiber.join(received);
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

const withDrainEngine = async (
  eventDrainTimeoutMs: number,
  run: (engine: EngineConnection["Service"]) => Effect.Effect<void, unknown, Scope.Scope>,
): Promise<void> => {
  const program = Effect.gen(function* () {
    const engine = yield* EngineConnection;
    yield* engine.ready;
    yield* run(engine);
  }).pipe(
    Effect.provide(
      EngineConnection.layer({
        executable: fixture,
        profileRoot: "/tmp/hitchhiker-event-drain-fixture",
        extensionManagement: false,
        requestTimeoutMs: 150,
        eventDrainTimeoutMs,
      }),
    ),
    Effect.scoped,
  );
  return Effect.runPromise(program);
};

const awaitChildProcessExit = (pid: number) =>
  Effect.tryPromise({
    try: async () => {
      const deadline = Date.now() + 2_000;
      for (;;) {
        try {
          process.kill(pid, 0);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ESRCH") return;
          throw cause;
        }
        if (Date.now() >= deadline) throw new Error("fixture child did not exit");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    catch: (cause) => cause,
  });

const awaitFile = async (path: string) => {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await access(path);
      return;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    if (Date.now() >= deadline) throw new Error("fixture did not start");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

test(
  "interrupting startup force-kills a host that ignores SIGTERM",
  { timeout: 3_000 },
  async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "hitchhiker-hung-engine-"));
    const controller = new AbortController();
    let resolveSpawned!: (pid: number) => void;
    const spawned = new Promise<number>((resolve) => {
      resolveSpawned = resolve;
    });
    const running = Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineConnection;
        yield* Effect.sync(() => resolveSpawned(engine.pid));
        yield* engine.ready;
      }).pipe(
        Effect.provide(
          EngineConnection.layer({
            executable: hungFixture,
            profileRoot,
            extensionManagement: false,
          }),
        ),
        Effect.scoped,
      ),
      { signal: controller.signal },
    );
    let pid: number | undefined;
    let exited = false;
    try {
      pid = await spawned;
      await awaitFile(join(profileRoot, "hung-engine-started"));
      controller.abort();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("startup interruption did not settle")),
          1_000,
        );
        void running.then(
          () => {
            clearTimeout(timeout);
            reject(new Error("startup unexpectedly succeeded"));
          },
          () => {
            clearTimeout(timeout);
            resolve();
          },
        );
      });
      await Effect.runPromise(awaitChildProcessExit(pid));
      exited = true;
    } finally {
      if (pid !== undefined && !exited) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Preserve the test failure when the owned process already exited.
        }
      }
      await running.catch(() => undefined);
      await rm(profileRoot, { recursive: true, force: true });
    }
  },
);

test("logical exit waits for ordered delivery and the final awaited handler", async () => {
  await withDrainEngine(1_000, (engine) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finalEntered = yield* Deferred.make<void>();
      const finalRelease = yield* Deferred.make<void>();
      const received: number[] = [];
      let finalWriteFinished = false;
      const consumer = yield* engine.events.pipe(
        Stream.filter((event) => event.event === "fixture.event"),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const index = event.params.index;
            assert.ok(typeof index === "number");
            if (index === 0) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            received.push(index);
            if (index === 39) {
              yield* Deferred.succeed(finalEntered, undefined);
              yield* Deferred.await(finalRelease);
              finalWriteFinished = true;
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* engine.request("burst-exit").pipe(
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* awaitChildProcessExit(engine.pid);
      const exiting = yield* engine.exit.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal(exiting.pollUnsafe(), undefined);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(finalEntered);
      assert.deepEqual(
        received,
        Array.from({ length: 40 }, (_, index) => index),
      );
      assert.equal(exiting.pollUnsafe(), undefined);
      assert.equal(finalWriteFinished, false);
      yield* Deferred.succeed(finalRelease, undefined);
      assert.equal(yield* Fiber.join(exiting), 0);
      assert.equal(finalWriteFinished, true);
      yield* Fiber.join(consumer);
    }),
  );
});

test("closing the layer settles a captured logical exit and terminates the child", async () => {
  const engine = await Effect.runPromise(
    Effect.gen(function* () {
      const connection = yield* EngineConnection;
      yield* connection.ready;
      return connection;
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  const error = await Effect.runPromise(engine.exit.pipe(Effect.flip, Effect.timeout(1_000)));
  assert.equal(error.code, "closed");
  await Effect.runPromise(awaitChildProcessExit(engine.pid));
  assert.deepEqual(
    await Effect.runPromise(engine.events.pipe(Stream.runCollect, Effect.timeout(1_000))),
    [],
  );
});

test("early and late event subscriptions do not hold graceful shutdown", async () => {
  await withDrainEngine(1_000, (engine) =>
    Effect.gen(function* () {
      const early = yield* engine.events.pipe(
        Stream.filter((event) => event.event === "fixture.event"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* engine.request("burst-exit").pipe(
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      assert.equal((yield* Fiber.join(early)).length, 1);
      assert.equal(yield* engine.exit, 0);
      assert.deepEqual(yield* engine.events.pipe(Stream.runCollect), []);
    }),
  );
});

test("a stuck direct subscriber after child exit is bounded", async () => {
  await withDrainEngine(50, (engine) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      yield* engine.events.pipe(
        Stream.filter((event) => event.event === "fixture.event"),
        Stream.mapEffect((event) =>
          event.params.index === 0
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(never)))
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* engine.request("burst-exit").pipe(
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* awaitChildProcessExit(engine.pid);
      assert.equal((yield* engine.exit.pipe(Effect.flip)).code, "event-drain-timeout");
    }),
  );
});

test("a failed direct subscriber after child exit is reported", async () => {
  await withDrainEngine(1_000, (engine) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const consumer = yield* engine.events.pipe(
        Stream.filter((event) => event.event === "fixture.event"),
        Stream.runForEach((event) =>
          event.params.index === 0
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.fail(new Error("consumer failed"))),
              )
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* engine.request("burst-exit").pipe(
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* awaitChildProcessExit(engine.pid);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(consumer);
      assert.equal((yield* engine.exit.pipe(Effect.flip)).code, "event-consumer-failed");
    }),
  );
});

test("an interrupted direct subscriber after child exit is reported", async () => {
  await withDrainEngine(1_000, (engine) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      const consumer = yield* engine.events.pipe(
        Stream.filter((event) => event.event === "fixture.event"),
        Stream.runForEach((event) =>
          event.params.index === 0
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(never)))
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* engine.request("burst-exit").pipe(
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* awaitChildProcessExit(engine.pid);
      yield* Fiber.interrupt(consumer);
      assert.equal((yield* engine.exit.pipe(Effect.flip)).code, "event-consumer-failed");
    }),
  );
});

test("an unrelated merged branch does not keep the finished engine branch registered", async () => {
  await withDrainEngine(1_000, (engine) =>
    Effect.gen(function* () {
      const merged = yield* Stream.merge(
        engine.events.pipe(Stream.filter((event) => event.event === "fixture.event")),
        Stream.never,
      ).pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* engine.request("burst-exit").pipe(
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      assert.equal(yield* engine.exit, 0);
      yield* Fiber.interrupt(merged);
    }),
  );
});

test("CDP EOF does not drop host events which are already draining to a subscriber", async () => {
  await withDrainEngine(1_000, (engine) =>
    Effect.gen(function* () {
      const received = yield* engine.events.pipe(
        Stream.filter((event) => event.event === "fixture.event"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* engine.request("close-cdp-burst-exit").pipe(
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      assert.deepEqual(
        (yield* Fiber.join(received)).map((event) => event.params.index),
        [0, 1, 2, 3],
      );
      assert.equal(yield* engine.exit, 0);
    }),
  );
});

test("nonzero child exits and incomplete host frames cannot report successful logical exit", async () => {
  await withDrainEngine(1_000, (engine) =>
    Effect.gen(function* () {
      yield* engine.request("exit-one").pipe(
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      assert.equal((yield* engine.exit.pipe(Effect.flip)).code, "exit");
    }),
  );
  await withDrainEngine(1_000, (engine) =>
    Effect.gen(function* () {
      yield* engine.request("partial-exit").pipe(
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      assert.equal((yield* engine.exit.pipe(Effect.flip)).code, "framing");
    }),
  );
});

test("a child that keeps running after host stdout closes is terminated after the drain deadline", async () => {
  await withDrainEngine(50, (engine) =>
    Effect.gen(function* () {
      yield* engine.request("close-stdout-hang").pipe(
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      assert.equal((yield* engine.exit.pipe(Effect.flip)).code, "event-drain-timeout");
      yield* awaitChildProcessExit(engine.pid);
    }),
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
      // The fixture acknowledges the close command before closing fd 4. Freeze the request
      // timer so this receipt, rather than scheduler load around the 150ms test timeout,
      // is the handshake that precedes the EOF assertion below.
      yield* engine.request("close-cdp").pipe(Effect.provide(TestClock.layer()));
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

test("an unacknowledged Native commit terminates the connection instead of permitting a retry", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineConnection;
      yield* engine.ready;
      assert.equal(
        (yield* engine.request("ui.commit", { revision: 1 }).pipe(Effect.flip)).code,
        "timeout",
      );
      assert.equal((yield* engine.request("echo").pipe(Effect.flip)).code, "timeout");
      assert.equal((yield* engine.exit.pipe(Effect.flip, Effect.timeout(2000))).code, "timeout");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

test("interrupting an enqueued Native commit terminates the uncertain connection", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineConnection;
      yield* engine.ready;
      const received = yield* engine.events.pipe(
        Stream.filter((event) => event.event === "ui.received"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      // This case exercises interruption after dispatch; the separate test above owns timeout.
      const pending = yield* engine
        .request("ui.commit", { revision: 1 })
        .pipe(Effect.provide(TestClock.layer()), Effect.forkScoped);
      yield* Fiber.join(received);
      yield* Fiber.interrupt(pending);
      assert.equal((yield* engine.request("echo").pipe(Effect.flip)).code, "commit-interrupted");
      assert.equal(
        (yield* engine.exit.pipe(Effect.flip, Effect.timeout(2000))).code,
        "commit-interrupted",
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
