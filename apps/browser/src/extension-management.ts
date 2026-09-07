import type {
  ExtensionManagementApi,
  ExtensionManagementSnapshot,
  ExtensionManagementSummary,
} from "@hitchhiker/runtime";
import { Effect } from "effect";
import type {
  ExtensionManager,
  ExtensionManagerError,
  ManagedExtension,
} from "./extension-manager.ts";

type ExtensionCapability = "extensions.read" | "extensions.manage";

const summary = (entry: ManagedExtension): ExtensionManagementSummary => ({
  installationId: entry.installationId,
  digest: entry.digest,
  expectedChromiumId: entry.expectedChromiumId,
  ...(entry.chromiumId === undefined ? {} : { chromiumId: entry.chromiumId }),
  name: entry.name,
  version: entry.version,
  permissions: [...entry.permissions],
  hostPermissions: [...entry.hostPermissions],
  optionalPermissions: [...entry.optionalPermissions],
  optionalHostPermissions: [...entry.optionalHostPermissions],
  state: entry.state,
  ...(entry.errorIntent === undefined ? {} : { errorIntent: entry.errorIntent }),
});

/** Keep native staging/review and the manager's raw diagnostics out of public plugin ports. */
export const createExtensionManagement = (
  manager: Pick<ExtensionManager, "list" | "remove" | "isReadOnly">,
  onFailure: (error: ExtensionManagerError) => Effect.Effect<void>,
) => {
  const snapshot = Effect.fn("ExtensionManagement.snapshot")(function* (): Effect.fn.Return<
    ExtensionManagementSnapshot,
    ExtensionManagerError
  > {
    const entries = yield* manager.list();
    return { readOnly: yield* manager.isReadOnly(), extensions: entries.map(summary) };
  });

  const forOwner = (
    authorize: (capability: ExtensionCapability) => Effect.Effect<void, unknown>,
  ): ExtensionManagementApi => ({
    list: Effect.fn("ExtensionManagement.list")(function* () {
      yield* authorize("extensions.read");
      const result = yield* snapshot().pipe(Effect.tapError(onFailure));
      yield* authorize("extensions.read");
      return result;
    }),
    remove: Effect.fn("ExtensionManagement.remove")(function* (installationId: string) {
      yield* authorize("extensions.manage");
      yield* manager
        .remove(
          installationId,
          Effect.suspend(() => authorize("extensions.manage")),
        )
        .pipe(Effect.tapError(onFailure));
      const result = yield* snapshot().pipe(Effect.tapError(onFailure));
      yield* authorize("extensions.manage");
      return result;
    }),
  });
  return { forOwner };
};

export type ExtensionManagement = ReturnType<typeof createExtensionManagement>;
