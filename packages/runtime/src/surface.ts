import { type NativeNode, type Surface } from "@hitchhiker/ui";
import { Context, Effect, Layer, PubSub, Schema, Semaphore, Stream } from "effect";
import { EngineConnection, EngineError } from "./engine.ts";
import { decodeNativeSurface } from "./surface-validation.ts";

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

      const commit = Effect.fn("NativeSurface.commit")(
        function* (value: unknown) {
          const surface = yield* decodeNativeSurface(value);
          if (revision >= Number.MAX_SAFE_INTEGER)
            return yield* invalid("Surface revision exhausted");
          const nextInputKeys = new Set<string>();
          const collectInputs = (node: NativeNode): void => {
            if (node.kind === "input") nextInputKeys.add(node.key);
            if ("children" in node) node.children.forEach(collectInputs);
          };
          collectInputs(surface.root);
          const root = yield* Schema.decodeUnknownEffect(Schema.Json)(surface.root).pipe(
            Effect.mapError(() => invalid("Surface must be JSON data")),
          );
          const next = revision + 1;
          const changedBindings =
            bindings.length !== surface.bindings.length ||
            bindings.some(
              (binding, index) =>
                binding.pageId !== surface.bindings[index].pageId ||
                binding.viewportId !== surface.bindings[index].viewportId,
            );
          yield* engine.request("ui.commit", {
            revision: next,
            root,
            clearViewports: changedBindings,
          });
          const nextIdentity = surface.identity ?? surface.root.key;
          if (nextIdentity !== identity) inputRevisions.clear();
          else if (revision > 0) inputRevisions.set(revision, { identity, keys: inputKeys });
          if (inputRevisions.size > 32) inputRevisions.delete(inputRevisions.keys().next().value!);
          identity = nextIdentity;
          inputKeys = nextInputKeys;
          revision = next;
          bindings = surface.bindings.map((binding) => ({ ...binding }));
          rectangles = new Map();
          // Native invalidates changed bindings atomically with tree adoption.
          return revision;
        },
        Effect.uninterruptible,
        permit.withPermit,
      );
      return NativeSurface.of({ commit, events: Stream.fromPubSub(events) });
    }),
  );
}
