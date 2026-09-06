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
import { Deferred, Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeBrowserController, normalizeAddressDraft } from "../src/controller.ts";

test("normalizes addresses and keeps plain search text out of engine navigation", () => {
  assert.equal(normalizeAddressDraft("example.com"), "https://example.com/");
  assert.equal(normalizeAddressDraft("https://example.test/path"), "https://example.test/path");
  assert.equal(normalizeAddressDraft("two words"), "https://duckduckgo.com/?q=two%20words");
  assert.equal(normalizeAddressDraft(""), undefined);
  assert.equal(normalizeAddressDraft("file:///private"), undefined);
});

test("window shutdown preserves the session, while cancellation persists actual surviving pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-window-session-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<EngineEvent>();
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({
              event: "host.ready",
              params: { pageBrowserGeneration: true },
            }),
            exit: Effect.never,
            events: Stream.fromPubSub(events),
            request: () => Effect.succeed({}),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            claimRawCdp: Effect.die("unused"),
          });
          const controller = yield* makeBrowserController(directory).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(EngineConnection, engine),
                Layer.succeed(
                  NativeSurface,
                  NativeSurface.of({ events: Stream.empty, commit: () => Effect.succeed(1) }),
                ),
              ),
            ),
          );
          const emit = (event: string, params = {}) =>
            PubSub.publish(events, { event, params }).pipe(Effect.andThen(Effect.sleep(15)));
          const persistedIds = () =>
            Effect.promise(async () => {
              const value = Schema.decodeUnknownSync(
                Schema.Struct({ pages: Schema.Array(Schema.Struct({ id: Schema.String })) }),
              )(JSON.parse(await readFile(join(directory, "browser-state.json"), "utf8")));
              return value.pages.map((page) => page.id);
            });
          const expectPersisted = (expected: readonly string[]) =>
            persistedIds().pipe(
              Effect.flatMap((actual) =>
                JSON.stringify(actual) === JSON.stringify(expected)
                  ? Effect.void
                  : Effect.fail(
                      new Error(`Expected ${expected.join(",")}; got ${actual.join(",")}`),
                    ),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced(10) }),
            );
          yield* controller.start;
          const first = yield* controller.openPage("https://one.test/");
          yield* emit("pages.created", { pageId: first, generation: 1 });
          const second = yield* controller.openPage("https://two.test/");
          yield* emit("pages.created", { pageId: second, generation: 1 });
          const explicit = yield* controller.openPage("https://explicit-close.test/");
          yield* emit("pages.created", { pageId: explicit, generation: 1 });
          yield* emit("window.closing");
          yield* emit("pages.closed", {
            pageId: first,
            generation: 1,
            reason: "window-close",
            remainingPages: 2,
          });
          yield* emit("pages.closed", {
            pageId: explicit,
            generation: 1,
            reason: "page-close",
            remainingPages: 1,
          });
          yield* expectPersisted([first, second]);
          assert.equal(
            (yield* controller.snapshot).pages.find((page) => page.id === first)?.lifecycle,
            "closed",
          );
          yield* emit("window.closeCancelled");
          yield* expectPersisted([second]);
          // A late close from the cancelled batch must not leave a phantom saved tab.
          yield* emit("pages.closed", {
            pageId: second,
            generation: 1,
            reason: "window-close",
            remainingPages: 0,
          });
          yield* expectPersisted([]);
          assert.equal(yield* controller.lastError, undefined);
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
            ready: Effect.succeed({
              event: "host.ready",
              params: { pageBrowserGeneration: true },
            }),
            exit: Effect.never,
            events: Stream.fromPubSub(engineEvents),
            request: (method, params = {}) =>
              Effect.sync(() => {
                if (method === "pages.open" && typeof params.id === "string")
                  opened.push(params.id);
                return {};
              }),
            loadUnpacked: () => Effect.die("unused extension load"),
            uninstall: () => Effect.die("unused extension uninstall"),
            claimRawCdp: Effect.die("unused raw CDP claim"),
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
            params: { pageId: opened[0]!, generation: 1 },
          });
          yield* Effect.sleep(5);

          yield* controller.dispatch("browser.new-page");
          yield* input({ kind: "insert_text", text: "two.test" });
          yield* Effect.sleep(25);
          yield* controller.dispatch("browser.navigate");
          yield* PubSub.publish(engineEvents, {
            event: "pages.created",
            params: { pageId: opened[1]!, generation: 1 },
          });
          yield* Effect.sleep(5);
          yield* PubSub.publish(engineEvents, {
            event: "pages.closed",
            params: {
              pageId: opened[1]!,
              generation: 1,
              reason: "page-close",
              remainingPages: 1,
            },
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
            (operation, id) =>
              Effect.sync(() => {
                assert.equal(operation, "uninstall");
                assert.equal(id, "pending-plugin");
                pluginCalls++;
              }).pipe(Effect.andThen(Deferred.await(releaseActivation))),
          );
          yield* controller.dispatch("interface.plugins");
          assert(JSON.stringify(committed.at(-1)).includes("plugins.uninstall.pending-plugin"));
          yield* controller.dispatch("plugins.uninstall.pending-plugin").pipe(Effect.timeout(500));
          yield* Effect.yieldNow;
          yield* controller.dispatch("plugins.uninstall.pending-plugin");
          assert.equal(pluginCalls, 1, "duplicate clicks must not enqueue additional removals");
          yield* controller.dispatch("screen.browser").pipe(Effect.timeout(500));
          assert(
            JSON.stringify(committed.at(-1)).includes("main-page"),
            "browsing remains responsive while a plugin stops",
          );
          yield* Deferred.succeed(releaseActivation, undefined);
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("drops a generation-zero close while an initial browser attachment is opening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-opening-close-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<EngineEvent>();
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({
              event: "host.ready",
              params: { pageBrowserGeneration: true },
            }),
            exit: Effect.never,
            events: Stream.fromPubSub(events),
            request: () => Effect.succeed({}),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            claimRawCdp: Effect.die("unused"),
          });
          const controller = yield* makeBrowserController(directory).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(EngineConnection, engine),
                Layer.succeed(
                  NativeSurface,
                  NativeSurface.of({ events: Stream.empty, commit: () => Effect.succeed(1) }),
                ),
              ),
            ),
          );
          yield* controller.start;
          const failed = yield* controller.openPage("https://failed.test/");
          yield* PubSub.publish(events, {
            event: "pages.closed",
            params: { pageId: failed, generation: 0, reason: "page-close", remainingPages: 0 },
          });
          yield* Effect.yieldNow;
          assert.equal((yield* controller.snapshot).pages.length, 0);

          const next = yield* controller.openPage("https://next.test/");
          yield* PubSub.publish(events, {
            event: "pages.created",
            params: { pageId: next, generation: 1 },
          });
          yield* Effect.yieldNow;
          assert.equal((yield* controller.snapshot).pages[0]?.id, next);
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a logical page and its persistence through replacement while rejecting stale generations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-browser-replacement-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<EngineEvent>();
          const requests: Array<{
            readonly method: string;
            readonly params: Record<string, unknown>;
          }> = [];
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({
              event: "host.ready",
              params: { pageBrowserGeneration: true, pageResourceSignals: true },
            }),
            exit: Effect.never,
            events: Stream.fromPubSub(events),
            request: (method, params = {}) =>
              Effect.sync(() => {
                requests.push({ method, params });
                return {};
              }),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            claimRawCdp: Effect.die("unused"),
          });
          const controller = yield* makeBrowserController(directory).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(EngineConnection, engine),
                Layer.succeed(
                  NativeSurface,
                  NativeSurface.of({ events: Stream.empty, commit: () => Effect.succeed(1) }),
                ),
              ),
            ),
          );
          const emit = (event: string, params: EngineEvent["params"]) =>
            PubSub.publish(events, { event, params }).pipe(Effect.andThen(Effect.sleep(10)));

          yield* controller.start;
          const id = yield* controller.openPage("https://one.test/");
          yield* emit("pages.created", { pageId: id, generation: 1 });
          yield* emit("pages.documentCommitted", { pageId: id, generation: 1 });
          yield* emit("pages.resourcesChanged", {
            pageId: id,
            generation: 1,
            known: true,
            audio: false,
            call: false,
            download: false,
            unsavedInput: false,
          });
          yield* controller.dispatch(`page.pin:${id}`);
          yield* emit("pages.navigationChanged", {
            pageId: id,
            generation: 1,
            url: "https://current.test/",
            loading: false,
            canGoBack: true,
            canGoForward: false,
          });
          yield* emit("pages.browserUnavailable", { pageId: id, generation: 1 });
          yield* emit("pages.titleChanged", { pageId: id, generation: 1, title: "stale" });
          yield* emit("pages.replaced", {
            pageId: id,
            generation: 2,
            previousGeneration: 1,
          });
          yield* emit("pages.navigationChanged", {
            pageId: id,
            generation: 1,
            url: "https://stale.test/",
            loading: false,
            canGoBack: false,
            canGoForward: false,
          });
          yield* emit("pages.resourcesChanged", {
            pageId: id,
            generation: 1,
            known: true,
            audio: false,
            call: false,
            download: false,
            unsavedInput: false,
          });

          const page = (yield* controller.snapshot).pages.find((entry) => entry.id === id);
          assert.equal(page?.url, "https://current.test/");
          assert.equal(page?.title, "https://one.test/");
          assert.deepEqual(page?.protections, {
            audio: true,
            call: true,
            download: true,
            unsavedInput: true,
          });
          assert.equal(
            requests.some((request) => request.method === "pages.reload"),
            false,
            "replacement must not reload automatically",
          );
          const persisted = JSON.parse(
            yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
          ) as {
            interface: { pinnedPageIds: string[] };
            pages: Array<{ id: string; url: string }>;
          };
          assert.deepEqual(persisted.interface.pinnedPageIds, [id]);
          assert.deepEqual(
            persisted.pages.map((entry) => ({ id: entry.id, url: entry.url })),
            [{ id, url: "https://current.test/" }],
          );

          yield* controller.dispatch("browser.reload");
          assert.deepEqual(requests.at(-1), { method: "pages.reload", params: { id } });
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("freezing requires idle navigation and protects pending scoped DOM writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-browser-dom-protection-"));
  const originalNow = Date.now;
  let testNow = 0;
  Date.now = () => testNow;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engineEvents = yield* PubSub.unbounded<EngineEvent>();
          const surfaceEvents = yield* PubSub.unbounded<SurfaceEvent>();
          const opened: string[] = [];
          const lifecycle: Array<{ readonly pageId: string; readonly state: string }> = [];
          let rendered: Deferred.Deferred<void> | undefined;
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({
              event: "host.ready",
              params: { pageResourceSignals: true, pageBrowserGeneration: true },
            }),
            exit: Effect.never,
            events: Stream.fromPubSub(engineEvents),
            request: (method, params = {}) =>
              Effect.sync(() => {
                if (method === "pages.open" && typeof params.id === "string")
                  opened.push(params.id);
                if (
                  method === "cdp.send" &&
                  typeof params.pageId === "string" &&
                  params.method === "Page.setWebLifecycleState" &&
                  params.params !== null &&
                  typeof params.params === "object" &&
                  !Array.isArray(params.params)
                ) {
                  const lifecycleParams = params.params as Record<string, unknown>;
                  if (typeof lifecycleParams.state === "string")
                    lifecycle.push({ pageId: params.pageId, state: lifecycleParams.state });
                }
                return {};
              }),
            loadUnpacked: () => Effect.die("unused extension load"),
            uninstall: () => Effect.die("unused extension uninstall"),
            claimRawCdp: Effect.die("unused raw CDP claim"),
          });
          const surface = NativeSurface.of({
            commit: () =>
              rendered
                ? Deferred.succeed(rendered, undefined).pipe(Effect.as(1))
                : Effect.succeed(1),
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
          const emitRendered = Effect.fn("test.emitRendered")(function* (
            event: string,
            params: EngineEvent["params"],
          ) {
            rendered = yield* Deferred.make<void>();
            yield* PubSub.publish(engineEvents, { event, params });
            yield* Deferred.await(rendered);
            rendered = undefined;
          });
          for (const url of ["https://one.test", "https://two.test", "https://three.test"])
            yield* controller.openPage(url);
          for (const id of opened) {
            yield* emitRendered("pages.created", { pageId: id, generation: 1 });
            yield* emitRendered("pages.documentCommitted", { pageId: id, generation: 1 });
            yield* PubSub.publish(engineEvents, {
              event: "pages.resourcesChanged",
              params: {
                pageId: id,
                generation: 1,
                known: true,
                audio: false,
                call: false,
                download: false,
                unsavedInput: false,
              },
            });
          }
          yield* Effect.yieldNow;
          yield* controller.configure({
            colorScheme: "system",
            sleepAfterMs: 10_000,
            alwaysAwakeOrigins: [],
          });
          testNow = 20_000;
          yield* controller.protectDomWrite(opened[1]!);
          yield* TestClock.adjust(1_000);
          yield* Effect.yieldNow;
          assert.equal(lifecycle.length, 0, "unknown loading state must prevent freezing");
          const navigation = (generation: number, loading: boolean, url = "https://three.test/") =>
            emitRendered("pages.navigationChanged", {
              pageId: opened[2]!,
              generation,
              loading,
              url,
              canGoBack: false,
              canGoForward: false,
            });
          yield* navigation(1, true, "");
          yield* TestClock.adjust(1_000);
          yield* Effect.yieldNow;
          assert.equal(lifecycle.length, 0, "loading must prevent freezing even with an empty URL");
          // Establish navigation knowledge for the DOM-protected page too, so
          // its absence below proves DOM protection rather than unknown loading.
          yield* emitRendered("pages.navigationChanged", {
            pageId: opened[1]!,
            generation: 1,
            loading: false,
            url: "https://two.test/",
            canGoBack: false,
            canGoForward: false,
          });
          yield* navigation(1, false);
          yield* TestClock.adjust(1_000);
          yield* Effect.yieldNow;
          assert.deepEqual(lifecycle, [{ pageId: opened[2]!, state: "frozen" }]);
          assert.equal(
            (yield* controller.snapshot).pages.find((page) => page.id === opened[1])?.lifecycle,
            "loaded",
          );
          yield* navigation(1, true, "");
          yield* TestClock.adjust(1_000);
          yield* Effect.yieldNow;
          assert.deepEqual(
            lifecycle.map((entry) => entry.state),
            ["frozen", "active"],
          );
          assert.equal(
            (yield* controller.snapshot).pages.find((page) => page.id === opened[2])?.lifecycle,
            "loaded",
          );
          testNow = 40_000;
          yield* TestClock.adjust(1_000);
          yield* Effect.yieldNow;
          assert.equal(
            lifecycle.length,
            2,
            "loading remains protected after the inactivity threshold",
          );
          yield* navigation(1, false);
          yield* TestClock.adjust(1_000);
          yield* Effect.yieldNow;
          assert.deepEqual(
            lifecycle.map((entry) => entry.state),
            ["frozen", "active", "frozen"],
          );
          yield* emitRendered("pages.replaced", {
            pageId: opened[2]!,
            generation: 2,
            previousGeneration: 1,
          });
          yield* Effect.yieldNow;
          yield* navigation(1, false);
          yield* TestClock.adjust(1_000);
          yield* Effect.yieldNow;
          assert.deepEqual(
            lifecycle,
            ["frozen", "active", "frozen"].map((state) => ({ pageId: opened[2]!, state })),
            "a replacement without current resources must stay ineligible for freezing",
          );
          assert.equal(
            (yield* controller.snapshot).pages.find((page) => page.id === opened[2])?.lifecycle,
            "loaded",
          );
          yield* emitRendered("pages.documentCommitted", { pageId: opened[2]!, generation: 2 });
          yield* PubSub.publish(engineEvents, {
            event: "pages.resourcesChanged",
            params: {
              pageId: opened[2]!,
              generation: 2,
              known: true,
              audio: false,
              call: false,
              download: false,
              unsavedInput: false,
            },
          });
          yield* navigation(1, false);
          yield* TestClock.adjust(1_000);
          yield* Effect.yieldNow;
          assert.equal(
            lifecycle.length,
            3,
            "retired navigation must not clear current loading protection",
          );
          yield* navigation(2, false);
          yield* TestClock.adjust(1_000);
          yield* Effect.yieldNow;
          assert.deepEqual(
            lifecycle.map((entry) => entry.state),
            ["frozen", "active", "frozen", "frozen"],
          );
          assert.equal(yield* controller.lastError, undefined);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    Date.now = originalNow;
    await rm(directory, { recursive: true, force: true });
  }
});
