import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, Layer, Schedule, Schema, Scope, Stream } from "effect";
import {
  DevToolsStatusSchema,
  EngineConnection,
  NativeSurface,
  createGrantStore,
  createPluginDispatcher,
} from "@hitchhiker/runtime";
import { makeBrowserController } from "../src/controller.ts";
import { browserMcpApi } from "../src/mcp.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const status = Schema.decodeUnknownEffect(DevToolsStatusSchema);
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
const until = <A>(effect: Effect.Effect<A, unknown>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(predicate, () => new Error("Native fixture state is not ready")),
    Effect.retry({ times: 160, schedule: Schedule.spaced(25) }),
  );

test(
  "public DevTools controls retain the document, enforce ownership/revocation and drain bounded windows",
  { skip: !binary, timeout: 60_000 },
  async (context) => {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-native-devtools-")));
    const server = createServer((_request, response) =>
      response.end(
        "<!doctype html><title>DevTools target</title><input value='retained'><p>Inspect me</p>",
      ),
    );
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}/`;
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
            const grants = yield* createGrantStore({
              directory: join(profile, "hitchhiker-grants"),
            });
            const changes: Schema.Json[] = [];
            yield* engine.events.pipe(
              Stream.filter((event) => event.event === "devtools.changed"),
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  changes.push(event.params);
                }),
              ),
              Effect.forkScoped,
            );
            const createCaller = Effect.fn("test.createDevToolsCaller")(function* (
              principal: string,
              scope: Scope.Scope,
            ) {
              const grant = yield* grants.issue({
                principal,
                profileId: "default",
                capabilities: ["devtools.manage"],
                origins: [],
              });
              const api = yield* controller.devtools
                .forOwner(
                  grants
                    .authorize(grant.token, { profileId: "default", capability: "devtools.manage" })
                    .pipe(Effect.asVoid),
                )
                .pipe(Effect.provideService(Scope.Scope, scope));
              const dispatch = createPluginDispatcher({
                manifest: {
                  id: principal,
                  name: "DevTools fixture",
                  version: "1.0.0",
                  capabilities: ["devtools.manage"],
                },
                profileId: "default",
                token: grant.token,
                grants,
                browser: browserMcpApi(controller),
                devtools: api,
                publish: () => Effect.die("No UI publication in fixture"),
                release: Effect.void,
              });
              return {
                grant,
                dispatch,
                call: (method: string, params: Schema.Json) =>
                  dispatch(method, params).pipe(Effect.flatMap(status)),
              };
            });
            const firstScope = yield* Scope.make();
            const secondScope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
            yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
            const first = yield* createCaller("first-inspector", firstScope);
            const second = yield* createCaller("second-inspector", secondScope);
            const pageId = yield* controller.openPage(url);
            const evaluate = (expression: string) =>
              engine
                .request("cdp.send", {
                  pageId,
                  method: "Runtime.evaluate",
                  params: { expression, returnByValue: true },
                })
                .pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Value)),
                  Effect.map((result) => result.result.value),
                );
            yield* until(evaluate("document.title"), (title) => title === "DevTools target");
            yield* evaluate("globalThis.fixtureMarker='same-document'");
            const initial = yield* first.call("devtools.status", { pageId });
            assert.equal(initial.state, "closed");
            assert.equal(
              (yield* Effect.exit(
                first.dispatch("devtools.show", { pageId, inspectAt: { x: -1, y: 0 } }),
              ))._tag,
              "Failure",
            );
            yield* first.call("devtools.show", { pageId, inspectAt: { x: 12, y: 24 } });
            const opened = yield* until(
              first.call("devtools.status", { pageId }),
              (value) => value.state === "open",
            );
            assert.equal(opened.instance, initial.instance + 1);
            const focused = yield* second.call("devtools.show", { pageId });
            assert.equal(focused.instance, opened.instance);
            yield* Scope.close(firstScope, Exit.void);
            assert.equal((yield* second.call("devtools.status", { pageId })).state, "open");
            const mismatchedLease = yield* engine
              .request("devtools.close", {
                pageId,
                expectedGeneration: opened.generation,
                expectedInstance: opened.instance,
                expectedLeaseId: crypto.randomUUID(),
              })
              .pipe(Effect.match({ onSuccess: () => undefined, onFailure: (error) => error.code }));
            assert.equal(
              mismatchedLease,
              "-32005",
              "well-formed foreign ownership must fail identity matching",
            );
            assert.equal((yield* second.call("devtools.status", { pageId })).state, "open");
            yield* grants.revoke(second.grant.grant.id);
            yield* until(
              engine.request("devtools.status", { pageId }).pipe(Effect.flatMap(status)),
              (value) => value.state === "closed",
            );
            assert.equal(
              (yield* Effect.exit(second.call("devtools.show", { pageId })))._tag,
              "Failure",
            );
            assert.equal(yield* evaluate("globalThis.fixtureMarker"), "same-document");
            const finalScope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(finalScope, Exit.void));
            const final = yield* createCaller("final-inspector", finalScope);
            yield* final.call("devtools.show", { pageId });
            const reopened = yield* until(
              final.call("devtools.status", { pageId }),
              (value) => value.state === "open",
            );
            assert.ok(reopened.instance > opened.instance);
            yield* final.call("devtools.close", { pageId });
            yield* until(
              final.call("devtools.status", { pageId }),
              (value) => value.state === "closed",
            );
            yield* final.call("devtools.show", { pageId });
            yield* controller.closePage(pageId);
            yield* until(controller.snapshot, (snapshot) =>
              snapshot.pages.every((page) => page.id !== pageId || page.lifecycle === "closed"),
            );
            assert.equal(
              (yield* Effect.exit(final.call("devtools.status", { pageId })))._tag,
              "Failure",
            );
            assert.ok(
              changes.some(
                (change) =>
                  Schema.decodeUnknownSync(DevToolsStatusSchema)(change).state === "closed",
              ),
            );
            const targets: string[] = [];
            for (let index = 0; index < 5; index++) {
              const id = yield* controller.openPage(url);
              targets.push(id);
              yield* until(
                engine.request("devtools.status", { pageId: id }).pipe(Effect.flatMap(status)),
                () => true,
              );
            }
            for (const id of targets.slice(0, 4))
              yield* final.call("devtools.show", { pageId: id });
            assert.equal(
              (yield* Effect.exit(final.call("devtools.show", { pageId: targets[4]! })))._tag,
              "Failure",
            );
            assert.equal(
              (yield* controller.snapshot).pages.filter((page) => page.lifecycle !== "closed")
                .length,
              5,
              "inspector browsers are not ordinary pages",
            );
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
