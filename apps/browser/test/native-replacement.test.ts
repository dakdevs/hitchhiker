import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import {
  EngineConnection,
  EngineError,
  NativeSurface,
  type EngineEvent,
  type JsonObject,
} from "@hitchhiker/runtime";
import { Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect";
import { createExtensionArtifactStore } from "../src/extension-artifacts.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";
import { makeBrowserController } from "../src/controller.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
// Public fixture key only. This test extension has no webpage communication surface.
const key =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCimYZ4vpvQw8fIhgaRjWXZqNMQHBZ14piDJkvP4XCMgpP0+NpZpwFbkNBJ8Ha0tZ+LV/9xUN/X7IUZ0C7LFtrGQrKB/XzpYgnEPUqIwsG6vL5KLUCAVjKqP61miL5KEzqKFQyimCLG4AfE5pfewMvT3PiTXZwLgtZA8oZZFjnzrQIDAQAB";
const Target = Schema.Struct({ targetId: Schema.String, type: Schema.String, url: Schema.String });
const decodeTargets = Schema.decodeUnknownEffect(
  Schema.Struct({ targetInfos: Schema.Array(Target) }),
);
const decodeTarget = Schema.decodeUnknownEffect(Schema.Struct({ targetInfo: Target }));
const decodeValue = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) }),
);
const decodePages = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      generation: Schema.Int,
      browserAvailable: Schema.Boolean,
      mainDocumentCommitted: Schema.Boolean,
      resourcesKnown: Schema.Boolean,
      url: Schema.String,
      title: Schema.String,
      canGoBack: Schema.Boolean,
    }),
  ),
);
const waitUntil = (label: string, condition: Effect.Effect<boolean, unknown>) =>
  condition.pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail(new Error(label)))),
    Effect.retry({ times: 120, schedule: Schedule.spaced(25) }),
  );

