import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EngineConnection,
  EngineError,
  NativeSurface,
  type EngineEvent,
  type SurfaceEvent,
} from "@hitchhiker/runtime";
import { defaultConfiguration } from "@hitchhiker/core";
import { createDefaultInterface } from "@hitchhiker/default-interface";
import { Deferred, Effect, Fiber, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeBrowserController, normalizeAddressDraft } from "../src/controller.ts";
import { ProfileWriteLeaseError } from "../src/profile-write-lease.ts";
import { saveBrowserPersistence } from "../src/persistence.ts";
import { browserMcpApi } from "../src/mcp.ts";

const waitUntil = (label: string, condition: Effect.Effect<boolean, unknown>) =>
  condition.pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail(new Error(label)))),
    Effect.retry({ times: 100, schedule: Schedule.spaced(10) }),
  );

test("normalizes addresses and keeps plain search text out of engine navigation", () => {
  assert.equal(normalizeAddressDraft("example.com"), "https://example.com/");
  assert.equal(normalizeAddressDraft("https://example.test/path"), "https://example.test/path");
  assert.equal(normalizeAddressDraft("two words"), "https://duckduckgo.com/?q=two%20words");
  assert.equal(normalizeAddressDraft(""), undefined);
  assert.equal(normalizeAddressDraft("file:///private"), undefined);
});

