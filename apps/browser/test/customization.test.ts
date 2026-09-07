import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfiguration } from "@hitchhiker/core";
import { createDefaultInterface } from "@hitchhiker/default-interface";
import { EngineConnection, NativeSurface, type EngineEvent } from "@hitchhiker/runtime";
import { Effect, Layer, PubSub, Schedule, Stream } from "effect";
import { makeBrowserController } from "../src/controller.ts";
import { saveBrowserPersistence } from "../src/persistence.ts";

test("portable settings persist together, retain pages and custom UI, and survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-customization-"));
  const settings = {
    configuration: {
      colorScheme: "dark",
      sleepAfterMs: 60_000,
      alwaysAwakeOrigins: ["https://awake.test"],
    },
    interface: { tabPlacement: "top" },
  } as const;
  try {
    await Effect.runPromise(
      saveBrowserPersistence(directory, {
        configuration: defaultConfiguration,
        interfaceConfiguration: { tabPlacement: "sidebar" },
        interfaceState: {
          ...createDefaultInterface("default"),
          selectedPageId: "kept-page",
          pageOrder: ["kept-page"],
          pinnedPageIds: ["kept-page"],
        },
        pages: [
          { id: "kept-page", url: "https://private.test/session", title: "Private document" },
        ],
      }),
    );
    const run = (restart: boolean) =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<EngineEvent>();
          let lastSurface: unknown;
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: { pageBrowserGeneration: true } }),
            exit: Effect.never,
            events: Stream.fromPubSub(events),
            request: (method, params = {}) =>
              Effect.gen(function* () {
                if (method === "pages.open")
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
          const controller = yield* makeBrowserController(directory, { freezeEnabled: false }).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(EngineConnection, engine),
                Layer.succeed(
                  NativeSurface,
                  NativeSurface.of({
                    events: Stream.empty,
                    commit: (value) =>
                      Effect.sync(() => {
                        lastSurface = value;
                        return 1;
                      }),
                  }),
                ),
              ),
            ),
          );
          yield* controller.start;
          yield* controller.snapshot.pipe(
            Effect.flatMap((state) =>
              state.pages.length === 1 ? Effect.void : Effect.fail("page pending"),
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced(10) }),
          );
          if (restart) {
            assert.deepEqual(yield* controller.portableSettings, settings);
            assert.equal(
              (yield* controller.snapshot).pages[0]?.url,
              "https://private.test/session",
            );
            return;
          }
          yield* controller.publishPluginSurface("custom-browser", {
            root: { type: "custom-fixture" },
            bindings: [{ viewportId: "custom-view", pageId: "kept-page" }],
          });
          const pluginSurface = lastSurface;
          yield* controller.applyPortableSettings(settings);
          assert.deepEqual(yield* controller.portableSettings, settings);
          assert.deepEqual(lastSurface, pluginSurface);
          const state = yield* controller.snapshot;
          assert.equal(state.pages[0]?.url, "https://private.test/session");
          assert.deepEqual(
            state.viewports.map((viewport) => [viewport.id, viewport.pageId]),
            [["custom-view", "kept-page"]],
          );
          const stored = yield* Effect.promise(() =>
            readFile(join(directory, "browser-state.json"), "utf8"),
          );
          const parsed = JSON.parse(stored);
          assert.deepEqual(parsed.configuration, settings.configuration);
          assert.equal(parsed.interface.tabPlacement, "top");
          assert.deepEqual(parsed.interface.pinnedPageIds, ["kept-page"]);
          assert.deepEqual(parsed.pages, [
            { id: "kept-page", url: "https://private.test/session", title: "Private document" },
          ]);
          const invalid = yield* controller
            .applyPortableSettings({
              ...settings,
              configuration: { ...settings.configuration, sleepAfterMs: 1 },
            })
            .pipe(Effect.result);
          assert.equal(invalid._tag, "Failure");
          assert.equal(
            yield* Effect.promise(() => readFile(join(directory, "browser-state.json"), "utf8")),
            stored,
          );
          assert.deepEqual(yield* controller.portableSettings, settings);
        }),
      );
    await Effect.runPromise(run(false));
    await Effect.runPromise(run(true));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed portable-settings write leaves the controller's current settings unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-customization-failure-"));
  const path = join(root, "not-a-directory");
  await writeFile(path, "occupied");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const controller = yield* makeBrowserController(path, { freezeEnabled: false }).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(
                  EngineConnection,
                  EngineConnection.of({
                    pid: 1,
                    ready: Effect.never,
                    exit: Effect.never,
                    events: Stream.empty,
                    request: () => Effect.succeed({}),
                    loadUnpacked: () => Effect.die("unused"),
                    uninstall: () => Effect.die("unused"),
                    openCdpSession: () => Effect.die("unused managed CDP session"),
                    claimRawCdp: Effect.die("unused"),
                  }),
                ),
                Layer.succeed(
                  NativeSurface,
                  NativeSurface.of({ events: Stream.empty, commit: () => Effect.succeed(1) }),
                ),
              ),
            ),
          );
          const before = yield* controller.portableSettings;
          const result = yield* controller
            .applyPortableSettings({
              configuration: { ...defaultConfiguration, colorScheme: "dark" },
              interface: { tabPlacement: "top" },
            })
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          assert.deepEqual(yield* controller.portableSettings, before);
        }),
      ),
    );
    assert.equal(await readFile(path, "utf8"), "occupied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