test(
  "Chromium replacement preserves logical pages and history while retiring old CDP requests",
  {
    skip: !binary || !isAbsolute(binary),
    timeout: 90_000,
  },
  async () => {
    if (!binary || !isAbsolute(binary)) return;
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-replacement-"));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(
        "<!doctype html><title>Replacement fixture</title><script>globalThis.fixtureReady=true</script>",
      );
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      const urls = ["initial", "first", "second"].map((step) => `${origin}/target?${step}`);
      const source = join(directory, "fixture");
      await mkdir(source);
      await writeFile(
        join(source, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Replacement test",
          version: "1.0",
          key,
          permissions: ["tabs", "debugger"],
          background: { service_worker: "worker.js" },
        }),
      );
      await writeFile(
        join(source, "worker.js"),
        `
      globalThis.fixtureTab = async targetId => {
        const matches = (await chrome.debugger.getTargets()).filter(t => t.id === targetId && Number.isInteger(t.tabId) && t.tabId > 0);
        if (matches.length !== 1) throw new Error('ambiguous target');
        return matches[0].tabId;
      };
      globalThis.fixtureDiscard = async tabId => {
        if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('invalid tab');
        const tab = await chrome.tabs.discard(tabId);
        return {id:tab.id,discarded:tab.discarded};
      };
    `,
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* acquireProfileWriteLease(join(directory, "profile"), binary);
            const runtime = EngineConnection.layer({
              executable: binary,
              profileRoot: lease.profileRoot,
              extensionManagement: true,
            });
            yield* Effect.gen(function* () {
              const engine = yield* EngineConnection;
              yield* Effect.addFinalizer(() =>
                engine.request("window.close").pipe(Effect.catch(() => Effect.void)),
              );
              yield* engine.ready;
              const events: EngineEvent[] = [];
              yield* engine.events.pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }),
                ),
                Effect.forkScoped,
              );
              const artifacts = yield* createExtensionArtifactStore({ profileLease: lease });
              const artifact = yield* artifacts.stage(source);
              const extensionId = yield* engine.loadUnpacked(artifact.directory);
              assert.equal(extensionId, artifact.expectedChromiumId);
              const workerUrl = `chrome-extension://${extensionId}/worker.js`;
              const controller = yield* makeBrowserController(lease.profileRoot, {
                profileLease: lease,
                freezeEnabled: false,
              });
              yield* controller.start;
              const target = yield* controller.openPage(urls[0]!);
              const control = yield* controller.openPage(urls[0]!);
              const pageCdp = (pageId: string, method: string, params: JsonObject = {}) =>
                engine.request("cdp.send", { pageId, method, params });
              const evaluate = (pageId: string, expression: string) =>
                pageCdp(pageId, "Runtime.evaluate", { expression, returnByValue: true }).pipe(
                  Effect.flatMap(decodeValue),
                  Effect.map((reply) => reply.result.value),
                );
              yield* waitUntil(
                "both pages reconcile",
                controller.snapshot.pipe(
                  Effect.map((state) =>
                    [target, control].every((id) => state.pages.some((page) => page.id === id)),
                  ),
                ),
              );
              for (const id of [target, control])
                yield* waitUntil(
                  "initial document ready",
                  evaluate(id, "globalThis.fixtureReady===true").pipe(
                    Effect.map((ready) => ready === true),
                  ),
                );
              const initialTarget = (yield* pageCdp(target, "Target.getTargetInfo").pipe(
                Effect.flatMap(decodeTarget),
              )).targetInfo.targetId;
              const controlTarget = (yield* pageCdp(control, "Target.getTargetInfo").pipe(
                Effect.flatMap(decodeTarget),
              )).targetInfo.targetId;
              assert.notEqual(
                initialTarget,
                controlTarget,
                "duplicate URLs retain distinct native target identities",
              );
              const raw = yield* engine.claimRawCdp;
              let nextRequest = 1;
              const rawCdp = Effect.fn("replacement-test.rawCdp")(function* (
                method: string,
                params: JsonObject = {},
                sessionId?: string,
              ) {
                return yield* Effect.scoped(
                  Effect.gen(function* () {
                    const id = nextRequest++;
                    const reply = yield* raw.events.pipe(
                      Stream.filter((event) => event.id === id),
                      Stream.take(1),
                      Stream.runCollect,
                      Effect.forkScoped({ startImmediately: true }),
                    );
                    yield* raw.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
                    const response = (yield* Fiber.join(reply).pipe(Effect.timeout(5_000)))[0];
                    assert.ok(response, `${method} returned a response`);
                    assert.equal(
                      response.error,
                      undefined,
                      `${method}: ${JSON.stringify(response.error)}`,
                    );
                    return response.result;
                  }),
                );
              });
              const worker = Effect.fn("replacement-test.worker")(function* (expression: string) {
                const targets = yield* rawCdp("Target.getTargets").pipe(
                  Effect.flatMap(decodeTargets),
                );
                const matches = targets.targetInfos.filter(
                  (entry) => entry.type === "service_worker" && entry.url === workerUrl,
                );
                assert.equal(matches.length, 1, "exact private extension worker identity");
                const attached = yield* rawCdp("Target.attachToTarget", {
                  targetId: matches[0]!.targetId,
                  flatten: true,
                }).pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(Schema.Struct({ sessionId: Schema.String })),
                  ),
                );
                return yield* rawCdp(
                  "Runtime.evaluate",
                  { expression, returnByValue: true, awaitPromise: true },
                  attached.sessionId,
                ).pipe(
                  Effect.flatMap(decodeValue),
                  Effect.map((response) => response.result.value),
                  Effect.ensuring(
                    rawCdp("Target.detachFromTarget", { sessionId: attached.sessionId }).pipe(
                      Effect.orDie,
                      Effect.asVoid,
                    ),
                  ),
                );
              });
              const nativeTab = yield* worker(`fixtureTab(${JSON.stringify(initialTarget)})`);
              const controlTab = yield* worker(`fixtureTab(${JSON.stringify(controlTarget)})`);
              assert.ok(typeof nativeTab === "number" && nativeTab > 0);
              assert.ok(typeof controlTab === "number" && controlTab > 0);
              assert.notEqual(
                nativeTab,
                controlTab,
                "duplicate URLs map to distinct exact extension tab IDs",
              );
              for (const url of urls.slice(1)) {
                yield* controller.navigatePage(target, url);
                yield* waitUntil(
                  "real navigation completed",
                  evaluate(
                    target,
                    `globalThis.fixtureReady===true && location.href===${JSON.stringify(url)}`,
                  ).pipe(Effect.map((ready) => ready === true)),
                );
              }
              yield* controller.dispatch(`page.pin:${target}`);
              yield* controller.dispatch(`page.select:${control}`);
              for (let cycle = 1; cycle <= 3; cycle++) {
                const oldTarget = (yield* pageCdp(target, "Target.getTargetInfo").pipe(
                  Effect.flatMap(decodeTarget),
                )).targetInfo.targetId;
                const oldTab = yield* worker(`fixtureTab(${JSON.stringify(oldTarget)})`);
                assert.ok(typeof oldTab === "number" && oldTab > 0);
                const pending = yield* pageCdp(target, "Runtime.evaluate", {
                  expression: "globalThis.pendingReplacementRequest=true;new Promise(()=>{})",
                  awaitPromise: true,
                }).pipe(Effect.result, Effect.forkScoped);
                yield* waitUntil(
                  "old CDP request reached renderer",
                  evaluate(target, "globalThis.pendingReplacementRequest===true").pipe(
                    Effect.map((ready) => ready === true),
                  ),
                );
                const discarded = yield* worker(`fixtureDiscard(${oldTab})`).pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.Struct({ id: Schema.Int, discarded: Schema.Literal(true) }),
                    ),
                  ),
                );
                assert.notEqual(discarded.id, oldTab);
                const retired = yield* Fiber.join(pending).pipe(Effect.timeout(2_000));
                assert.equal(
                  retired._tag,
                  "Failure",
                  "old pending CDP fails promptly at replacement",
                );
                if (retired._tag === "Failure") {
                  assert.ok(retired.failure instanceof EngineError);
                  assert.match(retired.failure.message, /browser (replaced|unavailable)/);
                }
                yield* waitUntil(
                  "replacement event drained",
                  Effect.sync(() =>
                    events.some(
                      (event) =>
                        event.event === "pages.replaced" &&
                        event.params.pageId === target &&
                        event.params.generation === cycle + 1,
                    ),
                  ),
                );
                const cached = (yield* engine
                  .request("pages.list")
                  .pipe(Effect.flatMap(decodePages))).find((page) => page.id === target);
                assert.ok(cached);
                assert.equal(cached.generation, cycle + 1);
                assert.equal(cached.url, urls[2]);
                assert.equal(cached.title, "Replacement fixture");
                assert.equal(cached.canGoBack, true);
                assert.equal(cached.resourcesKnown, false);
                assert.equal(cached.mainDocumentCommitted, false);
                const state = yield* controller.snapshot;
                assert.equal(state.pages.find((page) => page.id === target)?.url, urls[2]);
                assert.equal(state.viewports[0]?.pageId, control);
                assert.equal(
                  events.filter(
                    (event) => event.event === "pages.closed" && event.params.pageId === target,
                  ).length,
                  0,
                );
                yield* controller.dispatch(`page.select:${target}`);
                const selected = (yield* engine
                  .request("pages.list")
                  .pipe(Effect.flatMap(decodePages))).find((page) => page.id === target);
                assert.equal(selected?.mainDocumentCommitted, false);
                // Portable controller tests assert no reload command is issued by
                // selection. Here an explicit command restores the real history.
                yield* controller.dispatch("browser.reload");
                yield* waitUntil(
                  "explicit reload restores original document",
                  evaluate(
                    target,
                    `globalThis.fixtureReady===true && location.href===${JSON.stringify(urls[2])}`,
                  ).pipe(Effect.map((ready) => ready === true)),
                );
                const nextTarget = (yield* pageCdp(target, "Target.getTargetInfo").pipe(
                  Effect.flatMap(decodeTarget),
                )).targetInfo.targetId;
                assert.notEqual(nextTarget, oldTarget);
                const history = yield* pageCdp(target, "Page.getNavigationHistory").pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.Struct({
                        currentIndex: Schema.Int,
                        entries: Schema.Array(Schema.Struct({ url: Schema.String })),
                      }),
                    ),
                  ),
                );
                assert.deepEqual(
                  history.entries.map((entry) => entry.url),
                  urls,
                );
                assert.equal(history.currentIndex, 2);
                yield* controller.dispatch(`page.select:${control}`);
              }
              assert.equal(
                events.filter(
                  (event) => event.event === "pages.created" && event.params.pageId === target,
                ).length,
                1,
              );
              assert.deepEqual(
                events
                  .filter(
                    (event) => event.event === "pages.replaced" && event.params.pageId === target,
                  )
                  .map((event) => event.params.generation),
                [2, 3, 4],
              );
              yield* pageCdp(target, "Page.navigateToHistoryEntry", {
                entryId: (yield* pageCdp(target, "Page.getNavigationHistory").pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.Struct({ entries: Schema.Array(Schema.Struct({ id: Schema.Int })) }),
                    ),
                  ),
                )).entries[1]!.id,
              });
              yield* waitUntil(
                "real back history remains navigable",
                evaluate(target, `location.href===${JSON.stringify(urls[1])}`).pipe(
                  Effect.map((ready) => ready === true),
                ),
              );
              yield* controller.closePage(target);
              yield* waitUntil(
                "replaced page closes independently",
                Effect.sync(() =>
                  events.some(
                    (event) => event.event === "pages.closed" && event.params.pageId === target,
                  ),
                ),
              );
              const closed = yield* pageCdp(target, "Target.getTargetInfo").pipe(Effect.flip);
              assert.equal(closed.code, "-32001");
              assert.match(closed.message, /closed or unknown/);
              const unknown = yield* pageCdp("never-opened", "Target.getTargetInfo").pipe(
                Effect.flip,
              );
              assert.equal(unknown.code, "-32001");
              yield* engine.request("window.close");
              assert.equal(yield* engine.exit, 0);
              assert.equal(
                events.filter(
                  (event) => event.event === "pages.closed" && event.params.pageId === target,
                ).length,
                1,
              );
            }).pipe(Effect.provide(Layer.provideMerge(NativeSurface.layer, runtime)));
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
