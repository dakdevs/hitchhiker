import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { EngineConnection, EngineError, type JsonObject } from "@hitchhiker/runtime";
import { Cause, Effect, Exit, Fiber, Schedule, Stream } from "effect";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;

type RecordValue = Record<string, unknown>;

const record = (value: unknown, description: string): RecordValue => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), description);
  return value as RecordValue;
};

const stringField = (value: unknown, name: string): string => {
  const field = record(value, `expected object containing ${name}`)[name];
  if (typeof field !== "string") throw new Error(`expected string ${name}`);
  return field;
};

const numberField = (value: unknown, name: string): number => {
  const field = record(value, `expected object containing ${name}`)[name];
  if (typeof field !== "number") throw new Error(`expected number ${name}`);
  return field;
};

const arrayField = (value: unknown, name: string): readonly unknown[] => {
  const field = record(value, `expected object containing ${name}`)[name];
  assert.ok(Array.isArray(field), `expected array ${name}`);
  return field;
};

const startServer = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );

test(
  "pins isolated-world DOM identity to one native page and document",
  { skip: !binary || !isAbsolute(binary), timeout: 60_000 },
  async (context) => {
    if (!binary || !isAbsolute(binary)) return;

    let crossOrigin = "";
    const crossServer = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Cross frame</title><button>Cross secret</button>");
    });
    const mainServer = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.url === "/new") {
        response.end(
          "<!doctype html><title>Replacement document</title><button id='target'>Replacement target</button><script>globalThis.fixtureReady=true;globalThis.newTouched=0</script>",
        );
        return;
      }
      if (request.url === "/child") {
        response.end("<!doctype html><title>Same frame</title><button>Same-frame secret</button>");
        return;
      }
      if (request.url === "/second") {
        response.end(
          "<!doctype html><title>Second stable page</title><script>globalThis.fixtureReady=true;globalThis.secondTouched=0</script>",
        );
        return;
      }
      response.end(`<!doctype html>
        <title>Original document</title>
        <button id="target">Isolated target</button>
        <label>Probe input <input id="input" value="original"></label>
        <script>globalThis.loadedFrames = 0; globalThis.fixtureReady = false;</script>
        <iframe src="/child" onload="globalThis.loadedFrames++"></iframe>
        <iframe src="${crossOrigin}/child" onload="globalThis.loadedFrames++"></iframe>
        <script>
          globalThis.realClicks = 0;
          globalThis.hostileClickCalls = 0;
          globalThis.hostileSetterCalls = 0;
          document.querySelector('#target').addEventListener('click', () => globalThis.realClicks++);
          Object.defineProperty(HTMLElement.prototype, 'click', {
            configurable: true,
            value() { globalThis.hostileClickCalls++; throw new Error('HOSTILE click override'); }
          });
          const originalValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          Object.defineProperty(HTMLInputElement.prototype, 'value', {
            configurable: true,
            get: originalValue.get,
            set(value) { globalThis.hostileSetterCalls++; return originalValue.set.call(this, value); }
          });
          Object.defineProperty(Document.prototype, 'elementFromPoint', {
            configurable: true,
            value() { throw new Error('HOSTILE hit-test override'); }
          });
          window.addEventListener('load', () => {
            globalThis.fixtureReady = document.readyState === 'complete' && globalThis.loadedFrames === 2;
          }, { once: true });
        </script>`);
    });

    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-native-dom-"));
    try {
      crossOrigin = await startServer(crossServer);
      const mainOrigin = await startServer(mainServer);
      const requestedProfile = join(directory, "profile");
      await mkdir(requestedProfile, { recursive: true, mode: 0o700 });
      const profile = await realpath(requestedProfile);

      const evidence = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* EngineConnection;
            yield* engine.ready;

            const cdp = (pageId: string, method: string, params: JsonObject = {}) =>
              engine.request("cdp.send", { pageId, method, params });
            const evaluate = Effect.fn("native-dom.evaluate")(function* (
              pageId: string,
              expression: string,
              uniqueContextId?: string,
            ) {
              const raw = yield* cdp(pageId, "Runtime.evaluate", {
                expression,
                returnByValue: true,
                ...(uniqueContextId === undefined ? {} : { uniqueContextId }),
              });
              const result = record(
                record(raw, "Runtime.evaluate response").result,
                "remote object",
              );
              return result.value;
            });
            const waitForReady = (pageId: string) =>
              Effect.gen(function* () {
                if (
                  (yield* evaluate(
                    pageId,
                    "globalThis.fixtureReady === true && document.readyState === 'complete'",
                  )) !== true
                )
                  return yield* new EngineError({ code: "waiting", message: "fixture not ready" });
              }).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced(50) }));
            const cdpEvent = (
              pageId: string,
              method: string,
              predicate: (params: RecordValue) => boolean,
            ) =>
              engine.events.pipe(
                Stream.filter(
                  (event) =>
                    event.event === "cdp.event" &&
                    event.params.pageId === pageId &&
                    event.params.method === method,
                ),
                Stream.map((event) => record(event.params.params, `${method} params`)),
                Stream.filter(predicate),
                Stream.take(1),
                Stream.runHead,
                Effect.flatMap((value) =>
                  value._tag === "Some"
                    ? Effect.succeed(value.value)
                    : Effect.fail(
                        new EngineError({ code: "event", message: `missing ${method} event` }),
                      ),
                ),
                Effect.timeoutOrElse({
                  duration: 5_000,
                  orElse: () =>
                    Effect.fail(
                      new EngineError({
                        code: "event",
                        message: `timed out waiting for ${method}`,
                      }),
                    ),
                }),
              );

            const originalUrl = `${mainOrigin}/one`;
            yield* engine.request("pages.open", { id: "dom-first", url: originalUrl });
            yield* engine.request("pages.open", { id: "dom-second", url: `${mainOrigin}/second` });
            yield* waitForReady("dom-first");
            yield* waitForReady("dom-second");
            assert.equal(yield* evaluate("dom-first", "globalThis.loadedFrames"), 2);
            yield* engine.request("viewports.set", {
              viewports: [{ pageId: "dom-first", x: 0, y: 0, width: 800, height: 600 }],
            });

            yield* cdp("dom-first", "Page.enable");
            yield* cdp("dom-first", "DOM.enable");
            const frameTreeReply = record(
              yield* cdp("dom-first", "Page.getFrameTree"),
              "Page.getFrameTree response",
            );
            // cdp.send returns the protocol method's result directly, without a caller-visible CDP id.
            assert.ok("frameTree" in frameTreeReply);
            assert.equal("id" in frameTreeReply, false);
            const frameTree = record(frameTreeReply.frameTree, "frame tree");
            const topFrame = record(frameTree.frame, "top frame");
            const frameId = stringField(topFrame, "id");
            const loaderId = stringField(topFrame, "loaderId");
            const securityOrigin = stringField(topFrame, "securityOrigin");
            assert.equal(securityOrigin, mainOrigin);

            // Subscribe before Runtime.enable. Runtime must then replay the top frame's existing
            // default context rather than whichever child-frame context happens to arrive first.
            const defaultContext = yield* cdpEvent(
              "dom-first",
              "Runtime.executionContextCreated",
              (params) => {
                const contextValue = params.context;
                if (contextValue === null || typeof contextValue !== "object") return false;
                const aux = (contextValue as RecordValue).auxData;
                return (
                  aux !== null &&
                  typeof aux === "object" &&
                  (aux as RecordValue).isDefault === true &&
                  (aux as RecordValue).frameId === frameId
                );
              },
            ).pipe(Effect.forkScoped);
            yield* Effect.yieldNow;
            yield* cdp("dom-first", "Runtime.enable");
            const replayedDefault = record(
              (yield* Fiber.join(defaultContext)).context,
              "default execution context",
            );
            assert.equal(
              record(replayedDefault.auxData, "default context auxData").frameId,
              frameId,
            );

            const worldName = `hitchhiker-native-dom-${crypto.randomUUID()}`;
            const isolatedEventFiber = yield* cdpEvent(
              "dom-first",
              "Runtime.executionContextCreated",
              (params) => {
                const value = params.context;
                return (
                  value !== null &&
                  typeof value === "object" &&
                  (value as RecordValue).name === worldName &&
                  record((value as RecordValue).auxData, "isolated auxData").frameId === frameId
                );
              },
            ).pipe(Effect.forkScoped);
            yield* Effect.yieldNow;
            const created = record(
              yield* cdp("dom-first", "Page.createIsolatedWorld", {
                frameId,
                worldName,
                grantUniveralAccess: false,
              }),
              "Page.createIsolatedWorld response",
            );
            const executionContextId = numberField(created, "executionContextId");
            const isolatedEvent = record(
              (yield* Fiber.join(isolatedEventFiber)).context,
              "isolated execution context",
            );
            assert.equal(numberField(isolatedEvent, "id"), executionContextId);
            assert.equal(isolatedEvent.name, worldName);
            assert.equal(record(isolatedEvent.auxData, "isolated auxData").frameId, frameId);
            assert.equal(record(isolatedEvent.auxData, "isolated auxData").isDefault, false);
            const uniqueContextId = stringField(isolatedEvent, "uniqueId");
            assert.ok(uniqueContextId.length > 0);

            const markerName = `__hitchhiker_${crypto.randomUUID().replaceAll("-", "")}`;
            const markerValue = crypto.randomUUID();
            const markerExpression = `Object.defineProperty(globalThis, ${JSON.stringify(markerName)}, { value: ${JSON.stringify(markerValue)}, configurable: false }); ({ origin: location.origin, href: location.href })`;
            const markerResult = record(
              yield* evaluate("dom-first", markerExpression, uniqueContextId),
              "isolated marker result",
            );
            assert.equal(markerResult.origin, securityOrigin);
            assert.equal(markerResult.href, originalUrl);
            assert.equal(
              yield* evaluate(
                "dom-first",
                `Object.hasOwn(globalThis, ${JSON.stringify(markerName)})`,
              ),
              false,
              "the main world cannot enumerate the isolated-world document marker",
            );

            yield* cdp("dom-first", "Accessibility.enable");
            const axReply = record(
              yield* cdp("dom-first", "Accessibility.getFullAXTree", {
                frameId,
                depth: 8,
              }),
              "Accessibility.getFullAXTree response",
            );
            const axNodes = arrayField(axReply, "nodes").map((node) => record(node, "AX node"));
            yield* cdp("dom-first", "Accessibility.disable");
            const axText = (node: RecordValue, field: string): string | undefined => {
              const value = node[field];
              if (value === null || typeof value !== "object" || Array.isArray(value)) return;
              const text = (value as RecordValue).value;
              return typeof text === "string" ? text : undefined;
            };
            const axNames = axNodes.flatMap((node) => {
              const name = axText(node, "name");
              return name === undefined ? [] : [name];
            });
            assert.equal(axNames.includes("Same-frame secret"), false);
            assert.equal(axNames.includes("Cross secret"), false);
            const targetAx = axNodes.find(
              (node) =>
                axText(node, "name") === "Isolated target" && axText(node, "role") === "button",
            );
            const inputAx = axNodes.find((node) => axText(node, "role") === "textbox");
            assert.ok(targetAx, "AX tree should contain the top-frame button");
            assert.ok(inputAx, "AX tree should contain the top-frame text input");
            const targetBackendNodeId = numberField(targetAx, "backendDOMNodeId");
            const inputBackendNodeId = numberField(inputAx, "backendDOMNodeId");
            const explicitAxFrameIds = [
              ...new Set(
                axNodes.flatMap((node) => (typeof node.frameId === "string" ? [node.frameId] : [])),
              ),
            ];
            assert.deepEqual(explicitAxFrameIds, [frameId]);

            const objectGroup = `hitchhiker-native-dom-${crypto.randomUUID()}`;
            const resolveNode = Effect.fn("native-dom.resolveNode")(function* (
              backendNodeId: number,
            ) {
              const raw = record(
                yield* cdp("dom-first", "DOM.resolveNode", {
                  backendNodeId,
                  executionContextId,
                  objectGroup,
                }),
                "DOM.resolveNode response",
              );
              return stringField(record(raw.object, "resolved object"), "objectId");
            });
            const targetObjectId = yield* resolveNode(targetBackendNodeId);
            const inputObjectId = yield* resolveNode(inputBackendNodeId);

            const call = Effect.fn("native-dom.call")(function* (
              objectId: string,
              functionDeclaration: string,
              args: readonly string[] = [],
            ) {
              const raw = record(
                yield* cdp("dom-first", "Runtime.callFunctionOn", {
                  objectId,
                  functionDeclaration,
                  arguments: args.map((value): JsonObject => ({ value })),
                  returnByValue: true,
                  userGesture: true,
                }),
                "Runtime.callFunctionOn response",
              );
              assert.equal(raw.exceptionDetails, undefined, JSON.stringify(raw.exceptionDetails));
              return record(raw.result, "call result").value;
            });

            const clickResult = record(
              yield* call(
                targetObjectId,
                `function(markerName, markerValue) {
                  if (globalThis[markerName] !== markerValue || this.ownerDocument !== document || !this.isConnected) return { status: 'stale' };
                  const rect = Reflect.apply(Element.prototype.getBoundingClientRect, this, []);
                  const x = rect.left + rect.width / 2;
                  const y = rect.top + rect.height / 2;
                  const hit = Reflect.apply(Document.prototype.elementFromPoint, document, [x, y]);
                  if (hit !== this && !Reflect.apply(Node.prototype.contains, this, [hit])) return { status: 'covered', hitId: hit && hit.id, hitTag: hit && hit.tagName, targetId: this.id, rect: { x, y, width: rect.width, height: rect.height } };
                  Reflect.apply(HTMLElement.prototype.click, this, []);
                  return { status: 'clicked', hitId: hit.id };
                }`,
                [markerName, markerValue],
              ),
              "isolated click result",
            );
            assert.deepEqual(clickResult, { status: "clicked", hitId: "target" });

            const fillResult = yield* call(
              inputObjectId,
              `function(markerName, markerValue, value) {
                if (globalThis[markerName] !== markerValue || this.ownerDocument !== document || !this.isConnected) return 'stale';
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                Reflect.apply(setter, this, [value]);
                Reflect.apply(HTMLElement.prototype.focus, this, []);
                Reflect.apply(EventTarget.prototype.dispatchEvent, this, [new Event('input', { bubbles: true })]);
                Reflect.apply(EventTarget.prototype.dispatchEvent, this, [new Event('change', { bubbles: true })]);
                return 'filled';
              }`,
              [markerName, markerValue, "isolated value"],
            );
            assert.equal(fillResult, "filled");
            assert.deepEqual(
              yield* evaluate(
                "dom-first",
                "({realClicks,hostileClickCalls,hostileSetterCalls,value:document.querySelector('#input').value})",
              ),
              {
                realClicks: 1,
                hostileClickCalls: 0,
                hostileSetterCalls: 0,
                value: "isolated value",
              },
            );
            assert.equal(yield* evaluate("dom-second", "globalThis.secondTouched"), 0);

            yield* engine.request("pages.navigate", {
              id: "dom-first",
              url: `${mainOrigin}/new`,
            });
            yield* waitForReady("dom-first");
            assert.equal(yield* evaluate("dom-first", "document.title"), "Replacement document");

            const oldUniqueEvaluation = yield* Effect.exit(
              evaluate("dom-first", "globalThis.newTouched = 91", uniqueContextId),
            );
            assert.ok(Exit.isFailure(oldUniqueEvaluation), "old uniqueContextId must be rejected");
            const oldObjectCall = yield* Effect.exit(
              call(targetObjectId, "function() { globalThis.newTouched = 92; return true; }"),
            );
            assert.ok(Exit.isFailure(oldObjectCall), "old objectId must be rejected");
            const oldUniqueError = Exit.isFailure(oldUniqueEvaluation)
              ? Cause.pretty(oldUniqueEvaluation.cause).split("\n", 1)[0]
              : "unexpected success";
            const oldObjectError = Exit.isFailure(oldObjectCall)
              ? Cause.pretty(oldObjectCall.cause).split("\n", 1)[0]
              : "unexpected success";
            assert.equal(yield* evaluate("dom-first", "globalThis.newTouched"), 0);
            assert.equal(yield* evaluate("dom-second", "globalThis.secondTouched"), 0);

            yield* cdp("dom-first", "Runtime.releaseObjectGroup", { objectGroup }).pipe(
              Effect.catch(() => Effect.void),
            );
            yield* engine.request("window.close").pipe(Effect.catch(() => Effect.void));
            assert.equal(yield* engine.exit, 0);

            return {
              protocol: "cdp.send returns the direct method result and emits cdp.event separately",
              staleUniqueContextError: oldUniqueError,
              staleObjectError: oldObjectError,
              frameId,
              loaderId,
              securityOrigin,
              defaultContextUniqueId: stringField(replayedDefault, "uniqueId"),
              isolatedContextUniqueId: uniqueContextId,
              frameTreeChildren: Array.isArray(frameTree.childFrames)
                ? frameTree.childFrames.length
                : 0,
              axNodeCount: axNodes.length,
              axNodesWithBackendId: axNodes.filter(
                (node) => typeof node.backendDOMNodeId === "number",
              ).length,
              axNodesWithFrameId: axNodes.filter((node) => typeof node.frameId === "string").length,
              axFrameIds: explicitAxFrameIds,
              targetAxFrameId: typeof targetAx.frameId === "string" ? targetAx.frameId : null,
              inputAxFrameId: typeof inputAx.frameId === "string" ? inputAx.frameId : null,
              targetBackendNodeId,
              inputBackendNodeId,
            };
          }).pipe(
            Effect.provide(
              EngineConnection.layer({
                executable: binary,
                profileRoot: profile,
              }),
            ),
          ),
        ),
      );
      context.diagnostic(JSON.stringify(evidence));
    } finally {
      await Promise.allSettled([closeServer(mainServer), closeServer(crossServer)]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
