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

test(
  "real host retains native unsaved-input protection until a new main document commits",
  { skip: !binary, timeout: 30_000 },
  async () => {
    if (!binary) return;
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-input-protection-"));
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/frame")) {
        setTimeout(() => {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end("<!doctype html><title>child frame</title>");
        }, 100);
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.url?.startsWith("/replacement")) {
        response.end(
          "<!doctype html><title>replacement</title><script>globalThis.replacementReady=true</script>",
        );
        return;
      }
      response.end(
        '<!doctype html><title>input fixture</title><input id="input" value="x"><iframe id="child" src="/frame?initial"></iframe><script>globalThis.fixtureReady=true;globalThis.childLoadCount=0;document.querySelector("#child").addEventListener("load",()=>globalThis.childLoadCount++)</script>',
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
          const evaluate = Effect.fn("test.inputProtectionEvaluate")(function* (
            expression: string,
          ) {
            const raw = yield* engine.request("cdp.send", {
              pageId: "input-protection",
              method: "Runtime.evaluate",
              params: { expression, returnByValue: true },
            });
            const result = raw as { readonly result?: { readonly value?: unknown } };
            return result.result?.value;
          });
          const waitFor = Effect.fn("test.inputProtectionWaitFor")(function* (
            expression: string,
            message: string,
          ) {
            for (let tries = 0; tries < 100; ++tries) {
              if (yield* evaluate(expression)) return;
              yield* Effect.sleep(25);
            }
            assert.fail(
              `${message}: ${JSON.stringify(yield* evaluate('({value:document.querySelector("#input")?.value,focused:document.hasFocus(),active:document.activeElement?.id})'))}`,
            );
          });
          const resourceSignal = (unsavedInput: boolean) =>
            engine.events.pipe(
              Stream.filter(
                (event) =>
                  event.event === "pages.resourcesChanged" &&
                  event.params.pageId === "input-protection" &&
                  event.params.unsavedInput === unsavedInput,
              ),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            );
          const assertRetained = Effect.fn("test.assertInputProtectionRetained")(function* (
            action: Effect.Effect<void, unknown>,
            observableState: string,
            message: string,
          ) {
            const cleared = yield* resourceSignal(false);
            yield* Effect.yieldNow;
            yield* action;
            yield* waitFor(observableState, message);
            const result = yield* Effect.race(
              Fiber.join(cleared).pipe(Effect.as("cleared")),
              Effect.sleep(250).pipe(Effect.as("retained")),
            );
            assert.equal(result, "retained", message);
          });

          const initial = yield* resourceSignal(false);
          yield* Effect.yieldNow;
          yield* engine.request("pages.open", { id: "input-protection", url });
          yield* Fiber.join(initial).pipe(Effect.timeout(5_000));
          yield* waitFor(
            "globalThis.fixtureReady === true && globalThis.childLoadCount > 0",
            "input fixture and its initial subframe loaded",
          );

          yield* engine.request("viewports.set", {
            viewports: [{ pageId: "input-protection", x: 0, y: 0, width: 800, height: 600 }],
          });
          const protectedInput = yield* resourceSignal(true);
          yield* Effect.yieldNow;
          assert.equal(
            yield* evaluate(
              'const input=document.querySelector("#input");input.focus();input.setSelectionRange(1,1);input.value',
            ),
            "x",
            "CDP keyboard input targets the editable fixture",
          );
          // A platform Backspace exercises native pre-key handling and a real
          // renderer edit. Chromium's macOS CDP builder cannot insert a native
          // `char` event; its platform mapping treats that event as key-up.
          for (const type of ["rawKeyDown", "keyUp"]) {
            yield* engine.request("cdp.send", {
              pageId: "input-protection",
              method: "Input.dispatchKeyEvent",
              params: {
                type,
                key: "Backspace",
                code: "Backspace",
                windowsVirtualKeyCode: 8,
                nativeVirtualKeyCode: 51,
              },
            });
          }
          const protectedSignals = yield* Fiber.join(protectedInput).pipe(Effect.timeout(5_000));
          assert.equal(
            protectedSignals[0]?.params.unsavedInput,
            true,
            "native pre-key handling protected the edited page",
          );
          yield* waitFor(
            'document.querySelector("#input").value === ""',
            "native key input reached the editable document",
          );

          yield* assertRetained(
            engine
              .request("cdp.send", {
                pageId: "input-protection",
                method: "Runtime.evaluate",
                params: {
                  expression: 'location.hash="same-document";location.hash',
                  returnByValue: true,
                },
              })
              .pipe(Effect.asVoid),
            'location.hash === "#same-document"',
            "same-document hash navigation retained native unsaved-input protection",
          );
          yield* assertRetained(
            engine
              .request("cdp.send", {
                pageId: "input-protection",
                method: "Runtime.evaluate",
                params: {
                  expression: 'history.pushState({}, "", "#history");history.back();true',
                  returnByValue: true,
                },
              })
              .pipe(Effect.asVoid),
            'location.hash === "#same-document"',
            "history same-document navigation retained native unsaved-input protection",
          );
          yield* assertRetained(
            engine
              .request("cdp.send", {
                pageId: "input-protection",
                method: "Runtime.evaluate",
                params: {
                  expression:
                    'document.querySelector("#child").src="/frame?delayed";globalThis.childLoadCount',
                  returnByValue: true,
                },
              })
              .pipe(Effect.asVoid),
            "globalThis.childLoadCount > 1",
            "delayed subframe navigation retained native unsaved-input protection",
          );

          const cleared = yield* resourceSignal(false);
          yield* Effect.yieldNow;
          yield* engine.request("cdp.send", {
            pageId: "input-protection",
            method: "Page.navigate",
            params: { url: `${url}replacement` },
          });
          const clearedSignals = yield* Fiber.join(cleared).pipe(Effect.timeout(5_000));
          assert.equal(
            clearedSignals[0]?.params.unsavedInput,
            false,
            "a committed replacement main document cleared native unsaved-input protection",
          );
          yield* waitFor(
            "globalThis.replacementReady === true",
            "replacement main document committed after clearing protection",
          );
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
