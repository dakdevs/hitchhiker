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
  DevToolsStatusSchema,
  EngineConnection,
  NativeSurface,
  createGrantStore,
  createPluginStorage,
  type SurfaceEvent,
} from "@hitchhiker/runtime";
import { Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
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
const ObservedSurface = Schema.Struct({ root: Schema.Unknown });
const ObservedNode = Schema.Struct({
  key: Schema.String,
  kind: Schema.String,
  label: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  children: Schema.optional(Schema.Array(Schema.Unknown)),
});
const ModelState = Schema.Struct({
  selection: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("new-page") }),
    Schema.Struct({ kind: Schema.Literal("page"), pageId: Schema.String }),
  ]),
  pageOrder: Schema.Array(Schema.String),
});
const Evaluation = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
const PinsState = Schema.Struct({ pinnedPageIds: Schema.Array(Schema.String) });

const waitUntil = (label: string, condition: Effect.Effect<boolean, unknown>) =>
  condition.pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail(new Error(label)))),
    Effect.retry({ times: 160, schedule: Schedule.spaced(25) }),
  );

test(
  "installed startup migrates V1 state and public presenter replacement retains pages and DevTools",
  { skip: !binary || !pluginHost, timeout: 60_000 },
  async (context) => {
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
            yield* engine.ready;
            const nativeSurface = yield* NativeSurface;
            const input = yield* PubSub.unbounded<SurfaceEvent>();
            let revision = 0;
            const buttons = new Map<string, { key: string; action: string }>();
            const collect = (value: unknown): void => {
              const node = Schema.decodeUnknownSync(ObservedNode)(value);
              if (node.kind === "button" && node.label !== undefined && node.action !== undefined)
                buttons.set(node.label, { key: node.key, action: node.action });
              node.children?.forEach(collect);
            };
            let committed = "";
            const observedSurface = NativeSurface.of({
              ...nativeSurface,
              events: Stream.merge(nativeSurface.events, Stream.fromPubSub(input)),
              commit: (surface) =>
                nativeSurface.commit(surface).pipe(
                  Effect.tap((next) =>
                    Effect.sync(() => {
                      const decoded = Schema.decodeUnknownSync(ObservedSurface)(surface);
                      revision = next;
                      buttons.clear();
                      collect(decoded.root);
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
            assert.equal(installed.length, 6);
            assert.equal(installed.filter((entry) => entry.running).length, 5);
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
            yield* waitUntil(
              "default DevTools toolbar is composed",
              Effect.sync(() => buttons.has("Inspect selected page")),
            );
            const press = (label: string) =>
              Effect.gen(function* () {
                const button = buttons.get(label);
                assert.ok(button, `Missing composed button: ${label}`);
                yield* PubSub.publish(input, {
                  surfaceId: "main",
                  revision,
                  nodeId: button.key,
                  event: "press",
                  payload: { action: button.action },
                });
              });
            const inspector = engine
              .request("devtools.status", { pageId: "second" })
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(DevToolsStatusSchema)));
            const evaluate = (pageId: string, expression: string) =>
              engine
                .request("cdp.send", {
                  pageId,
                  method: "Runtime.evaluate",
                  params: { expression, returnByValue: true },
                })
                .pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Evaluation)),
                  Effect.map((result) => result.result.value),
                );
            const markers = new Map<string, string>();
            for (const pageId of ["first", "second"]) {
              yield* waitUntil(
                "restored document is ready",
                evaluate(pageId, "location.pathname").pipe(
                  Effect.map((value) => value === `/${pageId}`),
                ),
              );
              const marker = crypto.randomUUID();
              markers.set(pageId, marker);
              yield* evaluate(
                pageId,
                `globalThis.retentionMarker = ${JSON.stringify(marker)}; sessionStorage.setItem("retention-marker", ${JSON.stringify(marker)}); document.body.appendChild(Object.assign(document.createElement("input"), {id:"retention-input",value:${JSON.stringify(marker)}})); true`,
              );
            }
            yield* press("Inspect selected page");
            yield* waitUntil(
              "default DevTools opens real inspector",
              inspector.pipe(Effect.map((value) => value.state === "open")),
            );
            const inspectorBefore = yield* inspector;
            const modelBefore = yield* (yield* storage.forOwner("default-tab-model")).read();
            const pinsBefore = yield* (yield* storage.forOwner("default-tab-pins")).read();
            for (const placement of ["top", "sidebar"]) {
              yield* press("Settings");
              const label = `Use ${placement} tabs`;
              yield* waitUntil(
                "replacement control is composed",
                Effect.sync(() => buttons.has(label)),
              );
              yield* press(label);
              yield* waitUntil(
                "public replacement enables the selected presenter",
                manager
                  .plan()
                  .pipe(
                    Effect.map(
                      (plan) =>
                        plan.enabled.includes(`default-${placement}-tabs`) &&
                        plan.enabled.includes("default-devtools") &&
                        plan.enabled.length === 5,
                    ),
                  ),
              );
              yield* waitUntil(
                "replacement retains selected viewport",
                controller.snapshot.pipe(
                  Effect.map(
                    (snapshot) =>
                      snapshot.viewports.length === 1 && snapshot.viewports[0]?.pageId === "second",
                  ),
                ),
              );
              yield* waitUntil(
                "replacement publishes browser controls",
                Effect.sync(() => buttons.has("Settings")),
              );
              assert.deepEqual(yield* inspector, inspectorBefore);
              assert.deepEqual(
                yield* (yield* storage.forOwner("default-tab-model")).read(),
                modelBefore,
              );
              assert.deepEqual(
                yield* (yield* storage.forOwner("default-tab-pins")).read(),
                pinsBefore,
              );
              assert.equal((yield* manager.list()).filter((entry) => entry.running).length, 5);
              for (const [pageId, marker] of markers) {
                assert.deepEqual(
                  yield* evaluate(
                    pageId,
                    '[globalThis.retentionMarker,sessionStorage.getItem("retention-marker"),document.getElementById("retention-input")?.value]',
                  ),
                  [marker, marker, marker],
                );
              }
            }
            yield* waitUntil(
              "default DevTools close control appears",
              Effect.sync(() => buttons.has("Close inspector")),
            );
            yield* press("Close inspector");
            yield* waitUntil(
              "default DevTools closes real inspector",
              inspector.pipe(Effect.map((value) => value.state === "closed")),
            );
            yield* press("Inspect selected page");
            yield* waitUntil(
              "default DevTools reopens before revocation",
              inspector.pipe(Effect.map((value) => value.state === "open")),
            );
            const devtoolsGrant = (yield* grants.list()).find(
              (grant) => grant.principal === "default-devtools",
            );
            assert.ok(devtoolsGrant);
            yield* grants.revoke(devtoolsGrant.id);
            yield* waitUntil(
              "revoking default plugin closes its inspector",
              inspector.pipe(Effect.map((value) => value.state === "closed")),
            );
            assert.equal((yield* controller.snapshot).pages.length, 2);
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
            assert.equal(journal.version, 2);
            assert.equal(journal.revision, 7);
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
        { signal: context.signal },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);
