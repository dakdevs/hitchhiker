import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import {
  EngineConnection,
  NativeSurface,
  createGrantStore,
  type SurfaceEvent,
} from "@hitchhiker/runtime";
import { makeBrowserController } from "../src/controller.ts";
import { createBrowserComposition } from "../src/composition.ts";
import { createInstalledPluginLauncher } from "../src/plugin.ts";
import { createPluginManager } from "../src/plugin-manager.ts";
import { createPluginManagement } from "../src/plugin-management.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
const Node = Schema.Struct({
  key: Schema.String,
  kind: Schema.String,
  label: Schema.optional(Schema.String),
  accessibilityLabel: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  children: Schema.optional(Schema.Array(Schema.Unknown)),
});
const Surface = Schema.Struct({ root: Schema.Unknown });
const waitFor = <A>(effect: Effect.Effect<A, unknown>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(predicate, () => new Error("Waiting for independent management UI")),
    Effect.retry({ times: 100, schedule: Schedule.spaced(50) }),
  );

test(
  "standalone Settings and Plugins artifacts control a real browser through public SDK APIs",
  { skip: !binary || !pluginHost, timeout: 45_000 },
  async () => {
    const profile = await realpath(
      await mkdtemp(join(tmpdir(), "hitchhiker-native-extension-plugin-management-")),
    );
    const server = createServer((_request, response) =>
      response.end("<!doctype html><title>Retained management page</title>"),
    );
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address !== "string");
      const packages = await Promise.all(
        ["default-sidebar-tabs", "default-top-tabs", "event-target"].map(async (id) => {
          const contents =
            id === "event-target"
              ? "definePlugin({activate(){}});"
              : `
        import {column,row,viewport} from "./packages/ui/src/index.ts";
        let api;
        async function refresh(){const pages=await api.pages.list();const page=pages.at(-1);await api.ui.publishContribution("content",{root:viewport("page","content"),bindings:page?[{viewportId:"content",pageId:page.id}]:[]});}
        definePlugin({async activate(host){api=host;await api.ui.publishLayout({root:column("root",[row("toolbar",[]),column("slot",[],{flex:1})]),bindings:[]});await refresh();},onEvent(event){if(event.startsWith("pages."))return refresh();}});`;
          const bundled = await build({
            stdin: {
              contents: `import {definePlugin} from "./packages/plugin-sdk/src/index.ts";${contents}`,
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
              id,
              name: id === "event-target" ? "Event target" : id,
              version: "1.0.0",
              capabilities: id === "event-target" ? [] : ["ui.compose", "pages.list"],
            },
            code: bundled.outputFiles[0]!.text,
          };
        }),
      );
      for (const id of ["default-settings", "default-plugin-management"]) {
        const root = new URL(`../../default-plugins/dist/${id}/`, import.meta.url);
        packages.push({
          manifest: JSON.parse(await readFile(new URL("hitchhiker.plugin.json", root), "utf8")),
          code: await readFile(new URL("plugin.js", root), "utf8"),
        });
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const engine = yield* EngineConnection;
          const nativeSurface = yield* NativeSurface;
          const input = yield* PubSub.unbounded<SurfaceEvent>();
          yield* Effect.addFinalizer(() => PubSub.shutdown(input));
          const buttons = new Map<string, { key: string; action: string }>();
          let revision = 0;
          const collect = (value: unknown): void => {
            const node = Schema.decodeUnknownSync(Node)(value);
            if (node.kind === "button" && node.action && node.label)
              buttons.set(node.accessibilityLabel ?? node.label, {
                key: node.key,
                action: node.action,
              });
            node.children?.forEach(collect);
          };
          const observed = NativeSurface.of({
            ...nativeSurface,
            events: Stream.merge(nativeSurface.events, Stream.fromPubSub(input)),
            commit: (surface) =>
              nativeSurface.commit(surface).pipe(
                Effect.tap((next) =>
                  Effect.sync(() => {
                    revision = next;
                    buttons.clear();
                    collect(Schema.decodeUnknownSync(Surface)(surface).root);
                  }),
                ),
              ),
          });
          const controller = yield* makeBrowserController(profile, { freezeEnabled: false }).pipe(
            Effect.provideService(NativeSurface, observed),
          );
          yield* controller.start;
          const pageId = yield* controller.openPage(`http://127.0.0.1:${address.port}/`);
          const evaluate = (expression: string) =>
            engine
              .request("cdp.send", {
                pageId,
                method: "Runtime.evaluate",
                params: { expression, returnByValue: true },
              })
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Value)),
                Effect.map((value) => value.result.value),
              );
          yield* waitFor(evaluate("document.readyState"), (value) => value === "complete");
          yield* evaluate("globalThis.managementMarker='retained'");
          const grants = yield* createGrantStore({ directory: join(profile, "hitchhiker-grants") });
          const composition = yield* createBrowserComposition({
            recipe: undefined,
            controller,
            onRecoveryFailure: Effect.die("management recovery failed"),
          });
          const management = yield* createPluginManagement({ startPaused: true });
          const launch = yield* createInstalledPluginLauncher({
            executable: pluginHost!,
            grants,
            controller,
            composition,
            management,
          });
          const generations = new Map<string, number>();
          const manager = yield* createPluginManager({
            profileRoot: profile,
            grants,
            composition,
            launch: (artifact, grant, ready, activation) => {
              generations.set(artifact.manifest.id, activation.generation);
              return launch(artifact, grant, ready, activation);
            },
          });
          yield* management.bind(manager);
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
          yield* manager.applyPlan((yield* manager.plan()).revision, {
            enabled: ["default-sidebar-tabs", "default-settings", "default-plugin-management"],
            composition: {
              layout: "default-sidebar-tabs",
              slots: [
                {
                  key: "toolbar",
                  contributions: [
                    { pluginId: "default-settings", id: "launcher", optional: true },
                    { pluginId: "default-plugin-management", id: "launcher", optional: true },
                  ],
                },
                {
                  key: "slot",
                  route: { fallback: { pluginId: "default-sidebar-tabs", id: "content" } },
                  contributions: [
                    { pluginId: "default-sidebar-tabs", id: "content" },
                    { pluginId: "default-settings", id: "main", optional: true },
                    { pluginId: "default-plugin-management", id: "main", optional: true },
                  ],
                },
              ],
            },
            serviceBindings: [],
          });
          yield* management.enableMutations();
          const press = (label: string) =>
            Effect.gen(function* () {
              yield* waitFor(
                Effect.sync(() => buttons.has(label)),
                Boolean,
              );
              const button = buttons.get(label)!;
              yield* PubSub.publish(input, {
                surfaceId: "main",
                revision,
                nodeId: button.key,
                event: "press",
                payload: { action: button.action },
              });
            });
          const settingsGeneration = generations.get("default-settings");
          const managementGeneration = generations.get("default-plugin-management");
          yield* press("Settings");
          yield* press("Dark");
          yield* waitFor(controller.configuration, (value) => value.colorScheme === "dark");
          yield* waitFor(
            Effect.sync(() => buttons.has("Dark, selected")),
            Boolean,
          );
          yield* press("Use top tabs");
          yield* waitFor(manager.plan(), (plan) => plan.enabled.includes("default-top-tabs"));
          yield* waitFor(
            Effect.sync(() => buttons.has("Use sidebar tabs")),
            Boolean,
          );
          assert.equal((yield* controller.snapshot).viewports.length, 0);
          assert.equal(generations.get("default-settings"), settingsGeneration);
          assert.equal(generations.get("default-plugin-management"), managementGeneration);
          yield* press("Back");
          yield* waitFor(controller.snapshot, (value) => value.viewports[0]?.pageId === pageId);
          yield* press("Plugins");
          yield* press("Use sidebar tabs");
          yield* waitFor(manager.plan(), (plan) => plan.enabled.includes("default-sidebar-tabs"));
          yield* waitFor(
            Effect.sync(() => buttons.has("Use top tabs")),
            Boolean,
          );
          assert.equal(generations.get("default-settings"), settingsGeneration);
          assert.equal(generations.get("default-plugin-management"), managementGeneration);
          yield* press("Enable Event target");
          yield* waitFor(
            manager.managementSnapshot(),
            (value) =>
              value.plugins.find((plugin) => plugin.id === "event-target")?.running === true,
          );
          yield* waitFor(
            Effect.sync(() => buttons.has("Disable Event target")),
            Boolean,
          );
          yield* manager.disable("event-target");
          yield* waitFor(
            Effect.sync(() => buttons.has("Enable Event target")),
            Boolean,
          );
          yield* manager.disable("default-settings");
          yield* waitFor(
            Effect.sync(() => !buttons.has("Settings")),
            Boolean,
          );
          assert.equal(generations.get("default-plugin-management"), managementGeneration);
          yield* manager.enable("default-settings");
          yield* waitFor(
            Effect.sync(() => buttons.has("Settings")),
            Boolean,
          );
          yield* manager.disable("default-plugin-management");
          yield* waitFor(controller.snapshot, (value) => value.viewports[0]?.pageId === pageId);
          yield* waitFor(
            Effect.sync(() => !buttons.has("Plugins")),
            Boolean,
          );
          yield* manager.enable("default-plugin-management");
          yield* press("Plugins");
          yield* waitFor(controller.snapshot, (value) => value.viewports.length === 0);
          yield* manager.uninstall("default-plugin-management");
          yield* waitFor(controller.snapshot, (value) => value.viewports[0]?.pageId === pageId);
          assert.equal(yield* evaluate("globalThis.managementMarker"), "retained");
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
