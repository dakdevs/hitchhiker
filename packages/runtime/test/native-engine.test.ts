import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context, Effect, Fiber, Layer, Option, Schedule, Schema, Stream } from "effect";
import { EngineConnection, EngineError } from "../src/engine.ts";
import { openCdpRelay } from "../src/cdp-relay.ts";
import { chromium } from "playwright-core";
import { NodeServices } from "@effect/platform-node";
import { create as createGrantStore } from "../src/grants.ts";
import { NativeSurface } from "../src/surface.ts";
import { row, column, text, viewport as pageViewport } from "@hitchhiker/ui";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
const decodeValue = Schema.decodeUnknownEffect(Value);
const viewportBounds = Schema.decodeUnknownOption(
  Schema.Struct({ width: Schema.Number, height: Schema.Number }),
);

test(
  "real Chromium private IPC, browser-root CDP and separate profile storage",
  { skip: !binary, timeout: 60_000 },
  async () => {
    if (!binary) return;
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-engine-"));
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><title>Hitchhiker transport fixture</title><input id="input"><script>globalThis.fixtureReady=true;</script>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/`;
    const evaluate = Effect.fn("test.evaluate")(function* (
      engine: EngineConnection["Service"],
      pageId: string,
      expression: string,
    ) {
      const raw = yield* engine.request("cdp.send", {
        pageId,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      });
      const result = yield* decodeValue(raw);
      return result.result.value;
    });
    const loaded = Effect.fn("test.loaded")(
      function* (engine: EngineConnection["Service"], pageId: string) {
        const ready = yield* evaluate(engine, pageId, "globalThis.fixtureReady === true");
        if (!ready)
          return yield* new EngineError({ code: "loading", message: "Fixture not loaded" });
      },
      Effect.retry({ times: 100, schedule: Schedule.spaced(50) }),
    );
    const close = Effect.fn("test.close")(function* (engine: EngineConnection["Service"]) {
      // Root teardown can complete before its queued acknowledgement flushes.
      yield* engine.request("window.close").pipe(Effect.catch(() => Effect.void));
      assert.equal(yield* engine.exit, 0);
    });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const first = yield* EngineConnection;
          yield* first.ready;
          assert.deepEqual(yield* first.request("pages.list"), []);
          yield* first.request("pages.open", { id: "first", url });
          yield* loaded(first, "first");
          const viewport = yield* first.events.pipe(
            Stream.filter((event) => {
              const bounds = viewportBounds(event.params.payload);
              return (
                event.event === "ui.event" &&
                event.params.event === "viewport" &&
                event.params.revision === 1 &&
                Option.isSome(bounds) &&
                bounds.value.width > 0 &&
                bounds.value.height > 0
              );
            }),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          const root = row("root", [
            column("sidebar", [text("brand", "Hitchhiker")], { width: 260 }),
            pageViewport("page-region", "main-page", { flex: 1 }),
          ]);
          const nativeSurface = Context.get(yield* Layer.build(NativeSurface.layer), NativeSurface);
          yield* nativeSurface.commit({
            root,
            bindings: [{ viewportId: "main-page", pageId: "first" }],
          });
          const measured = yield* Fiber.join(viewport).pipe(Effect.timeout(5000));
          assert.equal(measured.length, 1);
          assert.equal(measured[0].params.nodeId, "page-region");
          const region = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              viewportId: Schema.String,
              x: Schema.Number,
              y: Schema.Number,
              width: Schema.Number,
              height: Schema.Number,
            }),
          )(measured[0].params.payload);
          assert.equal(region.viewportId, "main-page");
          assert.ok(region.width > 0 && region.height > 0);
          assert.equal(
            yield* nativeSurface
              .commit({ root, bindings: [{ viewportId: "unknown", pageId: "first" }] })
              .pipe(Effect.isFailure),
            true,
          );
          yield* first.request("viewports.set", {
            viewports: [{ pageId: "first", x: 260, y: 0, width: 400, height: 400 }],
          });
          assert.equal(
            yield* evaluate(
              first,
              "first",
              "document.querySelector('#input').value='persistent'; document.cookie='hitchhiker_probe=one; SameSite=Strict';localStorage.setItem('probe','one');true",
            ),
            true,
          );
          const response = yield* first.cdpEvents.pipe(
            Stream.filter((event) => event.id === 31),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* first.sendCdp({ id: 31, method: "Browser.getVersion" });
          const versions = yield* Fiber.join(response).pipe(Effect.timeout(5000));
          assert.equal(versions.length, 1);
          assert.ok("result" in versions[0]);
          yield* Effect.gen(function* () {
            const store = yield* createGrantStore({ directory: join(directory, "grants") });
            const issued = yield* store.issue({
              principal: "native-test",
              profileId: "first",
              capabilities: ["cdp.connect"],
              origins: [],
            });
            const relay = yield* openCdpRelay({
              engine: first,
              principal: issued.grant.principal,
              authorize: () =>
                store
                  .authorize(issued.token, { profileId: "first", capability: "cdp.connect" })
                  .pipe(
                    Effect.map(() => true),
                    Effect.catch(() => Effect.succeed(false)),
                  ),
              authorizationRecheckMs: 50,
            });
            yield* store.revocations.pipe(
              Stream.filter((event) => event.id === issued.grant.id),
              Stream.runForEach(() => relay.revoke),
              Effect.forkScoped,
            );
            yield* Effect.yieldNow;
            const browser = yield* Effect.acquireRelease(
              Effect.promise(() => chromium.connectOverCDP(relay.url, { timeout: 5000 })),
              (client) =>
                Effect.promise(() => client.close()).pipe(Effect.catch(() => Effect.void)),
            );
            const page = browser
              .contexts()
              .flatMap((context) => context.pages())
              .find((candidate) => candidate.url() === url);
            assert.ok(page, "standard CDP client discovers the existing CEF page");
            assert.equal(yield* Effect.promise(() => page.title()), "Hitchhiker transport fixture");
            assert.equal(
              yield* Effect.promise(() => page.locator("#input").inputValue()),
              "persistent",
            );
            yield* Effect.promise(() => page.locator("#input").fill("via-playwright"));
            yield* store.revoke(issued.grant.id);
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  if (!browser.isConnected()) return resolve();
                  const timer = setTimeout(
                    () => reject(new Error("Revoked CDP client remained connected")),
                    3000,
                  );
                  browser.once("disconnected", () => {
                    clearTimeout(timer);
                    resolve();
                  });
                }),
            );
          }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
          yield* Effect.gen(function* () {
            const second = yield* EngineConnection;
            yield* second.ready;
            yield* second.request("pages.open", { id: "second", url });
            yield* loaded(second, "second");
            assert.equal(
              yield* evaluate(
                second,
                "second",
                "document.cookie + ':' + (localStorage.getItem('probe') ?? '')",
              ),
              ":",
            );
            assert.equal(
              yield* evaluate(first, "first", "document.querySelector('#input').value"),
              "via-playwright",
            );
            yield* close(second);
          }).pipe(
            Effect.provide(
              EngineConnection.layer({
                executable: binary,
                profileRoot: join(directory, "second"),
              }),
            ),
            Effect.scoped,
          );
          yield* close(first);
          // macOS /var and /private/var name the same profile. Both CEF cache paths
          // must be canonicalized or the first launch silently uses memory storage.
          yield* Effect.gen(function* () {
            const restored = yield* EngineConnection;
            yield* restored.ready;
            yield* restored.request("pages.open", { id: "restored", url });
            yield* loaded(restored, "restored");
            assert.equal(
              yield* evaluate(restored, "restored", "localStorage.getItem('probe')"),
              "one",
            );
            yield* close(restored);
          }).pipe(
            Effect.provide(
              EngineConnection.layer({ executable: binary, profileRoot: join(directory, "first") }),
            ),
            Effect.scoped,
          );
        }).pipe(
          Effect.provide(
            EngineConnection.layer({ executable: binary, profileRoot: join(directory, "first") }),
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
