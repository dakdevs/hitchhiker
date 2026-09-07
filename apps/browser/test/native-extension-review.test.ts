import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { EngineConnection, NativeSurface } from "@hitchhiker/runtime";
import { Deferred, Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";
import { makeBrowserController } from "../src/controller.ts";
import { createNativeExtensionReview } from "../src/extension-review.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const interactive = process.env.HITCHHIKER_INTERACTIVE_REVIEW === "1";
const Decision = Schema.Struct({
  nonce: Schema.String,
  installationId: Schema.String,
  digest: Schema.String,
  approved: Schema.Boolean,
});

test(
  "native extension review binds denial to its nonce and refuses synthetic approval",
  {
    skip: !binary,
    timeout: interactive ? 180_000 : 60_000,
  },
  async (context) => {
    const profile = await realpath(
      await mkdtemp(join(tmpdir(), "hitchhiker-native-extension-review-")),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* acquireProfileWriteLease(profile, binary!);
            yield* Effect.gen(function* () {
              const engine = yield* EngineConnection;
              yield* engine.ready;
              const controller = yield* makeBrowserController(lease.profileRoot, {
                profileLease: lease,
              });
              yield* controller.start;
              const decisions: (typeof Decision.Type)[] = [];
              yield* engine.events.pipe(
                Stream.filter((event) => event.event === "extensions.reviewDecision"),
                Stream.runForEach((event) =>
                  Schema.decodeUnknownEffect(Decision)(event.params).pipe(
                    Effect.tap((decision) =>
                      Effect.sync(() => {
                        decisions.push(decision);
                      }),
                    ),
                  ),
                ),
                Effect.forkScoped,
              );
              const request = {
                nonce: crypto.randomUUID(),
                requester: "review-fixture",
                profileId: "default",
                name: "Review fixture\nUntrusted package text",
                version: "1.0",
                installationId: "a".repeat(32),
                digest: "b".repeat(64),
                expectedChromiumId: "c".repeat(32),
                permissions: Array.from(
                  { length: 25 },
                  (_, index) => `fixture-permission-${index}`,
                ),
                hostPermissions: ["https://example.test/*"],
                optionalPermissions: [],
                optionalHostPermissions: [],
              };
              assert.equal(
                (yield* engine
                  .request("extensions.review.show", { ...request, approved: true })
                  .pipe(Effect.result))._tag,
                "Failure",
              );
              yield* engine.request("extensions.review.show", request);
              assert.equal(
                (yield* engine
                  .request("extensions.review.show", { ...request, nonce: crypto.randomUUID() })
                  .pipe(Effect.result))._tag,
                "Failure",
              );
              assert.equal(
                (yield* engine
                  .request("extensions.review.cancel", { nonce: crypto.randomUUID() })
                  .pipe(Effect.result))._tag,
                "Failure",
              );
              assert.equal(
                (yield* engine
                  .request("extensions.review.approve", { nonce: request.nonce })
                  .pipe(Effect.result))._tag,
                "Failure",
              );
              assert.equal(decisions.length, 0);
              yield* engine.request("extensions.review.cancel", { nonce: request.nonce });
              yield* Effect.suspend(() =>
                decisions.length === 1 ? Effect.void : Effect.fail("waiting for native denial"),
              ).pipe(Effect.retry({ times: 80, schedule: Schedule.spaced(25) }));
              assert.deepEqual(decisions, [
                {
                  nonce: request.nonce,
                  installationId: request.installationId,
                  digest: request.digest,
                  approved: false,
                },
              ]);
              yield* engine.request("extensions.review.cancel", { nonce: request.nonce });
              assert.equal(decisions.length, 1);
              const shown = yield* Deferred.make<void>();
              const scopedReview = createNativeExtensionReview({
                engine: {
                  ...engine,
                  request: (method, params) =>
                    engine
                      .request(method, params)
                      .pipe(
                        Effect.tap(() =>
                          method === "extensions.review.show"
                            ? Deferred.succeed(shown, undefined)
                            : Effect.void,
                        ),
                      ),
                },
                onCleanupFailure: Effect.die("Native review cancellation failed"),
              });
              const pending = yield* scopedReview({
                requester: request.requester,
                profileId: request.profileId,
                authorize: Effect.void,
                artifact: {
                  installationId: request.installationId,
                  digest: request.digest,
                  expectedChromiumId: request.expectedChromiumId,
                  name: request.name,
                  version: request.version,
                  permissions: request.permissions,
                  host_permissions: request.hostPermissions,
                  optional_permissions: [],
                  optional_host_permissions: [],
                },
              }).pipe(Effect.forkScoped);
              yield* Deferred.await(shown).pipe(Effect.timeout(10_000));
              yield* Fiber.interrupt(pending).pipe(Effect.timeout(10_000));
              yield* Effect.suspend(() =>
                decisions.length === 2
                  ? Effect.void
                  : Effect.fail("waiting for scoped native denial"),
              ).pipe(Effect.retry({ times: 80, schedule: Schedule.spaced(25) }));
              assert.equal(decisions[1]?.approved, false);
              if (interactive) {
                const review = createNativeExtensionReview({
                  engine,
                  onCleanupFailure: Effect.void,
                });
                const approval = yield* review({
                  requester: request.requester,
                  profileId: request.profileId,
                  authorize: Effect.void,
                  artifact: {
                    installationId: request.installationId,
                    digest: request.digest,
                    expectedChromiumId: request.expectedChromiumId,
                    name: "Long untrusted name\u2028\u206a ".repeat(35),
                    version: request.version,
                    permissions: request.permissions,
                    host_permissions: request.hostPermissions,
                    optional_permissions: [],
                    optional_host_permissions: [],
                  },
                }).pipe(Effect.forkScoped);
                yield* Effect.sync(() => console.error("HITCHHIKER_REVIEW_READY_FOR_LOCAL_INPUT"));
                assert.equal(yield* Fiber.join(approval).pipe(Effect.timeout(120_000)), true);
                assert.equal(decisions.length, 3);
                assert.equal(decisions[2]?.installationId, request.installationId);
                assert.equal(decisions[2]?.digest, request.digest);
                assert.equal(decisions[2]?.approved, true);
                yield* Effect.sync(() => console.error("HITCHHIKER_REVIEW_APPROVED"));
              }
              yield* engine.request("window.close");
              assert.equal(yield* engine.exit.pipe(Effect.timeout(10_000)), 0);
            }).pipe(
              Effect.provide(
                Layer.provideMerge(
                  NativeSurface.layer,
                  EngineConnection.layer({
                    executable: binary!,
                    profileRoot: lease.profileRoot,
                    extensionManagement: false,
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
