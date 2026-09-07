import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { NodeServices } from "@effect/platform-node";
import {
  EngineConnection,
  NativeSurface,
  createGrantStore,
  createPluginStorage,
} from "@hitchhiker/runtime";
import { Cause, Effect, Layer, Schedule, Schema } from "effect";
import { createExtensionArtifactStore } from "../src/extension-artifacts.ts";
import { createExtensionManagement } from "../src/extension-management.ts";
import { createExtensionManager } from "../src/extension-manager.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { createPluginManager } from "../src/plugin-manager.ts";
import { makeBrowserController } from "../src/controller.ts";
import { createInstalledPluginLauncher, runPluginDirectory } from "../src/plugin.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const value = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) }),
);
const removed = Schema.Struct({
  phase: Schema.Literal("removed"),
  target: Schema.String,
  before: Schema.Int,
  after: Schema.Int,
});
const waitFor = <A>(effect: Effect.Effect<A, unknown>, ready: (item: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(ready, () => new Error("Fixture has not settled")),
    Effect.retry({ times: 160, schedule: Schedule.spaced(50) }),
    Effect.timeout(12_000),
  );

for (const mode of ["developer", "installed"] as const)
  test(
    `compiled ${mode} plugin lists and removes an extension through the public API`,
    { skip: !binary || !pluginHost, timeout: 90_000 },
    async (context) => {
      const profile = await realpath(
        await mkdtemp(join(tmpdir(), "hitchhiker-native-extension-plugin-")),
      );
      const packageDirectory = await mkdtemp(
        join(tmpdir(), "hitchhiker-extension-plugin-package-"),
      );
      const extensionSource = join(packageDirectory, "extension");
      const server = createServer((_request, response) =>
        response.end(
          "<!doctype html><title>Extension fixture</title><div id=extension-signal></div>",
        ),
      );
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        await mkdir(extensionSource, { recursive: true });
        await writeFile(
          join(extensionSource, "manifest.json"),
          JSON.stringify({
            manifest_version: 3,
            name: "Plugin extension fixture",
            version: "1.0",
            host_permissions: ["http://127.0.0.1/*"],
            content_scripts: [
              { matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_start" },
            ],
          }),
        );
        await writeFile(
          join(extensionSource, "content.js"),
          "document.documentElement.setAttribute('data-extension-plugin-fixture','installed')",
        );
        const manifest = {
          id: "extension-fixture-plugin",
          name: "Extension fixture plugin",
          version: "1.0.0",
          capabilities: ["extensions.read", "extensions.manage", "storage.local"],
        } as const;
        await writeFile(join(packageDirectory, "hitchhiker.plugin.json"), JSON.stringify(manifest));
        await build({
          entryPoints: [fileURLToPath(new URL("fixtures/extension-plugin.ts", import.meta.url))],
          bundle: true,
          format: "iife",
          platform: "browser",
          target: "safari17",
          outfile: join(packageDirectory, "dist", "plugin.js"),
          logLevel: "silent",
        });
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const lease = yield* acquireProfileWriteLease(profile, binary!);
              yield* Effect.gen(function* () {
                const engine = yield* EngineConnection;
                yield* engine.ready;
                const controller = yield* makeBrowserController(lease.profileRoot, {
                  profileLease: lease,
                });
                const grants = yield* createGrantStore({
                  directory: join(profile, "hitchhiker-grants"),
                });
                const credential = yield* grants.issue({
                  principal: manifest.id,
                  profileId: "default",
                  capabilities: [...manifest.capabilities],
                  origins: [],
                });
                const extensionArtifacts = yield* createExtensionArtifactStore({
                  profileLease: lease,
                });
                const extensionManager = yield* createExtensionManager({
                  profileRoot: lease.profileRoot,
                  lease,
                  engine,
                  artifacts: extensionArtifacts,
                });
                yield* extensionManager.restoreBeforePages();
                yield* controller.start;
                const extensions = createExtensionManagement(extensionManager, () => Effect.void);
                const preview = yield* extensionManager.previewLocal(extensionSource);
                yield* extensionManager.confirmInstall(preview.installationId, preview.digest);
                const page = yield* controller.openPage(`${origin}/before`);
                const evaluate = (expression: string) =>
                  engine
                    .request("cdp.send", {
                      pageId: page,
                      method: "Runtime.evaluate",
                      params: { expression, returnByValue: true },
                    })
                    .pipe(
                      Effect.flatMap(value),
                      Effect.map((result) => result.result.value),
                    );
                yield* waitFor(
                  evaluate(
                    "document.readyState === 'complete' && location.pathname === '/before' && document.documentElement.getAttribute('data-extension-plugin-fixture') === 'installed'",
                  ),
                  (item) => item === true,
                );
                const storage = yield* createPluginStorage({ profileRoot: profile });
                const ownerStorage = yield* storage.forOwner(manifest.id);
                let pluginError: string | undefined;
                if (mode === "developer") {
                  yield* runPluginDirectory({
                    profileRoot: profile,
                    directory: packageDirectory,
                    executable: pluginHost!,
                    token: credential.token,
                    grants,
                    controller,
                    extensions,
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.sync(() => {
                        pluginError = Cause.pretty(cause);
                      }),
                    ),
                    Effect.forkScoped,
                  );
                } else {
                  const launcher = yield* createInstalledPluginLauncher({
                    executable: pluginHost!,
                    grants,
                    controller,
                    extensions,
                  });
                  const manager = yield* createPluginManager({
                    profileRoot: profile,
                    grants,
                    launch: launcher,
                  });
                  const artifacts = yield* createPluginArtifactStore(profile);
                  const artifact = yield* artifacts.stage({
                    manifest,
                    code: yield* Effect.promise(() =>
                      readFile(join(packageDirectory, "dist", "plugin.js"), "utf8"),
                    ),
                  });
                  yield* manager.install(artifact.hash, credential.grant.id);
                  assert.equal((yield* manager.list())[0]?.running, true);
                }
                const result = ownerStorage
                  .read()
                  .pipe(
                    Effect.flatMap((state) => Schema.decodeUnknownEffect(removed)(state.value)),
                  );
                const completed = yield* waitFor(result, (item) => {
                  assert.equal(pluginError, undefined);
                  return item.target === preview.installationId;
                });
                assert.equal(completed.before, 1);
                assert.equal(completed.after, 1);
                assert.equal((yield* extensionManager.list())[0]?.state, "removed");
                const after = yield* controller.openPage(`${origin}/after`);
                const afterEvaluate = engine
                  .request("cdp.send", {
                    pageId: after,
                    method: "Runtime.evaluate",
                    params: {
                      expression:
                        "document.readyState === 'complete' && location.pathname === '/after'",
                      returnByValue: true,
                    },
                  })
                  .pipe(
                    Effect.flatMap(value),
                    Effect.map((result) => result.result.value),
                  );
                yield* waitFor(afterEvaluate, (item) => item === true);
                assert.equal(
                  yield* engine
                    .request("cdp.send", {
                      pageId: after,
                      method: "Runtime.evaluate",
                      params: {
                        expression:
                          "document.documentElement.hasAttribute('data-extension-plugin-fixture')",
                        returnByValue: true,
                      },
                    })
                    .pipe(
                      Effect.flatMap(value),
                      Effect.map((result) => result.result.value),
                    ),
                  false,
                );
                yield* engine.request("window.close");
                assert.equal(yield* engine.exit.pipe(Effect.timeout(10_000)), 0);
              }).pipe(
                Effect.provide(
                  Layer.provideMerge(
                    NativeSurface.layer,
                    EngineConnection.layer({
                      executable: binary!,
                      profileRoot: lease.profileRoot,
                      extensionManagement: true,
                    }),
                  ),
                ),
              );
            }).pipe(Effect.provide(NodeServices.layer)),
          ),
          { signal: context.signal },
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(profile, { recursive: true, force: true });
        await rm(packageDirectory, { recursive: true, force: true });
      }
    },
  );
