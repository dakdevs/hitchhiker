import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Cause, Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import {
  DevToolsStatusSchema,
  EngineConnection,
  NativeSurface,
  createGrantStore,
  type SurfaceEvent,
} from "@hitchhiker/runtime";
import { makeBrowserController } from "../src/controller.ts";
import { runPluginDirectory } from "../src/plugin.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const waitUntil = <A>(effect: Effect.Effect<A, unknown>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(predicate, () => new Error("Plugin fixture state is not ready")),
    Effect.retry({ times: 160, schedule: Schedule.spaced(25) }),
    Effect.timeout(10_000),
  );

test(
  "compiled DevTools plugin routes synthetic toolbar events to real Chromium and cleans up on revocation",
  { skip: !binary || !pluginHost, timeout: 60_000 },
  async (context) => {
    const profile = await realpath(
      await mkdtemp(join(tmpdir(), "hitchhiker-native-devtools-plugin-")),
    );
    const server = createServer((_request, response) =>
      response.end("<!doctype html><title>Plugin inspector target</title><p>Retained document</p>"),
    );
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await Effect.runPromise(
        Effect.gen(function* () {
          const lease = yield* acquireProfileWriteLease(profile, binary!);
          yield* Effect.gen(function* () {
            const engine = yield* EngineConnection;
            yield* engine.ready;
            const native = yield* NativeSurface;
            const input = yield* PubSub.unbounded<SurfaceEvent>();
            let revision = 0;
            let markup = "";
            const observedNative = NativeSurface.of({
              events: Stream.merge(native.events, Stream.fromPubSub(input)),
              commit: (surface) =>
                native.commit(surface).pipe(
                  Effect.tap((next) =>
                    Effect.sync(() => {
                      revision = next;
                      markup = JSON.stringify(surface);
                    }),
                  ),
                ),
            });
            const controller = yield* makeBrowserController(profile, {
              interfaceMode: "plugins",
              profileLease: lease,
              freezeEnabled: false,
            }).pipe(Effect.provideService(NativeSurface, observedNative));
            yield* controller.start;
            const pageId = yield* controller.openPage(`http://127.0.0.1:${address.port}/`);
            yield* waitUntil(controller.snapshot, (snapshot) =>
              snapshot.pages.some((page) => page.id === pageId),
            );
            const grants = yield* createGrantStore({
              directory: join(profile, "hitchhiker-grants"),
            });
            const credential = yield* grants.issue({
              principal: "devtools-workbench",
              profileId: "default",
              capabilities: ["pages.list", "devtools.manage", "ui.compose"],
              origins: [],
            });
            let pluginError: string | undefined;
            yield* runPluginDirectory({
              profileRoot: profile,
              directory: fileURLToPath(new URL("../../devtools-plugin", import.meta.url)),
              executable: pluginHost!,
              token: credential.token,
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
            yield* waitUntil(controller.snapshot, (snapshot) =>
              snapshot.viewports.some(
                (view) => view.id === "devtools-selected-page" && view.pageId === pageId,
              ),
            );
            assert.equal(pluginError, undefined);
            assert.match(markup, /Developer tools/);
            const inspector = engine
              .request("devtools.status", { pageId })
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(DevToolsStatusSchema)));
            const press = (action: string) =>
              PubSub.publish(input, {
                surfaceId: "main",
                revision,
                nodeId: action,
                event: "press",
                payload: { action },
              });
            yield* press("devtools.show");
            const opened = yield* waitUntil(inspector, (value) => value.state === "open");
            yield* waitUntil(
              Effect.sync(() => markup),
              (value) => value.includes("Inspector open."),
            );
            yield* press("devtools.close");
            yield* waitUntil(inspector, (value) => value.state === "closed");
            yield* press("devtools.show");
            const reopened = yield* waitUntil(inspector, (value) => value.state === "open");
            assert.ok(reopened.instance > opened.instance);
            yield* grants.revoke(credential.grant.id);
            yield* waitUntil(inspector, (value) => value.state === "closed");
            yield* waitUntil(controller.snapshot, (snapshot) => snapshot.viewports.length === 0);
            assert.equal(
              (yield* controller.snapshot).pages.filter((page) => page.lifecycle !== "closed")
                .length,
              1,
            );
            assert.equal(yield* controller.lastError, undefined);
            yield* engine.request("window.close");
            assert.equal(yield* engine.exit.pipe(Effect.timeout(10_000)), 0);
          }).pipe(
            Effect.scoped,
            Effect.provide(
              Layer.provideMerge(
                NativeSurface.layer,
                EngineConnection.layer({
                  executable: binary!,
                  profileRoot: lease.profileRoot,
                  extensionManagement: false,
                }),
              ),
            ),
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        { signal: context.signal },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);
