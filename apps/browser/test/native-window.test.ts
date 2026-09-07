import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { EngineConnection, NativeSurface } from "@hitchhiker/runtime";
import {
  column,
  dragRegion,
  iconButton,
  listItem,
  row,
  stack,
  windowControls,
} from "@hitchhiker/ui";
import { Effect, Layer, Schedule, Schema } from "effect";
import { makeBrowserController } from "../src/controller.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const Rect = { x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number };
const Chrome = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  windowWidth: Schema.Number,
  windowHeight: Schema.Number,
  fullscreen: Schema.Boolean,
  titleHidden: Schema.Boolean,
  controls: Schema.Array(
    Schema.Struct({
      ...Rect,
      kind: Schema.String,
      visible: Schema.Boolean,
      enabled: Schema.Boolean,
    }),
  ),
  regions: Schema.Array(Schema.Struct({ ...Rect, draggable: Schema.Boolean })),
});
const waitUntil = <A>(effect: Effect.Effect<A, unknown>, ready: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(ready, () => new Error("window layout did not settle")),
    Effect.retry({ times: 120, schedule: Schedule.spaced(25) }),
  );

test(
  "compact native chrome preserves system controls and page identity across sidebar toggles",
  { skip: !binary, timeout: 30_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "hitchhiker-window-native-"));
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Window fixture</title>");
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address !== "string");
      await Effect.runPromise(
        Effect.gen(function* () {
          const runtime = EngineConnection.layer({
            executable: binary!,
            profileRoot: profile,
            extensionManagement: false,
          });
          yield* Effect.gen(function* () {
            const engine = yield* EngineConnection;
            const surface = yield* NativeSurface;
            const controller = yield* makeBrowserController(profile, { freezeEnabled: false });
            yield* controller.start;
            const chrome = engine
              .request("window.chrome")
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Chrome)));
            const initial = yield* waitUntil(
              chrome,
              (c) => c.controls.length === 3 && c.regions.some((r) => r.draggable && r.width > 0),
            );
            assert.equal(initial.titleHidden, true, JSON.stringify(initial));
            assert(Math.abs(initial.width - initial.windowWidth) <= 2, JSON.stringify(initial));
            assert(Math.abs(initial.height - initial.windowHeight) <= 2, JSON.stringify(initial));
            for (const control of initial.controls) {
              assert(control.visible && control.enabled, JSON.stringify(control));
              assert(control.x >= 0 && control.x + control.width <= 80, JSON.stringify(control));
              assert(control.y >= 0 && control.y + control.height <= 36, JSON.stringify(control));
            }
            const page = yield* controller.openPage(`http://127.0.0.1:${address.port}/`);
            yield* waitUntil(controller.snapshot, (s) =>
              s.pages.some((p) => p.id === page && p.title === "Window fixture"),
            );
            const before = yield* controller.snapshot;
            const wide = (c: typeof Chrome.Type) =>
              c.regions.some(
                (r) => !r.draggable && r.x === 0 && r.y === 36 && r.width >= 760 && r.height > 400,
              );
            const sidebar = (c: typeof Chrome.Type) =>
              c.regions.some(
                (r) =>
                  !r.draggable && r.x === 280 && r.y === 36 && r.width >= 480 && r.height > 400,
              );
            yield* waitUntil(chrome, sidebar);
            yield* controller.dispatch("interface.tabs.toggle");
            yield* waitUntil(chrome, wide);
            assert.deepEqual((yield* controller.snapshot).viewports, before.viewports);
            yield* controller.dispatch("interface.tabs.toggle");
            yield* waitUntil(chrome, sidebar);
            assert.deepEqual((yield* controller.snapshot).viewports, before.viewports);
            yield* controller.dispatch("settings.tabs.top");
            yield* waitUntil(chrome, (c) =>
              c.regions.some(
                (r) => !r.draggable && r.x === 0 && r.y === 96 && r.width >= 760 && r.height > 350,
              ),
            );
            assert.deepEqual((yield* controller.snapshot).viewports, before.viewports);
            yield* controller.dispatch("interface.tabs.toggle");
            yield* waitUntil(chrome, wide);
            assert.deepEqual((yield* controller.snapshot).viewports, before.viewports);
            yield* controller.dispatch("interface.tabs.toggle");
            yield* controller.dispatch("settings.tabs.sidebar");
            yield* waitUntil(chrome, sidebar);
            yield* controller.dispatch("interface.settings");
            const settings = yield* waitUntil(chrome, (c) =>
              c.regions.some((r) => r.draggable && r.x === 80 && r.height === 36),
            );
            assert(settings.controls.every((control) => control.visible));
            yield* surface.commit({
              root: column(
                "custom",
                [
                  row(
                    "header",
                    [
                      windowControls("controls"),
                      stack(
                        "overlap",
                        [
                          dragRegion("drag", { width: 200, height: 36 }),
                          listItem("tab-row", "Page", "select", { width: 100, height: 36 }),
                          iconButton("button", "Action", "action", "plus", {
                            width: 28,
                            height: 36,
                          }),
                        ],
                        { width: 200, height: 36 },
                      ),
                    ],
                    { height: 36 },
                  ),
                ],
                { flex: 1 },
              ),
              bindings: [],
            });
            const custom = yield* waitUntil(chrome, (c) =>
              c.regions.some((r) => r.draggable && r.width === 200),
            );
            const draggable = (regions: typeof custom.regions, x: number, y: number) =>
              regions.reduce(
                (active, r) =>
                  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
                    ? r.draggable
                    : active,
                false,
              );
            assert.equal(
              draggable(custom.regions, 150, 18),
              false,
              "list rows also subtract from drag regions",
            );
            assert.equal(
              draggable(custom.regions, 90, 18),
              false,
              "overlapping controls subtract from drag regions",
            );
            assert.equal(
              draggable(custom.regions, 180, 18),
              true,
              "empty measured space remains draggable",
            );
            yield* surface.commit({
              root: column("all-drag", [dragRegion("full-header", { height: 36 })], { flex: 1 }),
              bindings: [],
            });
            const overlapping = yield* waitUntil(chrome, (c) =>
              c.regions.some((r) => r.draggable && r.x === 0 && r.width === c.width),
            );
            for (const control of overlapping.controls) {
              assert.equal(
                draggable(
                  overlapping.regions,
                  control.x + control.width / 2,
                  control.y + control.height / 2,
                ),
                false,
                `${control.kind} remains outside custom drag regions`,
              );
            }
          }).pipe(Effect.provide(Layer.provideMerge(NativeSurface.layer, runtime)));
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);
