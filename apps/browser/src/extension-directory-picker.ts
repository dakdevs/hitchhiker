import { isAbsolute } from "node:path";
import { EngineError, type EngineConnection } from "@hitchhiker/runtime";
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect";

export type ExtensionDirectoryPickerBridge = Pick<
  EngineConnection["Service"],
  "ready" | "exit" | "events" | "request"
>;

const Decision = Schema.Struct({
  nonce: Schema.String,
  operationId: Schema.String,
  directory: Schema.optional(Schema.String),
});
const decodeDecision = Schema.decodeUnknownOption(Decision, { onExcessProperty: "error" });
const OperationId = /^[a-f0-9]{32}$/;
const failure = (message: string) => new EngineError({ code: "extension-picker", message });

/** Private native adapter. The selected host path must be consumed without entering a public API. */
export const createNativeExtensionDirectoryPicker = (options: {
  readonly engine: ExtensionDirectoryPickerBridge;
  readonly onCleanupFailure: Effect.Effect<void>;
}) => {
  let active = false;
  return Effect.fn("ExtensionDirectoryPicker.request")(function* (request: {
    readonly requester: string;
    readonly profileId: string;
    readonly operationId: string;
    readonly authorize: Effect.Effect<void, unknown>;
  }) {
    if (!OperationId.test(request.operationId))
      return yield* failure("Extension directory picker identity is invalid");
    const authorize = request.authorize.pipe(
      Effect.mapError(() => failure("Extension directory picker authority was denied")),
    );
    yield* authorize;
    const ready = yield* options.engine.ready;
    if (
      !("extensionDirectoryPicker" in ready.params) ||
      ready.params.extensionDirectoryPicker !== true
    )
      return yield* failure("Native extension directory picker is unavailable");
    const nonce = crypto.randomUUID();
    let submitted = false;
    let decided = false;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (active) return false;
        active = true;
        return true;
      }).pipe(
        Effect.flatMap((acquired) =>
          acquired
            ? Effect.void
            : Effect.fail(failure("An extension directory picker is already active")),
        ),
      ),
      () =>
        Effect.gen(function* () {
          if (!submitted || decided) return;
          const cleanup = yield* Effect.raceFirst(
            options.engine.exit.pipe(Effect.asVoid),
            options.engine
              .request("extensions.directoryPicker.cancel", {
                nonce,
                operationId: request.operationId,
              })
              .pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  error.code === "-32602" ? Effect.void : Effect.fail(error),
                ),
              ),
          ).pipe(
            Effect.interruptible,
            Effect.timeout(5_000),
            Effect.forkChild({ startImmediately: true }),
          );
          const outcome = yield* Fiber.await(cleanup);
          if (outcome._tag === "Failure") {
            yield* options.onCleanupFailure;
            yield* Effect.failCause(outcome.cause).pipe(Effect.orDie);
          }
        }).pipe(
          Effect.uninterruptible,
          Effect.ensuring(
            Effect.sync(() => {
              active = false;
            }),
          ),
        ),
    );
    const decision = yield* Deferred.make<string | undefined, EngineError>();
    yield* options.engine.events.pipe(
      Stream.filter((event) => event.event === "extensions.directoryPickerDecision"),
      Stream.runForEach((event) => {
        if (event.params.nonce !== nonce) return Effect.void;
        const parsed = decodeDecision(event.params);
        if (Option.isNone(parsed) || parsed.value.operationId !== request.operationId)
          return Deferred.fail(decision, failure("Native picker identity does not match"));
        const directory = parsed.value.directory;
        if (
          directory !== undefined &&
          (!directory.isWellFormed() ||
            directory.includes("\0") ||
            !isAbsolute(directory) ||
            Buffer.byteLength(directory) > 4096)
        )
          return Deferred.fail(decision, failure("Native picker returned an invalid directory"));
        return Deferred.succeed(decision, directory);
      }),
      Effect.ensuring(Deferred.fail(decision, failure("Native picker event stream closed"))),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* authorize;
    submitted = true;
    yield* options.engine.request("extensions.directoryPicker.show", {
      nonce,
      operationId: request.operationId,
      requester: request.requester,
      profileId: request.profileId,
    });
    const directory = yield* Effect.raceFirst(
      Deferred.await(decision),
      Effect.raceFirst(
        options.engine.exit.pipe(
          Effect.andThen(Effect.fail(failure("Native host exited during directory selection"))),
        ),
        authorize.pipe(Effect.delay(500), Effect.forever),
      ),
    ).pipe(Effect.timeout(310_000));
    decided = true;
    yield* authorize;
    return directory;
  }, Effect.scoped);
};

export type NativeExtensionDirectoryPicker = ReturnType<
  typeof createNativeExtensionDirectoryPicker
>;
