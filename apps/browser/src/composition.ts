import { Deferred, Effect, Queue, Semaphore, Stream } from "effect";
import {
  EngineError,
  makePluginComposition,
  type CompositionOwner,
  type PluginCompositionRecipe,
  type SurfaceEvent,
} from "@hitchhiker/runtime";
import { text } from "@hitchhiker/ui";
import type { BrowserController } from "./controller.ts";

interface Inbox {
  readonly owner: CompositionOwner;
  readonly queue: Queue.Queue<SurfaceEvent>;
  readonly failed: Deferred.Deferred<never, EngineError>;
}
const error = (message: string) => new EngineError({ code: "composition", message });
const matches = (inbox: Inbox | undefined, owner: CompositionOwner) =>
  inbox?.owner.generation === owner.generation;

/** Trusted installed-worker adapter. Recipe identities never come from worker call parameters. */
export const createBrowserComposition = Effect.fn("Browser.createComposition")(function* (options: {
  readonly recipe: PluginCompositionRecipe | undefined;
  readonly controller: Pick<
    BrowserController,
    "publishPluginSurface" | "recoverPluginSurface" | "registerPluginEventHandler"
  >;
  readonly onRecoveryFailure: Effect.Effect<void>;
}) {
  const identity = `composition:${crypto.randomUUID()}`;
  const permit = yield* Semaphore.make(1);
  const inboxes = new Map<string, Inbox>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach(inboxes.values(), (inbox) => Queue.shutdown(inbox.queue), { discard: true }),
  );
  // This identity is stable for manager consumers while its membership tracks the live plan.
  const owners = new Set<string>();
  const recovery = {
    identity: "host-composition-recovery",
    root: text("recovery", "Plugin layout unavailable"),
    bindings: [],
  };
  const session = yield* makePluginComposition({
    recipe: options.recipe,
    recovery,
    commit: (surface) =>
      surface.identity === recovery.identity
        ? options.controller.recoverPluginSurface(identity)
        : options.controller.publishPluginSurface(identity, {
            root: surface.root,
            bindings: surface.bindings,
          }),
  });
  for (const owner of session.owners()) owners.add(owner);
  yield* options.controller.registerPluginEventHandler(identity, (event) =>
    permit.withPermit(
      Effect.gen(function* () {
        if (event.event === "error") {
          yield* options.onRecoveryFailure;
          return;
        }
        const routed = session.route(event);
        if (!routed) return;
        const inbox = inboxes.get(routed.owner.id);
        if (!inbox || !matches(inbox, routed.owner)) return;
        if (!Queue.offerUnsafe(inbox.queue, routed.event))
          yield* Deferred.fail(inbox.failed, error("Plugin input queue exceeded its capacity"));
      }),
    ),
  );
  yield* options.controller.recoverPluginSurface(identity);
  return {
    owners: owners as ReadonlySet<string>,
    activate: (owner: CompositionOwner) =>
      permit.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = inboxes.get(owner.id);
            if (matches(current, owner)) return yield* session.activate(owner);
            const candidate: Inbox = {
              owner,
              queue: yield* Queue.bounded<SurfaceEvent>(32),
              failed: yield* Deferred.make<never, EngineError>(),
            };
            const revision = yield* session
              .activate(owner)
              .pipe(Effect.onError(() => Queue.shutdown(candidate.queue)));
            inboxes.set(owner.id, candidate);
            if (current) {
              yield* Deferred.fail(current.failed, error("Plugin activation was replaced"));
              yield* Queue.shutdown(current.queue);
            }
            return revision;
          }),
        ),
      ),
    remove: (owner: CompositionOwner) =>
      permit.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const revision = yield* session.remove(owner);
            const inbox = inboxes.get(owner.id);
            if (inbox && matches(inbox, owner)) {
              inboxes.delete(owner.id);
              yield* Queue.shutdown(inbox.queue);
            }
            return revision;
          }),
        ),
      ),
    reconfigure: (recipe: PluginCompositionRecipe | undefined) =>
      permit.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const revision = yield* session.reconfigure(recipe);
            owners.clear();
            for (const owner of session.owners()) owners.add(owner);
            return revision;
          }),
        ),
      ),
    complete: session.complete,
    release: (owner: CompositionOwner) =>
      session.release(owner).pipe(permit.withPermit, Effect.asVoid),
    publishLayout: (owner: CompositionOwner, surface: unknown) =>
      session.publishLayout(owner, surface).pipe(permit.withPermit),
    publishContribution: (owner: CompositionOwner, id: string, surface: unknown) =>
      session.publishContribution(owner, id, surface).pipe(permit.withPermit),
    withdrawContribution: (owner: CompositionOwner, id: string) =>
      session.withdrawContribution(owner, id).pipe(permit.withPermit),
    showRoute: (owner: CompositionOwner, id: string) =>
      session.showRoute(owner, id).pipe(permit.withPermit),
    hideRoute: (owner: CompositionOwner, id: string) =>
      session.hideRoute(owner, id).pipe(permit.withPermit),
    events: (owner: CompositionOwner) =>
      Stream.unwrap(
        Effect.sync(() => {
          if (!owners.has(owner.id)) return Stream.empty;
          const inbox = inboxes.get(owner.id);
          if (!inbox || !matches(inbox, owner))
            return Stream.fail(error("Plugin activation is unavailable"));
          return Stream.fromQueue(inbox.queue).pipe(
            Stream.map((event) => ({ event: "ui.event", payload: event })),
          );
        }),
      ),
    failure: (owner: CompositionOwner) =>
      Effect.suspend(() => {
        if (!owners.has(owner.id)) return Effect.never;
        const inbox = inboxes.get(owner.id);
        return inbox && matches(inbox, owner)
          ? Deferred.await(inbox.failed)
          : Effect.fail(error("Plugin activation is unavailable"));
      }),
    recover: options.controller
      .recoverPluginSurface(identity)
      .pipe(permit.withPermit, Effect.asVoid),
  };
});
export type BrowserComposition = Effect.Success<ReturnType<typeof createBrowserComposition>>;
