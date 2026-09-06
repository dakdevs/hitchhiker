import assert from "node:assert/strict";
import test from "node:test";
import {
  EngineConnection,
  EngineError,
  type EngineEvent,
  type JsonObject,
  type ScopedDomDriver,
} from "@hitchhiker/runtime";
import { Deferred, Effect, Fiber, Layer, PubSub, Stream, type Scope } from "effect";
import { makeBrowserDomDriver } from "../src/dom.ts";

interface FakeOptions {
  readonly origin?: string;
  readonly nodes?: readonly JsonObject[];
  readonly accessibilityEnable?: {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
    readonly fail?: true;
  };
}

const withDriver = <A>(
  options: FakeOptions,
  use: (input: {
    readonly driver: ScopedDomDriver;
    readonly calls: string[];
    readonly setLoader: (loader: string) => void;
    readonly emit: (event: EngineEvent) => Effect.Effect<boolean>;
  }) => Effect.Effect<A, unknown, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<EngineEvent>();
      const calls: string[] = [];
      const markers = new Map<string, string>();
      let loaderId = "loader-one";
      let contextId = 40;
      const origin = options.origin ?? "https://allowed.test";
      const nodes = options.nodes ?? [
        {
          nodeId: "root",
          role: { value: "rootwebarea" },
          name: { value: "Fixture" },
          backendDOMNodeId: 1,
          frameId: "top",
        },
        {
          nodeId: "button",
          parentId: "root",
          role: { value: "button" },
          name: { value: "Save" },
          backendDOMNodeId: 2,
        },
      ];
      const engine = EngineConnection.of({
        pid: 1,
        ready: Effect.succeed({ event: "host.ready", params: {} }),
        exit: Effect.never,
        events: Stream.fromPubSub(events),
        request: (method, raw = {}) => {
          if (method !== "cdp.send")
            return Effect.fail(new EngineError({ code: "method", message: "unexpected method" }));
          const params = raw as Record<string, unknown>;
          const pageId = params.pageId;
          const cdpMethod = params.method;
          if (typeof pageId !== "string" || typeof cdpMethod !== "string")
            return Effect.fail(new EngineError({ code: "params", message: "bad params" }));
          calls.push(cdpMethod);
          if (pageId.startsWith("missing"))
            return Effect.fail(new EngineError({ code: "not-found", message: "no page" }));
          if (cdpMethod === "Page.getFrameTree")
            return Effect.succeed({
              frameTree: {
                frame: { id: "top", loaderId, securityOrigin: origin },
              },
            });
          if (cdpMethod === "Page.createIsolatedWorld") {
            const command = params.params as Record<string, unknown>;
            if (typeof command.worldName !== "string")
              return Effect.fail(new EngineError({ code: "params", message: "bad world" }));
            const id = ++contextId;
            // Publish inside the request, before its reply. A passing test proves the adapter's
            // startImmediately subscription is established at this exact boundary.
            return PubSub.publish(events, {
              event: "cdp.event",
              params: {
                pageId,
                method: "Runtime.executionContextCreated",
                params: {
                  context: {
                    id,
                    uniqueId: `unique-${id}`,
                    name: command.worldName,
                    auxData: { frameId: "top", isDefault: false },
                  },
                },
              },
            }).pipe(Effect.as({ executionContextId: id }));
          }
          if (cdpMethod === "Runtime.evaluate") {
            const command = params.params as Record<string, unknown>;
            const expression = String(command.expression);
            if (expression.startsWith("Object.defineProperty")) {
              const match = /\{ value: ("(?:[^"\\]|\\.)*")/.exec(expression);
              if (!match)
                return Effect.fail(new EngineError({ code: "expression", message: "bad marker" }));
              markers.set(pageId, JSON.parse(match[1]!) as string);
            }
            return Effect.succeed({
              result: { value: { marker: markers.get(pageId), origin } },
            });
          }
          if (cdpMethod === "Accessibility.enable" && options.accessibilityEnable !== undefined)
            return Deferred.succeed(options.accessibilityEnable.started, undefined).pipe(
              Effect.andThen(
                options.accessibilityEnable.fail
                  ? Effect.fail(new EngineError({ code: "cdp", message: "enable failed" }))
                  : Deferred.await(options.accessibilityEnable.release),
              ),
              Effect.as({}),
            );
          if (cdpMethod === "Accessibility.getFullAXTree") return Effect.succeed({ nodes });
          if (cdpMethod === "DOM.describeNode") {
            const command = params.params as Record<string, unknown>;
            const backendNodeId = command.backendNodeId;
            return Effect.succeed({
              node:
                backendNodeId === 2
                  ? { nodeName: "BUTTON", attributes: [] }
                  : { nodeName: "BODY", attributes: [] },
            });
          }
          if (cdpMethod === "DOM.resolveNode")
            return Effect.succeed({ object: { objectId: "object" } });
          if (cdpMethod === "Runtime.callFunctionOn")
            return Effect.succeed({ result: { value: { status: "ok" } } });
          return Effect.succeed({});
        },
        loadUnpacked: () => Effect.die("unused extension load"),
        uninstall: () => Effect.die("unused extension uninstall"),
        claimRawCdp: Effect.die("unused raw CDP claim"),
      });
      const driver = yield* makeBrowserDomDriver({
        protectWrite: () => Effect.sync(() => calls.push("protectWrite")),
      }).pipe(Effect.provide(Layer.succeed(EngineConnection, engine)));
      return yield* use({
        driver,
        calls,
        setLoader: (loader) => (loaderId = loader),
        emit: (event) => PubSub.publish(events, event),
      });
    }),
  );

