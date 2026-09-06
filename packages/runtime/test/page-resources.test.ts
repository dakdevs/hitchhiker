import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activatePage,
  freezePage,
  rememberPageResources,
  selectPageFreezes,
} from "../src/page-resources.ts";
import { defaultConfiguration, type BrowserState } from "@hitchhiker/core";
import { Effect, Fiber, Stream } from "effect";
import { EngineConnection } from "../src/engine.ts";

const state: BrowserState = Object.freeze({
  pages: Object.freeze([
    Object.freeze({
      id: "old",
      profileId: "profile",
      url: "https://old.example/",
      title: "Old",
      lifecycle: "loaded" as const,
      lastUsedAt: 0,
      protections: Object.freeze({
        audio: false,
        call: false,
        download: false,
        unsavedInput: false,
      }),
    }),
    Object.freeze({
      id: "shown",
      profileId: "profile",
      url: "https://shown.example/",
      title: "Shown",
      lifecycle: "loaded" as const,
      lastUsedAt: 0,
      protections: Object.freeze({
        audio: false,
        call: false,
        download: false,
        unsavedInput: false,
      }),
    }),
  ]),
  viewports: Object.freeze([Object.freeze({ id: "main", profileId: "profile", pageId: "shown" })]),
});
const configuration = Object.freeze({ ...defaultConfiguration, sleepAfterMs: 10_000 });
const idle = Object.freeze({ audio: false, call: false, download: false, unsavedInput: false });

test("resource scheduling fails closed until native snapshots are known", () => {
  assert.deepEqual(selectPageFreezes(state, configuration, 10_000, 8, false, new Map()), []);
  assert.deepEqual(selectPageFreezes(state, configuration, 10_000, 8, true, new Map()), []);

  let known = rememberPageResources(new Map(), { pageId: "old", ...idle });
  assert.deepEqual(selectPageFreezes(state, configuration, 10_000, 8, true, known), ["old"]);

  known = rememberPageResources(known, { pageId: "old", ...idle, audio: true });
  assert.deepEqual(selectPageFreezes(state, configuration, 10_000, 8, true, known), []);
  known = rememberPageResources(known, { pageId: "old", ...idle, call: true });
  assert.deepEqual(selectPageFreezes(state, configuration, 10_000, 8, true, known), []);
  known = rememberPageResources(known, { pageId: "old", ...idle, download: true });
  assert.deepEqual(selectPageFreezes(state, configuration, 10_000, 8, true, known), []);
  known = rememberPageResources(known, { pageId: "old", ...idle, unsavedInput: true });
  assert.deepEqual(selectPageFreezes(state, configuration, 10_000, 8, true, known), []);
});

test("freeze and activation use only reversible page lifecycle CDP calls", async () => {
  const calls: { method: string; params: object }[] = [];
  const transport = {
    request: (method: string, params: object) =>
      Effect.sync(() => {
        calls.push({ method, params });
      }),
  };
  await Effect.runPromise(freezePage(transport, "old"));
  await Effect.runPromise(activatePage(transport, "old"));
  assert.deepEqual(calls, [
    {
      method: "cdp.send",
      params: { pageId: "old", method: "Page.setWebLifecycleState", params: { state: "frozen" } },
    },
    {
      method: "cdp.send",
      params: { pageId: "old", method: "Page.setWebLifecycleState", params: { state: "active" } },
    },
  ]);
});

const binary = process.env.HITCHHIKER_NATIVE_BINARY;

test(
  "real host emits an initial resource snapshot and freezes then activates a page",
  { skip: !binary, timeout: 30_000 },
  async () => {
    if (!binary) return;
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-page-resources-"));
    const server = createServer((request, response) => {
      if (request.url === "/download") {
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Disposition", "attachment; filename=resource.bin");
        response.write(Buffer.alloc(1_024));
        const finish = setTimeout(() => response.end(Buffer.alloc(1_024)), 1_000);
        response.once("close", () => clearTimeout(finish));
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><title>resources</title><a id="download" href="/download">download</a><script>globalThis.ticks=0;setInterval(()=>globalThis.ticks++,25)</script>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/`;
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const engine = yield* EngineConnection;
          yield* engine.ready;
          const snapshot = yield* engine.events.pipe(
            Stream.filter(
              (event) =>
                event.event === "pages.resourcesChanged" && event.params.pageId === "resource",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* engine.request("pages.open", { id: "resource", url });
          const snapshots = yield* Fiber.join(snapshot).pipe(Effect.timeout(5_000));
          assert.deepEqual(snapshots[0]?.params, {
            pageId: "resource",
            audio: false,
            call: false,
            download: false,
            unsavedInput: false,
          });
          const ticks = Effect.fn("test.resourceTicks")(function* (pageId: string) {
            const raw = yield* engine.request("cdp.send", {
              pageId,
              method: "Runtime.evaluate",
              params: { expression: "globalThis.ticks", returnByValue: true },
            });
            const result = raw as { readonly result?: { readonly value?: unknown } };
            return typeof result.result?.value === "number" ? result.result.value : -1;
          });
          let loaded = yield* ticks("resource");
          for (let tries = 0; loaded < 2 && tries < 40; ++tries) {
            yield* Effect.sleep(25);
            loaded = yield* ticks("resource");
          }
          assert.ok(loaded >= 2, "resource fixture loaded before initiating its download");
          const downloadStarted = yield* engine.events.pipe(
            Stream.filter(
              (event) =>
                event.event === "pages.resourcesChanged" &&
                event.params.pageId === "resource" &&
                event.params.download === true,
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* engine.request("cdp.send", {
            pageId: "resource",
            method: "Runtime.evaluate",
            params: {
              expression: "document.querySelector('#download').click();true",
              userGesture: true,
            },
          });
          const downloadSignals = yield* Fiber.join(downloadStarted).pipe(Effect.timeout(5_000));
          assert.equal(
            downloadSignals[0]?.params.download,
            true,
            "native download activity protected the page",
          );
          const freezeSnapshot = yield* engine.events.pipe(
            Stream.filter(
              (event) =>
                event.event === "pages.resourcesChanged" &&
                event.params.pageId === "freeze" &&
                event.params.download === false &&
                event.params.audio === false &&
                event.params.call === false &&
                event.params.unsavedInput === false,
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* engine.request("pages.open", { id: "freeze", url });
          const idleSignals = yield* Fiber.join(freezeSnapshot).pipe(Effect.timeout(5_000));
          assert.equal(
            idleSignals[0]?.params.pageId,
            "freeze",
            "second page began with an idle snapshot",
          );
          let before = yield* ticks("freeze");
          for (let tries = 0; before < 2 && tries < 40; ++tries) {
            yield* Effect.sleep(25);
            before = yield* ticks("freeze");
          }
          assert.ok(before >= 2, "fixture timer became active before freeze");
          yield* freezePage(engine, "freeze");
          yield* Effect.sleep(250);
          assert.equal(yield* ticks("freeze"), before, "frozen page timer did not advance");
          yield* activatePage(engine, "freeze");
          let after = yield* ticks("freeze");
          for (let tries = 0; after <= before && tries < 40; ++tries) {
            yield* Effect.sleep(25);
            after = yield* ticks("freeze");
          }
          assert.ok(after > before, "active page timer resumed");
          yield* engine.request("window.close").pipe(Effect.catch(() => Effect.void));
          assert.equal(yield* engine.exit, 0);
        }).pipe(
          Effect.provide(
            EngineConnection.layer({
              executable: binary,
              profileRoot: join(directory, "profile"),
              extensionManagement: false,
            }),
          ),
          Effect.scoped,
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
