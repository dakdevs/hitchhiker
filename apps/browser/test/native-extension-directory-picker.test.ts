import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { EngineConnection, NativeSurface, createGrantStore } from "@hitchhiker/runtime";
import { Deferred, Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect";
import { createExtensionArtifactStore } from "../src/extension-artifacts.ts";
import { createExtensionInstallation } from "../src/extension-installation.ts";
import { createExtensionManager } from "../src/extension-manager.ts";
import { createNativeExtensionDirectoryPicker } from "../src/extension-directory-picker.ts";
import { createNativeExtensionReview } from "../src/extension-review.ts";
import { createExtensionUploadStore } from "../src/extension-upload.ts";
import { makeBrowserController } from "../src/controller.ts";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const interactive = process.env.HITCHHIKER_INTERACTIVE_PICKER === "1";
const waitFor = <A>(effect: Effect.Effect<A, unknown>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(predicate, () => new Error("Extension installation has not settled")),
    Effect.retry({ times: 240, schedule: Schedule.spaced(500) }),
    Effect.timeout(120_000),
  );

test(
  "native folder selection, separate permission review, and removal install a real MV3 extension",
  { skip: !binary || !interactive, timeout: 180_000 },
  async (context) => {
    const profile = await realpath(
      await mkdtemp(join(tmpdir(), "hitchhiker-native-extension-picker-")),
    );
    const server = createServer((_request, response) =>
      response.end("<!doctype html><title>Upload fixture</title>"),
    );
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const manifest = JSON.stringify({
        manifest_version: 3,
        name: "Interactive upload fixture",
        version: "1.0",
        host_permissions: ["http://127.0.0.1/*"],
        content_scripts: [
          { matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_start" },
        ],
        web_accessible_resources: [
          { resources: ["resource.bin"], matches: ["http://127.0.0.1/*"] },
        ],
      });
      const resource = new Uint8Array([0, 1, 127, 128, 255, 42]);
      const content = `{
const expected=[0,1,127,128,255,42];
const mark=()=>document.documentElement?.setAttribute('data-upload-extension','enabled');
fetch(chrome.runtime.getURL('resource.bin')).then(r=>r.arrayBuffer()).then(bytes=>{
 const actual=[...new Uint8Array(bytes)];
 if(actual.length===expected.length&&actual.every((byte,index)=>byte===expected[index])){
  if(document.documentElement)mark();else addEventListener('DOMContentLoaded',mark,{once:true});
 }
});
}`;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* acquireProfileWriteLease(profile, binary!);
            yield* Effect.gen(function* () {
              const engine = yield* EngineConnection;
              yield* engine.ready;
              const artifacts = yield* createExtensionArtifactStore({ profileLease: lease });
              const manager = yield* createExtensionManager({
                profileRoot: lease.profileRoot,
                lease,
                engine,
                artifacts,
              });
              yield* manager.restoreBeforePages();
              const controller = yield* makeBrowserController(lease.profileRoot, {
                profileLease: lease,
              });
              yield* controller.start;
              const grants = yield* createGrantStore({
                directory: join(lease.profileRoot, "hitchhiker-grants"),
              });
              const issued = yield* grants.issue({
                principal: "interactive-upload",
                profileId: "default",
                capabilities: ["extensions.install"],
                origins: [],
              });
              const uploads = yield* createExtensionUploadStore({ profileLease: lease });
              const installation = yield* createExtensionInstallation({
                manager,
                uploads,
                profileId: "default",
                onFailure: (_error: unknown) => Effect.void,
                pickLocal: createNativeExtensionDirectoryPicker({
                  engine,
                  onCleanupFailure: Effect.void,
                }),
                review: createNativeExtensionReview({ engine, onCleanupFailure: Effect.void }),
              });
              const owner = {
                principal: "interactive-upload",
                grantId: issued.grant.id,
                authorize: grants
                  .authorize(issued.token, {
                    profileId: "default",
                    capability: "extensions.install",
                  })
                  .pipe(Effect.asVoid),
              };
              const port = yield* installation.forOwner(owner);
              const source = join(profile, "selected-extension");
              yield* Effect.promise(async () => {
                await mkdir(source);
                await writeFile(join(source, "manifest.json"), manifest);
                await writeFile(join(source, "content.js"), content);
                await writeFile(join(source, "resource.bin"), resource);
              });
              const begun = yield* port.pickLocal();
              assert.equal(begun.state, "choosing");
              assert.equal(JSON.stringify(begun).includes(source), false);
              process.stdout.write(`HITCHHIKER_PICKER_FIXTURE_DIRECTORY=${source}\n`);
              process.stdout.write("HITCHHIKER_PICKER_READY_FOR_LOCAL_INPUT\n");
              const pending = yield* waitFor(
                port.status(begun.operationId),
                (item) => item.state === "awaiting_review",
              );
              assert.equal(JSON.stringify(pending).includes("directory"), false);
              assert.equal(JSON.stringify(pending).includes("nonce"), false);
              const reviewing = yield* port.requestReview(begun.operationId);
              assert.equal(reviewing.state, "reviewing");
              process.stdout.write("HITCHHIKER_PICKER_REVIEW_READY\n");
              const enabled = yield* waitFor(
                port.status(begun.operationId),
                (item) => item.state === "enabled",
              );
              const pageId = yield* controller.openPage(`${origin}/installed`);
              const decode = Schema.decodeUnknownEffect(
                Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) }),
              );
              const marker = engine
                .request("cdp.send", {
                  pageId,
                  method: "Runtime.evaluate",
                  params: {
                    expression:
                      "document.readyState === 'complete' && document.documentElement.getAttribute('data-upload-extension')",
                    returnByValue: true,
                  },
                })
                .pipe(
                  Effect.flatMap(decode),
                  Effect.map((value) => value.result.value),
                );
              yield* waitFor(marker, (value) => value === "enabled");
              yield* manager.remove(enabled.extension!.installationId);
              yield* engine.request("window.close");
              assert.equal(yield* engine.exit.pipe(Effect.timeout(10_000)), 0);
            }).pipe(
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
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
        { signal: context.signal },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);

test(
  "native picker enforces exact identity, cancellation, and window-close cleanup",
  {
    skip: !binary,
    timeout: 30_000,
  },
  async (context) => {
    const profile = await realpath(
      await mkdtemp(join(tmpdir(), "hitchhiker-native-extension-picker-")),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* acquireProfileWriteLease(profile, binary!);
            yield* Effect.gen(function* () {
              const engine = yield* EngineConnection;
              const ready = yield* engine.ready;
              assert.equal(ready.params.extensionDirectoryPicker, true);
              const nonce = crypto.randomUUID();
              const nextNonce = crypto.randomUUID();
              const operationId = "a".repeat(32);
              const decisions: unknown[] = [];
              const first = yield* Deferred.make<void>();
              const second = yield* Deferred.make<void>();
              const observer = yield* engine.events.pipe(
                Stream.filter((event) => event.event === "extensions.directoryPickerDecision"),
                Stream.runForEach((event) =>
                  Effect.sync(() => decisions.push(event.params)).pipe(
                    Effect.andThen(
                      Deferred.succeed(event.params.nonce === nonce ? first : second, undefined),
                    ),
                  ),
                ),
                Effect.forkScoped({ startImmediately: true }),
              );
              const show = {
                nonce,
                operationId,
                requester: "native-picker-fixture",
                profileId: "default",
              };
              const rejected = yield* Effect.flip(
                engine.request("extensions.directoryPicker.show", {
                  ...show,
                  directory: "/tmp",
                }),
              );
              assert.equal(rejected.code, "-32602");
              assert.equal(
                (yield* Effect.flip(
                  engine.request("extensions.directoryPicker.show", {
                    ...show,
                    operationId: "invalid",
                  }),
                )).code,
                "-32602",
              );
              for (const method of [
                "extensions.directoryPicker.select",
                "extensions.directoryPicker.approve",
              ]) {
                assert.equal((yield* Effect.flip(engine.request(method, show))).code, "-32601");
              }
              yield* engine.request("extensions.directoryPicker.show", show);
              assert.equal(
                (yield* Effect.flip(
                  engine.request("extensions.directoryPicker.show", {
                    ...show,
                    nonce: nextNonce,
                  }),
                )).code,
                "-32003",
              );
              assert.equal(
                (yield* Effect.flip(engine.request("extensions.review.show", {}))).code,
                "-32003",
              );
              assert.equal(
                (yield* Effect.flip(
                  engine.request("extensions.directoryPicker.cancel", {
                    nonce,
                    operationId: "b".repeat(32),
                  }),
                )).code,
                "-32602",
              );
              yield* engine.request("extensions.directoryPicker.cancel", { nonce, operationId });
              yield* Deferred.await(first).pipe(Effect.timeout(2_000));
              assert.deepEqual(decisions, [{ nonce, operationId }]);
              yield* engine.request("extensions.directoryPicker.cancel", { nonce, operationId });
              yield* engine.request("extensions.directoryPicker.show", {
                ...show,
                nonce: nextNonce,
              });
              yield* engine.request("window.close");
              yield* Deferred.await(second).pipe(Effect.timeout(2_000));
              assert.deepEqual(decisions, [
                { nonce, operationId },
                { nonce: nextNonce, operationId },
              ]);
              assert.equal(yield* engine.exit.pipe(Effect.timeout(10_000)), 0);
              yield* Fiber.interrupt(observer);
            }).pipe(
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
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
        { signal: context.signal },
      );
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
);