test("restoration settles for an empty profile and propagates startup or host failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-restore-barrier-"));
  try {
    for (const scenario of ["empty", "startup-failure", "host-exit", "closed"] as const) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const exited = yield* Deferred.make<number>();
            const engine = EngineConnection.of({
              pid: 1,
              ready:
                scenario === "startup-failure"
                  ? Effect.fail(new EngineError({ code: "ready-failed", message: "Not ready" }))
                  : Effect.succeed({
                      event: "host.ready",
                      params: { pageBrowserGeneration: true },
                    }),
              exit: Deferred.await(exited),
              events: Stream.never,
              request: () => Effect.succeed({}),
              loadUnpacked: () => Effect.die("unused"),
              uninstall: () => Effect.die("unused"),
              openCdpSession: () => Effect.die("unused managed CDP session"),
              claimRawCdp: Effect.die("unused"),
            });
            let commits = 0;
            const create = makeBrowserController(directory).pipe(
              Effect.provide(
                Layer.merge(
                  Layer.succeed(EngineConnection, engine),
                  Layer.succeed(
                    NativeSurface,
                    NativeSurface.of({
                      commit: () => Effect.sync(() => ++commits),
                      events: Stream.empty,
                    }),
                  ),
                ),
              ),
            );
            const controller = yield* scenario === "closed" ? Effect.scoped(create) : create;
            if (scenario === "empty") {
              yield* controller.start;
              yield* controller.restored;
              assert.equal(commits, 1);
              assert.deepEqual((yield* controller.snapshot).pages, []);
              assert.deepEqual(yield* controller.restoredPageInventory, {
                pageIds: [],
                pageOrder: [],
              });
            } else {
              if (scenario === "startup-failure") yield* Effect.exit(controller.start);
              if (scenario === "host-exit") yield* Deferred.succeed(exited, 0);
              const error = yield* controller.restored.pipe(
                Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }),
              );
              assert.equal(
                error?.code,
                scenario === "startup-failure"
                  ? "ready-failed"
                  : scenario === "host-exit"
                    ? "restore-exit"
                    : "restore-closed",
              );
              const inventoryError = yield* controller.restoredPageInventory.pipe(
                Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }),
              );
              assert.equal(inventoryError?.code, error?.code);
            }
          }),
        ).pipe(Effect.timeout(3000)),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plugin interface mode keeps page lifecycle while withholding legacy UI and retiring its V1 seed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-controller-"));
  try {
    await Effect.runPromise(
      saveBrowserPersistence(directory, {
        configuration: defaultConfiguration,
        interfaceConfiguration: { tabPlacement: "top" },
        interfaceState: {
          ...createDefaultInterface("default"),
          selectedPageId: "restored",
          pageOrder: ["restored"],
          pinnedPageIds: ["restored"],
        },
        pages: [{ id: "restored", url: "https://restored.test/", title: "Restored" }],
      }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<EngineEvent>();
          const commits: unknown[] = [];
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: { pageBrowserGeneration: true } }),
            exit: Effect.never,
            events: Stream.fromPubSub(events),
            request: (method, params = {}) =>
              Effect.gen(function* () {
                if (method !== "pages.open" || typeof params.id !== "string") return {};
                yield* PubSub.publish(events, {
                  event: "pages.created",
                  params: { pageId: params.id, generation: 1 },
                });
                yield* PubSub.publish(events, {
                  event: "pages.documentCommitted",
                  params: { pageId: params.id, generation: 1 },
                });
                yield* PubSub.publish(events, {
                  event: "pages.navigationChanged",
                  params: {
                    pageId: params.id,
                    generation: 1,
                    url: params.url,
                    loading: false,
                    canGoBack: false,
                    canGoForward: false,
                  },
                });
                return {};
              }),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            openCdpSession: () => Effect.die("unused managed CDP session"),
            claimRawCdp: Effect.die("unused"),
          });
          const controller = yield* makeBrowserController(directory, {
            interfaceMode: "plugins",
          }).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(EngineConnection, engine),
                Layer.succeed(
                  NativeSurface,
                  NativeSurface.of({
                    commit: (surface) =>
                      Effect.sync(() => commits.push(surface)).pipe(Effect.as(commits.length)),
                    events: Stream.empty,
                  }),
                ),
              ),
            ),
          );
          yield* controller.start;
          const mcp = browserMcpApi(controller);
          assert.equal(mcp.customization, undefined);
          assert.equal((yield* Effect.exit(mcp.setTabPlacement("top")))._tag, "Failure");

          yield* controller.restored;
          const recovery = JSON.stringify(commits.at(-1));
          assert.match(recovery, /plugin-recovery-status/);
          assert.doesNotMatch(recovery, /interface\.settings|browser\.new-page|plugin-management/);
          const beforeDispatch = commits.length;
          yield* controller.dispatch("interface.settings");
          assert.equal(commits.length, beforeDispatch);

          yield* controller.openPage("https://opened.test/");
          yield* waitUntil(
            "generic page opening in plugin mode",
            controller.snapshot.pipe(Effect.map((snapshot) => snapshot.pages.length === 2)),
          );
          assert.deepEqual(
            (yield* controller.snapshot).pages.map((page) => page.id),
            ["restored", (yield* controller.snapshot).pages[1]!.id],
          );

          yield* controller.retireLegacyBootstrapSeed();
          const persisted = JSON.parse(
            yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
          );
          assert.equal(persisted.version, 2);
          assert.equal("legacyBootstrapSeed" in persisted, false);
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores a complete session before its first persistence and render", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-restore-staging-"));
  try {
    await Effect.runPromise(
      saveBrowserPersistence(directory, {
        configuration: defaultConfiguration,
        interfaceConfiguration: { tabPlacement: "sidebar" },
        interfaceState: {
          ...createDefaultInterface("default"),
          selectedPageId: "first",
          pageOrder: ["first", "second", "third"],
          pinnedPageIds: [],
        },
        pages: [
          { id: "first", url: "https://first.test/", title: "First" },
          { id: "second", url: "https://second.test/", title: "Second" },
          { id: "third", url: "https://third.test/", title: "Third" },
        ],
      }),
    );
    const initialPersistence = await readFile(join(directory, "browser-state.json"));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<EngineEvent>();
          const commits: unknown[] = [];
          const opened: string[] = [];
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: { pageBrowserGeneration: true } }),
            exit: Effect.never,
            events: Stream.fromPubSub(events),
            request: (method, params = {}) =>
              Effect.gen(function* () {
                if (method !== "pages.open" || typeof params.id !== "string") return {};
                opened.push(params.id);
                if (params.id !== "third") {
                  yield* PubSub.publish(events, {
                    event: "pages.created",
                    params: { pageId: params.id, generation: 1 },
                  });
                  yield* PubSub.publish(events, {
                    event: "pages.documentCommitted",
                    params: { pageId: params.id, generation: 1 },
                  });
                  if (params.id === "first")
                    yield* PubSub.publish(events, {
                      event: "pages.titleChanged",
                      params: { pageId: params.id, generation: 1, title: "Updated first" },
                    });
                  yield* PubSub.publish(events, {
                    event: "pages.navigationChanged",
                    params: {
                      pageId: params.id,
                      generation: 1,
                      url: params.id === "first" ? "https://first.test/" : "https://second.test/",
                      loading: false,
                      canGoBack: false,
                      canGoForward: false,
                    },
                  });
                }
                return {};
              }),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            openCdpSession: () => Effect.die("unused managed CDP session"),
            claimRawCdp: Effect.die("unused"),
          });
          const surface = NativeSurface.of({
            commit: (next) => Effect.sync(() => commits.push(next)).pipe(Effect.as(commits.length)),
            events: Stream.empty,
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
          const restorationObserved = yield* Deferred.make<void>();
          yield* controller.restored.pipe(
            Effect.andThen(Deferred.succeed(restorationObserved, undefined)),
            Effect.forkScoped,
          );
          const inventory = yield* controller.restoredPageInventory.pipe(Effect.forkScoped);
          yield* waitUntil(
            "restored page opens",
            Effect.sync(() => opened.length === 3),
          );
          yield* waitUntil(
            "restored lifecycle events",
            controller.snapshot.pipe(
              Effect.map(
                (snapshot) =>
                  snapshot.pages.find((page) => page.id === "first")?.title === "Updated first",
              ),
            ),
          );
          assert.deepEqual(opened, ["first", "second", "third"]);
          assert.equal(commits.length, 0, "partial restored pages must not render");
          assert.equal(yield* Deferred.isDone(restorationObserved), false);
          assert.equal(inventory.pollUnsafe(), undefined, "partial pages must not seed plugins");
          assert.deepEqual(
            yield* Effect.promise(() => readFile(join(directory, "browser-state.json"))),
            initialPersistence,
            "early lifecycle changes must not write a partial restore",
          );
          const beforeFinalPageIds = JSON.parse(
            yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
          ).pages.map((page: { id: string }) => page.id);
          assert.deepEqual(beforeFinalPageIds, ["first", "second", "third"]);

          yield* PubSub.publish(events, {
            event: "pages.created",
            params: { pageId: "third", generation: 1 },
          });
          yield* Deferred.await(restorationObserved);
          yield* waitUntil(
            "completed restore render",
            Effect.sync(() => commits.length === 1),
          );
          assert.equal(commits.length, 1, "the completed restore renders once");
          assert.deepEqual(
            (yield* controller.snapshot).pages.map((page) => page.id),
            ["first", "second", "third"],
          );
          assert.deepEqual(yield* Fiber.join(inventory), {
            pageIds: ["first", "second", "third"],
            pageOrder: ["first", "second", "third"],
          });
          yield* waitUntil(
            "completed restore persistence",
            Effect.promise(
              async () =>
                JSON.parse(
                  await readFile(join(directory, "browser-state.json"), "utf8"),
                ).pages.find((page: { id: string }) => page.id === "first")?.title ===
                "Updated first",
            ),
          );
          const rendered = JSON.stringify(commits[0]);
          assert.match(rendered, /"value":"https:\/\/first\.test\/"/);
          assert.doesNotMatch(rendered, /"value":"https:\/\/third\.test\/"/);
          assert.equal(
            JSON.parse(
              yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
            ).pages.find((page: { id: string }) => page.id === "first")?.title,
            "Updated first",
          );
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore drains a bounded lifecycle queue while pages.open is still resolving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-restore-liveness-"));
  try {
    await Effect.runPromise(
      saveBrowserPersistence(directory, {
        configuration: defaultConfiguration,
        interfaceConfiguration: { tabPlacement: "sidebar" },
        interfaceState: {
          ...createDefaultInterface("default"),
          selectedPageId: "first",
          pageOrder: ["first"],
          pinnedPageIds: [],
        },
        pages: [{ id: "first", url: "https://first.test/", title: "First" }],
      }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.bounded<EngineEvent>({ capacity: 1 });
          const finishRequest = yield* Deferred.make<void>();
          const requestEventsSent = yield* Deferred.make<void>();
          const restorationObserved = yield* Deferred.make<void>();
          const commits: unknown[] = [];
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: { pageBrowserGeneration: true } }),
            exit: Effect.never,
            events: Stream.fromPubSub(events),
            request: (method, params = {}) =>
              Effect.gen(function* () {
                if (method !== "pages.open" || typeof params.id !== "string") return {};
                yield* PubSub.publish(events, {
                  event: "pages.created",
                  params: { pageId: params.id, generation: 1 },
                });
                yield* PubSub.publish(events, {
                  event: "pages.documentCommitted",
                  params: { pageId: params.id, generation: 1 },
                });
                yield* PubSub.publish(events, {
                  event: "pages.navigationChanged",
                  params: {
                    pageId: params.id,
                    generation: 1,
                    url: "https://first.test/",
                    loading: false,
                    canGoBack: false,
                    canGoForward: false,
                  },
                });
                yield* Deferred.succeed(requestEventsSent, undefined);
                yield* Deferred.await(finishRequest);
                return {};
              }),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            openCdpSession: () => Effect.die("unused managed CDP session"),
            claimRawCdp: Effect.die("unused"),
          });
          const surface = NativeSurface.of({
            commit: (next) => Effect.sync(() => commits.push(next)).pipe(Effect.as(commits.length)),
            events: Stream.empty,
          });
          const controller = yield* makeBrowserController(directory).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(EngineConnection, engine),
                Layer.succeed(NativeSurface, surface),
              ),
            ),
          );
          yield* Effect.yieldNow;
          const started = yield* Deferred.make<void, EngineError>();
          yield* Deferred.complete(started, controller.start).pipe(Effect.forkScoped);
          yield* controller.restored.pipe(
            Effect.andThen(Deferred.succeed(restorationObserved, undefined)),
            Effect.forkScoped,
          );
          yield* Deferred.await(requestEventsSent).pipe(Effect.timeout(500));
          yield* waitUntil(
            "restored page render",
            Effect.sync(() => commits.length > 0),
          );
          assert.equal(yield* Deferred.isDone(restorationObserved), false);
          yield* Deferred.succeed(finishRequest, undefined);
          yield* Deferred.await(started);
          yield* Deferred.await(restorationObserved);
          assert.deepEqual(
            (yield* controller.snapshot).pages.map((page) => page.id),
            ["first"],
          );
          assert.ok(commits.length > 0);
          assert.deepEqual(
            JSON.parse(
              yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
            ).pages.map((page: { id: string }) => page.id),
            ["first"],
          );
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a canceled close retries only the interrupted restored page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-restore-close-cancel-"));
  try {
    await Effect.runPromise(
      saveBrowserPersistence(directory, {
        configuration: defaultConfiguration,
        interfaceConfiguration: { tabPlacement: "sidebar" },
        interfaceState: {
          ...createDefaultInterface("default"),
          selectedPageId: "first",
          pageOrder: ["first", "second", "third"],
          pinnedPageIds: [],
        },
        pages: [
          { id: "first", url: "https://first.test/", title: "First" },
          { id: "second", url: "https://second.test/", title: "Second" },
          { id: "third", url: "https://third.test/", title: "Third" },
        ],
      }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const testScope = yield* Effect.scope;
          const events = yield* PubSub.unbounded<EngineEvent>();
          const opened: string[] = [];
          let secondAttempts = 0;
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: { pageBrowserGeneration: true } }),
            exit: Effect.never,
            events: Stream.fromPubSub(events),
            request: (method, params = {}) =>
              Effect.gen(function* () {
                if (method !== "pages.open" || typeof params.id !== "string") return {};
                opened.push(params.id);
                if (params.id === "second" && secondAttempts++ === 0) {
                  yield* PubSub.publish(events, { event: "window.closing", params: {} });
                  yield* Effect.forkIn(
                    Effect.sleep(10).pipe(
                      Effect.andThen(
                        PubSub.publish(events, { event: "window.closeCancelled", params: {} }),
                      ),
                    ),
                    testScope,
                  );
                  return yield* new EngineError({ code: "-32003", message: "Window is closing" });
                }
                yield* PubSub.publish(events, {
                  event: "pages.created",
                  params: { pageId: params.id, generation: 1 },
                });
                return {};
              }),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            openCdpSession: () => Effect.die("unused managed CDP session"),
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
          yield* controller.start.pipe(Effect.timeout(1_000));
          yield* waitUntil(
            "cancelled restored-page retry",
            Effect.sync(
              () =>
                JSON.stringify(opened) === JSON.stringify(["first", "second", "second", "third"]),
            ),
          );
          yield* waitUntil(
            "cancelled restored-page attachment",
            controller.snapshot.pipe(
              Effect.map(
                (snapshot) =>
                  JSON.stringify(snapshot.pages.map((page) => page.id)) ===
                  JSON.stringify(["first", "second", "third"]),
              ),
            ),
          );
          yield* controller.dispatch("page.pin:first");
          yield* waitUntil(
            "cancelled restore persistence",
            Effect.promise(
              async () =>
                JSON.parse(await readFile(join(directory, "browser-state.json"), "utf8")).interface
                  .pinnedPageIds?.[0] === "first",
            ),
          );
          assert.deepEqual(opened, ["first", "second", "second", "third"]);
          assert.deepEqual(
            (yield* controller.snapshot).pages.map((page) => page.id),
            ["first", "second", "third"],
          );
          assert.deepEqual(
            JSON.parse(
              yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
            ).pages.map((page: { id: string }) => page.id),
            ["first", "second", "third"],
          );
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a non-close pages.open error remains fatal during restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-restore-open-error-"));
  try {
    await Effect.runPromise(
      saveBrowserPersistence(directory, {
        configuration: defaultConfiguration,
        interfaceConfiguration: { tabPlacement: "sidebar" },
        interfaceState: createDefaultInterface("default"),
        pages: [{ id: "first", url: "https://first.test/", title: "First" }],
      }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let opens = 0;
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: { pageBrowserGeneration: true } }),
            exit: Effect.never,
            events: Stream.empty,
            request: () =>
              Effect.sync(() => {
                opens += 1;
              }).pipe(Effect.andThen(new EngineError({ code: "transport", message: "Timed out" }))),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            openCdpSession: () => Effect.die("unused managed CDP session"),
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
          const error = yield* controller.start.pipe(Effect.flip);
          assert.equal(error.code, "transport");
          assert.equal((yield* controller.restored.pipe(Effect.flip)).code, "transport");
          assert.equal(opens, 1);
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a close rejection followed by clean host exit preserves staged restore metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-restore-clean-exit-"));
  try {
    await Effect.runPromise(
      saveBrowserPersistence(directory, {
        configuration: defaultConfiguration,
        interfaceConfiguration: { tabPlacement: "sidebar" },
        interfaceState: {
          ...createDefaultInterface("default"),
          pageOrder: ["first", "second"],
        },
        pages: [
          { id: "first", url: "https://first.test/", title: "First" },
          { id: "second", url: "https://second.test/", title: "Second" },
        ],
      }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let opens = 0;
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: { pageBrowserGeneration: true } }),
            exit: Effect.succeed(0),
            events: Stream.empty,
            request: () =>
              Effect.sync(() => {
                opens += 1;
              }).pipe(
                Effect.andThen(new EngineError({ code: "-32003", message: "Window is closing" })),
              ),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            openCdpSession: () => Effect.die("unused managed CDP session"),
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
          yield* controller.start.pipe(Effect.timeout(500));
          assert.equal(opens, 1);
          assert.deepEqual(
            JSON.parse(
              yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
            ).pages.map((page: { id: string }) => page.id),
            ["first", "second"],
          );
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutdown during restore retains every unresolved opening page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-restore-shutdown-"));
  try {
    await Effect.runPromise(
      saveBrowserPersistence(directory, {
        configuration: defaultConfiguration,
        interfaceConfiguration: { tabPlacement: "sidebar" },
        interfaceState: {
          ...createDefaultInterface("default"),
          selectedPageId: "first",
          pageOrder: ["first", "second"],
          pinnedPageIds: [],
        },
        pages: [
          { id: "first", url: "https://first.test/", title: "First" },
          { id: "second", url: "https://second.test/", title: "Second" },
        ],
      }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<EngineEvent>();
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: { pageBrowserGeneration: true } }),
            exit: Effect.never,
            events: Stream.fromPubSub(events),
            request: () => Effect.succeed({}),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            openCdpSession: () => Effect.die("unused managed CDP session"),
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
          yield* PubSub.publish(events, { event: "window.closing", params: {} });
          yield* Effect.sleep(20);
          assert.deepEqual(
            JSON.parse(
              yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
            ).pages.map((page: { id: string }) => page.id),
            ["first", "second"],
          );
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lifecycle update queued before window closing tolerates only the typed closing render rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-closing-render-race-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<EngineEvent>();
          const lifecycleCommitStarted = yield* Deferred.make<void>();
          const releaseLifecycleCommit = yield* Deferred.make<void>();
          const closingRejected = yield* Deferred.make<void>();
          let nativeClosing = false;
          let commits = 0;
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
            openCdpSession: () => Effect.die("unused managed CDP session"),
            claimRawCdp: Effect.die("unused"),
          });
          const surface = NativeSurface.of({
            events: Stream.empty,
            commit: () =>
              Effect.gen(function* () {
                commits += 1;
                if (commits === 3) {
                  yield* Deferred.succeed(lifecycleCommitStarted, undefined);
                  yield* Deferred.await(releaseLifecycleCommit);
                }
                if (nativeClosing) {
                  yield* Deferred.succeed(closingRejected, undefined);
                  return yield* new EngineError({ code: "-32003", message: "Window is closing" });
                }
                return commits;
              }),
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
          const page = yield* controller.openPage("https://closing-race.test/");
          yield* PubSub.publish(events, {
            event: "pages.created",
            params: { pageId: page, generation: 1 },
          });
          yield* Deferred.await(lifecycleCommitStarted).pipe(Effect.timeout(500));

          // Native begins closing before the controller reaches the window.closing event
          // which follows this already queued lifecycle update.
          nativeClosing = true;
          yield* PubSub.publish(events, { event: "window.closing", params: {} });
          yield* Deferred.succeed(releaseLifecycleCommit, undefined);
          yield* Deferred.await(closingRejected).pipe(Effect.timeout(500));

          nativeClosing = false;
          yield* PubSub.publish(events, { event: "window.closeCancelled", params: {} });
          yield* waitUntil(
            "close cancellation redraw",
            Effect.sync(() => commits === 4),
          );

          assert.equal(yield* controller.lastError, undefined);
          assert.equal((yield* controller.snapshot).pages[0]?.id, page);
          assert.deepEqual(
            JSON.parse(
              yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
            ).pages.map((entry: { id: string }) => entry.id),
            [page],
          );
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
            openCdpSession: () => Effect.die("unused managed CDP session"),
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
            openCdpSession: () => Effect.die("unused managed CDP session"),
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
            openCdpSession: () => Effect.die("unused managed CDP session"),
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
          yield* waitUntil(
            "generation-zero close",
            controller.snapshot.pipe(Effect.map((snapshot) => snapshot.pages.length === 0)),
          );
          assert.equal((yield* controller.snapshot).pages.length, 0);

          const next = yield* controller.openPage("https://next.test/");
          yield* PubSub.publish(events, {
            event: "pages.created",
            params: { pageId: next, generation: 1 },
          });
          yield* waitUntil(
            "next page attachment",
            controller.snapshot.pipe(
              Effect.map(
                (snapshot) => snapshot.pages.length === 1 && snapshot.pages[0]?.id === next,
              ),
            ),
          );
          yield* waitUntil(
            "next page persistence",
            Effect.promise(
              async () =>
                JSON.stringify(
                  JSON.parse(
                    await readFile(join(directory, "browser-state.json"), "utf8"),
                  ).pages.map((page: { id: string }) => page.id),
                ) === JSON.stringify([next]),
            ),
          );
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
            openCdpSession: () => Effect.die("unused managed CDP session"),
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
            PubSub.publish(events, { event, params });

          yield* controller.start;
          const observer = yield* controller.observePages("replacement-test");
          const id = yield* controller.openPage("https://one.test/");
          yield* emit("pages.created", { pageId: id, generation: 1 });
          yield* waitUntil(
            "page created",
            controller.snapshot.pipe(
              Effect.map((snapshot) => snapshot.pages.some((page) => page.id === id)),
            ),
          );
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

          // A current-generation sentinel proves all preceding stale events were processed.
          yield* emit("pages.navigationChanged", {
            pageId: id,
            generation: 2,
            url: "https://current.test/",
            loading: false,
            canGoBack: true,
            canGoForward: true,
          });
          yield* waitUntil(
            "replacement events processed",
            observer
              .watch({})
              .pipe(
                Effect.map((snapshot) =>
                  snapshot.pages.some((page) => page.id === id && page.canGoForward),
                ),
              ),
          );
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
            openCdpSession: () => Effect.die("unused managed CDP session"),
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
          const inspectorEvent = (generation: number, instance: number, state: string) =>
            PubSub.publish(engineEvents, {
              event: "devtools.changed",
              params: { pageId: opened[2]!, generation, instance, state },
            });
          yield* inspectorEvent(2, 2, "opening");
          yield* TestClock.adjust(1_000);
          assert.equal(lifecycle.at(-1)?.state, "active", "opening an inspector wakes its target");
          const afterInspectorOpen = lifecycle.length;
          testNow = 60_000;
          yield* inspectorEvent(1, 99, "closed");
          yield* inspectorEvent(2, 1, "closed");
          yield* TestClock.adjust(1_000);
          assert.equal(
            lifecycle.length,
            afterInspectorOpen,
            "stale inspector events cannot release current protection",
          );
          yield* inspectorEvent(2, 2, "closing");
          yield* TestClock.adjust(1_000);
          assert.equal(
            lifecycle.length,
            afterInspectorOpen,
            "closing inspectors retain protection until they drain",
          );
          yield* inspectorEvent(2, 2, "closed");
          yield* TestClock.adjust(1_000);
          assert.equal(
            lifecycle.at(-1)?.state,
            "frozen",
            "closed inspectors release page protection",
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

test("configuration invalidations subscribe before initial delivery and coalesce durable changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-configuration-events-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        let failWrite = false;
        const engine = EngineConnection.of({
          pid: 1,
          ready: Effect.succeed({ event: "host.ready", params: {} }),
          exit: Effect.never,
          events: Stream.never,
          request: () => Effect.succeed({}),
          loadUnpacked: () => Effect.die("unused"),
          uninstall: () => Effect.die("unused"),
          openCdpSession: () => Effect.die("unused managed CDP session"),
          claimRawCdp: Effect.die("unused"),
        });
        const controller = yield* makeBrowserController(directory, {
          freezeEnabled: false,
          profileLease: {
            profileRoot: directory,
            assertHeld: Effect.void,
            withWrite: (operation) =>
              Effect.gen(function* () {
                if (failWrite)
                  return yield* new ProfileWriteLeaseError({ message: "test write denied" });
                return yield* operation;
              }),
          },
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(EngineConnection, engine),
              Layer.succeed(
                NativeSurface,
                NativeSurface.of({ commit: () => Effect.succeed(1), events: Stream.never }),
              ),
            ),
          ),
        );
        const initial = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const values: unknown[] = [];
        const observer = yield* controller.configurationEvents.pipe(
          Stream.take(2),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              values.push(event);
              if (values.length === 1) {
                yield* Deferred.succeed(initial, undefined);
                yield* Deferred.await(resume);
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(initial);
        const dark = { ...defaultConfiguration, colorScheme: "dark" as const };
        yield* controller.configure(dark);
        yield* controller.configure({ ...dark, sleepAfterMs: 60_000 });
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(observer).pipe(Effect.timeout(2_000));
        assert.deepEqual(values, [
          { event: "configuration.changed", payload: {} },
          { event: "configuration.changed", payload: {} },
        ]);
        assert.equal((yield* controller.configuration).sleepAfterMs, 60_000);

        const observed: unknown[] = [];
        const ready = yield* Deferred.make<void>();
        const next = yield* Deferred.make<void>();
        yield* controller.configurationEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              observed.push(event);
              yield* Deferred.succeed(observed.length === 1 ? ready : next, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        const before = yield* controller.configuration;
        yield* controller.configure(before);
        const invalid = yield* Effect.flip(controller.configure({ ...before, sleepAfterMs: -1 }));
        assert.equal(invalid.code, "invalid-configuration");
        failWrite = true;
        const failure = yield* Effect.flip(
          controller.configure({ ...before, colorScheme: "light" }),
        );
        assert.equal(failure.code, "persistence");
        assert.deepEqual(yield* controller.configuration, before);
        const legacyFailure = yield* Effect.flip(controller.dispatch("settings.color.light"));
        assert.equal(legacyFailure.code, "persistence");
        assert.deepEqual(yield* controller.configuration, before);
        failWrite = false;
        const imported = { ...before, colorScheme: "system" as const };
        yield* controller.applyPortableSettings({
          configuration: imported,
          interface: { tabPlacement: "sidebar" },
        });
        yield* Deferred.await(next).pipe(Effect.timeout(2_000));
        assert.equal(observed.length, 2, "no-op, rejected and failed writes do not notify");
        assert.deepEqual(yield* controller.configuration, imported);
        const persisted = JSON.parse(
          yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
        );
        assert.deepEqual(persisted.configuration, imported);
        yield* controller.dispatch("settings.color.dark");
        yield* waitUntil(
          "legacy settings invalidate readers",
          Effect.sync(() => observed.length === 3),
        );
        assert.equal((yield* controller.configuration).colorScheme, "dark");
      }).pipe(Effect.scoped),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
