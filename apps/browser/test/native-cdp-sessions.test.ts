import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schedule, Schema, Stream } from "effect";
import { EngineConnection, NativeSurface } from "@hitchhiker/runtime";
import { makeBrowserController } from "../src/controller.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const decodeTarget = Schema.decodeUnknownEffect(
  Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String }) }),
);
const decodeSession = Schema.decodeUnknownEffect(Schema.Struct({ sessionId: Schema.String }));
const decodeValue = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) }),
);
const until = <A>(
  effect: Effect.Effect<A, unknown>,
  predicate: (value: A) => boolean,
  description = "CDP fixture state",
) =>
  effect.pipe(
    Effect.filterOrFail(
      predicate,
      (value) => new Error(`${description} is not ready: ${JSON.stringify(value)}`),
    ),
    Effect.retry({ times: 160, schedule: Schedule.spaced(25) }),
  );

test(
  "flattened Chromium sessions isolate subscriptions and detach releases intercepted requests and debugger pauses",
  { skip: !binary, timeout: 60_000 },
  async (context) => {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-native-devtools-")));
    const server = createServer((_request, response) => {
      response.end("<!doctype html><title>CDP sessions</title><input value='retained'>");
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await Effect.runPromise(
        Effect.gen(function* () {
          const lease = yield* acquireProfileWriteLease(profile, binary!);
          yield* Effect.gen(function* () {
            const engine = yield* EngineConnection;
            yield* engine.ready;
            const controller = yield* makeBrowserController(profile, {
              interfaceMode: "plugins",
              profileLease: lease,
              freezeEnabled: false,
            });
            yield* controller.start;
            const pageId = yield* controller.openPage(`http://127.0.0.1:${address.port}/`);
            const host = (method: string, params: Schema.Json = {}) =>
              engine.request("cdp.send", { pageId, method, params });
            const evaluate = (expression: string) =>
              host("Runtime.evaluate", { expression, returnByValue: true }).pipe(
                Effect.flatMap(decodeValue),
                Effect.map((result) => result.result.value),
              );
            yield* until(evaluate("document.title"), (title) => title === "CDP sessions");
            const { targetInfo } = yield* host("Target.getTargetInfo").pipe(
              Effect.flatMap(decodeTarget),
            );
            const raw = yield* engine.claimRawCdp;
            const messages: Record<string, Schema.Json>[] = [];
            const hostEvents: Schema.Json[] = [];
            yield* raw.events.pipe(
              Stream.runForEach((message) =>
                Effect.sync(() => {
                  messages.push(message);
                }),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* engine.events.pipe(
              Stream.filter((event) => event.event === "cdp.event"),
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  hostEvents.push(event.params);
                }),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
            let nextId = 1;
            const command = Effect.fn("session-fixture.command")(function* (
              method: string,
              params: Schema.Json = {},
              sessionId?: string,
            ) {
              const id = nextId++;
              yield* raw.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
              const reply = yield* until(
                Effect.sync(() => messages.find((message) => message.id === id)),
                (message) => message !== undefined,
              );
              assert.ok(reply);
              assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`);
              assert.equal(reply.sessionId, sessionId);
              return reply.result;
            });
            const attach = () =>
              command("Target.attachToTarget", {
                targetId: targetInfo.targetId,
                flatten: true,
              }).pipe(Effect.flatMap(decodeSession));
            const first = yield* attach();
            const second = yield* attach();
            assert.notEqual(first.sessionId, second.sessionId);
            yield* host("Runtime.enable");
            yield* command("Runtime.enable", {}, first.sessionId);
            yield* command("Runtime.enable", {}, second.sessionId);
            const hasMarker = (value: unknown, marker: string) =>
              JSON.stringify(value).includes(marker);
            const assertDelivery = Effect.fn("session-fixture.delivery")(function* (
              marker: string,
              firstEnabled: boolean,
            ) {
              yield* evaluate(`console.log(${JSON.stringify(marker)}); true`);
              yield* until(
                Effect.sync(() =>
                  messages.some(
                    (message) =>
                      message.sessionId === second.sessionId &&
                      message.method === "Runtime.consoleAPICalled" &&
                      hasMarker(message, marker),
                  ),
                ),
                Boolean,
              );
              yield* until(
                Effect.sync(() => hostEvents.some((event) => hasMarker(event, marker))),
                Boolean,
              );
              // A later result on each live session is a protocol ordering barrier.
              yield* command("Runtime.evaluate", { expression: "1" }, first.sessionId);
              assert.equal(
                messages.some(
                  (message) =>
                    message.sessionId === first.sessionId &&
                    message.method === "Runtime.consoleAPICalled" &&
                    hasMarker(message, marker),
                ),
                firstEnabled,
              );
            });
            yield* assertDelivery("both-sessions", true);
            yield* command("Runtime.disable", {}, first.sessionId);
            yield* assertDelivery("second-and-host-only", false);
            yield* command("Target.detachFromTarget", { sessionId: first.sessionId });
            const remaining = yield* command(
              "Runtime.evaluate",
              {
                expression: "document.querySelector('input').value",
                returnByValue: true,
              },
              second.sessionId,
            ).pipe(Effect.flatMap(decodeValue));
            assert.equal(remaining.result.value, "retained");
            assert.equal(yield* evaluate("document.querySelector('input').value"), "retained");
            yield* command(
              "Fetch.enable",
              {
                patterns: [{ urlPattern: "*/held", requestStage: "Request" }],
              },
              second.sessionId,
            );
            yield* evaluate(
              "globalThis.fetchOutcome='waiting'; fetch('/held').then(r=>globalThis.fetchOutcome=r.status).catch(()=>globalThis.fetchOutcome='failed'); true",
            );
            yield* until(
              Effect.sync(() =>
                messages.some(
                  (message) =>
                    message.sessionId === second.sessionId &&
                    message.method === "Fetch.requestPaused",
                ),
              ),
              Boolean,
              "Fetch request pause",
            );
            assert.equal(yield* evaluate("globalThis.fetchOutcome"), "waiting");
            const pausedRequest = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                params: Schema.Struct({
                  requestId: Schema.String,
                  request: Schema.Struct({ url: Schema.String }),
                }),
              }),
            )(
              messages.find(
                (message) =>
                  message.sessionId === second.sessionId &&
                  message.method === "Fetch.requestPaused",
              ),
            );
            assert.equal(pausedRequest.params.request.url, `http://127.0.0.1:${address.port}/held`);
            assert.ok(pausedRequest.params.requestId.length > 0);
            yield* command("Target.detachFromTarget", { sessionId: second.sessionId });
            yield* until(
              evaluate("globalThis.fetchOutcome"),
              (value) => value === 200,
              "Fetch completion after detach",
            );

            const debuggerSession = yield* attach();
            yield* command("Debugger.enable", {}, debuggerSession.sessionId);
            yield* evaluate(
              "globalThis.timerTicks=0; globalThis.fixtureTimer=setInterval(()=>globalThis.timerTicks++,25); true",
            );
            yield* command("Debugger.pause", {}, debuggerSession.sessionId);
            yield* until(
              Effect.sync(() =>
                messages.some(
                  (message) =>
                    message.sessionId === debuggerSession.sessionId &&
                    message.method === "Debugger.paused",
                ),
              ),
              Boolean,
              "Debugger pause",
            );
            yield* command("Target.detachFromTarget", { sessionId: debuggerSession.sessionId });
            const resumedTicks = yield* evaluate("globalThis.timerTicks");
            assert.equal(typeof resumedTicks, "number");
            yield* until(
              evaluate("globalThis.timerTicks"),
              (value) =>
                typeof value === "number" &&
                typeof resumedTicks === "number" &&
                value > resumedTicks,
              "Timer execution after debugger detach",
            );
            yield* evaluate("clearInterval(globalThis.fixtureTimer); true");
            assert.equal(yield* evaluate("6 * 7"), 42);
            assert.equal(yield* evaluate("document.title"), "CDP sessions");
            assert.equal(yield* controller.lastError, undefined);
            yield* engine.request("window.close");
            assert.equal(yield* engine.exit.pipe(Effect.timeout(10_000)), 0);
          }).pipe(
            Effect.scoped,
            Effect.provide(
              Layer.provideMerge(
                NativeSurface.layer,
                EngineConnection.layer({
                  executable: binary!,
                  profileRoot: lease.profileRoot,
                  extensionManagement: false,
                }),
              ),
            ),
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        { signal: context.signal },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);
