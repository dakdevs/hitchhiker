import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  type SurfaceEvent,
  type TrustedPluginWorkerDiagnostics,
} from "@hitchhiker/runtime";
import { Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import { runDefaultPluginBootstrap } from "../src/default-plugin-bootstrap.ts";
import { loadDefaultPluginBundle } from "../src/default-plugin-bundle.ts";
import { startDefaultPluginInterface } from "../src/default-plugin-startup.ts";
import { createBrowserComposition } from "../src/composition.ts";
import { makeBrowserController } from "../src/controller.ts";
import { createExtensionArtifactStore } from "../src/extension-artifacts.ts";
import { createExtensionInstallation } from "../src/extension-installation.ts";
import { createExtensionManagement } from "../src/extension-management.ts";
import { createExtensionManager } from "../src/extension-manager.ts";
import { createNativeExtensionDirectoryPicker } from "../src/extension-directory-picker.ts";
import { createNativeExtensionReview } from "../src/extension-review.ts";
import { createExtensionUploadStore } from "../src/extension-upload.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { createPluginManagement } from "../src/plugin-management.ts";
import { createPluginManager } from "../src/plugin-manager.ts";
import { createInstalledPluginLauncher } from "../src/plugin.ts";
import { loadBrowserPersistence, saveBrowserPersistence } from "../src/persistence.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const interactive = process.env.HITCHHIKER_INTERACTIVE_DEFAULT_EXTENSIONS === "1";
const bundleRoot = fileURLToPath(new URL("../../default-plugins/dist/", import.meta.url));
const Node = Schema.Struct({
  key: Schema.String,
  kind: Schema.String,
  label: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  children: Schema.optional(Schema.Array(Schema.Unknown)),
});
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
type WorkerBinding = {
  readonly generation: number;
  readonly diagnostics: TrustedPluginWorkerDiagnostics;
};
const memory = Effect.fn("DefaultExtensions.memory")(function* (
  phase: string,
  bindings: ReadonlyMap<string, WorkerBinding>,
) {
  assert.equal(bindings.size, 8);
  const workers = yield* Effect.forEach(
    [...bindings],
    ([pluginId, binding]) =>
      Effect.gen(function* () {
        const identity = yield* binding.diagnostics.started.pipe(Effect.timeout(5_000));
        const usage = yield* binding.diagnostics.sample(identity);
        assert.deepEqual(usage.identity, identity);
        assert.ok(usage.physicalFootprintBytes > 0);
        assert.ok(usage.residentBytes > 0);
        return { pluginId, activationGeneration: binding.generation, ...usage };
      }),
    { concurrency: 8 },
  );
  assert.equal(new Set(workers.map((worker) => worker.identity.pid)).size, 8);
  process.stdout.write(
    `HITCHHIKER_DEFAULT_EXTENSIONS_MEMORY=${JSON.stringify({ phase, workers, physicalFootprintBytes: workers.reduce((sum, item) => sum + item.physicalFootprintBytes, 0), residentBytes: workers.reduce((sum, item) => sum + item.residentBytes, 0) })}\n`,
  );
});
const wait = (label: string, condition: Effect.Effect<boolean, unknown>) =>
  condition.pipe(
    Effect.filterOrFail(Boolean, () => new Error(label)),
    Effect.retry({ times: 480, schedule: Schedule.spaced(250) }),
  );

test(
  "default extension route uses real picker, review, Chromium install, removal, and fallback",
  { skip: !binary || !pluginHost || !interactive, timeout: 240_000 },
  async (context) => {
    const profile = await realpath(
      await mkdtemp(join(tmpdir(), "hitchhiker-native-default-startup-")),
    );
    const source = join(profile, "selected-default-extension");
    const server = createServer((_request, response) =>
      response.end("<!doctype html><title>Default extensions fixture</title>"),
    );
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      await mkdir(source);
      await writeFile(
        join(source, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Default route fixture",
          version: "1.0",
          host_permissions: ["http://127.0.0.1/*"],
          content_scripts: [
            { matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_start" },
          ],
          web_accessible_resources: [
            { resources: ["resource.bin"], matches: ["http://127.0.0.1/*"] },
          ],
        }),
      );
      await writeFile(join(source, "resource.bin"), new Uint8Array([0, 1, 127, 128, 255, 42]));
      await writeFile(
        join(source, "content.js"),
        `const expected=[0,1,127,128,255,42];fetch(chrome.runtime.getURL('resource.bin')).then(r=>r.arrayBuffer()).then(b=>{const a=[...new Uint8Array(b)];if(a.length===expected.length&&a.every((v,i)=>v===expected[i])){const mark=()=>document.documentElement?.setAttribute('data-default-extension','enabled');document.documentElement?mark():addEventListener('DOMContentLoaded',mark,{once:true});}});`,
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const started = performance.now();
            const lease = yield* acquireProfileWriteLease(profile, binary!);
            yield* saveBrowserPersistence(profile, {
              configuration: defaultConfiguration,
              interfaceConfiguration: { tabPlacement: "sidebar" },
              interfaceState: {
                ...createDefaultInterface("default"),
                selectedPageId: "retained",
                pageOrder: ["retained"],
              },
              pages: [{ id: "retained", url: `${origin}/retained`, title: "Retained" }],
            });
            const persistence = yield* lease.withWrite(loadBrowserPersistence(profile, "default"));
            yield* Effect.gen(function* () {
              const engine = yield* EngineConnection;
              yield* engine.ready;
              const native = yield* NativeSurface;
              const input = yield* PubSub.unbounded<SurfaceEvent>();
              let revision = 0;
              const buttons = new Map<string, { readonly key: string; readonly action: string }>();
              let last = "";
              const collect = (value: unknown): void => {
                const node = Schema.decodeUnknownSync(Node)(value);
                if (node.kind === "button" && node.label && node.action)
                  buttons.set(node.label, { key: node.key, action: node.action });
                node.children?.forEach(collect);
              };
              const observed = NativeSurface.of({
                ...native,
                events: Stream.merge(native.events, Stream.fromPubSub(input)),
                commit: (surface) =>
                  native.commit(surface).pipe(
                    Effect.tap((next) =>
                      Effect.sync(() => {
                        revision = next;
                        buttons.clear();
                        collect((surface as { root: unknown }).root);
                        last = JSON.stringify(surface);
                      }),
                    ),
                  ),
              });
              const controller = yield* makeBrowserController(profile, {
                interfaceMode: "plugins",
                initialPersistence: { value: persistence },
                freezeEnabled: false,
                profileLease: lease,
              }).pipe(Effect.provideService(NativeSurface, observed));
              const grants = yield* createGrantStore({
                directory: join(profile, "hitchhiker-grants"),
              });
              const extensionArtifacts = yield* createExtensionArtifactStore({
                profileLease: lease,
              });
              const extensionManager = yield* createExtensionManager({
                profileRoot: profile,
                lease,
                engine,
                artifacts: extensionArtifacts,
              });
              yield* extensionManager.restoreBeforePages();
              yield* controller.start;
              const uploads = yield* createExtensionUploadStore({ profileLease: lease });
              const extensionInstallation = yield* createExtensionInstallation({
                manager: extensionManager,
                uploads,
                profileId: "default",
                onFailure: () => Effect.void,
                pickLocal: createNativeExtensionDirectoryPicker({
                  engine,
                  onCleanupFailure: Effect.void,
                }),
                review: createNativeExtensionReview({ engine, onCleanupFailure: Effect.void }),
              });
              const extensions = createExtensionManagement(extensionManager, () => Effect.void);
              const composition = yield* createBrowserComposition({
                recipe: undefined,
                controller,
                onRecoveryFailure: Effect.void,
              });
              const management = yield* createPluginManagement({ startPaused: true });
              const workerBindings = new Map<string, WorkerBinding>();
              const launchWorker = yield* createInstalledPluginLauncher({
                executable: pluginHost!,
                onWorkerDiagnostics: (owner, diagnostics) =>
                  Effect.sync(() => {
                    assert.equal(owner.profileId, "default");
                    workerBindings.set(owner.pluginId, {
                      generation: owner.generation,
                      diagnostics,
                    });
                  }),
                grants,
                controller,
                composition,
                management,
                extensions,
                extensionInstallation,
                onRecoveryFailure: Effect.void,
              });
              const generations = new Map<string, number>();
              const launch: typeof launchWorker = (artifact, grant, ready, activation) => {
                generations.set(artifact.manifest.id, activation.generation);
                return launchWorker(artifact, grant, ready, activation);
              };
              const manager = yield* createPluginManager({
                profileRoot: profile,
                grants,
                launch,
                composition,
                onRecoveryFailure: Effect.void,
              });
              const artifacts = yield* createPluginArtifactStore(profile);
              const storage = yield* createPluginStorage({ profileRoot: profile });
              yield* management.bind(manager);
              yield* startDefaultPluginInterface({
                mode: "installed",
                persistence,
                controller,
                bootstrap: (seed, placement) =>
                  runDefaultPluginBootstrap({
                    profileRoot: profile,
                    lease,
                    manager,
                    artifacts,
                    grants,
                    storage,
                    seed,
                    placement,
                    loadBundle: loadDefaultPluginBundle(bundleRoot),
                  }),
              });
              yield* management.enableMutations();
              yield* wait(
                "eight default workers did not start",
                manager
                  .list()
                  .pipe(
                    Effect.map(
                      (items) =>
                        items.length === 9 && items.filter((item) => item.running).length === 8,
                    ),
                  ),
              );
              process.stdout.write(
                `HITCHHIKER_DEFAULT_EXTENSIONS_SIX_READY=${JSON.stringify({ ms: performance.now() - started })}\n`,
              );
              const evaluate = (pageId: string, expression: string) =>
                engine
                  .request("cdp.send", {
                    pageId,
                    method: "Runtime.evaluate",
                    params: { expression, returnByValue: true },
                  })
                  .pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Value)),
                    Effect.map((result) => result.result.value),
                  );
              yield* wait(
                "retained document not loaded",
                evaluate("retained", "document.readyState").pipe(
                  Effect.map((value) => value === "complete"),
                ),
              );
              yield* evaluate("retained", "globalThis.defaultExtensionRetained='retained'");
              yield* memory("startup", workerBindings);
              const press = (label: string) =>
                Effect.gen(function* () {
                  const button = buttons.get(label);
                  assert.ok(button, `Missing ${label}`);
                  yield* PubSub.publish(input, {
                    surfaceId: "main",
                    revision,
                    nodeId: button.key,
                    event: "press",
                    payload: { action: button.action },
                  });
                });
              const openedAt = performance.now();
              yield* press("Extensions");
              yield* wait(
                "extension route did not open",
                controller.snapshot.pipe(
                  Effect.map(
                    (state) => buttons.has("Add extension") && state.viewports.length === 0,
                  ),
                ),
              );
              process.stdout.write(
                `HITCHHIKER_DEFAULT_EXTENSIONS_MAIN_SHOWN=${JSON.stringify({ ms: performance.now() - started, observedRouteMs: performance.now() - openedAt })}\n`,
              );
              yield* press("Add extension");
              yield* wait(
                "picker did not start",
                Effect.sync(() => last.includes("choosing.")),
              );
              yield* memory("picker", workerBindings);
              process.stdout.write(
                `HITCHHIKER_DEFAULT_EXTENSIONS_PICKER_DIRECTORY=${source}\nHITCHHIKER_DEFAULT_EXTENSIONS_PICKER_READY\n`,
              );
              yield* wait(
                "review control did not appear",
                Effect.sync(() => buttons.has("Request review")),
              );
              yield* press("Request review");
              yield* wait(
                "review did not start",
                Effect.sync(() => last.includes("reviewing.")),
              );
              yield* memory("review", workerBindings);
              process.stdout.write("HITCHHIKER_DEFAULT_EXTENSIONS_REVIEW_READY\n");
              yield* wait(
                "extension did not install",
                extensionManager
                  .list()
                  .pipe(
                    Effect.map((items) =>
                      items.some(
                        (item) => item.name === "Default route fixture" && item.state === "enabled",
                      ),
                    ),
                  ),
              );
              const pageId = yield* controller.openPage(`${origin}/installed`);
              yield* wait(
                "extension content script did not verify its binary",
                engine
                  .request("cdp.send", {
                    pageId,
                    method: "Runtime.evaluate",
                    params: {
                      expression:
                        "document.readyState === 'complete' && document.documentElement.getAttribute('data-default-extension')",
                      returnByValue: true,
                    },
                  })
                  .pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Value)),
                    Effect.map((value) => value.result.value === "enabled"),
                  ),
              );
              yield* memory("installed", workerBindings);
              assert.equal(
                yield* evaluate("retained", "globalThis.defaultExtensionRetained"),
                "retained",
              );
              yield* wait(
                "remove control did not appear",
                Effect.sync(() => buttons.has("Remove Default route fixture")),
              );
              yield* press("Remove Default route fixture");
              yield* wait(
                "extension was not removed",
                extensionManager
                  .list()
                  .pipe(
                    Effect.map((items) =>
                      items.some(
                        (item) => item.name === "Default route fixture" && item.state === "removed",
                      ),
                    ),
                  ),
              );
              const retained = new Map(generations);
              yield* manager.disable("default-extension-management");
              yield* wait(
                "disabling the selected extension route did not restore its fallback",
                controller.snapshot.pipe(
                  Effect.map(
                    (state) =>
                      !buttons.has("Add extension") &&
                      state.viewports.some((view) => view.pageId === "retained"),
                  ),
                ),
              );
              for (const [id, generation] of retained)
                if (id !== "default-extension-management")
                  assert.equal(generations.get(id), generation);
              yield* manager.enable("default-extension-management");
              yield* wait(
                "re-enabled extension route did not restore its worker",
                manager
                  .list()
                  .pipe(
                    Effect.map(
                      (items) =>
                        items.find((item) => item.id === "default-extension-management")
                          ?.running === true,
                    ),
                  ),
              );
              yield* press("Extensions");
              yield* wait(
                "extension route did not reopen",
                Effect.sync(() => buttons.has("Add extension")),
              );
              yield* press("Back");
              yield* wait(
                "browser fallback was not restored",
                controller.snapshot.pipe(
                  Effect.map(
                    (state) =>
                      !buttons.has("Add extension") &&
                      state.viewports.some((view) => view.pageId === "retained"),
                  ),
                ),
              );
              assert.equal(
                yield* evaluate("retained", "globalThis.defaultExtensionRetained"),
                "retained",
              );
              yield* memory("removed", workerBindings);
              process.stdout.write(
                `HITCHHIKER_DEFAULT_EXTENSIONS_REMOVED=${JSON.stringify({ ms: performance.now() - started })}\n`,
              );
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
    }
  },
);