test("reuses one isolated world per document and authorizes around write protection", async () => {
  await Effect.runPromise(
    withDriver({}, ({ driver, calls, setLoader }) =>
      Effect.gen(function* () {
        const first = yield* driver.capture({
          pageId: "page",
          maxDepth: 8,
          interactiveOnly: false,
          authorize: () => Effect.void,
        });
        yield* driver.capture({
          pageId: "page",
          maxDepth: 8,
          interactiveOnly: false,
          authorize: () => Effect.void,
        });
        assert.equal(calls.filter((call) => call === "Page.createIsolatedWorld").length, 1);
        const writeOrder: string[] = [];
        yield* driver.click(first.document, first.nodes[1]!, () =>
          Effect.sync(() => {
            writeOrder.push("authorize");
            calls.push("authorize");
          }),
        );
        const protectIndex = calls.lastIndexOf("protectWrite");
        const authorizeIndexes = calls.flatMap((call, index) =>
          call === "authorize" ? [index] : [],
        );
        const callIndex = calls.lastIndexOf("Runtime.callFunctionOn");
        assert.equal(authorizeIndexes.length, 2);
        assert.ok(
          authorizeIndexes[0]! < protectIndex &&
            authorizeIndexes[1]! > protectIndex &&
            callIndex > authorizeIndexes[1]!,
        );
        assert.deepEqual(writeOrder, ["authorize", "authorize"]);

        setLoader("loader-two");
        yield* driver.capture({
          pageId: "page",
          maxDepth: 8,
          interactiveOnly: false,
          authorize: () => Effect.void,
        });
        assert.equal(calls.filter((call) => call === "Page.createIsolatedWorld").length, 2);
      }),
    ),
  );
});

test("fails before AX capture for non-HTTP origins and cleans transient missing-page locks", async () => {
  await Effect.runPromise(
    withDriver({ origin: "file://" }, ({ driver, calls }) =>
      Effect.gen(function* () {
        for (let index = 0; index < 300; index++)
          yield* driver
            .capture({
              pageId: `missing-${index}`,
              maxDepth: 8,
              interactiveOnly: false,
              authorize: () => Effect.void,
            })
            .pipe(Effect.flip);
        const denied = yield* driver
          .capture({
            pageId: "page",
            maxDepth: 8,
            interactiveOnly: false,
            authorize: () => Effect.void,
          })
          .pipe(Effect.flip);
        assert.equal(denied.code, "unsupported");
        assert.equal(calls.includes("Accessibility.getFullAXTree"), false);
      }),
    ),
  );
});

