import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schedule, Schema } from "effect";
import { column, row, text, viewport, windowControls } from "@hitchhiker/ui";
import { EngineConnection } from "../src/engine.ts";
import { NativeSurface } from "../src/surface.ts";
import { composePluginSurface } from "../src/composition.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
test(
  "composed Native fragments retain distinct Chromium documents through unrelated updates",
  { skip: !binary, timeout: 30000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "hitchhiker-composed-native-"));
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>Composition ${request.url}</title><p>Fixture</p>`);
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address !== "string");
      await Effect.runPromise(
        Effect.gen(function* () {
          const engine = yield* EngineConnection;
          const native = yield* NativeSurface;
          const evaluate = (pageId: string, expression: string) =>
            engine
              .request("cdp.send", {
                pageId,
                method: "Runtime.evaluate",
                params: { expression, returnByValue: true },
              })
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Value)),
                Effect.map((v) => v.result.value),
              );
          yield* engine.ready;
          for (const id of ["first", "second"]) {
            yield* engine.request("pages.open", {
              id,
              url: `http://127.0.0.1:${address.port}/${id}`,
            });
            yield* evaluate(id, "document.title").pipe(
              Effect.filterOrFail(
                (value) => value === `Composition /${id}`,
                () => new Error("document not ready"),
              ),
              Effect.retry({ times: 120, schedule: Schedule.spaced(25) }),
            );
            yield* evaluate(id, `globalThis.marker='${id}'; true`);
          }
          const compose = (label: string) =>
            composePluginSurface({
              layout: {
                owner: { id: "layout", generation: 1 },
                surface: {
                  root: column(
                    "root",
                    [
                      row("header", [windowControls("system"), text("title", label)], {
                        height: 36,
                      }),
                      row("content", [], { flex: 1 }),
                    ],
                    { flex: 1 },
                  ),
                  bindings: [],
                },
              },
              slots: [
                {
                  key: "content",
                  contributions: ["first", "second"].map((id) => ({
                    owner: { id: `${id}-plugin`, generation: 1 },
                    id: "page",
                    surface: {
                      root: viewport("page", "view", { flex: 1 }),
                      bindings: [{ viewportId: "view", pageId: id }],
                    },
                  })),
                },
              ],
            });
          const first = yield* compose("Original");
          yield* native.commit(first.surface);
          yield* engine.request("window.chrome").pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  regions: Schema.Array(
                    Schema.Struct({
                      draggable: Schema.Boolean,
                      x: Schema.Number,
                      y: Schema.Number,
                      width: Schema.Number,
                      height: Schema.Number,
                    }),
                  ),
                }),
              ),
            ),
            Effect.filterOrFail(
              (chrome) => {
                const pages = chrome.regions.filter(
                  (r) => !r.draggable && r.y === 36 && r.height > 400 && r.width > 200,
                );
                return pages.length === 2 && pages[0].x !== pages[1].x;
              },
              () => new Error("composed viewports have not reached Native layout"),
            ),
            Effect.retry({ times: 120, schedule: Schedule.spaced(25) }),
          );
          const next = yield* compose("Updated by the layout plugin");
          assert.deepEqual(next.surface.bindings, first.surface.bindings);
          yield* native.commit(next.surface);
          for (const id of ["first", "second"])
            assert.equal(yield* evaluate(id, "globalThis.marker"), id);
          yield* engine.request("window.close");
          assert.equal(yield* engine.exit.pipe(Effect.timeout(10000)), 0);
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              NativeSurface.layer,
              EngineConnection.layer({
                executable: binary!,
                profileRoot: profile,
                extensionManagement: false,
              }),
            ),
          ),
          Effect.scoped,
          Effect.provide(NodeServices.layer),
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);
