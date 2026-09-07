import type { PluginManagementApi, PluginManagementSnapshot } from "@hitchhiker/runtime";
import { Deferred, Effect, Schema } from "effect";
import type { PluginManager } from "./plugin-manager.ts";

export class PluginManagementError extends Schema.TaggedError<PluginManagementError>()(
  "PluginManagementError",
  { message: Schema.String },
) {}

type ManagementBackend = Pick<
  PluginManager,
  "managementSnapshot" | "enable" | "disable" | "rollback" | "uninstall" | "replaceSelf"
>;

/** Installed callers receive an identity-bound port, never the manager or its staging authority. */
export const createPluginManagement = Effect.fn("PluginManagement.create")(function* (
  options: { readonly startPaused?: boolean } = {},
) {
  const scope = yield* Effect.scope;
  let backend: ManagementBackend | undefined;
  let closed = false;
  let pending = 0;
  let mutationsEnabled = options.startPaused !== true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );

  const requireBackend = Effect.suspend(() =>
    backend && !closed
      ? Effect.succeed(backend)
      : Effect.fail(new PluginManagementError({ message: "Plugin management is unavailable" })),
  );
  const bind = Effect.fn("PluginManagement.bind")(function* (manager: ManagementBackend) {
    if (backend || closed)
      return yield* new PluginManagementError({ message: "Plugin management cannot be rebound" });
    backend = manager;
  });
  const mutate = (
    isActive: () => boolean,
    operation: (manager: ManagementBackend) => Effect.Effect<unknown, unknown>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const manager = yield* requireBackend;
        if (!mutationsEnabled)
          return yield* new PluginManagementError({ message: "Plugin startup is not complete" });
        if (!isActive())
          return yield* new PluginManagementError({ message: "Plugin activation is not ready" });
        // Detached work must remain bounded even when a caller repeatedly times out or exits.
        if (pending >= 16)
          return yield* new PluginManagementError({ message: "Plugin management is busy" });
        pending += 1;
        const reply = yield* Deferred.make<PluginManagementSnapshot, unknown>();
        const task = Effect.suspend(() => operation(manager)).pipe(
          Effect.andThen(manager.managementSnapshot()),
          Effect.onExit((exit) => Deferred.done(reply, exit)),
          Effect.ensuring(
            Effect.sync(() => {
              pending -= 1;
            }),
          ),
        );
        yield* Effect.forkIn(task, scope, { uninterruptible: false });
        // Stopping the requesting plugin cancels only its reply waiter, not the admitted mutation.
        return yield* restore(Deferred.await(reply));
      }),
    );
  const forPlugin = (callerId: string, isActive: () => boolean): PluginManagementApi => ({
    snapshot: () => requireBackend.pipe(Effect.flatMap((manager) => manager.managementSnapshot())),
    enable: (id) => mutate(isActive, (manager) => manager.enable(id)),
    disable: (id) => mutate(isActive, (manager) => manager.disable(id)),
    rollback: (id) => mutate(isActive, (manager) => manager.rollback(id)),
    uninstall: (id) => mutate(isActive, (manager) => manager.uninstall(id)),
    replaceSelf: (targetId, expectedRevision) =>
      mutate(isActive, (manager) => manager.replaceSelf(callerId, targetId, expectedRevision)),
  });
  const enableMutations = Effect.fn("PluginManagement.enableMutations")(function* () {
    yield* requireBackend;
    mutationsEnabled = true;
  });
  return { bind, forPlugin, enableMutations };
});

export type PluginManagement = Effect.Success<ReturnType<typeof createPluginManagement>>;
