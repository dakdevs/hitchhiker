import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineConnection, NativeSurface, type SurfaceEvent } from "@hitchhiker/runtime";
import { Deferred, Effect, Layer, PubSub, Stream } from "effect";
import { makeBrowserController } from "../src/controller.ts";
import { type ExtensionPreview } from "../src/extension-controls.ts";

test("native extension review binds the staged digest, shows every permission and ignores duplicate installs", async () => {
  const profile = await mkdtemp(join(tmpdir(), "hitchhiker-extension-controls-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<SurfaceEvent>();
          const installGate = yield* Deferred.make<void>();
          const commits: unknown[] = [];
          const paths: string[] = [];
          const installs: string[][] = [];
          const preview: ExtensionPreview = {
            installationId: "a".repeat(32),
            digest: "b".repeat(64),
            expectedChromiumId: "c".repeat(32),
            name: "Fixture",
            version: "1.0",
            permissions: Array.from({ length: 41 }, (_, index) => `permission${index}`),
            host_permissions: ["https://example.test/*"],
            optional_permissions: [],
            optional_host_permissions: [],
          };
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: { pageBrowserGeneration: true } }),
            exit: Effect.never,
            events: Stream.empty,
            request: () => Effect.succeed({}),
            loadUnpacked: () => Effect.die("unexpected direct engine load"),
            uninstall: () => Effect.die("unexpected direct engine uninstall"),
            openCdpSession: () => Effect.die("unused managed CDP session"),
            claimRawCdp: Effect.die("unexpected raw CDP"),
          });
          const surface = NativeSurface.of({
            events: Stream.fromPubSub(events),
            commit: (tree) => Effect.sync(() => commits.push(tree)),
          });
          const controller = yield* makeBrowserController(profile, {
            extensions: {
              readOnly: false,
              list: () => Effect.succeed([]),
              previewLocal: (path) =>
                Effect.sync(() => {
                  paths.push(path);
                  return preview;
                }),
              reviewPrepared: () => Effect.succeed(preview),
              confirmInstall: (id, digest) =>
                Effect.sync(() => {
                  installs.push([id, digest]);
                }).pipe(Effect.andThen(Deferred.await(installGate))),
              cancelPreview: () => Effect.void,
              remove: () => Effect.void,
            },
          }).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(EngineConnection, engine),
                Layer.succeed(NativeSurface, surface),
              ),
            ),
          );
          yield* controller.start;
          yield* controller.dispatch("interface.extensions");
          yield* PubSub.publish(events, {
            surfaceId: "main",
            revision: 1,
            event: "input",
            nodeId: "extension-directory",
            payload: { kind: "insert_text", text: "/tmp/my extension 🚀" },
          });
          yield* Effect.sleep(30);
          yield* controller.dispatch("extensions.preview");
          yield* Effect.sleep(10);
          assert.deepEqual(paths, ["/tmp/my extension 🚀"]);
          assert.ok(JSON.stringify(commits.at(-1)).includes("permission19"));
          assert.ok(!JSON.stringify(commits.at(-1)).includes('"action":"extensions.install"'));
          yield* controller.dispatch("extensions.install");
          assert.deepEqual(installs, []);
          yield* controller.dispatch("extensions.permissions.next");
          assert.ok(JSON.stringify(commits.at(-1)).includes("permission39"));
          yield* controller.dispatch("extensions.permissions.next");
          assert.ok(JSON.stringify(commits.at(-1)).includes("permission40"));
          assert.ok(JSON.stringify(commits.at(-1)).includes("https://example.test/*"));
          yield* controller.dispatch("extensions.install");
          yield* Effect.yieldNow;
          yield* controller.dispatch("extensions.install");
          assert.deepEqual(installs, [[preview.installationId, preview.digest]]);
          yield* controller.dispatch("screen.browser").pipe(Effect.timeout(500));
          yield* Deferred.succeed(installGate, undefined);
          yield* Effect.sleep(10);
          // Plugin trees cannot convert matching action strings into local installation.
          yield* controller.publishPluginSurface("fixture-plugin", {
            root: { key: "spoof", kind: "button", label: "Install", action: "extensions.preview" },
            bindings: [],
          });
          yield* PubSub.publish(events, {
            surfaceId: "main",
            revision: 1,
            event: "press",
            nodeId: "spoof",
            payload: { action: "extensions.preview" },
          });
          yield* Effect.sleep(10);
          assert.equal(paths.length, 1);
          assert.equal(yield* controller.lastError, undefined);
        }),
      ),
    );
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
