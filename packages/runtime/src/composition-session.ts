import type { Surface } from "@hitchhiker/ui";
import { Effect, Schema, Semaphore } from "effect";
import {
  composePluginSurface,
  routeCompositionEvent,
  type CompositionOwner,
  type CompositionRoute,
} from "./composition.ts";
import { EngineError } from "./engine.ts";
import { decodeNativeSurface } from "./surface-validation.ts";
import type { SurfaceEvent } from "./surface.ts";

const Owner = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,62}$/)),
  generation: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
});
const ContributionId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/));
export const PluginCompositionRecipeSchema = Schema.Struct({
  layout: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,62}$/)),
  slots: Schema.Array(
    Schema.Struct({
      key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      contributions: Schema.Array(
        Schema.Struct({ pluginId: Owner.fields.id, id: ContributionId }),
      ).check(Schema.isMaxLength(32)),
    }),
  ).check(Schema.isMaxLength(32)),
});

type PublishedLayout = { readonly owner: CompositionOwner; readonly surface: Surface };
type PublishedContribution = {
  readonly owner: CompositionOwner;
  readonly id: string;
  readonly surface: Surface;
};
type State = {
  latest: Map<string, number>;
  active: Map<string, CompositionOwner>;
  layout: PublishedLayout | undefined;
  contributions: Map<string, PublishedContribution>;
};

export interface PluginCompositionRecipe {
  readonly layout: string;
  readonly slots: readonly {
    readonly key: string;
    readonly contributions: readonly { readonly pluginId: string; readonly id: string }[];
  }[];
}
export interface PluginCompositionSession {
  readonly activate: (owner: unknown) => Effect.Effect<number, EngineError>;
  readonly publishLayout: (owner: unknown, value: unknown) => Effect.Effect<number, EngineError>;
  readonly publishContribution: (
    owner: unknown,
    id: unknown,
    value: unknown,
  ) => Effect.Effect<number, EngineError>;
  readonly withdrawContribution: (
    owner: unknown,
    id: unknown,
  ) => Effect.Effect<number, EngineError>;
  /** Clear this activation’s publications while permitting subsequent publication. */
  readonly release: (owner: unknown) => Effect.Effect<number, EngineError>;
  /**
   * A failed remove leaves the last committed surface and routes intact. The
   * owner supervisor must treat that commit error as fatal and recover it.
   */
  readonly remove: (owner: unknown) => Effect.Effect<number, EngineError>;
  readonly route: (
    event: SurfaceEvent,
  ) => { readonly owner: CompositionOwner; readonly event: SurfaceEvent } | undefined;
}
export interface MakePluginCompositionOptions {
  readonly recipe: PluginCompositionRecipe;
  readonly commit: (surface: Surface) => Effect.Effect<number, EngineError>;
  readonly recovery: Surface;
}

const maxOwners = 32;
const maxContributions = 32;
const invalid = (message: string) => new EngineError({ code: "composition", message });
const contributionKey = (pluginId: string, id: string) => `${pluginId}\u0000${id}`;
const sameOwner = (left: CompositionOwner | undefined, right: CompositionOwner) =>
  left?.id === right.id && left.generation === right.generation;
const cloneState = (state: State): State => ({
  latest: new Map(state.latest),
  active: new Map(state.active),
  layout: state.layout,
  contributions: new Map(state.contributions),
});

/**
 * Trusted host-side coordinator for a fixed plugin layout recipe. Plugin data
 * is decoded before storage, and only a successful Native commit adopts a new
 * publication set and its event routes.
 */
