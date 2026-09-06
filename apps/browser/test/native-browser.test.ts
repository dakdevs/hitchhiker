import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { EngineConnection, EngineError, NativeSurface } from "@hitchhiker/runtime";
import { column, viewport } from "@hitchhiker/ui";
import { Effect, Exit, Layer, Schedule, Schema } from "effect";
import { makeBrowserController } from "../src/controller.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
const decodeValue = Schema.decodeUnknownEffect(Value);

test(
  "restores real pages through the Native controller without losing page state",
  { skip: !binary || !isAbsolute(binary), timeout: 60_000 },
  async () => {
    if (!binary || !isAbsolute(binary)) return;
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-browser-native-"));
    const requestedProfile = join(directory, "profile");
    const server = createServer((request, response) => {
      const title = request.url === "/two" ? "Second fixture" : "First fixture";
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        `<!doctype html><title>${title}</title><input id="input"><script>globalThis.counter=0;globalThis.ticks=0;setInterval(()=>globalThis.ticks++,50)</script>`,
      );
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const firstUrl = `http://127.0.0.1:${address.port}/one`;
      const secondUrl = `http://127.0.0.1:${address.port}/two`;
      await mkdir(requestedProfile, { recursive: true, mode: 0o700 });
      const profile = await realpath(requestedProfile);
      await writeFile(
        join(profile, "browser-state.json"),
        JSON.stringify({
          version: 1,
          configuration: { colorScheme: "system", sleepAfterMs: 300_000, alwaysAwakeOrigins: [] },
          interface: {
            tabPlacement: "sidebar",
            selectedPageId: "first",
            pageOrder: ["first", "second"],
            pinnedPageIds: ["first"],
          },
          pages: [
            { id: "first", url: firstUrl, title: "First fixture" },
            { id: "second", url: secondUrl, title: "Second fixture" },
          ],
        }),
        { mode: 0o600 },
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = EngineConnection.layer({ executable: binary, profileRoot: profile });
            const layers = Layer.provideMerge(NativeSurface.layer, runtime);
            yield* Effect.gen(function* () {
              const engine = yield* EngineConnection;
              const controller = yield* makeBrowserController(profile);
              const evaluate = Effect.fn("native-browser.evaluate")(function* (
                pageId: string,
                expression: string,
              ) {
                const raw = yield* engine.request("cdp.send", {
                  pageId,
                  method: "Runtime.evaluate",
                  params: { expression, returnByValue: true },
                });
                return (yield* decodeValue(raw)).result.value;
              });
              const waitFor = (
                description: string,
                predicate: () => Effect.Effect<boolean, unknown>,
              ) =>
                Effect.gen(function* () {
                  const controllerError = yield* controller.lastError;
                  if (controllerError)
                    return yield* new EngineError({
                      code: "controller",
                      message: `${description}: ${controllerError}`,
                    });
                  if (!(yield* predicate()))
                    return yield* new EngineError({ code: "waiting", message: description });
                }).pipe(
                  Effect.retry({ times: 100, schedule: Schedule.spaced(50) }),
                  Effect.timeoutOrElse({
                    duration: 6_000,
                    orElse: () =>
                      Effect.fail(
                        new Error(`Timed out waiting for ${description}; engine may have exited`),
                      ),
                  }),
                );

              // Exercise the browser-root raw CDP pipe immediately so a host
              // failure is reported before waiting on controller events.
              yield* engine.sendCdp({ id: 1, method: "Browser.getVersion" });
              yield* controller.start;
              yield* waitFor("both restored pages", () =>
                controller.snapshot.pipe(Effect.map((state) => state.pages.length === 2)),
              );
              const restored = yield* controller.snapshot;
              assert.equal(restored.pages.length, 2, JSON.stringify(restored));
              assert.equal(
                restored.pages.find((page) => page.id === "first")?.title,
                "First fixture",
              );
              assert.equal(
                restored.pages.find((page) => page.id === "second")?.title,
                "Second fixture",
              );
              assert.equal(yield* evaluate("first", "document.title"), "First fixture");
              assert.equal(yield* evaluate("second", "document.title"), "Second fixture");
              assert.equal(
                yield* evaluate(
                  "first",
                  "document.querySelector('#input').value='persistent';globalThis.counter=41;true",
                ),
                true,
              );

              yield* controller.configure({
                colorScheme: "system",
                sleepAfterMs: 10_000,
                alwaysAwakeOrigins: [],
              });
              yield* Effect.sleep(12_000);
              const frozen = yield* controller.snapshot;
              assert.equal(frozen.pages.find((page) => page.id === "first")?.lifecycle, "loaded");
              assert.equal(
                frozen.pages.find((page) => page.id === "second")?.lifecycle,
                "sleeping",
                JSON.stringify(frozen),
              );
              const pausedTicks = yield* evaluate("second", "globalThis.ticks");
              yield* Effect.sleep(200);
              assert.equal(yield* evaluate("second", "globalThis.ticks"), pausedTicks);
              yield* controller.publishPluginSurface("plugin-test", {
                root: column("replacement", [viewport("second-view", "canvas", { flex: 1 })], {
                  flex: 1,
                }),
                bindings: [{ viewportId: "canvas", pageId: "second" }],
              });
              const custom = yield* controller.snapshot;
              assert.deepEqual(
                custom.viewports.map((view) => view.pageId),
                ["second"],
              );
              assert.equal(custom.pages.find((page) => page.id === "second")?.lifecycle, "loaded");
              yield* waitFor("reactivated plugin page timer", () =>
                evaluate("second", "globalThis.ticks").pipe(
                  Effect.map((ticks) => ticks !== pausedTicks),
                ),
              );
              assert(
                Exit.isFailure(
                  yield* Effect.exit(
                    controller.publishPluginSurface("bad-replacement", {
                      root: { kind: "invalid" },
                      bindings: [],
                    }),
                  ),
                ),
              );
              assert.deepEqual(
                (yield* controller.snapshot).viewports.map((view) => view.pageId),
                ["second"],
              );
              yield* controller.releasePluginSurface("plugin-test");
              assert.deepEqual(
                (yield* controller.snapshot).viewports.map((view) => view.pageId),
                ["first"],
              );
              assert.equal(
                (yield* controller.snapshot).pages.find((page) => page.id === "second")?.lifecycle,
                "loaded",
              );

              yield* controller.dispatch("settings.tabs.top");
              yield* controller.dispatch("settings.tabs.sidebar");
              yield* controller.dispatch("page.pin:first");
              yield* controller.dispatch("page.select:second");
              yield* controller.dispatch("page.close:second");
              yield* waitFor("selected-page close", () =>
                controller.snapshot.pipe(
                  Effect.map(
                    (state) =>
                      state.pages.find((page) => page.id === "second")?.lifecycle === "closed",
                  ),
                ),
              );
              assert.deepEqual(
                yield* evaluate(
                  "first",
                  "[document.querySelector('#input').value,globalThis.counter]",
                ),
                ["persistent", 41],
              );
              const persisted = JSON.parse(
                yield* Effect.promise(() => readFile(join(profile, "browser-state.json"), "utf8")),
              ) as {
                interface: {
                  selectedPageId?: string;
                  pageOrder: string[];
                  pinnedPageIds: string[];
                };
                pages: { id: string; url: string }[];
              };
              assert.deepEqual(persisted.interface.pageOrder, ["first"]);
              assert.deepEqual(persisted.interface.pinnedPageIds, ["first"]);
              assert.equal(persisted.interface.selectedPageId, "first");
              assert.deepEqual(
                persisted.pages.map((page) => page.id),
                ["first"],
              );

              yield* engine.request("window.close").pipe(Effect.catch(() => Effect.void));
              assert.equal(yield* engine.exit, 0);
            }).pipe(Effect.provide(layers));
          }),
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
