import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, Fiber, PubSub, Stream } from "effect";
import { EngineError, type EngineEvent, type JsonObject } from "@hitchhiker/runtime";
import {
  createNativeExtensionReview,
  type ExtensionReviewBridge,
} from "../src/extension-review.ts";

const artifact = {
  installationId: "a".repeat(32),
  digest: "b".repeat(64),
  expectedChromiumId: "c".repeat(32),
  name: "Fixture",
  version: "1.0",
  permissions: ["storage"],
  host_permissions: [],
  optional_permissions: [],
  optional_host_permissions: [],
};
const request = { requester: "plugin-a", profileId: "default", artifact, authorize: Effect.void };
const setup = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<EngineEvent>();
  const shown = yield* Deferred.make<JsonObject>();
  const calls: { method: string; params: JsonObject }[] = [];
  let onShow = (_params: JsonObject): Effect.Effect<void> => Effect.void;
  const bridge: ExtensionReviewBridge = {
    ready: Effect.succeed({ event: "host.ready", params: { extensionReview: true } }),
    exit: Effect.never,
    events: Stream.fromPubSub(events),
    request: (method, params = {}) =>
      Effect.gen(function* () {
        calls.push({ method, params });
        if (method === "extensions.review.show") {
          yield* Deferred.succeed(shown, params);
          yield* onShow(params);
        }
        return {};
      }),
  };
  const publish = (params: JsonObject) =>
    PubSub.publish(events, {
      event: "extensions.reviewDecision",
      params,
    }).pipe(Effect.asVoid);
  return {
    bridge,
    calls,
    shown,
    publish,
    setShow: (handler: typeof onShow) => {
      onShow = handler;
    },
  };
});

for (const approved of [true, false]) {
  test(`captures native ${approved ? "approval" : "denial"} emitted before the show reply`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* setup;
          fixture.setShow((params) =>
            fixture
              .publish({
                nonce: "foreign",
                installationId: artifact.installationId,
                digest: artifact.digest,
                approved: true,
              })
              .pipe(
                Effect.andThen(
                  fixture.publish({
                    nonce: params.nonce!,
                    installationId: artifact.installationId,
                    digest: artifact.digest,
                    approved,
                  }),
                ),
              ),
          );
          const review = createNativeExtensionReview({
            engine: fixture.bridge,
            onCleanupFailure: Effect.void,
          });
          assert.equal(yield* review(request), approved);
          assert.deepEqual(
            fixture.calls.map((call) => call.method),
            ["extensions.review.show"],
          );
        }),
      ),
    ));
}

test("rejects a decision for a different artifact and cancels the exact native nonce", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        fixture.setShow((params) =>
          fixture.publish({
            nonce: params.nonce!,
            installationId: artifact.installationId,
            digest: "d".repeat(64),
            approved: true,
          }),
        );
        const review = createNativeExtensionReview({
          engine: fixture.bridge,
          onCleanupFailure: Effect.void,
        });
        yield* Effect.flip(review(request));
        assert.equal(fixture.calls[1]?.method, "extensions.review.cancel");
        assert.equal(fixture.calls[1]?.params.nonce, fixture.calls[0]?.params.nonce);
      }),
    ),
  ));

test("scope interruption cancels a pending prompt and releases the single-review slot", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        const review = createNativeExtensionReview({
          engine: fixture.bridge,
          onCleanupFailure: Effect.void,
        });
        const running = yield* review(request).pipe(Effect.forkScoped);
        yield* Deferred.await(fixture.shown);
        yield* Effect.flip(review(request));
        yield* Fiber.interrupt(running);
        assert.equal(fixture.calls[1]?.method, "extensions.review.cancel");
        fixture.setShow((params) =>
          fixture.publish({
            nonce: params.nonce!,
            installationId: artifact.installationId,
            digest: artifact.digest,
            approved: false,
          }),
        );
        assert.equal(yield* review(request), false);
      }),
    ),
  ));

test("revocation while waiting cancels the native prompt", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        let allowed = true;
        fixture.setShow(() =>
          Effect.sync(() => {
            allowed = false;
          }),
        );
        const review = createNativeExtensionReview({
          engine: fixture.bridge,
          onCleanupFailure: Effect.void,
        });
        yield* Effect.flip(
          review({
            ...request,
            authorize: Effect.suspend(() => (allowed ? Effect.void : Effect.fail("revoked"))),
          }),
        ).pipe(Effect.timeout(2_000));
        assert.equal(fixture.calls[1]?.method, "extensions.review.cancel");
      }),
    ),
  ));

test("a failed cancellation invokes the recovery callback", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        let recovery = false;
        const review = createNativeExtensionReview({
          engine: {
            ...fixture.bridge,
            request: (method, params) =>
              method === "extensions.review.cancel"
                ? Effect.fail(new EngineError({ code: "broken-pipe", message: "fixture" }))
                : fixture.bridge.request(method, params),
          },
          onCleanupFailure: Effect.sync(() => {
            recovery = true;
          }),
        });
        const running = yield* review(request).pipe(Effect.forkScoped);
        yield* Deferred.await(fixture.shown);
        yield* Fiber.interrupt(running);
        assert.equal(recovery, true);
      }),
    ),
  ));

for (const stalls of [false, true]) {
  test(`interrupted review ${stalls ? "recovers from stalled" : "awaits asynchronous"} native cancellation`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* setup;
          let recovery = false;
          let cancelled = false;
          const review = createNativeExtensionReview({
            engine: {
              ...fixture.bridge,
              request: (method, params) => {
                if (method !== "extensions.review.cancel")
                  return fixture.bridge.request(method, params);
                return stalls
                  ? Effect.never
                  : Effect.sleep(10).pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          cancelled = true;
                          return {};
                        }),
                      ),
                    );
              },
            },
            onCleanupFailure: Effect.sync(() => {
              recovery = true;
            }),
          });
          const running = yield* review(request).pipe(Effect.forkScoped);
          yield* Deferred.await(fixture.shown);
          yield* Fiber.interrupt(running).pipe(Effect.timeout(7_000));
          assert.equal(cancelled, !stalls);
          assert.equal(recovery, stalls);
        }),
      ),
    ));
}
