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
const Contribution = Schema.Struct({
  pluginId: Owner.fields.id,
  id: ContributionId,
  optional: Schema.optional(Schema.Literal(true)),
});
const Route = Schema.Struct({
  fallback: Schema.Struct({ pluginId: Owner.fields.id, id: ContributionId }),
});
export const PluginCompositionRecipeSchema = Schema.Struct({
  layout: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,62}$/)),
  slots: Schema.Array(
    Schema.Struct({
      key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      contributions: Schema.Array(Contribution).check(Schema.isMaxLength(32)),
      route: Schema.optional(Route),
    }),
  ).check(Schema.isMaxLength(32)),
});

type PublishedLayout = { readonly owner: CompositionOwner; readonly surface: Surface };
type PublishedContribution = {
  readonly owner: CompositionOwner;
  readonly id: string;
  readonly surface: Surface;
};
type SelectedRoute = { readonly owner: CompositionOwner; readonly contributionId: string };
type State = {
  latest: Map<string, number>;
  active: Map<string, CompositionOwner>;
  layout: PublishedLayout | undefined;
  contributions: Map<string, PublishedContribution>;
  selections: Map<string, SelectedRoute>;
};

export interface PluginCompositionRecipe {
  readonly layout: string;
  readonly slots: readonly {
    readonly key: string;
    readonly contributions: readonly {
      readonly pluginId: string;
      readonly id: string;
      readonly optional?: true;
    }[];
    readonly route?: { readonly fallback: { readonly pluginId: string; readonly id: string } };
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
  readonly showRoute: (owner: unknown, id: unknown) => Effect.Effect<number, EngineError>;
  readonly hideRoute: (owner: unknown, id: unknown) => Effect.Effect<number, EngineError>;
  /** Clear this activation’s publications while permitting subsequent publication. */
  readonly release: (owner: unknown) => Effect.Effect<number, EngineError>;
  /**
   * A failed remove leaves the last committed surface and routes intact. The
   * owner supervisor must treat that commit error as fatal and recover it.
   */
  readonly remove: (owner: unknown) => Effect.Effect<number, EngineError>;
  readonly reconfigure: (recipe: unknown | undefined) => Effect.Effect<number, EngineError>;
  readonly complete: Effect.Effect<boolean>;
  readonly owners: () => ReadonlySet<string>;
  readonly route: (
    event: SurfaceEvent,
  ) => { readonly owner: CompositionOwner; readonly event: SurfaceEvent } | undefined;
}
export interface MakePluginCompositionOptions {
  readonly recipe: PluginCompositionRecipe | undefined;
  readonly commit: (surface: Surface) => Effect.Effect<number, EngineError>;
  readonly recovery: Surface;
}

const maxOwners = 32;
/** Tombstones prevent stale generation reuse; restart after 256 distinct owner identities. */
const maxHistoricalOwners = 256;
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
  selections: new Map(state.selections),
});
type Plan = {
  readonly recipe: typeof PluginCompositionRecipeSchema.Type | undefined;
  readonly configured: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
  readonly routeSlots: ReadonlyMap<
    string,
    { readonly fallback: string; readonly contributions: ReadonlySet<string> }
  >;
  readonly owners: ReadonlySet<string>;
};

/**
 * Trusted host-side coordinator for a live plugin layout recipe. Plugin data
 * is decoded before storage, and only a successful Native commit adopts a new
 * publication set and its event routes.
 */
