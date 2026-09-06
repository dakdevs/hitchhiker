import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { EngineConnection, EngineError, NativeSurface } from "@hitchhiker/runtime";
import { Effect, Layer, Schedule, Schema } from "effect";
import { createExtensionArtifactStore } from "../src/extension-artifacts.ts";
import { createExtensionManager, type ExtensionManager } from "../src/extension-manager.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";
import { makeBrowserController, type BrowserController } from "../src/controller.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const decodeValue = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) }),
);
const evaluate = Effect.fn("extensions-test.evaluate")(function* (
  engine: EngineConnection["Service"],
  pageId: string,
  expression: string,
) {
  const response = yield* engine.request("cdp.send", {
    pageId,
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true },
  });
  return (yield* decodeValue(response)).result.value;
});
const waitFor = (engine: EngineConnection["Service"], pageId: string, expression: string) =>
  evaluate(engine, pageId, expression).pipe(
    Effect.flatMap((result) =>
      result === true
        ? Effect.void
        : Effect.fail(new EngineError({ code: "waiting", message: expression })),
    ),
    Effect.retry({ times: 120, schedule: Schedule.spaced(50) }),
  );

test(
  "managed MV3 review, profile isolation, restart replay and removal use real Chromium",
  { skip: !binary || !isAbsolute(binary), timeout: 120_000 },
  async () => {
    if (!binary || !isAbsolute(binary)) return;
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-managed-extensions-"));
    const profile = join(directory, "profile with spaces 🚀");
    const source = join(directory, "unpacked source");
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><title>Managed extension fixture</title><div id="fixture-extension-status"></div><script>globalThis.fixtureReady=true</script>',
      );
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      await mkdir(source, { recursive: true });
      await writeFile(
        join(source, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Managed extension fixture 🚀",
          version: "1.0",
          permissions: ["storage", "tabs"],
          host_permissions: ["http://127.0.0.1/*"],
          background: { service_worker: "worker.js" },
          content_scripts: [
            { matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_idle" },
          ],
        }),
      );
      await writeFile(
        join(source, "content.js"),
        `if(location.origin===${JSON.stringify(origin)})chrome.runtime.sendMessage({type:'probe'},response=>{if(chrome.runtime.lastError)return;document.querySelector('#fixture-extension-status').textContent=JSON.stringify(response)});`,
      );
      await writeFile(
        join(source, "worker.js"),
        `let pending=Promise.resolve();chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message.type!=='probe'||sender.id!==chrome.runtime.id||new URL(sender.url).origin!==${JSON.stringify(origin)})return;pending=pending.then(async()=>{const {count=0}=await chrome.storage.local.get('count');await chrome.storage.local.set({count:count+1});reply({count:count+1,windowId:sender.tab.windowId})});return true;});`,
      );
      let installationId = "";
      let chromiumId = "";
      let previousCount = 0;
      let persistedPage = "";
      const session = async (
        root: string,
        run: (
          manager: ExtensionManager,
          engine: EngineConnection["Service"],
          controller: BrowserController,
        ) => Effect.Effect<void, unknown>,
      ) => {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const lease = yield* acquireProfileWriteLease(root, binary);
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
                const artifacts = yield* createExtensionArtifactStore({ profileLease: lease });
                const manager = yield* createExtensionManager({
                  profileRoot: lease.profileRoot,
                  lease,
                  engine,
                  artifacts,
                });
                yield* manager.restoreBeforePages();
                const controller = yield* makeBrowserController(lease.profileRoot, {
                  profileLease: lease,
                });
                yield* controller.start;
                yield* run(manager, engine, controller);
                yield* engine.request("window.close").pipe(Effect.catch(() => Effect.void));
                assert.equal(yield* engine.exit, 0);
              }).pipe(Effect.provide(Layer.provideMerge(NativeSurface.layer, runtime)));
            }),
          ).pipe(Effect.provide(NodeServices.layer)),
        );
      };
      await session(profile, (manager, engine, controller) =>
        Effect.gen(function* () {
          persistedPage = yield* controller.openPage(`${origin}/one`);
          yield* waitFor(engine, persistedPage, "globalThis.fixtureReady===true");
          const preview = yield* manager.previewLocal(source);
          installationId = preview.installationId;
          chromiumId = preview.expectedChromiumId;
          assert.equal((yield* manager.list())[0].state, "prepared");
          assert.equal(
            yield* evaluate(
              engine,
              persistedPage,
              "document.querySelector('#fixture-extension-status').textContent",
            ),
            "",
          );
          yield* manager.confirmInstall(preview.installationId, preview.digest);
          assert.equal((yield* manager.list())[0].state, "enabled");
          // Chromium registers content scripts for subsequent document loads.
          yield* engine.request("pages.reload", { id: persistedPage });
          yield* waitFor(
            engine,
            persistedPage,
            "!!document.querySelector('#fixture-extension-status')?.textContent",
          );
          const first = yield* evaluate(
            engine,
            persistedPage,
            "JSON.parse(document.querySelector('#fixture-extension-status').textContent)",
          );
          const secondPage = yield* controller.openPage(`${origin}/two`);
          yield* waitFor(
            engine,
            secondPage,
            "!!document.querySelector('#fixture-extension-status')?.textContent",
          );
          const second = yield* evaluate(
            engine,
            secondPage,
            "JSON.parse(document.querySelector('#fixture-extension-status').textContent)",
          );
          const result = Schema.decodeUnknownSync(
            Schema.Struct({ count: Schema.Int, windowId: Schema.Int }),
          );
          assert.notEqual(
            result(first).windowId,
            result(second).windowId,
            "CEF pages still have distinct Chrome windows",
          );
          previousCount = Math.max(result(first).count, result(second).count);
          assert.ok(previousCount >= 2);
          yield* manager.enterReadOnly();
          assert.equal(yield* manager.remove(installationId).pipe(Effect.isFailure), true);
        }),
      );
      // Loading always uses the profile copy, even when the original source disappears.
      await rm(source, { recursive: true });
      await session(join(directory, "second profile"), (manager, engine, controller) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* manager.list(), []);
          const page = yield* controller.openPage(`${origin}/isolated`);
          yield* waitFor(engine, page, "globalThis.fixtureReady===true");
          yield* Effect.sleep(300);
          assert.equal(
            yield* evaluate(
              engine,
              page,
              "document.querySelector('#fixture-extension-status').textContent",
            ),
            "",
          );
        }),
      );
      await session(profile, (manager, engine, controller) =>
        Effect.gen(function* () {
          const entries = yield* manager.list();
          assert.equal(entries[0].expectedChromiumId, chromiumId);
          assert.equal(entries[0].state, "enabled");
          yield* waitFor(
            engine,
            persistedPage,
            "!!document.querySelector('#fixture-extension-status')?.textContent",
          );
          const count = yield* evaluate(
            engine,
            persistedPage,
            "JSON.parse(document.querySelector('#fixture-extension-status').textContent).count",
          );
          assert.ok(
            typeof count === "number" && count > previousCount,
            "replay preserves extension storage",
          );
          yield* manager.remove(installationId);
          assert.equal((yield* manager.list())[0].state, "removed");
          const page = yield* controller.openPage(`${origin}/removed`);
          yield* waitFor(engine, page, "globalThis.fixtureReady===true");
          yield* Effect.sleep(300);
          assert.equal(
            yield* evaluate(
              engine,
              page,
              "document.querySelector('#fixture-extension-status').textContent",
            ),
            "",
          );
        }),
      );
      await session(profile, (manager, engine, controller) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* manager.list(), []);
          const page = yield* controller.openPage(`${origin}/removed-after-restart`);
          yield* waitFor(engine, page, "globalThis.fixtureReady===true");
          yield* Effect.sleep(300);
          assert.equal(
            yield* evaluate(
              engine,
              page,
              "document.querySelector('#fixture-extension-status').textContent",
            ),
            "",
          );
        }),
      );
      assert.ok(
        !(
          await readFile(join(profile, "hitchhiker-extensions", "extensions.json"), "utf8")
        ).includes(installationId),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
