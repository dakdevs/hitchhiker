import { createHash } from "node:crypto";
import type { NativeNode, Surface } from "@hitchhiker/ui";
import { Effect, Schema } from "effect";
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
const Contribution = Schema.Struct({
  owner: Owner,
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/)),
  surface: Schema.Unknown,
});
const Input = Schema.Struct({
  layout: Schema.Struct({ owner: Owner, surface: Schema.Unknown }),
  slots: Schema.Array(
    Schema.Struct({
      key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      contributions: Schema.Array(Contribution).check(Schema.isMaxLength(32)),
    }),
  ).check(Schema.isMaxLength(32)),
});
export type CompositionOwner = typeof Owner.Type;
export interface CompositionRoute {
  readonly owner: CompositionOwner;
  readonly nodeId: string;
  readonly kind: "button" | "list-item" | "input";
  readonly action?: string;
  readonly wireAction?: string;
}
export interface ComposedPluginSurface {
  readonly surface: Surface;
  readonly routes: ReadonlyMap<string, CompositionRoute>;
}
const invalid = (message: string) => new EngineError({ code: "composition", message });
const wireId = (owner: CompositionOwner, part: string, type: string, key: string): string =>
  `h${createHash("sha256")
    .update(JSON.stringify([owner.id, owner.generation, part, type, key]))
    .digest("hex")}`;

/** The trusted coordinator supplies owner bindings and order; plugins never select another owner. */
export const composePluginSurface = Effect.fn("composePluginSurface")(function* (
  value: unknown,
): Effect.fn.Return<ComposedPluginSurface, EngineError> {
  const input = yield* Schema.decodeUnknownEffect(Input, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => invalid("Malformed composition configuration")),
  );
  if (input.slots.reduce((count, slot) => count + slot.contributions.length, 0) > 32)
    return yield* invalid("Too many composition contributions");
  if (
    input.slots.some(
      (slot) => !slot.key.isWellFormed() || Buffer.byteLength(slot.key, "utf8") > 128,
    )
  )
    return yield* invalid("Invalid composition slot key");
  const layout = yield* decodeNativeSurface(input.layout.surface);
  const nodes = new Map<string, NativeNode>();
  const collect = (node: NativeNode): void => {
    nodes.set(node.key, node);
    if ("children" in node) node.children.forEach(collect);
  };
  collect(layout.root);
  const generations = new Map([[input.layout.owner.id, input.layout.owner.generation]]);
  const contributionIds = new Set<string>();
  const slotChildren = new Map<string, NativeNode[]>();
  const routes = new Map<string, CompositionRoute>();
  const bindings: Surface["bindings"][number][] = [];
  const namespace = (surface: Surface, owner: CompositionOwner, part: string): NativeNode => {
    for (const binding of surface.bindings)
      bindings.push({
        ...binding,
        viewportId: wireId(owner, part, "viewport", binding.viewportId),
      });
    const visit = (node: NativeNode): NativeNode => {
      const key = wireId(owner, part, "node", node.key);
      if ("children" in node) return { ...node, key, children: node.children.map(visit) };
      if (node.kind === "viewport")
        return { ...node, key, viewportId: wireId(owner, part, "viewport", node.viewportId) };
      if (node.kind === "button" || node.kind === "list-item" || node.kind === "input") {
        const action = node.action;
        const wireAction = action === undefined ? undefined : wireId(owner, part, "action", action);
        routes.set(key, { owner, nodeId: node.key, kind: node.kind, action, wireAction });
        return { ...node, key, ...(wireAction === undefined ? {} : { action: wireAction }) };
      }
      return { ...node, key };
    };
    return visit(surface.root);
  };
  for (const slot of input.slots) {
    const container = nodes.get(slot.key);
    if (
      slotChildren.has(slot.key) ||
      !container ||
      !("children" in container) ||
      container.children.length !== 0
    )
      return yield* invalid("Slots must name distinct empty layout containers");
    const children: NativeNode[] = [];
    for (const contribution of slot.contributions) {
      const identity = JSON.stringify([contribution.owner.id, contribution.id]);
      if (contributionIds.has(identity)) return yield* invalid("Duplicate contribution");
      contributionIds.add(identity);
      const generation = generations.get(contribution.owner.id);
      if (generation !== undefined && generation !== contribution.owner.generation)
        return yield* invalid("Conflicting owner generations");
      generations.set(contribution.owner.id, contribution.owner.generation);
      const surface = yield* decodeNativeSurface(contribution.surface);
      children.push(namespace(surface, contribution.owner, `contribution:${contribution.id}`));
    }
    slotChildren.set(slot.key, children);
  }
  const root = namespace(layout, input.layout.owner, "layout");
  const translatedSlots = new Map(
    [...slotChildren].map(([key, children]) => [
      wireId(input.layout.owner, "layout", "node", key),
      children,
    ]),
  );
  const expand = (node: NativeNode): NativeNode =>
    "children" in node
      ? { ...node, children: translatedSlots.get(node.key) ?? node.children.map(expand) }
      : node;
  const surface = yield* decodeNativeSurface({
    identity: wireId(input.layout.owner, "layout", "identity", "root"),
    root: expand(root),
    bindings,
  });
  return { surface, routes };
});

/** Translate only events for the committed candidate; never trust a caller-supplied action owner. */
export const routeCompositionEvent = (
  routes: ReadonlyMap<string, CompositionRoute>,
  event: SurfaceEvent,
): { readonly owner: CompositionOwner; readonly event: SurfaceEvent } | undefined => {
  const route = routes.get(event.nodeId);
  if (!route || (event.event !== "press" && event.event !== "input")) return;
  if (event.event === "input" && route.kind !== "input") return;
  if (
    event.event === "press" &&
    (route.wireAction === undefined || event.payload.action !== route.wireAction)
  )
    return;
  return {
    owner: route.owner,
    event: {
      ...event,
      nodeId: route.nodeId,
      payload: {
        ...event.payload,
        ...(event.event === "press" ? { action: route.action! } : {}),
      },
    },
  };
};
