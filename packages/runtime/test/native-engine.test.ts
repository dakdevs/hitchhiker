import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Context, Effect, Fiber, Layer, Option, Schedule, Schema, Stream } from "effect";
import { EngineConnection, EngineError } from "../src/engine.ts";
import { openCdpRelay } from "../src/cdp-relay.ts";
import { chromium } from "playwright-core";
import { NodeServices } from "@effect/platform-node";
import { create as createGrantStore } from "../src/grants.ts";
import { NativeSurface } from "../src/surface.ts";
import { row, column, text, viewport as pageViewport } from "@hitchhiker/ui";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const extensionFixture = fileURLToPath(
  new URL("../../../apps/host-probe/fixtures/extension", import.meta.url),
);
const extensionArtifactsModule = pathToFileURL(
  fileURLToPath(new URL("../../../apps/browser/src/extension-artifacts.ts", import.meta.url)),
).href;
const profileLeaseModule = pathToFileURL(
  fileURLToPath(new URL("../../../apps/browser/src/profile-write-lease.ts", import.meta.url)),
).href;
const Value = Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) });
const decodeValue = Schema.decodeUnknownEffect(Value);
const viewportBounds = Schema.decodeUnknownOption(
  Schema.Struct({ width: Schema.Number, height: Schema.Number }),
);

