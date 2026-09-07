import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schedule, Schema } from "effect";
import {
  EngineConnection,
  NativeSurface,
  createGrantStore,
  PluginCompositionRecipeSchema,
} from "@hitchhiker/runtime";
import { makeBrowserController } from "../src/controller.ts";
import { createBrowserComposition } from "../src/composition.ts";
import { createInstalledPluginLauncher } from "../src/plugin.ts";
import { createPluginManager } from "../src/plugin-manager.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const example = new URL("../../composition-example/", import.meta.url);
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });

test(
  "three installed SDK plugins compose Chromium pages, survive removal, and restore from artifacts",
  { skip: !binary || !pluginHost, timeout: 45000 },
  async () => {
    const profile = await realpath(
      await mkdtemp(join(tmpdir(), "hitchhiker-installed-composition-")),
    );
    const server = createServer((request, response) =>
      response.end(`<!doctype html><title>Panel ${request.url}</title><p>Retained page</p>`),
    );
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address !== "string");
      const recipe = Schema.decodeUnknownSync(Schema.fromJsonString(PluginCompositionRecipeSchema))(
        await readFile(new URL("composition.json", example), "utf8"),
      );
      const packages = await Promise.all(
        ["right", "left", "layout"].map(async (name) => ({
          name,
          manifest: JSON.parse(
            await readFile(new URL(`${name}.hitchhiker.plugin.json`, example), "utf8"),
          ),
          code: await readFile(new URL(`dist/${name}.js`, example), "utf8"),
        })),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const engine = yield* EngineConnection;
          const controller = yield* makeBrowserController(profile, { freezeEnabled: false });
          const grants = yield* createGrantStore({ directory: join(profile, "hitchhiker-grants") });
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
                (title) => title === `Panel /${name}`,
                () => new Error("waiting for document"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced(25) }),
            );
            yield* evaluate(id, `globalThis.marker='${name}'`);
          }
          let fatal = false;
          const onRecoveryFailure = Effect.sync(() => {
            fatal = true;
          });
          const composition = yield* createBrowserComposition({
            recipe,
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
          const waitForPages = (expected: readonly string[]) =>
            controller.snapshot.pipe(
              Effect.filterOrFail(
                (state) =>
                  !fatal &&
                  JSON.stringify(state.viewports.map((view) => view.pageId).sort()) ===
                    JSON.stringify([...expected].sort()),
                (state) =>
                  new Error(
                    `Waiting for composed pages: ${JSON.stringify({ fatal, expected, viewports: state.viewports })}`,
                  ),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced(25) }),
            );
          const artifacts = yield* createPluginArtifactStore(profile);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const manager = yield* createPluginManager({
                profileRoot: profile,
                grants,
                launch,
                compositionOwners: composition.owners,
                onRecoveryFailure,
              });
              for (const pkg of packages) {
                const artifact = yield* artifacts.stage(pkg);
                const grant = yield* grants.issue({
                  principal: artifact.manifest.id,
                  profileId: "default",
                  capabilities: artifact.manifest.capabilities,
                  origins: [],
                });
                yield* manager.install(artifact.hash, grant.grant.id);
              }
              yield* waitForPages(ids);
              assert.equal((yield* manager.list()).filter((plugin) => plugin.running).length, 3);
              yield* manager.disable("split-left");
              yield* waitForPages([ids[1]!]);
              assert.equal(yield* evaluate(ids[0]!, "globalThis.marker"), "first");
              assert.equal(yield* evaluate(ids[1]!, "globalThis.marker"), "second");
              yield* manager.enable("split-left");
              yield* waitForPages(ids);
              yield* manager.disable("split-layout");
              yield* waitForPages([]);
              yield* manager.enable("split-layout");
              yield* waitForPages(ids);
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const manager = yield* createPluginManager({
                profileRoot: profile,
                grants,
                launch,
                compositionOwners: composition.owners,
                onRecoveryFailure,
              });
              yield* manager.restore();
              yield* waitForPages(ids);
              assert.equal((yield* manager.list()).filter((plugin) => plugin.running).length, 3);
              assert.equal(yield* evaluate(ids[0]!, "globalThis.marker"), "first");
              assert.equal(yield* evaluate(ids[1]!, "globalThis.marker"), "second");
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
