import { lucideNames, type NativeNode, type Surface } from "@hitchhiker/ui";
import { Context, Effect, Layer, PubSub, Schema, Semaphore, Stream } from "effect";
import { EngineConnection, EngineError } from "./engine.ts";

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
  bindings: Schema.Array(Schema.Struct({ viewportId: Schema.String, pageId: Schema.String })),
});

const NativeEvent = Schema.Struct({
  surfaceId: Schema.Literal("main"),
  revision: Schema.Int,
  nodeId: Schema.String,
  event: Schema.Literals(["press", "input", "viewport", "error"]),
  payload: Schema.Record(Schema.String, Schema.Json),
});
const Rectangle = Schema.Struct({
  viewportId: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type SurfaceEvent = typeof NativeEvent.Type;
const decodeEvent = Schema.decodeUnknownEffect(NativeEvent);
const decodeRectangle = Schema.decodeUnknownEffect(Rectangle);
const invalid = (message: string) => new EngineError({ code: "surface", message });

/** Owns geometry at the trusted boundary. UI consumers supply component trees and page bindings. */
export class NativeSurface extends Context.Service<
  NativeSurface,
  {
    readonly commit: (surface: unknown) => Effect.Effect<number, EngineError>;
    readonly events: Stream.Stream<SurfaceEvent>;
  }
>()("@hitchhiker/runtime/NativeSurface") {
  static readonly layer = Layer.effect(
    NativeSurface,
    Effect.gen(function* () {
      const engine = yield* EngineConnection;
      const permit = yield* Semaphore.make(1);
      const events = yield* PubSub.bounded<SurfaceEvent>({ capacity: 64 });
      yield* Effect.addFinalizer(() => PubSub.shutdown(events));
      let revision = 0;
      let bindings: Surface["bindings"] = [];
      let rectangles = new Map<string, typeof Rectangle.Type>();
      let identity = "";
      let inputKeys = new Set<string>();
      const inputRevisions = new Map<number, { identity: string; keys: ReadonlySet<string> }>();

      const handleEvent = Effect.fn("NativeSurface.handleEvent")(function* (data: unknown) {
        const event = yield* decodeEvent(data).pipe(
          Effect.mapError(() => invalid("Malformed Native event")),
        );
        if (event.revision !== revision) {
          // Text edits already emitted by Native must survive a controlled-value redraw.
          // Replacing the interface identity or removing the field invalidates those edits.
          const previous = inputRevisions.get(event.revision);
          if (
            event.event !== "input" ||
            previous?.identity !== identity ||
            !previous.keys.has(event.nodeId) ||
            !inputKeys.has(event.nodeId)
          )
            return;
        }
        if (event.event !== "viewport") {
          return event;
        }
        const rectangle = yield* decodeRectangle(event.payload).pipe(
          Effect.mapError(() => invalid("Malformed viewport rectangle")),
        );
        if (!bindings.some((binding) => binding.viewportId === rectangle.viewportId)) return;
        if (
          ![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isFinite) ||
          rectangle.x < 0 ||
          rectangle.y < 0 ||
          rectangle.width <= 0 ||
          rectangle.height <= 0
        )
          return;
        rectangles.set(rectangle.viewportId, rectangle);
        if (!bindings.every((binding) => rectangles.has(binding.viewportId))) return;
        const viewports = bindings.map((binding) => {
          const region = rectangles.get(binding.viewportId)!;
          // Round both edges inward so fractional Native layouts cannot overlap at the CEF boundary.
          const x = Math.ceil(region.x),
            y = Math.ceil(region.y);
          return {
            pageId: binding.pageId,
            x,
            y,
            width: Math.floor(region.x + region.width) - x,
            height: Math.floor(region.y + region.height) - y,
          };
        });
        if (viewports.some((viewport) => viewport.width <= 0 || viewport.height <= 0)) return;
        yield* engine.request("viewports.set", { viewports });
        return event;
      });
      yield* engine.events.pipe(
        Stream.filter((event) => event.event === "ui.event"),
        Stream.runForEach((event) =>
          handleEvent(event.params).pipe(
            permit.withPermit,
            Effect.flatMap((event) =>
              event === undefined ? Effect.void : PubSub.publish(events, event),
            ),
            Effect.catch((error) =>
              PubSub.publish(events, {
                surfaceId: "main",
                revision,
                nodeId: "host",
                event: "error",
                payload: { code: error.code, message: error.message },
              }),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const commit = Effect.fn("NativeSurface.commit")(function* (value: unknown) {
        const serialized = yield* Effect.try({
          try: () => JSON.stringify(value),
          catch: () => invalid("Surface must be serializable JSON"),
        });
        if (!serialized || Buffer.byteLength(serialized) > 250 * 1024)
          return yield* invalid("Surface exceeds host frame limit");
        const envelope = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SurfaceEnvelope))(
          serialized,
        ).pipe(Effect.mapError(() => invalid("Malformed surface envelope")));
        const pending: { node: unknown; depth: number }[] = [{ node: envelope.root, depth: 0 }];
        let total = 0;
        while (pending.length > 0) {
          const entry = pending.pop()!;
          if (++total > 250 || entry.depth > 12)
            return yield* invalid("Surface exceeds component limits");
          const branch = yield* Schema.decodeUnknownEffect(Branch)(entry.node).pipe(
            Effect.mapError(() => invalid("Malformed Native node")),
          );
          if ((branch.children?.length ?? 0) > 100)
            return yield* invalid("Too many Native children");
          for (const child of branch.children ?? [])
            pending.push({ node: child, depth: entry.depth + 1 });
        }
        const decodedRoot = yield* Schema.decodeUnknownEffect(Node, { onExcessProperty: "error" })(
          envelope.root,
        ).pipe(Effect.mapError(() => invalid("Malformed Native component")));
        const surface: Surface = { ...envelope, root: decodedRoot };
        if (revision >= Number.MAX_SAFE_INTEGER)
          return yield* invalid("Surface revision exhausted");
        const viewportIds = new Set<string>();
        const nextInputKeys = new Set<string>();
        let count = 0;
        const collect = (node: NativeNode, depth: number): boolean => {
          if (++count > 250 || depth > 12) return false;
          if (
            node.kind === "button" &&
            node.accessibilityLabel !== undefined &&
            !node.accessibilityLabel.trim()
          )
            return false;
          if (node.kind === "button" && node.iconOnly && (!node.icon || !node.label.trim()))
            return false;
          if (node.kind === "viewport") {
            if (viewportIds.has(node.viewportId)) return false;
            viewportIds.add(node.viewportId);
          }
          if (node.kind === "input") nextInputKeys.add(node.key);
          return !("children" in node) || node.children.every((child) => collect(child, depth + 1));
        };
        if (!collect(surface.root, 0) || surface.bindings.length > 32)
          return yield* invalid("Surface exceeds component or viewport limits");
        const boundPages = new Set<string>(),
          boundViewports = new Set<string>();
        for (const binding of surface.bindings) {
          if (
            !viewportIds.has(binding.viewportId) ||
            boundPages.has(binding.pageId) ||
            boundViewports.has(binding.viewportId)
          )
            return yield* invalid("Bindings require distinct pages and declared viewports");
          boundPages.add(binding.pageId);
          boundViewports.add(binding.viewportId);
        }
        const root = yield* Schema.decodeUnknownEffect(Schema.Json)(surface.root).pipe(
          Effect.mapError(() => invalid("Surface must be JSON data")),
        );
        const next = revision + 1;
        yield* engine.request("ui.commit", { revision: next, root });
        const nextIdentity = surface.identity ?? surface.root.key;
        if (nextIdentity !== identity) inputRevisions.clear();
        else if (revision > 0) inputRevisions.set(revision, { identity, keys: inputKeys });
        if (inputRevisions.size > 32) inputRevisions.delete(inputRevisions.keys().next().value!);
        identity = nextIdentity;
        inputKeys = nextInputKeys;
        const changedBindings =
          bindings.length !== surface.bindings.length ||
          bindings.some(
            (binding, index) =>
              binding.pageId !== surface.bindings[index].pageId ||
              binding.viewportId !== surface.bindings[index].viewportId,
          );
        revision = next;
        bindings = surface.bindings.map((binding) => ({ ...binding }));
        rectangles = new Map();
        // Keep unchanged page placements during text redraws; new bindings wait for Native measurements.
        if (changedBindings) yield* engine.request("viewports.set", { viewports: [] });
        return revision;
      }, permit.withPermit);
      return NativeSurface.of({ commit, events: Stream.fromPubSub(events) });
    }),
  );
}
