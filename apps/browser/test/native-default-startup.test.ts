import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { defaultConfiguration } from "@hitchhiker/core";
import { createDefaultInterface } from "@hitchhiker/default-interface";
import {
  EngineConnection,
  NativeSurface,
  createGrantStore,
  createPluginStorage,
} from "@hitchhiker/runtime";
import { Effect, Layer, Schedule, Schema } from "effect";
import { runDefaultPluginBootstrap } from "../src/default-plugin-bootstrap.ts";
import { loadDefaultPluginBundle } from "../src/default-plugin-bundle.ts";
import { startDefaultPluginInterface } from "../src/default-plugin-startup.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { createBrowserComposition } from "../src/composition.ts";
import { makeBrowserController } from "../src/controller.ts";
import { createPluginManagement } from "../src/plugin-management.ts";
import { createPluginManager } from "../src/plugin-manager.ts";
import { createInstalledPluginLauncher } from "../src/plugin.ts";
import { loadBrowserPersistence, saveBrowserPersistence } from "../src/persistence.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const artifactsRoot = fileURLToPath(new URL("../../default-plugins/dist/", import.meta.url));
const ModelState = Schema.Struct({
  selection: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("new-page") }),
    Schema.Struct({ kind: Schema.Literal("page"), pageId: Schema.String }),
  ]),
  pageOrder: Schema.Array(Schema.String),
});
const PinsState = Schema.Struct({ pinnedPageIds: Schema.Array(Schema.String) });

const waitUntil = (label: string, condition: Effect.Effect<boolean, unknown>) =>
  condition.pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail(new Error(label)))),
    Effect.retry({ times: 160, schedule: Schedule.spaced(25) }),
  );

test(
  "installed startup migrates V1 browser state into the default plugin interface",
  { skip: !binary || !pluginHost, timeout: 60_000 },
  async () => {
    const profile = await realpath(
      await mkdtemp(join(tmpdir(), "hitchhiker-native-default-startup-")),
    );
    const server = createServer((request, response) =>
      response.end(`<!doctype html><title>${request.url}</title><p>startup fixture</p>`),
    );
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address !== "string");
      const first = `http://127.0.0.1:${address.port}/first`;
      const second = `http://127.0.0.1:${address.port}/second`;
      await Effect.runPromise(
        saveBrowserPersistence(profile, {
          configuration: defaultConfiguration,
          interfaceConfiguration: { tabPlacement: "sidebar" },
          interfaceState: {
            ...createDefaultInterface("default"),
            selectedPageId: "second",
            pageOrder: ["second", "first"],
            pinnedPageIds: ["second"],
          },
          pages: [
            { id: "first", url: first, title: "First" },
            { id: "second", url: second, title: "Second" },
          ],
        }),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const lease = yield* acquireProfileWriteLease(profile, binary!);
          const initialPersistence = yield* lease.withWrite(
            loadBrowserPersistence(profile, "default"),
          );
          yield* Effect.gen(function* () {
            const engine = yield* EngineConnection;
            const nativeSurface = yield* NativeSurface;
            let committed = "";
            const observedSurface = NativeSurface.of({
              ...nativeSurface,
              commit: (surface) =>
                nativeSurface.commit(surface).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      committed = JSON.stringify(surface);
                    }),
                  ),
                ),
            });
            const controller = yield* makeBrowserController(lease.profileRoot, {
              interfaceMode: "plugins",
              initialPersistence: { value: initialPersistence },
              freezeEnabled: false,
              profileLease: lease,
            }).pipe(Effect.provideService(NativeSurface, observedSurface));
            yield* controller.start;
            assert.match(committed, /plugin-recovery-status/);
            assert.doesNotMatch(
              committed,
              /browser\.new-page|interface\.settings|interface\.plugins/,
            );

            const grants = yield* createGrantStore({
              directory: join(lease.profileRoot, "hitchhiker-grants"),
            });
            const failedRecovery = { value: false };
            const onRecoveryFailure = Effect.sync(() => {
              failedRecovery.value = true;
            });
            const composition = yield* createBrowserComposition({
              recipe: undefined,
              controller,
              onRecoveryFailure,
            });
            const management = yield* createPluginManagement({ startPaused: true });
            const launch = yield* createInstalledPluginLauncher({
              executable: pluginHost!,
              grants,
              controller,
              composition,
              management,
              onRecoveryFailure,
            });
            const manager = yield* createPluginManager({
              profileRoot: lease.profileRoot,
              grants,
              launch,
              composition,
              onRecoveryFailure,
            });
            const artifacts = yield* createPluginArtifactStore(lease.profileRoot);
            const storage = yield* createPluginStorage({ profileRoot: lease.profileRoot });
            yield* management.bind(manager);
            yield* startDefaultPluginInterface({
              mode: "installed",
              persistence: initialPersistence,
              controller,
              bootstrap: (seed, placement) =>
                runDefaultPluginBootstrap({
                  profileRoot: lease.profileRoot,
                  lease,
                  manager,
                  artifacts,
                  grants,
                  storage,
                  seed,
                  placement,
                  loadBundle: loadDefaultPluginBundle(artifactsRoot),
                }),
            });
            yield* management.enableMutations();

            const installed = yield* manager.list();
            assert.equal(installed.length, 5);
            assert.equal(installed.filter((entry) => entry.running).length, 4);
            const model = Schema.decodeUnknownSync(ModelState)(
              (yield* (yield* storage.forOwner("default-tab-model")).read()).value,
            );
            const pins = Schema.decodeUnknownSync(PinsState)(
              (yield* (yield* storage.forOwner("default-tab-pins")).read()).value,
            );
            assert.deepEqual(model.selection, {
              kind: "page",
              pageId: "second",
            });
            assert.deepEqual(model.pageOrder, ["second", "first"]);
            assert.deepEqual(pins.pinnedPageIds, ["second"]);
            yield* waitUntil(
              "default presenter selects the migrated page",
              controller.snapshot.pipe(
                Effect.map(
                  (state) =>
                    state.viewports.length === 1 && state.viewports[0]?.pageId === "second",
                ),
              ),
            );
            assert.equal(failedRecovery.value, false);

            const journal = JSON.parse(
              yield* Effect.promise(() =>
                readFile(
                  join(lease.profileRoot, "hitchhiker-plugins", "default-bootstrap.json"),
                  "utf8",
                ),
              ),
            );
            assert.equal(journal.state, "completed");
            const persisted = JSON.parse(
              yield* Effect.promise(() =>
                readFile(join(lease.profileRoot, "browser-state.json"), "utf8"),
              ),
            );
            assert.equal(persisted.version, 2);
            assert.equal("interface" in persisted, false);
            assert.equal("legacyBootstrapSeed" in persisted, false);

            yield* engine.request("window.close");
            assert.equal(yield* engine.exit.pipe(Effect.timeout(10_000)), 0);
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
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);
