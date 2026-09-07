import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeServices } from "@effect/platform-node";
import { createGrantStore } from "@hitchhiker/runtime";
import { Deferred, Effect } from "effect";
import { reconcileExtensionInstallations } from "../src/extension-installation-reconciliation.ts";
import { ExtensionManagerError } from "../src/extension-manager.ts";

test("installation reconciliation checks persisted authority at startup and on revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-installation-grants-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const grants = yield* createGrantStore({ directory });
          const issued = yield* grants.issue({
            principal: "plugin-a",
            profileId: "profile-a",
            capabilities: ["extensions.install"],
            origins: [],
          });
          const revoked = yield* Deferred.make<void>();
          const observed: boolean[] = [];
          yield* reconcileExtensionInstallations({
            profileId: "profile-a",
            grants,
            onFailure: (error) => Effect.die(error),
            manager: {
              reconcilePrepared: (authorized) =>
                authorized({ principal: "plugin-a", grantId: issued.grant.id }).pipe(
                  Effect.mapError(
                    () => new ExtensionManagerError({ message: "authority unavailable" }),
                  ),
                  Effect.flatMap((allowed) =>
                    Effect.sync(() => {
                      observed.push(allowed);
                    }).pipe(
                      Effect.andThen(allowed ? Effect.void : Deferred.succeed(revoked, undefined)),
                    ),
                  ),
                ),
            },
          });
          assert.deepEqual(observed, [true]);
          yield* grants.revoke(issued.grant.id);
          yield* Deferred.await(revoked).pipe(Effect.timeout(2_000));
          assert.deepEqual(observed, [true, false]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
