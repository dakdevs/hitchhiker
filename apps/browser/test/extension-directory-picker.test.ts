import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, type EngineEvent, type JsonObject } from "@hitchhiker/runtime";
import { Deferred, Effect, Fiber, PubSub, Stream } from "effect";
import {
  createNativeExtensionDirectoryPicker,
  type ExtensionDirectoryPickerBridge,
} from "../src/extension-directory-picker.ts";

const operationId = "a".repeat(32);
const request = {
  requester: "plugin-a",
  profileId: "default",
  operationId,
  authorize: Effect.void,
};

const setup = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<EngineEvent>();
  const shown = yield* Deferred.make<JsonObject>();
  const calls: { method: string; params: JsonObject }[] = [];
  let onShow = (_params: JsonObject): Effect.Effect<void> => Effect.void;
  const bridge: ExtensionDirectoryPickerBridge = {
    ready: Effect.succeed({
      event: "host.ready",
      params: { extensionDirectoryPicker: true },
    }),
    exit: Effect.never,
    events: Stream.fromPubSub(events),
    request: (method, params = {}) =>
      Effect.gen(function* () {
        calls.push({ method, params });
        if (method === "extensions.directoryPicker.show") {
          yield* Deferred.succeed(shown, params);
          yield* onShow(params);
        }
        return {};
      }),
  };
  const publish = (params: JsonObject) =>
    PubSub.publish(events, {
      event: "extensions.directoryPickerDecision",
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

test("captures a private directory decision emitted before the show reply", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        fixture.setShow((params) =>
          fixture.publish({ nonce: "foreign", operationId, directory: "/private/foreign" }).pipe(
            Effect.andThen(
              fixture.publish({
                nonce: params.nonce!,
                operationId,
                directory: "/private/extension",
              }),
            ),
          ),
        );
        const picker = createNativeExtensionDirectoryPicker({
          engine: fixture.bridge,
          onCleanupFailure: Effect.void,
        });
        assert.equal(yield* picker(request), "/private/extension");
        assert.deepEqual(
          fixture.calls.map((call) => call.method),
          ["extensions.directoryPicker.show"],
        );
      }),
    ),
  ));

test("represents user cancellation without a directory", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        fixture.setShow((params) => fixture.publish({ nonce: params.nonce!, operationId }));
        const picker = createNativeExtensionDirectoryPicker({
          engine: fixture.bridge,
          onCleanupFailure: Effect.void,
        });
        assert.equal(yield* picker(request), undefined);
      }),
    ),
  ));

test("rejects wrong operation identity and invalid paths, then cancels the exact picker", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        for (const paramsOf of [
          (nonce: JsonObject[string]) => ({ nonce, operationId: "b".repeat(32) }),
          (nonce: JsonObject[string]) => ({ nonce, operationId, directory: "relative/path" }),
        ]) {
          const fixture = yield* setup;
          fixture.setShow((params) => fixture.publish(paramsOf(params.nonce)));
          const picker = createNativeExtensionDirectoryPicker({
            engine: fixture.bridge,
            onCleanupFailure: Effect.void,
          });
          yield* Effect.flip(picker(request));
          assert.equal(fixture.calls[1]?.method, "extensions.directoryPicker.cancel");
          assert.deepEqual(fixture.calls[1]?.params, {
            nonce: fixture.calls[0]!.params.nonce,
            operationId,
          });
        }
      }),
    ),
  ));

test("interruption and revocation cancel a pending picker and release its slot", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        let allowed = true;
        const picker = createNativeExtensionDirectoryPicker({
          engine: fixture.bridge,
          onCleanupFailure: Effect.void,
        });
        const pending = yield* picker(request).pipe(Effect.forkScoped);
        yield* Deferred.await(fixture.shown);
        yield* Effect.flip(picker(request));
        yield* Fiber.interrupt(pending);
        assert.equal(fixture.calls[1]?.method, "extensions.directoryPicker.cancel");

        fixture.setShow(() =>
          Effect.sync(() => {
            allowed = false;
          }),
        );
        yield* Effect.flip(
          picker({
            ...request,
            authorize: Effect.suspend(() =>
              allowed ? Effect.void : Effect.fail(new Error("revoked")),
            ),
          }),
        ).pipe(Effect.timeout(2_000));
        assert.equal(fixture.calls.at(-1)?.method, "extensions.directoryPicker.cancel");
      }),
    ),
  ));

test("failed picker cancellation invokes recovery", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        let recovery = false;
        const picker = createNativeExtensionDirectoryPicker({
          engine: {
            ...fixture.bridge,
            request: (method, params) =>
              method === "extensions.directoryPicker.cancel"
                ? Effect.fail(new EngineError({ code: "broken-pipe", message: "fixture" }))
                : fixture.bridge.request(method, params),
          },
          onCleanupFailure: Effect.sync(() => {
            recovery = true;
          }),
        });
        const pending = yield* picker(request).pipe(Effect.forkScoped);
        yield* Deferred.await(fixture.shown);
        yield* Fiber.interrupt(pending);
        assert.equal(recovery, true);
      }),
    ),
  ));
