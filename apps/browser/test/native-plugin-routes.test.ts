import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schedule, Schema } from "effect";
import { EngineConnection, NativeSurface, createGrantStore } from "@hitchhiker/runtime";
import { makeBrowserController } from "../src/controller.ts";
import { createBrowserComposition } from "../src/composition.ts";
import { createInstalledPluginLauncher } from "../src/plugin.ts";
import { createPluginManager } from "../src/plugin-manager.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
const waitFor = <A>(effect: Effect.Effect<A, unknown>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(predicate, () => new Error("Waiting for native plugin route")),
    Effect.retry({ times: 100, schedule: Schedule.spaced(50) }),
  );

test(
  "installed SDK routes hide Chromium bindings and restore the latest live page",
  {
    skip: !binary || !pluginHost,
    timeout: 45_000,
  },
  async () => {
    const profile = await realpath(
      await mkdtemp(join(tmpdir(), "hitchhiker-native-extension-plugin-routes-")),
    );
    const server = createServer((_request, response) =>
      response.end("<!doctype html><title>Retained route page</title>"),
    );
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const packages = await Promise.all(
        ["browser", "manager"].map(async (role) => {
          const code =
            role === "browser"
              ? `
        import {column, viewport} from "./packages/ui/src/index.ts";
        let api;
        async function refresh() {
          const pages = await api.pages.list();
          const page = pages.at(-1);
          await api.ui.publishContribution("content", {root: viewport("page", "content"), bindings: page ? [{viewportId:"content",pageId:page.id}] : []});
        }
        definePlugin({async activate(host) {
          api=host;
          await api.ui.publishLayout({root:column("root",[column("slot",[])]),bindings:[]});
          await refresh();
        },onEvent(event) { if(event.startsWith("pages.")) return refresh(); }});`
              : `
        import {text} from "./packages/ui/src/index.ts";
        let api;
        definePlugin({async activate(host) {
          api=host;
          await api.ui.publishContribution("main",{root:text("management","Independent management"),bindings:[]});
          await api.ui.showRoute("main");
        },async onEvent(event) { if(event.startsWith("pages.")) await api.ui.hideRoute("main"); }});`;
          const bundled = await build({
            stdin: {
              contents: `import {definePlugin} from "./packages/plugin-sdk/src/index.ts";${code}`,
              resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
              loader: "ts",
            },
            bundle: true,
            write: false,
            format: "iife",
            platform: "browser",
          });
          return {
            manifest: {
              id: `route-${role}`,
              name: `Route ${role}`,
              version: "1.0.0",
              capabilities: ["ui.compose", "pages.list"],
            },
            code: bundled.outputFiles[0]!.text,
          };
        }),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* EngineConnection;
            const controller = yield* makeBrowserController(profile, { freezeEnabled: false });
            yield* controller.start;
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
            const first = yield* controller.openPage(`http://127.0.0.1:${address.port}/first`);
            yield* waitFor(evaluate(first, "document.readyState"), (value) => value === "complete");
            yield* evaluate(first, "globalThis.retainedRouteMarker='first'");
            const grants = yield* createGrantStore({
              directory: join(profile, "hitchhiker-grants"),
            });
            const composition = yield* createBrowserComposition({
              recipe: undefined,
              controller,
              onRecoveryFailure: Effect.die("route recovery failed"),
            });
            const launch = yield* createInstalledPluginLauncher({
              executable: pluginHost!,
              grants,
              controller,
              composition,
            });
            const manager = yield* createPluginManager({
              profileRoot: profile,
              grants,
              launch,
              composition,
            });
            const artifacts = yield* createPluginArtifactStore(profile);
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
            const recipe = {
              layout: "route-browser",
              slots: [
                {
                  key: "slot",
                  route: { fallback: { pluginId: "route-browser", id: "content" } },
                  contributions: [
                    { pluginId: "route-browser", id: "content" },
                    { pluginId: "route-manager", id: "main", optional: true as const },
                  ],
                },
              ],
            };
            const plan = {
              enabled: ["route-browser", "route-manager"],
              composition: recipe,
              serviceBindings: [],
            };
            yield* manager.applyPlan((yield* manager.plan()).revision, plan);
            assert.equal((yield* manager.list()).filter((entry) => entry.running).length, 2);
            yield* waitFor(controller.snapshot, (state) => state.viewports.length === 0);
            assert.equal(yield* composition.complete, true);
            assert.equal(yield* evaluate(first, "globalThis.retainedRouteMarker"), "first");
            const second = yield* controller.openPage(`http://127.0.0.1:${address.port}/second`);
            yield* waitFor(
              controller.snapshot,
              (state) => state.viewports.length === 1 && state.viewports[0]?.pageId === second,
            );
            assert.equal(yield* evaluate(first, "globalThis.retainedRouteMarker"), "first");
            yield* waitFor(
              evaluate(second, "document.readyState"),
              (value) => value === "complete",
            );
            yield* manager.disable("route-manager");
            assert.equal((yield* manager.list()).filter((entry) => entry.running).length, 1);
            assert.deepEqual((yield* manager.plan()).composition, recipe);
            yield* manager.enable("route-manager");
            yield* waitFor(controller.snapshot, (state) => state.viewports.length === 0);
            yield* manager.uninstall("route-manager");
            yield* waitFor(
              controller.snapshot,
              (state) => state.viewports.length === 1 && state.viewports[0]?.pageId === second,
            );
            assert.deepEqual((yield* manager.plan()).composition, recipe);
            assert.equal(
              (yield* manager.list()).some((entry) => entry.id === "route-manager"),
              false,
            );
            assert.equal(yield* evaluate(first, "globalThis.retainedRouteMarker"), "first");
            assert.equal(yield* controller.lastError, undefined);
            yield* engine.request("window.close");
            assert.equal(yield* engine.exit.pipe(Effect.timeout(10_000)), 0);
          }),
        ).pipe(
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
