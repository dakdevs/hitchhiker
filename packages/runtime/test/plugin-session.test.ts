import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, Fiber, Stream } from "effect";
import { create } from "../src/grants.ts";
import { runLivePlugin, type LivePluginOptions } from "../src/plugin-session.ts";

const hostScript = (marker: string) => `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(marker)}, String(process.pid) + "\\n");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  send({ id: request.id, result: true });
  if (request.method === "stop") process.exit(0);
});
`;

const waitForExit = async (pid: number) => {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) assert.fail(`plugin fixture process ${pid} leaked`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const waitForSpawn = async (marker: string, index: number) => {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const pids = await readFile(marker, "utf8").then(
      (value) => value.trim().split("\n").filter(Boolean).map(Number),
      () => [] as number[],
    );
    if (Number.isSafeInteger(pids[index])) return pids[index]!;
    if (Date.now() >= deadline) assert.fail(`plugin fixture process ${index} did not spawn`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("live plugin authenticates before spawn, expires idle credentials, and escalates recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-session-"));
  const marker = join(directory, "spawned");
  const executable = join(directory, "host.cjs");
  await writeFile(executable, hostScript(marker), { mode: 0o700 });
  await chmod(executable, 0o700);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory: join(directory, "grants") });
        const issued = yield* grants.issue({
          principal: "idle-plugin",
          profileId: "default",
          capabilities: [],
          origins: [],
        });
        let releases = 0;
        const base: LivePluginOptions = {
          manifest: {
            id: "idle-plugin",
            version: "1.0.0",
            name: "Idle",
            capabilities: [],
          },
          executable,
          code: "globalThis.HitchhikerPlugin={activate(){}}",
          profileId: "default",
          token: issued.token,
          grants,
          browser: {
            pages: Effect.succeed([]),
            open: () => Effect.die("not used"),
            navigate: () => Effect.die("not used"),
            close: () => Effect.die("not used"),
            configuration: Effect.die("not used"),
            configure: () => Effect.die("not used"),
            setTabPlacement: () => Effect.die("not used"),
          },
          publish: () => Effect.die("not used"),
          release: Effect.sync(() => releases++),
          events: Stream.never,
        };

        const invalid = yield* Effect.exit(runLivePlugin({ ...base, token: "invalid" }));
        assert(Exit.isFailure(invalid));
        assert.equal(
          yield* Effect.promise(() =>
            readFile(marker, "utf8").then(
              () => true,
              () => false,
            ),
          ),
          false,
        );
        assert.equal(releases, 0);

        const idle = yield* runLivePlugin(base).pipe(Effect.forkScoped);
        const pid = yield* Effect.promise(() => waitForSpawn(marker, 0));
        yield* grants.revoke(issued.grant.id);
        assert(Exit.isFailure(yield* Fiber.await(idle).pipe(Effect.timeout(2_000))));
        assert.equal(releases, 1);
        yield* Effect.promise(() => waitForExit(pid));

        const recoveryGrant = yield* grants.issue({
          principal: "recovery-plugin",
          profileId: "default",
          capabilities: [],
          origins: [],
        });
        let recoveryAttempts = 0;
        let escalations = 0;
        const recovery = yield* runLivePlugin({
          ...base,
          manifest: {
            id: "recovery-plugin",
            version: "1.0.0",
            name: "Recovery",
            capabilities: [],
          },
          token: recoveryGrant.token,
          release: Effect.sync(() => recoveryAttempts++).pipe(
            Effect.andThen(Effect.fail("release failed")),
          ),
          onRecoveryFailure: Effect.sync(() => escalations++),
        }).pipe(Effect.forkScoped);
        yield* Effect.promise(() => waitForSpawn(marker, 1));
        yield* Fiber.interrupt(recovery);
        assert.equal(recoveryAttempts, 3);
        assert.equal(escalations, 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
