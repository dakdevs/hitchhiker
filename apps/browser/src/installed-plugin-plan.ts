import { Effect, Schema } from "effect";
import {
  LivePluginManifest,
  InstalledPluginPlanInputSchema,
  type InstalledPluginPlanInput,
  makePluginComposition,
  type LivePluginManifest as PluginManifest,
  type PluginCompositionRecipe,
  type ServiceGraph,
} from "@hitchhiker/runtime";
import { text } from "@hitchhiker/ui";
import { planInstalledServices, requiredDependentClosure } from "./installed-service-plan.ts";

export { InstalledPluginPlanInputSchema, InstalledPluginPlanSchema } from "@hitchhiker/runtime";
export type { InstalledPluginPlanInput, InstalledPluginPlan } from "@hitchhiker/runtime";

const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
/** A single installed-plugin plan may run this many workers, regardless of origin. */
export const MaxInstalledPluginWorkers = 5;
// Keep plan admission compatible with durable manager revision metadata.
const GrantId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const InstalledPluginPlanArtifactSchema = Schema.Struct({
  manifest: LivePluginManifest,
  hash: Hash,
  grantId: GrantId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type InstalledPluginPlanArtifact = typeof InstalledPluginPlanArtifactSchema.Type;

export class InstalledPluginPlanError extends Schema.TaggedError<InstalledPluginPlanError>()(
  "InstalledPluginPlanError",
  { message: Schema.String },
) {}

const invalid = (message: string) => new InstalledPluginPlanError({ message });
const hasUi = (manifest: PluginManifest) =>
  manifest.capabilities.includes("ui.compose") ||
  manifest.capabilities.includes("browser.full-control");
const contributionKey = (owner: string, id: string) => `${owner}\u0000${id}`;
const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && [...left].every((value) => right.has(value));

export interface PreparedInstalledPluginPlan {
  readonly plan: InstalledPluginPlanInput;
  readonly artifacts: readonly InstalledPluginPlanArtifact[];
  readonly graph: ServiceGraph;
  readonly blocked: readonly string[];
  /** Service dependencies always win; a ready layout is preferred over other ready workers. */
  readonly order: readonly string[];
}

export interface InstalledPluginPlanDiff {
  /** Existing workers stop in dependent-first order. */
  readonly stop: readonly string[];
  /** Candidate workers start in provider/layout-first order. */
  readonly start: readonly string[];
}

const validateComposition = (composition: PluginCompositionRecipe | undefined) =>
  composition === undefined
    ? Effect.void
    : makePluginComposition({
        recipe: composition,
        recovery: { root: text("recovery", "Plugin layout unavailable"), bindings: [] },
        commit: () => Effect.succeed(0),
      }).pipe(Effect.asVoid);

const declaredCompositionOwners = (composition: PluginCompositionRecipe | undefined) =>
  composition === undefined
    ? new Set<string>()
    : new Set([
        composition.layout,
        ...composition.slots.flatMap((slot) => slot.contributions.map((entry) => entry.pluginId)),
      ]);
const requiredCompositionOwners = (composition: PluginCompositionRecipe | undefined) =>
  composition === undefined
    ? new Set<string>()
    : new Set([
        composition.layout,
        ...composition.slots.flatMap((slot) =>
          slot.contributions.filter((entry) => !entry.optional).map((entry) => entry.pluginId),
        ),
      ]);

const contributionIds = (composition: PluginCompositionRecipe | undefined, owner: string) =>
  new Set(
    composition?.slots.flatMap((slot) =>
      slot.contributions
        .filter((entry) => entry.pluginId === owner)
        .map((entry) => contributionKey(entry.pluginId, entry.id)),
    ) ?? [],
  );

const combinedOrder = (graph: ServiceGraph, composition: PluginCompositionRecipe | undefined) => {
  const nodes = new Set(graph.order);
  const edges = new Map([...nodes].map((id) => [id, new Set<string>()]));
  const incoming = new Map([...nodes].map((id) => [id, 0]));
  const add = (from: string, to: string) => {
    if (from === to || !nodes.has(from) || !nodes.has(to) || edges.get(from)!.has(to)) return;
    edges.get(from)!.add(to);
    incoming.set(to, incoming.get(to)! + 1);
  };
  for (const binding of graph.bindings) add(binding.provider, binding.consumer);
  const compareReady = (left: string, right: string) => {
    if (left === right) return 0;
    if (composition?.layout === left) return -1;
    if (composition?.layout === right) return 1;
    return left < right ? -1 : 1;
  };
  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort(compareReady);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of [...edges.get(id)!].sort()) {
      const count = incoming.get(dependent)! - 1;
      incoming.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort(compareReady);
      }
    }
  }
  return order.length === nodes.size ? order : undefined;
};