export const makePluginComposition = Effect.fn("makePluginComposition")(function* (
  options: MakePluginCompositionOptions,
): Effect.fn.Return<PluginCompositionSession, EngineError> {
  const recipe = yield* Schema.decodeUnknownEffect(PluginCompositionRecipeSchema, {
    onExcessProperty: "error",
  })(options.recipe).pipe(Effect.mapError(() => invalid("Malformed composition recipe")));
  if (recipe.slots.reduce((total, slot) => total + slot.contributions.length, 0) > maxContributions)
    return yield* invalid("Too many configured contributions");
  const slots = new Set<string>();
  const configured = new Set<string>();
  const allowedOwners = new Set([recipe.layout]);
  for (const slot of recipe.slots) {
    if (!slot.key.isWellFormed() || Buffer.byteLength(slot.key, "utf8") > 128)
      return yield* invalid("Composition slot keys must be well-formed UTF-8 up to 128 bytes");
    if (slots.has(slot.key)) return yield* invalid("Composition slots must be distinct");
    slots.add(slot.key);
    for (const contribution of slot.contributions) {
      const key = contributionKey(contribution.pluginId, contribution.id);
      if (configured.has(key)) return yield* invalid("Configured contributions must be distinct");
      configured.add(key);
      allowedOwners.add(contribution.pluginId);
    }
  }
  if (allowedOwners.size > maxOwners)
    return yield* invalid("Too many configured composition owners");
  const recovery = yield* decodeNativeSurface(options.recovery).pipe(
    Effect.mapError(() => invalid("Malformed recovery surface")),
  );
  const permit = yield* Semaphore.make(1);
  let state: State = {
    latest: new Map(),
    active: new Map(),
    layout: undefined,
    contributions: new Map(),
  };
  let routes: ReadonlyMap<string, CompositionRoute> = new Map();
  let lastRevision = 0;

  const candidate = Effect.fn("PluginComposition.candidate")(function* (next: State) {
    if (!next.layout) return { surface: recovery, routes: new Map<string, CompositionRoute>() };
    const slots = recipe.slots.map((slot) => ({
      key: slot.key,
      contributions: slot.contributions.flatMap((entry) => {
        const published = next.contributions.get(contributionKey(entry.pluginId, entry.id));
        return published === undefined
          ? []
          : [{ owner: published.owner, id: published.id, surface: published.surface }];
      }),
    }));
    return yield* composePluginSurface({
      layout: { owner: next.layout.owner, surface: next.layout.surface },
      slots,
    });
  });
  const commitCandidate = Effect.fn("PluginComposition.commitCandidate")(function* (next: State) {
    const composed = yield* candidate(next);
    return yield* Effect.uninterruptible(
      options.commit(composed.surface).pipe(
        Effect.tap((revision) =>
          Effect.sync(() => {
            state = next;
            routes = composed.routes;
            lastRevision = revision;
          }),
        ),
      ),
    );
  });
  const decodeOwner = (owner: unknown) =>
    Schema.decodeUnknownEffect(Owner, { onExcessProperty: "error" })(owner).pipe(
      Effect.mapError(() => invalid("Malformed composition owner")),
    );

  const activate = Effect.fn("PluginComposition.activate")(function* (value: unknown) {
    const owner = yield* decodeOwner(value);
    return yield* permit.withPermit(
      Effect.gen(function* () {
        if (!allowedOwners.has(owner.id))
          return yield* invalid("Owner is not declared by the composition recipe");
        const current = state.active.get(owner.id);
        const latest = state.latest.get(owner.id);
        if (sameOwner(current, owner)) return lastRevision;
        if (latest !== undefined && owner.generation <= latest)
          return yield* invalid("Composition owner generations must increase");
        const next = cloneState(state);
        next.latest.set(owner.id, owner.generation);
        next.active.set(owner.id, owner);
        if (next.layout?.owner.id === owner.id) next.layout = undefined;
        for (const [key, contribution] of next.contributions)
          if (contribution.owner.id === owner.id) next.contributions.delete(key);
        return yield* commitCandidate(next);
      }),
    );
  });
  const publishLayout = Effect.fn("PluginComposition.publishLayout")(function* (
    value: unknown,
    surface: unknown,
  ) {
    const owner = yield* decodeOwner(value);
    if (owner.id !== recipe.layout)
      return yield* invalid("Only the configured layout may publish a layout");
    const decoded = yield* decodeNativeSurface(surface).pipe(
      Effect.mapError(() => invalid("Malformed layout surface")),
    );
    return yield* permit.withPermit(
      Effect.gen(function* () {
        if (!sameOwner(state.active.get(owner.id), owner))
          return yield* invalid("Stale layout publication");
        const next = cloneState(state);
        next.layout = { owner, surface: decoded };
        return yield* commitCandidate(next);
      }),
    );
  });
  const publishContribution = Effect.fn("PluginComposition.publishContribution")(function* (
    value: unknown,
    contribution: unknown,
    surface: unknown,
  ) {
    const owner = yield* decodeOwner(value);
    const id = yield* Schema.decodeUnknownEffect(ContributionId)(contribution).pipe(
      Effect.mapError(() => invalid("Malformed contribution ID")),
    );
    if (!configured.has(contributionKey(owner.id, id)))
      return yield* invalid("Contribution is not declared by the composition recipe");
    const decoded = yield* decodeNativeSurface(surface).pipe(
      Effect.mapError(() => invalid("Malformed contribution surface")),
    );
    return yield* permit.withPermit(
      Effect.gen(function* () {
        if (!sameOwner(state.active.get(owner.id), owner))
          return yield* invalid("Stale contribution publication");
        const next = cloneState(state);
        next.contributions.set(contributionKey(owner.id, id), { owner, id, surface: decoded });
        return yield* commitCandidate(next);
      }),
    );
  });
  const clear = Effect.fn("PluginComposition.clear")(function* (
    value: unknown,
    deactivate: boolean,
  ) {
    const owner = yield* decodeOwner(value);
    return yield* permit.withPermit(
      Effect.gen(function* () {
        if (!sameOwner(state.active.get(owner.id), owner)) return lastRevision;
        const next = cloneState(state);
        if (deactivate) next.active.delete(owner.id);
        if (next.layout?.owner.id === owner.id) next.layout = undefined;
        for (const [key, contribution] of next.contributions)
          if (contribution.owner.id === owner.id) next.contributions.delete(key);
        return yield* commitCandidate(next);
      }),
    );
  });
  const withdrawContribution = Effect.fn("PluginComposition.withdrawContribution")(function* (
    value: unknown,
    contribution: unknown,
  ) {
    const owner = yield* decodeOwner(value);
    const id = yield* Schema.decodeUnknownEffect(ContributionId)(contribution).pipe(
      Effect.mapError(() => invalid("Malformed contribution ID")),
    );
    const key = contributionKey(owner.id, id);
    if (!configured.has(key))
      return yield* invalid("Contribution is not declared by the composition recipe");
    return yield* permit.withPermit(
      Effect.gen(function* () {
        if (!sameOwner(state.active.get(owner.id), owner))
          return yield* invalid("Stale contribution withdrawal");
        if (!state.contributions.has(key)) return lastRevision;
        const next = cloneState(state);
        next.contributions.delete(key);
        return yield* commitCandidate(next);
      }),
    );
  });

  return {
    activate,
    publishLayout,
    publishContribution,
    withdrawContribution,
    release: (owner) => clear(owner, false),
    remove: (owner) => clear(owner, true),
    route: (event) => {
      const routed = routeCompositionEvent(routes, event);
      return routed && sameOwner(state.active.get(routed.owner.id), routed.owner)
        ? routed
        : undefined;
    },
  };
});
