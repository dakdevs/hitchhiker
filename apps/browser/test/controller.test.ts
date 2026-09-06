import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EngineConnection,
  NativeSurface,
  type EngineEvent,
  type SurfaceEvent,
} from "@hitchhiker/runtime";
import { Deferred, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { makeBrowserController, normalizeAddressDraft } from "../src/controller.ts";

test("normalizes addresses and keeps plain search text out of engine navigation", () => {
  assert.equal(normalizeAddressDraft("example.com"), "https://example.com/");
  assert.equal(normalizeAddressDraft("https://example.test/path"), "https://example.test/path");
  assert.equal(normalizeAddressDraft("two words"), "https://duckduckgo.com/?q=two%20words");
  assert.equal(normalizeAddressDraft(""), undefined);
  assert.equal(normalizeAddressDraft("file:///private"), undefined);
});

test("filters non-page engine feedback, selects a successor, and persists the current mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-browser-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engineEvents = yield* PubSub.unbounded<EngineEvent>();
          const surfaceEvents = yield* PubSub.unbounded<SurfaceEvent>();
          const committed: unknown[] = [];
          const opened: string[] = [];
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: {} }),
            exit: Effect.never,
            events: Stream.fromPubSub(engineEvents),
            cdpEvents: Stream.empty,
            request: (method, params = {}) =>
              Effect.sync(() => {
                if (method === "pages.open" && typeof params.id === "string")
                  opened.push(params.id);
                return {};
              }),
            sendCdp: () => Effect.void,
          });
          const surface = NativeSurface.of({
            commit: (next) =>
              Effect.sync(() => committed.push(next)).pipe(Effect.as(committed.length)),
            events: Stream.fromPubSub(surfaceEvents),
          });
          const controller = yield* makeBrowserController(directory).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(EngineConnection, engine),
                Layer.succeed(NativeSurface, surface),
              ),
            ),
          );
          yield* controller.start;
          const initialCommits = committed.length;
          yield* PubSub.publish(engineEvents, { event: "ui.event", params: {} });
          yield* Effect.sleep(5);
          assert.equal(committed.length, initialCommits);

          const input = (payload: SurfaceEvent["payload"]) =>
            PubSub.publish<SurfaceEvent>(surfaceEvents, {
              surfaceId: "main",
              revision: 1,
              nodeId: "address",
              event: "input",
              payload,
            });
          yield* input({ kind: "insert_text", text: "one.test" });
          yield* Effect.sleep(25);
          yield* controller.dispatch("browser.navigate");
          yield* PubSub.publish(engineEvents, {
            event: "pages.created",
            params: { pageId: opened[0]! },
          });
          yield* Effect.sleep(5);

          yield* controller.dispatch("browser.new-page");
          yield* input({ kind: "insert_text", text: "two.test" });
          yield* Effect.sleep(25);
          yield* controller.dispatch("browser.navigate");
          yield* PubSub.publish(engineEvents, {
            event: "pages.created",
            params: { pageId: opened[1]! },
          });
          yield* Effect.sleep(5);
          yield* PubSub.publish(engineEvents, {
            event: "pages.closed",
            params: { pageId: opened[1]! },
          });
          yield* Effect.sleep(5);
          assert.deepEqual(
            Schema.decodeUnknownSync(
              Schema.Struct({
                bindings: Schema.Array(
                  Schema.Struct({ viewportId: Schema.String, pageId: Schema.String }),
                ),
              }),
            )(committed.at(-1)).bindings,
            [{ viewportId: "main-page", pageId: opened[0]! }],
          );

          yield* controller.dispatch(`page.pin:${opened[0]}`);
          const persisted = JSON.parse(
            yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
          ) as {
            interface: { pinnedPageIds: string[] };
          };
          assert.deepEqual(persisted.interface.pinnedPageIds, [opened[0]]);

          const releaseActivation = yield* Deferred.make<void>();
          let pluginCalls = 0;
          yield* controller.updatePluginControls(
            [
              {
                id: "pending-plugin",
                name: "Pending",
                version: "1.0.0",
                enabled: false,
                running: false,
              },
            ],
            () =>
              Effect.sync(() => {
                pluginCalls++;
              }).pipe(Effect.andThen(Deferred.await(releaseActivation))),
          );
          yield* controller.dispatch("interface.plugins");
          yield* controller.dispatch("plugins.enable.pending-plugin").pipe(Effect.timeout(500));
          yield* Effect.yieldNow;
          yield* controller.dispatch("plugins.enable.pending-plugin");
          assert.equal(pluginCalls, 1, "duplicate clicks must not enqueue additional activations");
          yield* controller.dispatch("screen.browser").pipe(Effect.timeout(500));
          assert(
            JSON.stringify(committed.at(-1)).includes("main-page"),
            "browsing remains responsive while a plugin starts",
          );
          yield* Deferred.succeed(releaseActivation, undefined);
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