/** Validates a complete candidate before the manager writes or stops anything. */
export const prepareInstalledPluginPlan = Effect.fn("Browser.prepareInstalledPluginPlan")(
  function* (
    input: unknown,
    artifacts: unknown,
  ): Effect.fn.Return<PreparedInstalledPluginPlan, InstalledPluginPlanError> {
    const plan = yield* Schema.decodeUnknownEffect(InstalledPluginPlanInputSchema, {
      onExcessProperty: "error",
    })(input).pipe(Effect.mapError(() => invalid("Malformed installed plugin plan")));
    const entries = yield* Schema.decodeUnknownEffect(
      Schema.Array(InstalledPluginPlanArtifactSchema).check(Schema.isMaxLength(16)),
      { onExcessProperty: "error" },
    )(artifacts).pipe(Effect.mapError(() => invalid("Malformed installed plugin artifacts")));
    if (new Set(plan.enabled).size !== plan.enabled.length)
      return yield* invalid("Enabled plugin identities must be distinct");
    const byId = new Map(entries.map((entry) => [entry.manifest.id, entry]));
    if (byId.size !== entries.length)
      return yield* invalid("Installed plugin identities must be distinct");
    if (plan.enabled.some((id) => !byId.has(id)))
      return yield* invalid("Enabled plugin is not installed");
    yield* validateComposition(plan.composition).pipe(
      Effect.mapError(() => invalid("Malformed composition recipe")),
    );
    const services = yield* planInstalledServices(
      entries.map((entry) => ({
        manifest: entry.manifest,
        enabled: plan.enabled.includes(entry.manifest.id),
      })),
      plan.serviceBindings,
    ).pipe(Effect.mapError((error) => invalid(error.message)));
    if (services.graph.plugins.length > MaxInstalledPluginWorkers)
      return yield* invalid(`Installed plan exceeds ${MaxInstalledPluginWorkers} runnable plugins`);
    const runnable = new Set(services.graph.plugins.map((plugin) => plugin.id));
    const declaredOwners = declaredCompositionOwners(plan.composition);
    const requiredOwners = requiredCompositionOwners(plan.composition);
    const enabledUi = new Set(plan.enabled.filter((id) => hasUi(byId.get(id)!.manifest)));
    if (plan.composition === undefined && enabledUi.size > 0)
      return yield* invalid("Enabled UI plugins require a composition recipe");
    for (const owner of requiredOwners) {
      const entry = byId.get(owner);
      if (!entry || !plan.enabled.includes(owner) || !runnable.has(owner) || !hasUi(entry.manifest))
        return yield* invalid("Required composition owners must be enabled runnable UI plugins");
    }
    for (const owner of declaredOwners) {
      if (!plan.enabled.includes(owner)) continue;
      const entry = byId.get(owner);
      if (!entry || !hasUi(entry.manifest))
        return yield* invalid("Enabled composition owners must be UI plugins");
    }
    if ([...enabledUi].some((id) => !declaredOwners.has(id)))
      return yield* invalid("Every enabled UI plugin must be represented by the composition");
    const order = combinedOrder(services.graph, plan.composition);
    if (!order) return yield* invalid("Service and composition dependencies contain a cycle");
    return Object.freeze({
      plan: Object.freeze({
        enabled: Object.freeze([...plan.enabled]),
        ...(plan.composition === undefined ? {} : { composition: plan.composition }),
        serviceBindings: Object.freeze([...plan.serviceBindings]),
      }),
      artifacts: Object.freeze([...entries]),
      graph: services.graph,
      blocked: services.blocked,
      order: Object.freeze(order),
    });
  },
);

const requiredBindingSignature = (graph: ServiceGraph, consumer: string) =>
  graph.bindings
    .filter((binding) => binding.consumer === consumer && !binding.dependency.optional)
    .map(
      (binding) => `${binding.dependency.id}\u0000${binding.provider}\u0000${binding.service.id}`,
    )
    .sort()
    .join("\u0001");

/** Computes only workers that must change; optional service bindings retain consumers. */
export const diffInstalledPluginPlans = (
  previous: PreparedInstalledPluginPlan,
  candidate: PreparedInstalledPluginPlan,
): InstalledPluginPlanDiff => {
  const oldIds = new Set(previous.graph.order);
  const nextIds = new Set(candidate.graph.order);
  const oldArtifacts = new Map(previous.artifacts.map((entry) => [entry.manifest.id, entry]));
  const nextArtifacts = new Map(candidate.artifacts.map((entry) => [entry.manifest.id, entry]));
  const seeds = new Set<string>();
  for (const id of oldIds) {
    if (!nextIds.has(id)) seeds.add(id);
    else {
      const oldArtifact = oldArtifacts.get(id)!;
      const nextArtifact = nextArtifacts.get(id)!;
      if (oldArtifact.hash !== nextArtifact.hash || oldArtifact.grantId !== nextArtifact.grantId)
        seeds.add(id);
      if (
        requiredBindingSignature(previous.graph, id) !==
        requiredBindingSignature(candidate.graph, id)
      )
        seeds.add(id);
    }
  }
  for (const id of nextIds) if (!oldIds.has(id)) seeds.add(id);
  const oldComposition = previous.plan.composition;
  const nextComposition = candidate.plan.composition;
  if (oldComposition?.layout !== nextComposition?.layout) {
    if (oldComposition) seeds.add(oldComposition.layout);
    if (nextComposition) seeds.add(nextComposition.layout);
  }
  const compositionIds = new Set([
    ...declaredCompositionOwners(oldComposition),
    ...declaredCompositionOwners(nextComposition),
  ]);
  for (const id of compositionIds)
    if (!sameSet(contributionIds(oldComposition, id), contributionIds(nextComposition, id)))
      seeds.add(id);
  const oldSlots = new Set(oldComposition?.slots.map((slot) => slot.key) ?? []);
  const nextSlots = new Set(nextComposition?.slots.map((slot) => slot.key) ?? []);
  if (!sameSet(oldSlots, nextSlots)) {
    if (oldComposition) seeds.add(oldComposition.layout);
    if (nextComposition) seeds.add(nextComposition.layout);
  }
  let closure = new Set(seeds);
  for (;;) {
    const next = requiredDependentClosure(previous.graph, closure);
    for (const id of requiredDependentClosure(candidate.graph, next)) next.add(id);
    if (next.size === closure.size) break;
    closure = next;
  }
  return Object.freeze({
    stop: Object.freeze([...previous.graph.order].reverse().filter((id) => closure.has(id))),
    start: Object.freeze(candidate.order.filter((id) => closure.has(id) || !oldIds.has(id))),
  });
};
