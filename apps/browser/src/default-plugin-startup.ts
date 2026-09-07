import { Effect } from "effect";
import type { BrowserController } from "./controller.ts";
import { legacyBootstrapSeedOf, type BrowserPersistence } from "./persistence.ts";
import {
  mapDefaultPluginState,
  type DefaultPluginStateMigration,
} from "./default-plugin-state-migration.ts";

/** Application ordering around the durable distribution bootstrap. */
export const startDefaultPluginInterface = Effect.fn("DefaultPluginStartup.start")(
  function* (options: {
    readonly mode: "installed" | "safe" | "developer";
    /** Captured under the profile lease before the controller can write restored state. */
    readonly persistence: BrowserPersistence | undefined;
    readonly controller: Pick<
      BrowserController,
      "restoredPageInventory" | "retireLegacyBootstrapSeed"
    >;
    /** Resolves only after a completed or abandoned bootstrap journal is durable. */
    readonly bootstrap: (
      seed: DefaultPluginStateMigration,
      placement: "sidebar" | "top",
    ) => Effect.Effect<void, unknown>;
  }) {
    if (options.mode !== "installed") return;
    const inventory = yield* options.controller.restoredPageInventory;
    const seed = yield* Effect.try(() => mapDefaultPluginState(options.persistence, inventory));
    const placement = legacyBootstrapSeedOf(options.persistence)?.tabPlacement ?? "sidebar";
    yield* options.bootstrap(seed, placement);
    // Never clear the migration source before the journal makes its reuse impossible.
    yield* options.controller.retireLegacyBootstrapSeed();
  },
);
