import { EngineError, type EngineConnection } from "@hitchhiker/runtime";
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect";
import type { ExtensionPreview } from "./extension-manager.ts";

export type ExtensionReviewBridge = Pick<
  EngineConnection["Service"],
  "ready" | "exit" | "events" | "request"
>;
const Decision = Schema.Struct({
  nonce: Schema.String,
  installationId: Schema.String,
  digest: Schema.String,
  approved: Schema.Boolean,
});
const decodeDecision = Schema.decodeUnknownOption(Decision, { onExcessProperty: "error" });
const failure = (message: string) => new EngineError({ code: "extension-review", message });

/** Trusted adapter only. Neither the nonce nor native approval is a public plugin operation. */
export const createNativeExtensionReview = (options: {
  readonly engine: ExtensionReviewBridge;
  readonly onCleanupFailure: Effect.Effect<void>;
}) => {
  let active = false;
  return Effect.fn("ExtensionReview.request")(function* (request: {
    readonly requester: string;
    readonly profileId: string;
    readonly artifact: ExtensionPreview;
    readonly authorize: Effect.Effect<void, unknown>;
  }) {
    const authorize = request.authorize.pipe(
      Effect.mapError(() => failure("Extension review authority was denied")),
    );
    yield* authorize;
    const ready = yield* options.engine.ready;
    if (ready.params.extensionReview !== true)
      return yield* failure("Native extension review is unavailable");
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
          acquired ? Effect.void : Effect.fail(failure("An extension review is already active")),
        ),
      ),
      () =>
        Effect.gen(function* () {
          if (!submitted || decided) return;
          // A fresh child can finish asynchronous cancellation even when the caller is already
          // interrupted. The outer finalizer waits for its bounded Exit and handles every cause.
          const cleanup = yield* Effect.raceFirst(
            options.engine.exit.pipe(Effect.asVoid),
            options.engine.request("extensions.review.cancel", { nonce }).pipe(
              Effect.asVoid,
              // A rejected show never owned a native prompt. Cancel is nonce-bound.
              Effect.catch((error) => (error.code === "-32602" ? Effect.void : Effect.fail(error))),
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
    const decision = yield* Deferred.make<boolean, EngineError>();
    yield* options.engine.events.pipe(
      Stream.filter((event) => event.event === "extensions.reviewDecision"),
      Stream.runForEach((event) => {
        if (event.params.nonce !== nonce) return Effect.void;
        const parsed = decodeDecision(event.params);
        if (
          Option.isNone(parsed) ||
          parsed.value.installationId !== request.artifact.installationId ||
          parsed.value.digest !== request.artifact.digest
        )
          return Deferred.fail(decision, failure("Native review identity does not match"));
        return Deferred.succeed(decision, parsed.value.approved);
      }),
      Effect.ensuring(Deferred.fail(decision, failure("Native review event stream closed"))),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* authorize;
    submitted = true;
    yield* options.engine.request("extensions.review.show", {
      nonce,
      requester: request.requester,
      profileId: request.profileId,
      installationId: request.artifact.installationId,
      digest: request.artifact.digest,
      expectedChromiumId: request.artifact.expectedChromiumId,
      name: request.artifact.name,
      version: request.artifact.version,
      permissions: [...request.artifact.permissions],
      hostPermissions: [...request.artifact.host_permissions],
      optionalPermissions: [...request.artifact.optional_permissions],
      optionalHostPermissions: [...request.artifact.optional_host_permissions],
    });
    const approved = yield* Effect.raceFirst(
      Deferred.await(decision),
      Effect.raceFirst(
        options.engine.exit.pipe(Effect.andThen(Effect.fail(failure("Native host exited")))),
        authorize.pipe(Effect.delay(500), Effect.forever),
      ),
    ).pipe(Effect.timeout(310_000));
    decided = true;
    yield* authorize;
    return approved;
  }, Effect.scoped);
};
