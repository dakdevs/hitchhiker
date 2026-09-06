import assert from "node:assert/strict";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Deferred, Effect, Exit } from "effect";
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
