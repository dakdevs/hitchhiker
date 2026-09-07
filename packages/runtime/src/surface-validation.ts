import { lucideNames, type NativeNode, type Surface } from "@hitchhiker/ui";
import { Effect, Schema } from "effect";
import { EngineError } from "./engine.ts";

const Branch = Schema.Struct({ children: Schema.optional(Schema.Array(Schema.Unknown)) });
const Style = {
  key: Schema.String,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  flex: Schema.optional(Schema.Number),
  padding: Schema.optional(Schema.Number),
  gap: Schema.optional(Schema.Number),
  bg: Schema.optional(Schema.String),
  fg: Schema.optional(Schema.String),
  radius: Schema.optional(Schema.Number),
  fontSize: Schema.optional(Schema.Number),
};
const Icon = Schema.TemplateLiteral([Schema.Literal("app:lucide-"), Schema.Literals(lucideNames)]);
const Node: Schema.Codec<NativeNode> = Schema.Union([
  Schema.Struct({
    ...Style,
    kind: Schema.Literals(["row", "column", "stack", "scroll"]),
    children: Schema.Array(Schema.suspend(() => Node)),
  }),
  Schema.Struct({ ...Style, kind: Schema.Literal("text"), label: Schema.String }),
  Schema.Struct({
    ...Style,
    kind: Schema.Literal("button"),
    label: Schema.String,
    action: Schema.String,
    icon: Schema.optional(Icon),
    iconOnly: Schema.optional(Schema.Boolean),
    accessibilityLabel: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.Literals(["ghost", "secondary"])),
  }),
  Schema.Struct({
    ...Style,
    kind: Schema.Literal("list-item"),
    label: Schema.String,
    action: Schema.String,
    icon: Schema.optional(Icon),
  }),
  Schema.Struct({
    ...Style,
    kind: Schema.Literal("input"),
    label: Schema.String,
    value: Schema.String,
    placeholder: Schema.optional(Schema.String),
    action: Schema.optional(Schema.String),
  }),
  Schema.Struct({ ...Style, kind: Schema.Literal("icon"), icon: Icon }),
  Schema.Struct({ ...Style, kind: Schema.Literal("spacer") }),
  Schema.Struct({ ...Style, kind: Schema.Literal("drag-region") }),
  Schema.Struct({ ...Style, kind: Schema.Literal("viewport"), viewportId: Schema.String }),
]);
const SurfaceEnvelope = Schema.Struct({
  identity: Schema.optional(Schema.String),
  root: Schema.Unknown,
  bindings: Schema.Array(
    Schema.Struct({
      viewportId: Schema.String,
      pageId: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)),
    }),
  ),
});

const maxSurfaceBytes = 250 * 1024;
const maxNodes = 250;
const maxDepth = 12;
const maxChildren = 100;
const maxBindings = 32;
const maxKeyBytes = 128;
const maxActionBytes = 256;
const maxDisplayStringBytes = 4000;
const color = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const invalid = (message: string) => new EngineError({ code: "surface", message });
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

