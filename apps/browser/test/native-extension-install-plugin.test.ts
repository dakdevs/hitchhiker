import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
import { createExtensionInstallation } from "../src/extension-installation.ts";
import { createExtensionManager } from "../src/extension-manager.ts";
import { createNativeExtensionReview } from "../src/extension-review.ts";
import { createExtensionUploadStore } from "../src/extension-upload.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { createPluginManager } from "../src/plugin-manager.ts";
import { makeBrowserController } from "../src/controller.ts";
import { createInstalledPluginLauncher, runPluginDirectory } from "../src/plugin.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const interactive = process.env.HITCHHIKER_INTERACTIVE_EXTENSION_PLUGIN_INSTALL === "1";
const waitFor = <A>(effect: Effect.Effect<A, unknown>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(predicate, () => new Error("Public installation has not settled")),
    Effect.retry({ times: 240, schedule: Schedule.spaced(500) }),
    Effect.timeout(120_000),
  );
const Report = Schema.Struct({
  phase: Schema.String,
  operationId: Schema.String,
  installationId: Schema.NullOr(Schema.String),
});
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });

for (const mode of ["developer", "installed"] as const)
  test(
    `compiled ${mode} plugin installs a binary extension using scoped progress events`,
    { skip: !binary || !pluginHost || !interactive, timeout: 180_000 },
    async (context) => {
      const profile = await realpath(
        await mkdtemp(join(tmpdir(), "hitchhiker-native-extension-plugin-")),
      );
      const packageDirectory = await mkdtemp(
        join(tmpdir(), "hitchhiker-extension-install-plugin-"),
      );
      const server = createServer((_request, response) =>
        response.end("<!doctype html><title>Public installation</title>"),
      );
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const manifest = {
          id: "extension-install-fixture",
          name: "Public extension installer",
          version: "1.0.0",
          capabilities: ["extensions.install", "storage.local"],
        } as const;
        await writeFile(join(packageDirectory, "hitchhiker.plugin.json"), JSON.stringify(manifest));
        await build({
          entryPoints: [
            fileURLToPath(new URL("fixtures/extension-install-plugin.ts", import.meta.url)),
          ],
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
                const artifacts = yield* createExtensionArtifactStore({ profileLease: lease });
                const extensionManager = yield* createExtensionManager({
                  profileRoot: profile,
                  lease,
                  engine,
                  artifacts,
                });
                yield* extensionManager.restoreBeforePages();
                const controller = yield* makeBrowserController(profile, { profileLease: lease });
                yield* controller.start;
                const grants = yield* createGrantStore({
                  directory: join(profile, "hitchhiker-grants"),
                });
                const credential = yield* grants.issue({
                  principal: manifest.id,
                  profileId: "default",
                  capabilities: [...manifest.capabilities],
                  origins: [],
                });
                const uploads = yield* createExtensionUploadStore({ profileLease: lease });
                const extensionInstallation = yield* createExtensionInstallation({
                  manager: extensionManager,
                  uploads,
                  profileId: "default",
                  onFailure: () => Effect.void,
                  review: createNativeExtensionReview({ engine, onCleanupFailure: Effect.void }),
                });
                const storage = yield* createPluginStorage({ profileRoot: profile });
                const ownerStorage = yield* storage.forOwner(manifest.id);
                let pluginFailure: string | undefined;
                if (mode === "developer") {
                  yield* runPluginDirectory({
                    profileRoot: profile,
                    directory: packageDirectory,
                    executable: pluginHost!,
                    token: credential.token,
                    grants,
                    controller,
                    extensionInstallation,
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.sync(() => {
                        pluginFailure = Cause.pretty(cause);
                      }),
                    ),
                    Effect.forkScoped,
                  );
                } else {
                  const launcher = yield* createInstalledPluginLauncher({
                    executable: pluginHost!,
                    grants,
                    controller,
                    extensionInstallation,
                  });
                  const plugins = yield* createPluginManager({
                    profileRoot: profile,
                    grants,
                    launch: launcher,
                  });
                  const pluginArtifacts = yield* createPluginArtifactStore(profile);
                  const artifact = yield* pluginArtifacts.stage({
                    manifest,
                    code: yield* Effect.promise(() =>
                      readFile(join(packageDirectory, "dist", "plugin.js"), "utf8"),
                    ),
                  });
                  yield* plugins.install(artifact.hash, credential.grant.id);
                  assert.equal((yield* plugins.list())[0]?.running, true);
                }
                const report = ownerStorage
                  .read()
                  .pipe(Effect.flatMap((state) => Schema.decodeUnknownEffect(Report)(state.value)));
                yield* waitFor(report, (state) => {
                  assert.equal(pluginFailure, undefined);
                  return state.phase === "reviewing";
                });
                process.stdout.write(`HITCHHIKER_PUBLIC_INSTALL_REVIEW_READY=${mode}\n`);
                const enabled = yield* waitFor(report, (state) => {
                  assert.equal(pluginFailure, undefined);
                  return state.phase === "enabled";
                });
                assert.ok(enabled.installationId);
                const owned = yield* extensionManager.listOwned({
                  principal: manifest.id,
                  grantId: credential.grant.id,
                  authorize: Effect.void,
                });
                assert.equal(owned[0]?.operationId, enabled.operationId);
                assert.equal(owned[0]?.installationId, enabled.installationId);
                const pageId = yield* controller.openPage(`${origin}/installed`);
                yield* waitFor(
                  engine
                    .request("cdp.send", {
                      pageId,
                      method: "Runtime.evaluate",
                      params: {
                        expression:
                          "document.readyState === 'complete' && document.documentElement.getAttribute('data-public-installation')",
                        returnByValue: true,
                      },
                    })
                    .pipe(
                      Effect.flatMap(Schema.decodeUnknownEffect(Value)),
                      Effect.map((value) => value.result.value),
                    ),
                  (value) => value === "enabled",
                );
                yield* extensionManager.remove(enabled.installationId);
                yield* engine.request("window.close");
                assert.equal(yield* engine.exit.pipe(Effect.timeout(10_000)), 0);
              }).pipe(
                Effect.provide(
                  Layer.provideMerge(
                    NativeSurface.layer,
                    EngineConnection.layer({
                      executable: binary!,
                      profileRoot: profile,
                      extensionManagement: true,
                    }),
                  ),
                ),
              );
            }),
          ).pipe(Effect.provide(NodeServices.layer)),
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
