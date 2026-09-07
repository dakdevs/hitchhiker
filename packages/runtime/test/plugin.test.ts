import assert from "node:assert/strict";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Deferred, Effect, Exit, Fiber, Stream, Schema, type Scope } from "effect";
import { PluginCallError } from "../src/plugin-dispatch.ts";
import { spawnPluginHost, WorkerIdentitySchema, WorkerUsageSchema } from "../src/plugin.ts";

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
type DiagnosticHost = Effect.Success<ReturnType<typeof spawnPluginHost>>;
const withDiagnostics = async (
  sampleBody: string,
  use: (host: DiagnosticHost) => Effect.Effect<void, unknown, Scope.Scope>,
  announce = true,
  call: Parameters<typeof spawnPluginHost>[0]["call"] = () => Effect.die("unused"),
) => {
  const dir = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-diagnostics-"));
  const executable = join(dir, "fixture.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}
const readline=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const identity={pid:123,generation:7,startAbstime:'42'};
let count=0;let stops=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);
 if(q.method==='activate'){${announce ? "send({hostControl:{event:'worker.started',identity}});" : ""}send({id:q.id,result:null});}
 else if(q.method==='stop'){if(++stops>1){send({id:q.id,error:{code:"duplicate_stop",message:"duplicate stop"}});return;}${announce ? "send({hostControl:{event:'worker.stopped',identity}});" : ""}send({id:q.id,result:null});}
 else if(q.hostControl){count++;const reply=()=>send({hostControl:{id:q.hostControl.id,result:{identity,physicalFootprintBytes:10,residentBytes:8}}});${sampleBody}}
});
`,
  );
  await chmod(executable, 0o700);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* spawnPluginHost({ executable, call });
        yield* use(host);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout(8_000)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("diagnostic frames stay private while exact samples and ordinary events remain available", () =>
  withDiagnostics("reply();send({event:'visible',params:{}});", (host) =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const visible = yield* Deferred.make<void>();
      yield* host.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            seen.push(event);
            if (event.event === "visible") yield* Deferred.succeed(visible, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* host.activate("");
      const identity = yield* host.diagnostics.started;
      assert.deepEqual(identity, { pid: 123, generation: 7, startAbstime: "42" });
      assert.deepEqual(yield* host.diagnostics.sample(identity), {
        identity,
        physicalFootprintBytes: 10,
        residentBytes: 8,
      });
      yield* Deferred.await(visible);
      assert.deepEqual(seen, [{ event: "visible", params: {} }]);
      assert.equal(
        (yield* Effect.flip(host.diagnostics.sample({ ...identity, pid: 124 }))).code,
        "stale_worker",
      );
      yield* host.stop;
      yield* host.diagnostics.stopped(identity);
    }),
  ));

test("concurrent graceful stops cancel an in-flight call and await one broker stop", async () => {
  const entered = Effect.runSync(Deferred.make<void>());
  let canceled = false;
  await withDiagnostics(
    "reply();send({event:'plugin.call',params:{callId:1,method:'pending',params:{}}});",
    (host) =>
      Effect.gen(function* () {
        yield* host.activate("");
        const identity = yield* host.diagnostics.started;
        yield* host.diagnostics.sample(identity);
        yield* Deferred.await(entered);
        yield* Effect.all([host.stop, host.stop], { concurrency: 2 });
        assert(canceled, "the in-flight call cannot resolve into the exited worker");
        yield* host.diagnostics.stopped(identity);
        yield* host.stop;
      }),
    true,
    () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            canceled = true;
          }),
        ),
      ),
  );
});

for (const [name, body] of [
  ["duplicate start", "send({hostControl:{event:'worker.started',identity}});"],
  [
    "mismatched stop",
    "send({hostControl:{event:'worker.stopped',identity:{...identity,pid:124}}});",
  ],
  [
    "start after stop",
    "send({hostControl:{event:'worker.stopped',identity}});send({hostControl:{event:'worker.started',identity}});",
  ],
] as const)
  test(`diagnostics reject ${name} as protocol failure`, () =>
    withDiagnostics(body, (host) =>
      Effect.gen(function* () {
        yield* host.activate("");
        const identity = yield* host.diagnostics.started;
        assert.equal((yield* Effect.flip(host.diagnostics.sample(identity))).code, "protocol");
        assert.equal((yield* Effect.flip(host.failure)).code, "protocol");
      }),
    ));

test("canceling one stop observer leaves another subscribed to the exact stop", () =>
  withDiagnostics("reply();send({hostControl:{event:'worker.stopped',identity}});", (host) =>
    Effect.gen(function* () {
      yield* host.activate("");
      const identity = yield* host.diagnostics.started;
      const first = yield* host.diagnostics.stopped(identity).pipe(Effect.forkScoped);
      const second = yield* host.diagnostics.stopped(identity).pipe(Effect.forkScoped);
      yield* Effect.sleep(10);
      yield* Fiber.interrupt(first);
      // A reply sent just before stop may settle before or after the stop is consumed.
      const sampled = yield* Effect.exit(host.diagnostics.sample(identity));
      if (Exit.isSuccess(sampled)) assert.deepEqual(sampled.value.identity, identity);
      yield* Fiber.join(second).pipe(Effect.timeout(500));
      yield* host.diagnostics.stopped(identity);
      assert.equal((yield* Effect.flip(host.diagnostics.sample(identity))).code, "stale_worker");
    }),
  ));

test("mismatched and late sample replies cannot change worker attribution", () =>
  withDiagnostics(
    "if(count===1)send({hostControl:{id:q.hostControl.id,result:{identity:{...identity,pid:124},physicalFootprintBytes:1,residentBytes:1}}});else reply();",
    (host) =>
      Effect.gen(function* () {
        yield* host.activate("");
        const identity = yield* host.diagnostics.started;
        assert.equal((yield* Effect.flip(host.diagnostics.sample(identity))).code, "stale_worker");
        assert.deepEqual((yield* host.diagnostics.sample(identity)).identity, identity);
      }),
  ));

test("eight pending samples time out, a ninth hits capacity, and late replies leave reclaimed slots usable", () =>
  withDiagnostics(
    "if(count<=8)setTimeout(reply,2250);else reply();send({event:'received',params:{count}});",
    (host) =>
      Effect.gen(function* () {
        const eight = yield* Deferred.make<void>();
        yield* host.events.pipe(
          Stream.runForEach((event) =>
            event.event === "received" && event.params.count === 8
              ? Deferred.succeed(eight, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* host.activate("");
        const identity = yield* host.diagnostics.started;
        const requests = [];
        for (let index = 0; index < 8; index++)
          requests.push(yield* host.diagnostics.sample(identity).pipe(Effect.forkScoped));
        yield* Deferred.await(eight);
        assert.equal((yield* Effect.flip(host.diagnostics.sample(identity))).code, "capacity");
        for (const request of requests)
          assert.equal((yield* Effect.flip(Fiber.join(request))).code, "timeout");
        assert.deepEqual((yield* host.diagnostics.sample(identity)).identity, identity);
        yield* Effect.sleep(350);
        assert.deepEqual((yield* host.diagnostics.sample(identity)).identity, identity);
      }),
  ));

test("diagnostic wire schemas enforce native PID, uint64 start time and safe byte counts", () => {
  const identity = { pid: 123, generation: 7, startAbstime: "18446744073709551615" };
  assert.deepEqual(Schema.decodeUnknownSync(WorkerIdentitySchema)(identity), identity);
  for (const invalid of [
    { ...identity, pid: 2147483648 },
    { ...identity, startAbstime: "18446744073709551616" },
    { ...identity, startAbstime: "0" },
    { ...identity, startAbstime: "01" },
  ])
    assert.throws(() => Schema.decodeUnknownSync(WorkerIdentitySchema)(invalid));
  assert.throws(() =>
    Schema.decodeUnknownSync(WorkerUsageSchema)({
      identity,
      physicalFootprintBytes: Number.MAX_SAFE_INTEGER + 1,
      residentBytes: 0,
    }),
  );
});

test("unavailable diagnostic identity has a deadline without stopping ordinary host commands", () =>
  withDiagnostics(
    "reply();",
    (host) =>
      Effect.gen(function* () {
        yield* host.activate("");
        assert.equal((yield* Effect.flip(host.diagnostics.started)).code, "unavailable");
        yield* host.stop;
      }),
    false,
  ));

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
