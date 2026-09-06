import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { EngineConnection, NativeSurface, createGrantStore } from "@hitchhiker/runtime";
import { Cause, Effect, Layer, Schedule } from "effect";
import { makeBrowserController } from "../src/controller.ts";
import { runPluginDirectory } from "../src/plugin.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
test(
  "compiled canvas plugin composes real Native/Chromium and revocation restores the default interface",
  { skip: !binary || !pluginHost, timeout: 30000 },
  async () => {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-canvas-native-")));
    const server = createServer((_request, response) =>
      response.end("<!doctype html><title>Canvas fixture</title><input value='retained'>"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const engine = yield* EngineConnection;
          const controller = yield* makeBrowserController(profile);
          const grants = yield* createGrantStore({ directory: join(profile, "hitchhiker-grants") });
          const issued = yield* grants.issue({
            principal: "canvas-example",
            profileId: "default",
            capabilities: ["pages.list", "pages.manage", "ui.compose"],
            origins: [],
          });
          yield* controller.start;
          const pageId = yield* controller.openPage(`http://127.0.0.1:${address.port}/`);
          let pluginError: string | undefined;
          let revoked = false;
          const wait = (id: string) =>
            Effect.gen(function* () {
              if (pluginError && !revoked) return yield* Effect.fail(pluginError);
              const state = yield* controller.snapshot;
              if (!state.viewports.some((view) => view.id === id && view.pageId === pageId))
                return yield* Effect.fail(`Waiting for ${id}`);
            }).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced(50) }));
          yield* wait("main-page");
          yield* runPluginDirectory({
            directory: fileURLToPath(new URL("../../canvas-plugin", import.meta.url)),
            executable: pluginHost!,
            token: issued.token,
            grants,
            controller,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                pluginError = Cause.pretty(cause);
              }),
            ),
            Effect.forkScoped,
          );
          yield* wait(`view-${pageId}`);
          revoked = true;
          yield* grants.revoke(issued.grant.id);
          yield* wait("main-page");
          assert.equal((yield* controller.snapshot).pages.length, 1);
          assert.equal(yield* controller.lastError, undefined);
          yield* engine.request("window.close").pipe(Effect.ignoreCause);
          assert.equal(yield* engine.exit, 0);
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