// The runtime envelope is deliberately smaller than Native's 1 MiB root_json
// ceiling: it includes bindings and provides an earlier controller-side bound.
// Native does not receive identity, bindings, or page IDs; their association is
// enforced here before ui.commit. Native's WireString parser additionally checks
// UTF-8; reject lone UTF-16 surrogates here before sending strings to Native.
const validateNode = (
  node: NativeNode,
  state: { count: number; keys: Set<string>; viewports: Set<string> },
  depth: number,
): string | undefined => {
  if (++state.count > maxNodes || depth > maxDepth) return "Surface exceeds component limits";
  if (
    !node.key ||
    !node.key.isWellFormed() ||
    byteLength(node.key) > maxKeyBytes ||
    state.keys.has(node.key)
  )
    return "Native node keys must be distinct non-empty values up to 128 bytes";
  state.keys.add(node.key);

  for (const [value, maximum] of [
    [node.width, 8192],
    [node.height, 8192],
    [node.flex, 100],
    [node.padding, 256],
    [node.gap, 256],
    [node.radius, 256],
    [node.fontSize, 64],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > maximum))
      return "Native style values must be finite and within host limits";
  }
  if (node.fontSize !== undefined && node.fontSize < 8)
    return "Native font size must be between 8 and 64";
  if (
    (node.bg !== undefined && !color.test(node.bg)) ||
    (node.fg !== undefined && !color.test(node.fg))
  )
    return "Native colors must be #RRGGBB or #RRGGBBAA";

  for (const value of [
    "label" in node ? node.label : undefined,
    "value" in node ? node.value : undefined,
    "placeholder" in node ? node.placeholder : undefined,
    "accessibilityLabel" in node ? node.accessibilityLabel : undefined,
  ]) {
    if (value !== undefined && (!value.isWellFormed() || byteLength(value) > maxDisplayStringBytes))
      return "Native display strings exceed host limits";
  }
  if (
    "action" in node &&
    node.action !== undefined &&
    (!node.action.isWellFormed() || byteLength(node.action) > maxActionBytes)
  )
    return "Native actions exceed host limits";
  if (
    node.kind === "button" &&
    node.accessibilityLabel !== undefined &&
    !node.accessibilityLabel.trim()
  )
    return "Native button accessibility labels cannot be blank";
  if (node.kind === "button" && node.iconOnly && (!node.icon || !node.label.trim()))
    return "Icon-only Native buttons require an icon and label";
  if (node.kind === "viewport") {
    if (
      !node.viewportId ||
      !node.viewportId.isWellFormed() ||
      byteLength(node.viewportId) > maxKeyBytes ||
      state.viewports.has(node.viewportId)
    )
      return "Native viewport IDs must be distinct non-empty values up to 128 bytes";
    state.viewports.add(node.viewportId);
  }
  if ("children" in node) {
    if (node.children.length > maxChildren) return "Too many Native children";
    for (const child of node.children) {
      const message = validateNode(child, state, depth + 1);
      if (message) return message;
    }
  }
  return undefined;
};

/** Decodes the bounded JSON surface protocol accepted by the Native host. */
export const decodeNativeSurface = Effect.fn("decodeNativeSurface")(function* (value: unknown) {
  const serialized = yield* Effect.try({
    try: () => JSON.stringify(value),
    catch: () => invalid("Surface must be serializable JSON"),
  });
  if (!serialized || Buffer.byteLength(serialized) > maxSurfaceBytes)
    return yield* invalid("Surface exceeds host frame limit");
  const envelope = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SurfaceEnvelope), {
    onExcessProperty: "error",
  })(serialized).pipe(Effect.mapError(() => invalid("Malformed surface envelope")));

  const pending: { node: unknown; depth: number }[] = [{ node: envelope.root, depth: 0 }];
  let total = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (++total > maxNodes || entry.depth > maxDepth)
      return yield* invalid("Surface exceeds component limits");
    const branch = yield* Schema.decodeUnknownEffect(Branch)(entry.node).pipe(
      Effect.mapError(() => invalid("Malformed Native node")),
    );
    if ((branch.children?.length ?? 0) > maxChildren)
      return yield* invalid("Too many Native children");
    for (const child of branch.children ?? [])
      pending.push({ node: child, depth: entry.depth + 1 });
  }
  const root = yield* Schema.decodeUnknownEffect(Node, { onExcessProperty: "error" })(
    envelope.root,
  ).pipe(Effect.mapError(() => invalid("Malformed Native component")));
  const state = { count: 0, keys: new Set<string>(), viewports: new Set<string>() };
  const nodeError = validateNode(root, state, 0);
  if (nodeError) return yield* invalid(nodeError);
  if (envelope.bindings.length > maxBindings)
    return yield* invalid("Surface exceeds viewport limits");

  const pages = new Set<string>();
  const viewports = new Set<string>();
  for (const binding of envelope.bindings) {
    if (
      !state.viewports.has(binding.viewportId) ||
      byteLength(binding.viewportId) > maxKeyBytes ||
      pages.has(binding.pageId) ||
      viewports.has(binding.viewportId)
    )
      return yield* invalid("Bindings require distinct pages and declared viewports");
    pages.add(binding.pageId);
    viewports.add(binding.viewportId);
  }
  return { ...envelope, root } satisfies Surface;
});
