import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Layer, Schedule, Schema } from "effect";
import {
  EngineConnection,
  NativeSurface,
  createGrantStore,
  createPluginStorage,
  PluginCompositionRecipeSchema,
} from "@hitchhiker/runtime";
import { makeBrowserController } from "../src/controller.ts";
import { createBrowserComposition } from "../src/composition.ts";
import { createInstalledPluginLauncher } from "../src/plugin.ts";
import { createPluginManager } from "../src/plugin-manager.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { PluginServiceRecipeSchema } from "../src/service-recipe.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const artifactsRoot = new URL("../../default-plugins/dist/", import.meta.url);
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
for (const placement of ["sidebar", "top"] as const)
  test(
    `six default ${placement} plugins switch presenters live with retained Chromium documents and rollback`,
    { skip: !binary || !pluginHost, timeout: 60_000 },
    async () => {
      const profile = await realpath(
        await mkdtemp(join(tmpdir(), `hitchhiker-default-${placement}-`)),
      );
      const server = createServer((request, response) =>
        response.end(`<!doctype html><title>Tab ${request.url}</title><p>Retained</p>`),
      );
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert(address && typeof address !== "string");
        const recipe = Schema.decodeUnknownSync(
          Schema.fromJsonString(PluginCompositionRecipeSchema),
        )(await readFile(new URL(`${placement}/composition.json`, artifactsRoot), "utf8"));
        const services = Schema.decodeUnknownSync(Schema.fromJsonString(PluginServiceRecipeSchema))(
          await readFile(new URL(`${placement}/services.json`, artifactsRoot), "utf8"),
        );
        const presenter = `default-${placement}-tabs`;
        const alternate = placement === "sidebar" ? "top" : "sidebar";
        const alternatePresenter = `default-${alternate}-tabs`;
        const alternateRecipe = Schema.decodeUnknownSync(
          Schema.fromJsonString(PluginCompositionRecipeSchema),
        )(await readFile(new URL(`${alternate}/composition.json`, artifactsRoot), "utf8"));
        const alternateServices = Schema.decodeUnknownSync(
          Schema.fromJsonString(PluginServiceRecipeSchema),
        )(await readFile(new URL(`${alternate}/services.json`, artifactsRoot), "utf8"));
        const packages = await Promise.all(
          [
            "default-tab-model",
            "default-tab-pins",
            "default-browser-layout",
            presenter,
            alternatePresenter,
            "default-devtools",
            "default-extension-management",
          ].map(async (id) => ({
            manifest: JSON.parse(
              await readFile(new URL(`${id}/hitchhiker.plugin.json`, artifactsRoot), "utf8"),
            ),
            code: await readFile(new URL(`${id}/plugin.js`, artifactsRoot), "utf8"),
          })),
        );
        await Effect.runPromise(
          Effect.gen(function* () {
            const engine = yield* EngineConnection;
            const nativeSurface = yield* NativeSurface;
            let committedSurface = "";
            const observedSurface = {
              ...nativeSurface,
              commit: (surface: Parameters<typeof nativeSurface.commit>[0]) =>
                nativeSurface.commit(surface).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      committedSurface = JSON.stringify(surface);
                    }),
                  ),
                ),
            };
            const controller = yield* makeBrowserController(profile, { freezeEnabled: false }).pipe(
              Effect.provideService(NativeSurface, observedSurface),
            );
            const grants = yield* createGrantStore({
              directory: join(profile, "hitchhiker-grants"),
            });
            yield* controller.start;
            const ids: string[] = [];
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
            for (const name of ["first", "second"]) {
              const id = yield* controller.openPage(`http://127.0.0.1:${address.port}/${name}`);
              ids.push(id);
              yield* evaluate(id, "document.title").pipe(
                Effect.filterOrFail(
                  (title) => title === `Tab /${name}`,
                  () => new Error("Document not ready"),
                ),
                Effect.retry({ times: 100, schedule: Schedule.spaced(25) }),
              );
              yield* evaluate(id, `globalThis.marker='${name}'`);
            }
            const storage = yield* createPluginStorage({ profileRoot: profile });
            const modelStorage = yield* storage.forOwner("default-tab-model");
            const pinsStorage = yield* storage.forOwner("default-tab-pins");
            yield* modelStorage.write(0, {
              version: 1,
              pagesRevision: 0,
              selection: { kind: "page", pageId: ids[1]! },
              pageOrder: [ids[1]!, ids[0]!],
            });
            yield* pinsStorage.write(0, { version: 1, pagesRevision: 0, pinnedPageIds: [ids[1]!] });
            let fatal = false;
            const onRecoveryFailure = Effect.sync(() => {
              fatal = true;
            });
            const composition = yield* createBrowserComposition({
              recipe: undefined,
              controller,
              onRecoveryFailure,
            });
            const launch = yield* createInstalledPluginLauncher({
              executable: pluginHost!,
              grants,
              controller,
              composition,
              onRecoveryFailure,
            });
            const artifacts = yield* createPluginArtifactStore(profile);
            const generations = new Map<string, number>();
            const active = new Set<string>();
            let peak = 0;
            const options = {
              profileRoot: profile,
              grants,
              launch: (...args: Parameters<typeof launch>) =>
                Effect.sync(() => {
                  generations.set(args[0].manifest.id, args[3].generation);
                  active.add(args[0].manifest.id);
                  peak = Math.max(peak, active.size);
                }).pipe(
                  Effect.andThen(launch(...args)),
                  Effect.ensuring(
                    Effect.sync(() => {
                      active.delete(args[0].manifest.id);
                    }),
                  ),
                  Effect.tapCause((cause) =>
                    Effect.sync(() =>
                      process.stderr.write(
                        `Default plugin ${args[0].manifest.id}: ${Cause.pretty(cause)}\n`,
                      ),
                    ),
                  ),
                ),
              composition,
              onRecoveryFailure,
            };
            const selected = () =>
              controller.snapshot.pipe(
                Effect.filterOrFail(
                  (state) =>
                    !fatal && state.viewports.length === 1 && state.viewports[0]?.pageId === ids[1],
                  () => new Error("Default presenter did not bind selected page"),
                ),
                Effect.retry({ times: 120, schedule: Schedule.spaced(25) }),
              );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const manager = yield* createPluginManager(options);
                const started = performance.now();
                for (const pkg of packages) {
                  const artifact = yield* artifacts.stage(pkg);
                  const grant = yield* grants.issue({
                    principal: artifact.manifest.id,
                    profileId: "default",
                    capabilities: artifact.manifest.capabilities,
                    origins: [],
                  });
                  yield* manager.install(artifact.hash, grant.grant.id, { staged: true });
                }
                const full = {
                  enabled: [
                    "default-tab-model",
                    "default-tab-pins",
                    "default-browser-layout",
                    presenter,
                    "default-devtools",
                    "default-extension-management",
                  ],
                  composition: recipe,
                  serviceBindings: services.bindings,
                };
                const alternatePlan = {
                  enabled: [
                    "default-tab-model",
                    "default-tab-pins",
                    "default-browser-layout",
                    alternatePresenter,
                    "default-devtools",
                    "default-extension-management",
                  ],
                  composition: alternateRecipe,
                  serviceBindings: alternateServices.bindings,
                };
                const apply = (plan: typeof full) =>
                  manager
                    .plan()
                    .pipe(Effect.flatMap((current) => manager.applyPlan(current.revision, plan)));
                yield* apply(full);
                yield* selected();
                process.stdout.write(
                  `Default ${placement} six-plugin install and first viewport: ${Math.round(performance.now() - started)}ms\n`,
                );
                assert.equal((yield* manager.list()).filter((entry) => entry.running).length, 6);
                assert(
                  committedSurface.includes("Tab /second"),
                  "SDK presenter must publish tab controls",
                );
                assert(
                  committedSurface.includes("app:lucide-pin"),
                  "Selected pin controls must initially be present",
                );
                yield* manager.disable("default-tab-pins");
                yield* selected();
                yield* Effect.sync(() => !committedSurface.includes("app:lucide-pin")).pipe(
                  Effect.filterOrFail(
                    Boolean,
                    () => new Error("Pin controls remained after provider removal"),
                  ),
                  Effect.retry({ times: 100, schedule: Schedule.spaced(25) }),
                );
                assert.equal(
                  (yield* manager.list()).find((entry) => entry.id === presenter)?.running,
                  true,
                );
                yield* manager.enable("default-tab-pins");
                yield* selected();
                yield* Effect.sync(() => committedSurface.includes("app:lucide-pin")).pipe(
                  Effect.filterOrFail(
                    Boolean,
                    () => new Error("Pin controls did not return after provider restoration"),
                  ),
                  Effect.retry({ times: 100, schedule: Schedule.spaced(25) }),
                );
                const stableGenerations = new Map(generations);
                const modelBefore = yield* modelStorage.read();
                const pinsBefore = yield* pinsStorage.read();
                yield* apply(alternatePlan);
                yield* selected();
                for (const id of [
                  "default-tab-model",
                  "default-tab-pins",
                  "default-browser-layout",
                  "default-devtools",
                  "default-extension-management",
                ])
                  assert.equal(generations.get(id), stableGenerations.get(id));
                assert.equal(active.has(presenter), false);
                assert.equal(active.has(alternatePresenter), true);
                yield* apply(full);
                yield* selected();
                assert.notEqual(generations.get(presenter), stableGenerations.get(presenter));
                for (const id of [
                  "default-tab-model",
                  "default-tab-pins",
                  "default-browser-layout",
                  "default-devtools",
                  "default-extension-management",
                ])
                  assert.equal(generations.get(id), stableGenerations.get(id));
                const failedPackage = packages.find(
                  (pkg) => pkg.manifest.id === alternatePresenter,
                )!;
                const failed = yield* artifacts.stage({
                  manifest: { ...failedPackage.manifest, id: "failing-presenter" },
                  code: `${failedPackage.code}\n{const activate=globalThis.HitchhikerPlugin.activate;globalThis.HitchhikerPlugin.activate=async()=>{await activate();throw new Error("fixture failed after publication")}}`,
                });
                const failedGrant = yield* grants.issue({
                  principal: "failing-presenter",
                  profileId: "default",
                  capabilities: failed.manifest.capabilities,
                  origins: [],
                });
                yield* manager.install(failed.hash, failedGrant.grant.id, { staged: true });
                const beforeFailure = yield* manager.plan();
                assert(
                  Exit.isFailure(
                    yield* Effect.exit(
                      apply({
                        ...alternatePlan,
                        enabled: alternatePlan.enabled.map((id) =>
                          id === alternatePresenter ? "failing-presenter" : id,
                        ),
                        composition: {
                          ...alternateRecipe,
                          slots: alternateRecipe.slots.map((slot) => ({
                            ...slot,
                            ...(slot.route === undefined
                              ? {}
                              : {
                                  route: {
                                    fallback: {
                                      ...slot.route.fallback,
                                      pluginId:
                                        slot.route.fallback.pluginId === alternatePresenter
                                          ? "failing-presenter"
                                          : slot.route.fallback.pluginId,
                                    },
                                  },
                                }),
                            contributions: slot.contributions.map((entry) =>
                              entry.pluginId === alternatePresenter
                                ? { ...entry, pluginId: "failing-presenter" }
                                : entry,
                            ),
                          })),
                        },
                        serviceBindings: alternateServices.bindings.map((binding) =>
                          binding.consumer === alternatePresenter
                            ? { ...binding, consumer: "failing-presenter" }
                            : binding,
                        ),
                      }),
                    ),
                  ),
                );
                yield* selected();
                assert.ok(
                  generations.has("failing-presenter"),
                  "rollback must follow actual candidate activation",
                );
                assert.deepEqual(yield* manager.plan(), beforeFailure);
                for (const id of [
                  "default-tab-model",
                  "default-tab-pins",
                  "default-browser-layout",
                  "default-devtools",
                  "default-extension-management",
                ])
                  assert.equal(generations.get(id), stableGenerations.get(id));
                assert.deepEqual(yield* modelStorage.read(), modelBefore);
                assert.deepEqual(yield* pinsStorage.read(), pinsBefore);
                assert.equal(peak, 6);
                assert.equal(yield* evaluate(ids[0]!, "globalThis.marker"), "first");
                assert.equal(yield* evaluate(ids[1]!, "globalThis.marker"), "second");
              }),
            );
            assert.equal(active.size, 0, "all six activations must finish before manager restart");
            const beforeRestart = new Map(generations);
            yield* Effect.scoped(
              Effect.gen(function* () {
                const manager = yield* createPluginManager(options);
                yield* manager.restore();
                yield* selected();
                assert.equal((yield* manager.list()).filter((entry) => entry.running).length, 6);
                for (const id of active) {
                  assert.ok(beforeRestart.has(id));
                  assert.notEqual(
                    generations.get(id),
                    beforeRestart.get(id),
                    `${id} must get a new activation`,
                  );
                }
                assert(
                  committedSurface.includes("Tab /second"),
                  "SDK presenter must publish tab controls",
                );
                assert.equal(yield* evaluate(ids[1]!, "globalThis.marker"), "second");
                const saved = yield* pinsStorage.read();
                assert.deepEqual(
                  Schema.decodeUnknownSync(
                    Schema.Struct({ pinnedPageIds: Schema.Array(Schema.String) }),
                  )(saved.value).pinnedPageIds,
                  [ids[1]],
                );
              }),
            );
            assert.equal(fatal, false);
            assert.equal(yield* controller.lastError, undefined);
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