export const makePluginComposition = Effect.fn("makePluginComposition")(function* (
  options: MakePluginCompositionOptions,
): Effect.fn.Return<PluginCompositionSession, EngineError> {
  const decodePlan = (value: unknown | undefined) =>
    Effect.gen(function* () {
      if (value === undefined)
        return {
          recipe: undefined,
          configured: new Set<string>(),
          required: new Set<string>(),
          routeSlots: new Map(),
          owners: new Set<string>(),
        } satisfies Plan;
      const recipe = yield* Schema.decodeUnknownEffect(PluginCompositionRecipeSchema, {
        onExcessProperty: "error",
      })(value).pipe(Effect.mapError(() => invalid("Malformed composition recipe")));
      if (
        recipe.slots.reduce((total, slot) => total + slot.contributions.length, 0) >
        maxContributions
      )
        return yield* invalid("Too many configured contributions");
      const slots = new Set<string>();
      const configured = new Set<string>();
      const required = new Set<string>();
      const routeSlots = new Map<
        string,
        { readonly fallback: string; readonly contributions: ReadonlySet<string> }
      >();
      const owners = new Set([recipe.layout]);
      for (const slot of recipe.slots) {
        if (!slot.key.isWellFormed() || Buffer.byteLength(slot.key, "utf8") > 128)
          return yield* invalid("Composition slot keys must be well-formed UTF-8 up to 128 bytes");
        if (slots.has(slot.key)) return yield* invalid("Composition slots must be distinct");
        slots.add(slot.key);
        const entries = new Map<string, typeof Contribution.Type>();
        for (const contribution of slot.contributions) {
          const key = contributionKey(contribution.pluginId, contribution.id);
          if (configured.has(key))
            return yield* invalid("Configured contributions must be distinct");
          configured.add(key);
          entries.set(key, contribution);
          if (!contribution.optional) required.add(key);
          owners.add(contribution.pluginId);
        }
        if (slot.route !== undefined) {
          const fallback = contributionKey(slot.route.fallback.pluginId, slot.route.fallback.id);
          const fallbackEntry = entries.get(fallback);
          if (fallbackEntry === undefined || fallbackEntry.optional)
            return yield* invalid("Route fallbacks must name a required slot contribution");
          routeSlots.set(slot.key, { fallback, contributions: new Set(entries.keys()) });
        }
      }
      if (owners.size > maxOwners) return yield* invalid("Too many configured composition owners");
      return { recipe, configured, required, routeSlots, owners } satisfies Plan;
    });
  let plan: Plan = yield* decodePlan(options.recipe);
  const recovery = yield* decodeNativeSurface(options.recovery).pipe(
    Effect.mapError(() => invalid("Malformed recovery surface")),
  );
  const permit = yield* Semaphore.make(1);
  let state: State = {
    latest: new Map(),
    active: new Map(),
    layout: undefined,
    contributions: new Map(),
    selections: new Map(),
  };
  let routes: ReadonlyMap<string, CompositionRoute> = new Map();
  let lastRevision = 0;

  const currentContribution = (next: State, key: string) => {
    const published = next.contributions.get(key);
    return published !== undefined &&
      sameOwner(next.active.get(published.owner.id), published.owner)
      ? published
      : undefined;
  };
  const selectedKey = (selection: SelectedRoute) =>
    contributionKey(selection.owner.id, selection.contributionId);
  const clearContributionSelection = (next: State, key: string, nextPlan: Plan = plan) => {
    for (const [slot, route] of nextPlan.routeSlots)
      if (route.fallback === key) next.selections.delete(slot);
    for (const [slot, selection] of next.selections)
      if (selectedKey(selection) === key) next.selections.delete(slot);
  };
  const clearOwnerSelections = (next: State, owner: CompositionOwner, nextPlan: Plan = plan) => {
    for (const [slot, route] of nextPlan.routeSlots)
      if (route.fallback.startsWith(`${owner.id}\u0000`)) next.selections.delete(slot);
    for (const [slot, selection] of next.selections)
      if (selection.owner.id === owner.id) next.selections.delete(slot);
  };

  const candidate = Effect.fn("PluginComposition.candidate")(function* (
    next: State,
    nextPlan: Plan = plan,
  ) {
    if (!nextPlan.recipe || !next.layout)
      return { surface: recovery, routes: new Map<string, CompositionRoute>() };
    for (const route of nextPlan.routeSlots.values())
      if (currentContribution(next, route.fallback) === undefined)
        return { surface: recovery, routes: new Map<string, CompositionRoute>() };
    const slots = nextPlan.recipe.slots.map((slot) => {
      const route = nextPlan.routeSlots.get(slot.key);
      const selected = next.selections.get(slot.key);
      const selectedKey =
        route !== undefined &&
        selected !== undefined &&
        route.contributions.has(contributionKey(selected.owner.id, selected.contributionId)) &&
        sameOwner(next.active.get(selected.owner.id), selected.owner) &&
        sameOwner(
          currentContribution(next, contributionKey(selected.owner.id, selected.contributionId))
            ?.owner,
          selected.owner,
        )
          ? contributionKey(selected.owner.id, selected.contributionId)
          : undefined;
      const entries = route === undefined ? slot.contributions : [];
      const keys =
        route === undefined
          ? entries.map((entry) => contributionKey(entry.pluginId, entry.id))
          : [selectedKey ?? route.fallback];
      return {
        key: slot.key,
        contributions: keys.flatMap((key) => {
          const published = next.contributions.get(key);
          return published === undefined ||
            !sameOwner(next.active.get(published.owner.id), published.owner)
            ? []
            : [{ owner: published.owner, id: published.id, surface: published.surface }];
        }),
      };
    });
    return yield* composePluginSurface({
      layout: { owner: next.layout.owner, surface: next.layout.surface },
      slots,
    });
  });
  const commitCandidate = Effect.fn("PluginComposition.commitCandidate")(function* (
    next: State,
    nextPlan: Plan = plan,
  ) {
    const composed = yield* candidate(next, nextPlan);
    return yield* Effect.uninterruptible(
      options.commit(composed.surface).pipe(
        Effect.tap((revision) =>
          Effect.sync(() => {
            state = next;
            plan = nextPlan;
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
        if (!plan.owners.has(owner.id))
          return yield* invalid("Owner is not declared by the composition recipe");
        const current = state.active.get(owner.id);
        const latest = state.latest.get(owner.id);
        if (sameOwner(current, owner)) return lastRevision;
        if (latest === undefined && state.latest.size >= maxHistoricalOwners)
          return yield* invalid("Composition owner history is full; restart is required");
        if (latest !== undefined && owner.generation <= latest)
          return yield* invalid("Composition owner generations must increase");
        const next = cloneState(state);
        next.latest.set(owner.id, owner.generation);
        next.active.set(owner.id, owner);
        if (next.layout?.owner.id === owner.id) next.layout = undefined;
        for (const [key, contribution] of next.contributions)
          if (contribution.owner.id === owner.id) next.contributions.delete(key);
        clearOwnerSelections(next, owner);
        return yield* commitCandidate(next);
      }),
    );
  });
  const publishLayout = Effect.fn("PluginComposition.publishLayout")(function* (
    value: unknown,
    surface: unknown,
  ) {
    const owner = yield* decodeOwner(value);
    const decoded = yield* decodeNativeSurface(surface).pipe(
      Effect.mapError(() => invalid("Malformed layout surface")),
    );
    return yield* permit.withPermit(
      Effect.gen(function* () {
        if (owner.id !== plan.recipe?.layout)
          return yield* invalid("Only the configured layout may publish a layout");
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
    const decoded = yield* decodeNativeSurface(surface).pipe(
      Effect.mapError(() => invalid("Malformed contribution surface")),
    );
    return yield* permit.withPermit(
      Effect.gen(function* () {
        if (!plan.configured.has(contributionKey(owner.id, id)))
          return yield* invalid("Contribution is not declared by the composition recipe");
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
        clearOwnerSelections(next, owner);
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
    return yield* permit.withPermit(
      Effect.gen(function* () {
        if (!plan.configured.has(key))
          return yield* invalid("Contribution is not declared by the composition recipe");
        if (!sameOwner(state.active.get(owner.id), owner))
          return yield* invalid("Stale contribution withdrawal");
        if (!state.contributions.has(key)) return lastRevision;
        const next = cloneState(state);
        next.contributions.delete(key);
        clearContributionSelection(next, key);
        return yield* commitCandidate(next);
      }),
    );
  });
  const showRoute = Effect.fn("PluginComposition.showRoute")(function* (
    value: unknown,
    contribution: unknown,
  ) {
    const owner = yield* decodeOwner(value);
    const id = yield* Schema.decodeUnknownEffect(ContributionId)(contribution).pipe(
      Effect.mapError(() => invalid("Malformed contribution ID")),
    );
    return yield* permit.withPermit(
      Effect.gen(function* () {
        if (!plan.recipe) return yield* invalid("Composition routes are unavailable");
        const key = contributionKey(owner.id, id);
        const routeSlot = [...plan.routeSlots].find(([, route]) => route.contributions.has(key));
        if (routeSlot === undefined)
          return yield* invalid("Contribution is not declared in a route slot");
        if (!sameOwner(state.active.get(owner.id), owner))
          return yield* invalid("Stale route selection");
        const published = currentContribution(state, key);
        if (published === undefined || !sameOwner(published.owner, owner))
          return yield* invalid("Route contribution is not published");
        const [slot, route] = routeSlot;
        if (currentContribution(state, route.fallback) === undefined)
          return yield* invalid("Route fallback is not published");
        const current = state.selections.get(slot);
        if (
          (key === route.fallback && current === undefined) ||
          (current !== undefined &&
            sameOwner(current.owner, owner) &&
            current.contributionId === id)
        )
          return lastRevision;
        const next = cloneState(state);
        if (key === route.fallback) next.selections.delete(slot);
        else next.selections.set(slot, { owner, contributionId: id });
        return yield* commitCandidate(next);
      }),
    );
  });
  const hideRoute = Effect.fn("PluginComposition.hideRoute")(function* (
    value: unknown,
    contribution: unknown,
  ) {
    const owner = yield* decodeOwner(value);
    const id = yield* Schema.decodeUnknownEffect(ContributionId)(contribution).pipe(
      Effect.mapError(() => invalid("Malformed contribution ID")),
    );
    return yield* permit.withPermit(
      Effect.gen(function* () {
        if (!plan.recipe) return yield* invalid("Composition routes are unavailable");
        const key = contributionKey(owner.id, id);
        const routeSlot = [...plan.routeSlots].find(([, route]) => route.contributions.has(key));
        if (routeSlot === undefined)
          return yield* invalid("Contribution is not declared in a route slot");
        const [slot] = routeSlot;
        const selected = state.selections.get(slot);
        if (
          selected === undefined ||
          !sameOwner(selected.owner, owner) ||
          selected.contributionId !== id
        )
          return lastRevision;
        const next = cloneState(state);
        next.selections.delete(slot);
        return yield* commitCandidate(next);
      }),
    );
  });
  const reconfigure = Effect.fn("PluginComposition.reconfigure")(function* (
    value: unknown | undefined,
  ) {
    const nextPlan = yield* decodePlan(value);
    return yield* permit.withPermit(
      Effect.gen(function* () {
        for (const owner of state.active.values())
          if (!nextPlan.owners.has(owner.id))
            return yield* invalid("Active composition owners must be stopped before removal");
        const next = cloneState(state);
        if (next.layout && next.layout.owner.id !== nextPlan.recipe?.layout)
          next.layout = undefined;
        for (const [key] of next.contributions)
          if (!nextPlan.configured.has(key)) next.contributions.delete(key);
        for (const [slot, selection] of next.selections) {
          const route = nextPlan.routeSlots.get(slot);
          const previousRoute = plan.routeSlots.get(slot);
          const key = selectedKey(selection);
          if (
            route === undefined ||
            route.fallback !== previousRoute?.fallback ||
            route.fallback === key ||
            currentContribution(next, route.fallback) === undefined ||
            !route.contributions.has(key) ||
            !sameOwner(next.active.get(selection.owner.id), selection.owner) ||
            !sameOwner(currentContribution(next, key)?.owner, selection.owner)
          )
            next.selections.delete(slot);
        }
        return yield* commitCandidate(next, nextPlan);
      }),
    );
  });

  return {
    activate,
    publishLayout,
    publishContribution,
    withdrawContribution,
    showRoute,
    hideRoute,
    release: (owner) => clear(owner, false),
    remove: (owner) => clear(owner, true),
    reconfigure,
    complete: Effect.sync(() => {
      if (!plan.recipe) return true;
      if (!state.layout || !sameOwner(state.active.get(plan.recipe.layout), state.layout.owner))
        return false;
      return [...plan.required].every((key) => {
        const contribution = state.contributions.get(key);
        return (
          contribution !== undefined &&
          sameOwner(state.active.get(contribution.owner.id), contribution.owner)
        );
      });
    }),
    owners: () => new Set(plan.owners),
    route: (event) => {
      const routed = routeCompositionEvent(routes, event);
      return routed && sameOwner(state.active.get(routed.owner.id), routed.owner)
        ? routed
        : undefined;
    },
  };
});
