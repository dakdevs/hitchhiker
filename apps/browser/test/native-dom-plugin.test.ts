import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { NodeServices } from "@effect/platform-node";
import { Cause, Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import {
  EngineConnection,
  NativeSurface,
  createGrantStore,
  createPluginStorage,
  type SurfaceEvent,
} from "@hitchhiker/runtime";
import { makeBrowserController } from "../src/controller.ts";
import { makeBrowserDomDriver } from "../src/dom.ts";
import { createInstalledPluginLauncher, runPluginDirectory } from "../src/plugin.ts";
import { createBrowserComposition } from "../src/composition.ts";
import { createPluginManager } from "../src/plugin-manager.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const ObservedSurface = Schema.Struct({ root: Schema.Unknown });
const ObservedNode = Schema.Struct({
  key: Schema.String,
  kind: Schema.String,
  label: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  children: Schema.optional(Schema.Array(Schema.Unknown)),
});
const Evaluation = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
const Result = Schema.Struct({ phase: Schema.String, code: Schema.optional(Schema.String) });
const waitUntil = <A>(effect: Effect.Effect<A, unknown>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(
      predicate,
      (value) => new Error(`DOM plugin fixture state is not ready: ${JSON.stringify(value)}`),
    ),
    Effect.retry({ times: 160, schedule: Schedule.spaced(25) }),
    Effect.timeout(10_000),
  );

for (const mode of ["developer", "installed"] as const)
  test(
    `compiled ${mode} plugin uses scoped DOM references and rejects stale documents and foreign origins`,
    {
      skip: !binary || !pluginHost,
      timeout: 60_000,
    },
    async (context) => {
      const profile = await realpath(
        await mkdtemp(join(tmpdir(), "hitchhiker-native-dom-plugin-")),
      );
      const directory = await mkdtemp(join(tmpdir(), "hitchhiker-dom-plugin-package-"));
      const servers = [createServer(), createServer()];
      for (const server of servers)
        server.on("request", (request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end(
            "<!doctype html><title>" +
              request.url +
              "</title><label>Name<input id=\"name\"></label><button onclick=\"document.title='submitted:'+document.getElementById('name').value\">Submit</button>",
          );
        });
      try {
        for (const server of servers)
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origins = servers.map((server) => {
          const address = server.address();
          assert.ok(address && typeof address !== "string");
          return `http://127.0.0.1:${address.port}`;
        });
        const manifest = {
          id: "dom-fixture",
          name: "DOM fixture",
          version: "1.0.0",
          capabilities: ["pages.list", "pages.read", "pages.write", "storage.local", "ui.compose"],
        };
        await writeFile(join(directory, "hitchhiker.plugin.json"), JSON.stringify(manifest));
        await build({
          entryPoints: [fileURLToPath(new URL("fixtures/dom-plugin.ts", import.meta.url))],
          bundle: true,
          format: "iife",
          platform: "browser",
          target: "safari17",
          outfile: join(directory, "dist", "plugin.js"),
          logLevel: "silent",
        });
        await Effect.runPromise(
          Effect.gen(function* () {
            const lease = yield* acquireProfileWriteLease(profile, binary!);
            yield* Effect.gen(function* () {
              const engine = yield* EngineConnection;
              yield* engine.ready;
              const native = yield* NativeSurface;
              const input = yield* PubSub.unbounded<SurfaceEvent>();
              let revision = 0;
              const buttons = new Map<string, { key: string; action: string }>();
              const collect = (value: unknown): void => {
                const node = Schema.decodeUnknownSync(ObservedNode)(value);
                if (node.kind === "button" && node.label !== undefined && node.action !== undefined)
                  buttons.set(node.label, { key: node.key, action: node.action });
                node.children?.forEach(collect);
              };
              const observed = NativeSurface.of({
                events: Stream.merge(native.events, Stream.fromPubSub(input)),
                commit: (surface) =>
                  native.commit(surface).pipe(
                    Effect.tap((next) =>
                      Effect.sync(() => {
                        revision = next;
                        buttons.clear();
                        collect(Schema.decodeUnknownSync(ObservedSurface)(surface).root);
                      }),
                    ),
                  ),
              });
              const controller = yield* makeBrowserController(profile, {
                interfaceMode: "plugins",
                profileLease: lease,
                freezeEnabled: false,
              }).pipe(Effect.provideService(NativeSurface, observed));
              yield* controller.start;
              const pageId = yield* controller.openPage(`${origins[0]}/form`);
              const evaluate = (expression: string) =>
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
              yield* waitUntil(evaluate("document.title"), (value) => value === "/form");
              const grants = yield* createGrantStore({
                directory: join(profile, "hitchhiker-grants"),
              });
              const credential = yield* grants.issue({
                principal: manifest.id,
                profileId: "default",
                capabilities: [
                  "pages.list",
                  "pages.read",
                  "pages.write",
                  "storage.local",
                  "ui.compose",
                ],
                origins: [origins[0]!],
              });
              const storage = yield* createPluginStorage({ profileRoot: profile });
              const ownerStorage = yield* storage.forOwner(manifest.id);
              const dom = yield* makeBrowserDomDriver({ protectWrite: controller.protectDomWrite });
              let pluginError: string | undefined;
              if (mode === "installed") {
                const composition = yield* createBrowserComposition({
                  recipe: undefined,
                  controller,
                  onRecoveryFailure: Effect.die("Fixture composition recovery failed"),
                });
                const launch = yield* createInstalledPluginLauncher({
                  executable: pluginHost!,
                  grants,
                  controller,
                  dom,
                  composition,
                });
                const manager = yield* createPluginManager({
                  profileRoot: profile,
                  grants,
                  launch,
                  composition,
                });
                const artifacts = yield* createPluginArtifactStore(profile);
                const code = yield* Effect.promise(() =>
                  readFile(join(directory, "dist", "plugin.js"), "utf8"),
                );
                const artifact = yield* artifacts.stage({ manifest, code });
                yield* manager.install(artifact.hash, credential.grant.id, { staged: true });
                const plan = yield* manager.plan();
                yield* manager.applyPlan(plan.revision, {
                  enabled: [manifest.id],
                  composition: { layout: manifest.id, slots: [] },
                  serviceBindings: [],
                });
                assert.equal((yield* manager.list()).filter((plugin) => plugin.running).length, 1);
              } else {
                yield* runPluginDirectory({
                  profileRoot: profile,
                  directory,
                  executable: pluginHost!,
                  token: credential.token,
                  grants,
                  controller,
                  dom,
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() => {
                      pluginError = Cause.pretty(cause);
                    }),
                  ),
                  Effect.forkScoped,
                );
              }
              yield* waitUntil(controller.snapshot, (snapshot) => {
                assert.equal(pluginError, undefined);
                return snapshot.viewports.some((view) => view.pageId === pageId);
              });
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
              const result = ownerStorage
                .read()
                .pipe(Effect.flatMap((state) => Schema.decodeUnknownEffect(Result)(state.value)));
              yield* press("Exercise DOM");
              yield* waitUntil(result, (value) => value.phase === "exercised");
              assert.equal(yield* evaluate("document.title"), "submitted:Hitchhiker");
              yield* controller.navigatePage(pageId, `${origins[0]}/replacement`);
              yield* waitUntil(evaluate("document.title"), (value) => value === "/replacement");
              yield* press("Use old reference");
              const stale = yield* waitUntil(result, (value) => value.phase === "dom.stale");
              assert.equal(stale.code, "stale_ref");
              assert.equal(yield* evaluate("document.getElementById('name').value"), "");
              yield* controller.navigatePage(pageId, `${origins[1]}/foreign`);
              yield* waitUntil(evaluate("document.title"), (value) => value === "/foreign");
              yield* press("Read moved page");
              const foreign = yield* waitUntil(result, (value) => value.phase === "dom.origin");
              assert.equal(foreign.code, "not_authorized");
              yield* grants.revoke(credential.grant.id);
              yield* waitUntil(controller.snapshot, (snapshot) => snapshot.viewports.length === 0);
              assert.equal((yield* controller.snapshot).pages.length, 1);
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
        for (const server of servers) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await rm(profile, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