test("fails closed before describing or emitting a 513th ambiguous text control", async () => {
  const nodes = Array.from({ length: 513 }, (_, index) => ({
    nodeId: `password-${index}`,
    role: { value: "textbox" },
    name: { value: `Password ${index}` },
    value: { value: `secret-${index}` },
    backendDOMNodeId: index + 1,
  }));
  await Effect.runPromise(
    withDriver({ nodes }, ({ driver, calls }) =>
      Effect.gen(function* () {
        const failure = yield* driver
          .capture({
            pageId: "page",
            maxDepth: 8,
            interactiveOnly: false,
            authorize: () => Effect.void,
          })
          .pipe(Effect.flip);
        assert.equal(failure.code, "limit");
        assert.equal(calls.includes("DOM.describeNode"), false);
      }),
    ),
  );
});

test("disables accessibility when capture is interrupted as enable completes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* withDriver({ accessibilityEnable: { started, release } }, ({ driver, calls }) =>
          Effect.gen(function* () {
            const capture = yield* driver
              .capture({
                pageId: "page",
                maxDepth: 8,
                interactiveOnly: false,
                authorize: () => Effect.void,
              })
              .pipe(Effect.forkDetach);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(capture);
            yield* Deferred.succeed(release, undefined);
            assert.ok(
              calls.indexOf("Accessibility.disable") > calls.indexOf("Accessibility.enable"),
            );
            assert.equal(calls.includes("Accessibility.getFullAXTree"), false);
          }),
        );
      }),
    ),
  );
});

test("disables accessibility when enable fails after dispatch", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* withDriver(
          { accessibilityEnable: { started, release, fail: true } },
          ({ driver, calls }) =>
            Effect.gen(function* () {
              yield* driver
                .capture({
                  pageId: "page",
                  maxDepth: 8,
                  interactiveOnly: false,
                  authorize: () => Effect.void,
                })
                .pipe(Effect.flip);
              yield* Deferred.await(started);
              assert.ok(
                calls.indexOf("Accessibility.disable") > calls.indexOf("Accessibility.enable"),
              );
              assert.equal(calls.includes("Accessibility.getFullAXTree"), false);
            }),
        );
      }),
    ),
  );
});

for (const event of ["pages.browserUnavailable", "pages.replaced"]) {
  test(`${event} retires cached documents without context-destruction events`, async () => {
    await Effect.runPromise(
      withDriver({}, ({ driver, calls, emit }) =>
        Effect.gen(function* () {
          const capture = yield* driver.capture({
            pageId: "page",
            maxDepth: 8,
            interactiveOnly: false,
            authorize: () => Effect.void,
          });
          const invalidated = yield* driver.invalidations.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* emit({
            event,
            params: {
              pageId: "page",
              generation: event === "pages.replaced" ? 2 : 1,
              previousGeneration: 1,
            },
          });
          assert.deepEqual(yield* Fiber.join(invalidated), ["page"]);
          yield* Effect.yieldNow;
          // The fixture deliberately retains every Chromium document/context/marker ID.
          // The native replacement event alone must invalidate the old handle.
          const before = calls.length;
          const stale = yield* driver
            .click(capture.document, capture.nodes[1]!, () => Effect.void)
            .pipe(Effect.flip);
          assert.equal(stale.code, "stale_ref");
          assert.equal(calls.slice(before).includes("Runtime.callFunctionOn"), false);
          yield* driver.capture({
            pageId: "page",
            maxDepth: 8,
            interactiveOnly: false,
            authorize: () => Effect.void,
          });
          assert.equal(calls.filter((call) => call === "Page.createIsolatedWorld").length, 2);
        }),
      ),
    );
  });
}
