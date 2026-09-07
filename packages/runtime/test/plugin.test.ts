import assert from "node:assert/strict";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Deferred, Effect, Exit } from "effect";
import { PluginCallError } from "../src/plugin-dispatch.ts";
import { spawnPluginHost } from "../src/plugin.ts";

const script = `#!${process.execPath}
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({ input:process.stdin }).on('line', line => {
 const req = JSON.parse(line);
 if(req.method==='activate') {
  send({event:'plugin.call',params:{callId:1,method:'pages.list',params:{}}});
  send({id:req.id,result:{active:true}});
 } else if(req.method==='resolve') {
  send({id:req.id,result:{resolved:true}});
  if(req.params.callId===1) send({event:'plugin.call',params:{callId:2,method:'seen',params:req.params}});
 } else send({id:req.id,result:{accepted:true}});
});
`;
test("isolated transport resolves nested calls without blocking replies and disallows revision reuse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-transport-"));
  const executable = join(dir, "fixture.cjs");
  await writeFile(executable, script);
  await chmod(executable, 0o700);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Deferred.make<unknown>();
        const host = yield* spawnPluginHost({
          executable,
          call: (method, params) => {
            if (method === "pages.list") return Effect.succeed([{ id: "one" }]);
            if (method === "seen")
              return Deferred.succeed(seen, params).pipe(Effect.as({ accepted: true }));
            return Effect.fail("denied");
          },
        });
        yield* host.activate("compiled");
        assert.deepEqual(yield* Deferred.await(seen).pipe(Effect.timeout(3000)), {
          callId: 1,
          result: [{ id: "one" }],
        });
        assert(Exit.isFailure(yield* Effect.exit(host.activate("replacement"))));
        yield* host.stop;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isolated transport sanitizes capability denials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-deny-"));
  const executable = join(dir, "fixture.cjs");
  await writeFile(executable, script);
  await chmod(executable, 0o700);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Deferred.make<unknown>();
        const host = yield* spawnPluginHost({
          executable,
          call: (method, params) =>
            method === "seen"
              ? Deferred.succeed(seen, params).pipe(Effect.as(null))
              : Effect.fail("private credential contents"),
        });
        yield* host.activate("compiled");
        const reply = JSON.stringify(yield* Deferred.await(seen).pipe(Effect.timeout(3000)));
        assert(reply.includes('"code":"denied"'));
        assert(!reply.includes("private credential"));
        yield* host.stop;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isolated transport preserves only safe public call errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-public-error-"));
  const executable = join(dir, "fixture.cjs");
  await writeFile(executable, script);
  await chmod(executable, 0o700);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Deferred.make<unknown>();
        const host = yield* spawnPluginHost({
          executable,
          call: (method, params) =>
            method === "seen"
              ? Deferred.succeed(seen, params).pipe(Effect.as(null))
              : Effect.fail(
                  new PluginCallError({
                    code: "conflict",
                    message: "Plugin storage revision changed",
                  }),
                ),
        });
        yield* host.activate("compiled");
        assert.deepEqual(yield* Deferred.await(seen).pipe(Effect.timeout(3000)), {
          callId: 1,
          error: { code: "conflict", message: "Plugin storage revision changed" },
        });
        yield* host.stop;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [code, message] of [
  ["not_authorized", "DOM access is not authorized for this page."],
  ["stale_ref", "The DOM reference is stale; take a new snapshot."],
] as const)
  test(`isolated transport preserves the safe ${code} DOM error`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-dom-error-"));
    const executable = join(dir, "fixture.cjs");
    await writeFile(executable, script);
    await chmod(executable, 0o700);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const seen = yield* Deferred.make<unknown>();
          const host = yield* spawnPluginHost({
            executable,
            call: (method, params) =>
              method === "seen"
                ? Deferred.succeed(seen, params).pipe(Effect.as(null))
                : Effect.fail(new PluginCallError({ code, message: "untrusted DOM detail" })),
          });
          yield* host.activate("compiled");
          assert.deepEqual(yield* Deferred.await(seen).pipe(Effect.timeout(3000)), {
            callId: 1,
            error: { code, message },
          });
          yield* host.stop;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test("isolated transport rejects untrusted objects that imitate DOM errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-dom-imposter-"));
  const executable = join(dir, "fixture.cjs");
  await writeFile(executable, script);
  await chmod(executable, 0o700);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Deferred.make<unknown>();
        const host = yield* spawnPluginHost({
          executable,
          call: (method, params) =>
            method === "seen"
              ? Deferred.succeed(seen, params).pipe(Effect.as(null))
              : Effect.fail({ code: "stale_ref", message: "untrusted DOM detail" }),
        });
        yield* host.activate("compiled");
        assert.deepEqual(yield* Deferred.await(seen).pipe(Effect.timeout(3000)), {
          callId: 1,
          error: { code: "denied", message: "Operation was denied or could not complete" },
        });
        yield* host.stop;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const event of ["plugin.resource", "plugin.crash"] as const)
  test(`isolated transport remembers ${event} during activation while the broker stays alive`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-terminal-"));
    const executable = join(dir, "fixture.cjs");
    await writeFile(
      executable,
      `#!${process.execPath}
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'activate')
    process.stdout.write(JSON.stringify({ event: ${JSON.stringify(event)}, params: {} }) + '\\n');
});
`,
      { mode: 0o700 },
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const host = yield* spawnPluginHost({ executable, call: () => Effect.die("not used") });
          const failure = yield* host.activate("compiled").pipe(Effect.flip, Effect.timeout(2000));
          assert.equal(failure.code, event === "plugin.resource" ? "resource" : "crash");
          // No event subscription was needed; late lifecycle consumers see the same terminal cause.
          assert.equal(yield* host.failure.pipe(Effect.flip, Effect.timeout(100)), failure);
          assert.equal(yield* host.sendEvent("ui.event", {}).pipe(Effect.flip), failure);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

for (const stalled of ["startup", "resolve"] as const)
  test(`activation timeout identifies a stalled ${stalled} without exposing plugin payloads`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-timeout-"));
    const executable = join(dir, "fixture.cjs");
    await writeFile(
      executable,
      `#!${process.execPath}
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'activate' && ${JSON.stringify(stalled)} === 'resolve') {
    send({ event: 'plugin.started', params: {} });
    send({ event: 'plugin.call', params: {
      callId: 1, method: 'private-plugin-method', params: { secret: 'private-payload' }
    } });
  }
});
`,
      { mode: 0o700 },
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const host = yield* spawnPluginHost({
            executable,
            call: () => Effect.succeed({ secret: "private-result" }),
          });
          const failure = yield* host.activate("private-code").pipe(Effect.flip);
          assert.equal(failure.code, "timeout");
          assert.match(failure.message, /did not reply to activate/);
          assert(
            failure.message.includes(
              stalled === "startup"
                ? "worker=unconfirmed, calls=0/0, phase=idle"
                : "worker=started, calls=1/0, phase=resolve",
            ),
            failure.message,
          );
          assert(!failure.message.includes("private-"));
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
