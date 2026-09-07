import { Effect, Stream } from "effect";
import type { GrantStoreApi } from "@hitchhiker/runtime";
import type { ExtensionManager, ExtensionManagerError } from "./extension-manager.ts";

/** Reconcile persisted reviews before accepting callers, then cover dropped events and grant expiry. */
export const reconcileExtensionInstallations = Effect.fn("ExtensionInstallation.reconcile")(
  function* (options: {
    readonly manager: Pick<ExtensionManager, "reconcilePrepared">;
    readonly grants: GrantStoreApi;
    readonly profileId: string;
    readonly onFailure: (error: ExtensionManagerError) => Effect.Effect<void>;
  }) {
    const reconcile = options.manager.reconcilePrepared((identity) =>
      options.grants
        .authorizeGrant(identity.grantId, {
          profileId: options.profileId,
          capability: "extensions.install",
        })
        .pipe(
          Effect.map((authorized) => authorized.principal === identity.principal),
          Effect.catch((error) =>
            error.code === "denied" ? Effect.succeed(false) : Effect.fail(error),
          ),
        ),
    );
    // Failure to read authority must not be interpreted as permission to delete pending artifacts.
    yield* reconcile;
    yield* options.grants.revocations.pipe(
      Stream.runForEach(() => reconcile.pipe(Effect.catch(options.onFailure))),
      Effect.forkScoped,
    );
    yield* reconcile.pipe(
      Effect.catch(options.onFailure),
      Effect.delay(30_000),
      Effect.forever,
      Effect.forkScoped,
    );
  },
);
