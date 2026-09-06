import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Exit } from "effect";
import { EngineConnection } from "../src/engine.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
test(
  "native profile lease denies a second broker and releases after an engine crash",
  { skip: !binary, timeout: 30_000 },
  async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "hitchhiker-native-lease-"));
    const launch = <A, E>(operation: Effect.Effect<A, E, EngineConnection>) =>
      operation.pipe(
        Effect.provide(
          EngineConnection.layer({ executable: binary!, profileRoot, extensionManagement: false }),
        ),
        Effect.scoped,
      );
    try {
      await Effect.runPromise(
        launch(
          Effect.gen(function* () {
            const first = yield* EngineConnection;
            yield* first.ready;
            const duplicate = yield* launch(
              Effect.gen(function* () {
                const second = yield* EngineConnection;
                return yield* second.ready;
              }),
            ).pipe(Effect.exit);
            assert(Exit.isFailure(duplicate), "the second broker must not reach readiness");
            assert.deepEqual(yield* first.request("pages.list"), []);
            process.kill(first.pid, "SIGKILL");
            yield* first.exit.pipe(Effect.ignoreCause);
          }),
        ),
      );
      await Effect.runPromise(
        launch(
          Effect.gen(function* () {
            const recovered = yield* EngineConnection;
            yield* recovered.ready;
            assert.deepEqual(yield* recovered.request("pages.list"), []);
            yield* recovered.request("window.close").pipe(Effect.ignoreCause);
            assert.equal(yield* recovered.exit, 0);
          }),
        ),
      );
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  },
);
