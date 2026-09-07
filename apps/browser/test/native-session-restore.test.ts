import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { EngineConnection, NativeSurface } from "@hitchhiker/runtime";
import { Effect, Layer, Schedule } from "effect";
import { makeBrowserController } from "../src/controller.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;

test(
  "a thirty-page native session restores and closes without losing pending tabs",
  { skip: !binary, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "hitchhiker-session-burst-"));
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>Restored ${request.url}</title><p>Session fixture</p>`);
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address !== "string");
      const pages = Array.from({ length: 30 }, (_, i) => ({
        id: `restore-${i}`,
        url: `http://127.0.0.1:${address.port}/${i}`,
        title: `Saved ${i}`,
      }));
      const session = {
        version: 1,
        configuration: { colorScheme: "light", sleepAfterMs: 300000, alwaysAwakeOrigins: [] },
        interface: {
          tabPlacement: "sidebar",
          selectedPageId: "restore-15",
          pageOrder: pages.map((p) => p.id),
          pinnedPageIds: pages.slice(0, 6).map((p) => p.id),
        },
        pages,
      };
      await writeFile(join(profile, "browser-state.json"), JSON.stringify(session));
      await Effect.runPromise(
        Effect.gen(function* () {
          const runtime = EngineConnection.layer({
            executable: binary!,
            profileRoot: profile,
            extensionManagement: false,
          });
          yield* Effect.gen(function* () {
            const engine = yield* EngineConnection;
            const controller = yield* makeBrowserController(profile, { freezeEnabled: false });
            yield* controller.start;
            const restored = yield* controller.snapshot.pipe(
              Effect.filterOrFail(
                (s) =>
                  s.pages.length === 30 && s.pages.every((p) => p.title.startsWith("Restored /")),
                () => new Error("session restore did not settle"),
              ),
              Effect.retry({ times: 300, schedule: Schedule.spaced(25) }),
            );
            assert.equal(yield* controller.lastError, undefined);
            assert.deepEqual(restored.pages.map((p) => p.id).sort(), pages.map((p) => p.id).sort());
            assert.deepEqual(
              restored.viewports.map((v) => v.pageId),
              ["restore-15"],
            );
            yield* engine.request("window.close");
            assert.equal(yield* engine.exit.pipe(Effect.timeout(10_000)), 0);
            assert.equal(yield* controller.lastError, undefined);
          }).pipe(Effect.provide(Layer.provideMerge(NativeSurface.layer, runtime)));
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      const saved = JSON.parse(
        await readFile(join(profile, "browser-state.json"), "utf8"),
      ) as typeof session;
      assert.deepEqual(saved.pages.map((p) => p.id).sort(), pages.map((p) => p.id).sort());
      assert.equal(saved.interface.selectedPageId, "restore-15");
      assert.deepEqual(saved.interface.pinnedPageIds, session.interface.pinnedPageIds);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);