test(
  "real Chromium private IPC, browser-root CDP and separate profile storage",
  { skip: !binary, timeout: 60_000 },
  async () => {
    if (!binary) return;
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-engine-"));
    const firstProfile = join(directory, "first profile 🚀");
    const keylessSource = join(directory, "keyless extension 🚀");
    const keyedSource = join(directory, "keyed extension");
    await cp(extensionFixture, keylessSource, { recursive: true, force: false });
    await cp(extensionFixture, keyedSource, { recursive: true, force: false });
    const keyedManifestPath = join(keyedSource, "manifest.json");
    const keyedManifest = JSON.parse(await readFile(keyedManifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    keyedManifest.key = "AQID";
    await writeFile(keyedManifestPath, JSON.stringify(keyedManifest), "utf8");
    const { createExtensionArtifactStore } = (await import(extensionArtifactsModule)) as {
      readonly createExtensionArtifactStore: (options: {
        readonly profileLease: unknown;
      }) => Effect.Effect<{
        readonly stage: (sourceDirectory: string) => Effect.Effect<{
          readonly directory: string;
          readonly expectedChromiumId: string;
        }>;
      }>;
    };
    const { acquireProfileWriteLease } = (await import(profileLeaseModule)) as {
      readonly acquireProfileWriteLease: (
        profileRoot: string,
        executable: string,
      ) => Effect.Effect<unknown, unknown, never>;
    };
    const [keylessArtifact, keyedArtifact] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const profileLease = yield* acquireProfileWriteLease(firstProfile, binary);
          const extensionArtifacts = yield* createExtensionArtifactStore({ profileLease });
          return yield* Effect.all([
            extensionArtifacts.stage(keylessSource),
            extensionArtifacts.stage(keyedSource),
          ]);
        }),
      ),
    );
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><title>Hitchhiker transport fixture</title><input id="input"><script>globalThis.fixtureReady=true;</script>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/`;
    const evaluate = Effect.fn("test.evaluate")(function* (
      engine: EngineConnection["Service"],
      pageId: string,
      expression: string,
    ) {
      const raw = yield* engine.request("cdp.send", {
        pageId,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      });
      const result = yield* decodeValue(raw);
      return result.result.value;
    });
    const loaded = Effect.fn("test.loaded")(
      function* (engine: EngineConnection["Service"], pageId: string) {
        const ready = yield* evaluate(engine, pageId, "globalThis.fixtureReady === true");
        if (!ready)
          return yield* new EngineError({ code: "loading", message: "Fixture not loaded" });
      },
      Effect.retry({ times: 100, schedule: Schedule.spaced(50) }),
    );
    const close = Effect.fn("test.close")(function* (engine: EngineConnection["Service"]) {
      // Root teardown can complete before its queued acknowledgement flushes.
      yield* engine.request("window.close").pipe(Effect.catch(() => Effect.void));
      assert.equal(yield* engine.exit, 0);
    });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const first = yield* EngineConnection;
          yield* Effect.addFinalizer(() =>
            first.request("window.close").pipe(Effect.catch(() => Effect.void)),
          );
          yield* first.ready;
          const keylessId = yield* first.loadUnpacked(keylessArtifact.directory);
          assert.equal(keylessId, keylessArtifact.expectedChromiumId);
          const keyedId = yield* first.loadUnpacked(keyedArtifact.directory);
          assert.equal(keyedId, keyedArtifact.expectedChromiumId);
          assert.notEqual(keyedId, keylessId);
          yield* first.uninstall(keyedId);
          yield* first.uninstall(keylessId);
          assert.deepEqual(yield* first.request("pages.list"), []);
          yield* first.request("pages.open", { id: "first", url });
          yield* loaded(first, "first");
          const viewport = yield* first.events.pipe(
            Stream.filter((event) => {
              const bounds = viewportBounds(event.params.payload);
              return (
                event.event === "ui.event" &&
                event.params.event === "viewport" &&
                event.params.revision === 1 &&
                Option.isSome(bounds) &&
                bounds.value.width > 0 &&
                bounds.value.height > 0
              );
            }),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          const root = row("root", [
            column("sidebar", [text("brand", "Hitchhiker")], { width: 260 }),
            pageViewport("page-region", "main-page", { flex: 1 }),
          ]);
          const nativeSurface = Context.get(yield* Layer.build(NativeSurface.layer), NativeSurface);
          yield* nativeSurface.commit({
            root,
            bindings: [{ viewportId: "main-page", pageId: "first" }],
          });
          const measured = yield* Fiber.join(viewport).pipe(Effect.timeout(5000));
          assert.equal(measured.length, 1);
          assert.equal(measured[0].params.nodeId, "page-region");
          const region = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              viewportId: Schema.String,
              x: Schema.Number,
              y: Schema.Number,
              width: Schema.Number,
              height: Schema.Number,
            }),
          )(measured[0].params.payload);
          assert.equal(region.viewportId, "main-page");
          assert.ok(region.width > 0 && region.height > 0);
          assert.equal(
            yield* nativeSurface
              .commit({ root, bindings: [{ viewportId: "unknown", pageId: "first" }] })
              .pipe(Effect.isFailure),
            true,
          );
          yield* first.request("viewports.set", {
            viewports: [{ pageId: "first", x: 260, y: 0, width: 400, height: 400 }],
          });
          assert.equal(
            yield* evaluate(
              first,
              "first",
              "document.querySelector('#input').value='persistent'; document.cookie='hitchhiker_probe=one; SameSite=Strict';localStorage.setItem('probe','one');true",
            ),
            true,
          );
          yield* Effect.gen(function* () {
            const store = yield* createGrantStore({ directory: join(directory, "grants") });
            const issued = yield* store.issue({
              principal: "native-test",
              profileId: "first",
              capabilities: ["cdp.connect"],
              origins: [],
            });
            const relay = yield* openCdpRelay({
              engine: first,
              principal: issued.grant.principal,
              authorize: () =>
                store
                  .authorize(issued.token, { profileId: "first", capability: "cdp.connect" })
                  .pipe(
                    Effect.map(() => true),
                    Effect.catch(() => Effect.succeed(false)),
                  ),
              authorizationRecheckMs: 50,
            });
            yield* store.revocations.pipe(
              Stream.filter((event) => event.id === issued.grant.id),
              Stream.runForEach(() => relay.revoke),
              Effect.forkScoped,
            );
            yield* Effect.yieldNow;
            const browser = yield* Effect.acquireRelease(
              Effect.promise(() => chromium.connectOverCDP(relay.url, { timeout: 5000 })),
              (client) =>
                Effect.promise(() => client.close()).pipe(
                  Effect.timeoutOrElse({ duration: 2_000, orElse: () => Effect.void }),
                  Effect.catch(() => Effect.void),
                ),
            );
            const page = browser
              .contexts()
              .flatMap((context) => context.pages())
              .find((candidate) => candidate.url() === url);
            assert.ok(page, "standard CDP client discovers the existing CEF page");
            assert.equal(yield* Effect.promise(() => page.title()), "Hitchhiker transport fixture");
            assert.equal(
              yield* Effect.promise(() => page.locator("#input").inputValue()),
              "persistent",
            );
            yield* Effect.promise(() => page.locator("#input").fill("via-playwright"));
            const browserSession = yield* Effect.promise(() => browser.newBrowserCDPSession());
            const blockedMutation = yield* Effect.promise(() =>
              browserSession
                .send("Extensions.loadUnpacked", { path: keylessArtifact.directory })
                .then(
                  () => undefined,
                  (error: unknown) => error,
                ),
            );
            assert.notEqual(blockedMutation, undefined);
            assert.match(String(blockedMutation), /Method is not available through this relay/);
            assert.equal(yield* Effect.promise(() => page.title()), "Hitchhiker transport fixture");
            yield* store.revoke(issued.grant.id);
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  if (!browser.isConnected()) return resolve();
                  const timer = setTimeout(
                    () => reject(new Error("Revoked CDP client remained connected")),
                    3000,
                  );
                  browser.once("disconnected", () => {
                    clearTimeout(timer);
                    resolve();
                  });
                }),
            );
          }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
          yield* Effect.gen(function* () {
            const second = yield* EngineConnection;
            yield* second.ready;
            yield* second.request("pages.open", { id: "second", url });
            yield* loaded(second, "second");
            assert.equal(
              yield* evaluate(
                second,
                "second",
                "document.cookie + ':' + (localStorage.getItem('probe') ?? '')",
              ),
              ":",
            );
            assert.equal(
              yield* evaluate(first, "first", "document.querySelector('#input').value"),
              "via-playwright",
            );
            yield* close(second);
          }).pipe(
            Effect.provide(
              EngineConnection.layer({
                executable: binary,
                profileRoot: join(directory, "second"),
                extensionManagement: false,
              }),
            ),
            Effect.scoped,
          );
          yield* close(first);
          // macOS /var and /private/var name the same profile. Both CEF cache paths
          // must be canonicalized or the first launch silently uses memory storage.
          yield* Effect.gen(function* () {
            const restored = yield* EngineConnection;
            yield* restored.ready;
            yield* restored.request("pages.open", { id: "restored", url });
            yield* loaded(restored, "restored");
            assert.equal(
              yield* evaluate(restored, "restored", "localStorage.getItem('probe')"),
              "one",
            );
            yield* close(restored);
          }).pipe(
            Effect.provide(
              EngineConnection.layer({
                executable: binary,
                profileRoot: firstProfile,
                extensionManagement: false,
              }),
            ),
            Effect.scoped,
          );
        }).pipe(
          Effect.provide(
            EngineConnection.layer({
              executable: binary,
              profileRoot: firstProfile,
              extensionManagement: true,
            }),
          ),
          Effect.scoped,
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
