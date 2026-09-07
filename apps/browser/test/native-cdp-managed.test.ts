import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect";
import { EngineConnection, NativeSurface, type ManagedCdpEvent } from "@hitchhiker/runtime";
import { makeBrowserController } from "../src/controller.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";
import { createExtensionArtifactStore } from "../src/extension-artifacts.ts";
import { createExtensionManager } from "../src/extension-manager.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const decodeTarget = Schema.decodeUnknownEffect(
  Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String }) }),
);
const decodeValue = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) }),
);
const until = <A>(
  effect: Effect.Effect<A, unknown>,
  predicate: (value: A) => boolean,
  description: string,
) =>
  effect.pipe(
    Effect.filterOrFail(
      predicate,
      (value) => new Error(`${description}: ${JSON.stringify(value)}`),
    ),
    Effect.retry({ times: 160, schedule: Schedule.spaced(25) }),
  );

test(
  "managed CDP sessions retain independent events while Chromium installs and removes an extension",
  {
    skip: !binary,
    timeout: 60_000,
  },
  async (context) => {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-native-devtools-")));
    const source = join(profile, "fixture-source");
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Managed CDP fixture</title><input value='retained'>");
    });
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
          name: "Managed CDP coexistence fixture",
          version: "1.0",
          content_scripts: [
            { matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_end" },
          ],
        }),
      );
      await writeFile(
        join(source, "content.js"),
        `if(location.origin===${JSON.stringify(origin)})document.documentElement.dataset.cdpExtension='installed';`,
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const lease = yield* acquireProfileWriteLease(profile, binary!);
          yield* Effect.gen(function* () {
            const engine = yield* EngineConnection;
            yield* engine.ready;
            const artifacts = yield* createExtensionArtifactStore({ profileLease: lease });
            const manager = yield* createExtensionManager({
              profileRoot: profile,
              lease,
              engine,
              artifacts,
            });
            yield* manager.restoreBeforePages();
            const controller = yield* makeBrowserController(profile, {
              interfaceMode: "plugins",
              profileLease: lease,
              freezeEnabled: false,
            });
            yield* controller.start;
            const pageId = yield* controller.openPage(`${origin}/retained`);
            const evaluate = (page: string, expression: string) =>
              engine
                .request("cdp.send", {
                  pageId: page,
                  method: "Runtime.evaluate",
                  params: { expression, returnByValue: true },
                })
                .pipe(
                  Effect.flatMap(decodeValue),
                  Effect.map((result) => result.result.value),
                );
            yield* until(
              evaluate(pageId, "document.title"),
              (value) => value === "Managed CDP fixture",
              "Page loaded",
            );
            const { targetInfo } = yield* engine
              .request("cdp.send", { pageId, method: "Target.getTargetInfo", params: {} })
              .pipe(Effect.flatMap(decodeTarget));
            const first = yield* engine.openCdpSession(targetInfo.targetId);
            const second = yield* engine.openCdpSession(targetInfo.targetId);
            const firstEvents: ManagedCdpEvent[] = [];
            const secondEvents: ManagedCdpEvent[] = [];
            yield* first.events.pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  firstEvents.push(event);
                }),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* second.events.pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  secondEvents.push(event);
                }),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* first.request("Runtime.enable");
            yield* second.request("Runtime.enable");
            assert.equal(yield* engine.claimRawCdp.pipe(Effect.isFailure), true);
            assert.equal(yield* first.request("Target.getTargets").pipe(Effect.isFailure), true);
            assert.equal(
              yield* first
                .request("Extensions.loadUnpacked", { path: source })
                .pipe(Effect.isFailure),
              true,
            );
            const sessionValue = (expression: string) =>
              second.request("Runtime.evaluate", { expression, returnByValue: true }).pipe(
                Effect.flatMap(decodeValue),
                Effect.map((result) => result.result.value),
              );
            const preview = yield* manager.previewLocal(source);
            const installed = yield* Effect.all(
              [
                manager.confirmInstall(preview.installationId, preview.digest),
                sessionValue("document.querySelector('input').value"),
              ],
              { concurrency: 2 },
            );
            assert.equal(installed[1], "retained");
            assert.equal((yield* manager.list())[0]?.state, "enabled");
            const installedPage = yield* controller.openPage(`${origin}/installed`);
            yield* until(
              evaluate(installedPage, "document.documentElement.dataset.cdpExtension ?? null"),
              (value) => value === "installed",
              "Extension content script ran",
            );
            yield* first.request("Runtime.disable");
            const marker = "managed-session-after-install";
            yield* sessionValue(`console.log(${JSON.stringify(marker)}); true`);
            yield* until(
              Effect.sync(() =>
                secondEvents.some((event) => JSON.stringify(event).includes(marker)),
              ),
              Boolean,
              "Second session received event",
            );
            yield* first.request("Runtime.evaluate", { expression: "1" });
            assert.equal(
              firstEvents.some((event) => JSON.stringify(event).includes(marker)),
              false,
            );
            const removed = yield* Effect.all(
              [
                manager.remove(preview.installationId),
                sessionValue("document.querySelector('input').value"),
              ],
              { concurrency: 2 },
            );
            assert.equal(removed[1], "retained");
            assert.equal((yield* manager.list())[0]?.state, "removed");
            const removedPage = yield* controller.openPage(`${origin}/removed`);
            yield* until(
              evaluate(removedPage, "document.readyState"),
              (value) => value === "complete",
              "Removed extension page loaded",
            );
            assert.equal(
              yield* evaluate(removedPage, "document.documentElement.dataset.cdpExtension ?? null"),
              null,
            );
            assert.equal(yield* sessionValue("document.querySelector('input').value"), "retained");
            yield* first.close;
            assert.equal(
              yield* first.request("Runtime.evaluate", { expression: "1" }).pipe(Effect.isFailure),
              true,
            );
            assert.equal(yield* engine.claimRawCdp.pipe(Effect.isFailure), true);
            yield* second.close;
            yield* Effect.scoped(
              Effect.gen(function* () {
                const recovery = yield* engine.openCdpSession(targetInfo.targetId);
                const pauses: Schema.Json[] = [];
                yield* recovery.events.pipe(
                  Stream.filter((event) => event.method === "Fetch.requestPaused"),
                  Stream.runForEach((event) =>
                    Effect.sync(() => {
                      pauses.push(event.params);
                    }),
                  ),
                  Effect.forkScoped({ startImmediately: true }),
                );
                yield* recovery.request("Fetch.enable", { patterns: [{ urlPattern: "*/held" }] });
                yield* evaluate(
                  pageId,
                  "globalThis.managedFetch='waiting'; fetch('/held').then(r=>globalThis.managedFetch=r.status).catch(()=>globalThis.managedFetch='failed'); true",
                );
                yield* until(
                  Effect.sync(() => pauses.length),
                  (count) => count === 1,
                  "Managed request intercepted",
                );
                const paused = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({ request: Schema.Struct({ url: Schema.String }) }),
                )(pauses[0]);
                assert.equal(paused.request.url, `${origin}/held`);
                assert.equal(yield* evaluate(pageId, "globalThis.managedFetch"), "waiting");
              }),
            );
            yield* until(
              evaluate(pageId, "globalThis.managedFetch"),
              (value) => value === 200,
              "Scope cleanup released request",
            );
            const removedTarget = yield* engine
              .request("cdp.send", {
                pageId: removedPage,
                method: "Target.getTargetInfo",
                params: {},
              })
              .pipe(Effect.flatMap(decodeTarget));
            const disappearing = yield* engine.openCdpSession(removedTarget.targetInfo.targetId);
            const streamExit = yield* disappearing.events.pipe(
              Stream.runDrain,
              Effect.exit,
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* controller.closePage(removedPage);
            yield* Fiber.join(streamExit).pipe(Effect.timeout(5_000));
            assert.equal(
              yield* disappearing
                .request("Runtime.evaluate", { expression: "1" })
                .pipe(Effect.isFailure),
              true,
            );
            yield* disappearing.close;
            const raw = yield* engine.claimRawCdp;
            assert.ok(raw);
            assert.equal(
              yield* engine.openCdpSession(targetInfo.targetId).pipe(Effect.isFailure),
              true,
            );
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
                  profileRoot: lease.profileRoot,
                  extensionManagement: true,
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
