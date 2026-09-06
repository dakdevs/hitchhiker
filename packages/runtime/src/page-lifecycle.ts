import { Schema } from "effect";

/** Private native browser incarnation, not a Chrome extension tab identifier. */
export const NativePageGeneration = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(0xffff_ffff),
);
export const AttachedPageGeneration = NativePageGeneration.check(Schema.isGreaterThan(0));
const AttachedPage = { pageId: Schema.String, generation: AttachedPageGeneration };

export const PageLifecycleEvent = Schema.Union([
  Schema.Struct({ event: Schema.Literal("pages.created"), params: Schema.Struct(AttachedPage) }),
  Schema.Struct({
    event: Schema.Literal("pages.browserUnavailable"),
    params: Schema.Struct(AttachedPage),
  }),
  Schema.Struct({
    event: Schema.Literal("pages.replaced"),
    params: Schema.Struct({ ...AttachedPage, previousGeneration: AttachedPageGeneration }),
  }),
  Schema.Struct({
    event: Schema.Literal("pages.documentCommitted"),
    params: Schema.Struct(AttachedPage),
  }),
  Schema.Struct({
    event: Schema.Literal("pages.closed"),
    params: Schema.Struct({
      pageId: Schema.String,
      generation: NativePageGeneration,
      reason: Schema.Literals(["page-close", "window-close"]),
      remainingPages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  }),
  Schema.Struct({
    event: Schema.Literal("pages.titleChanged"),
    params: Schema.Struct({ ...AttachedPage, title: Schema.String }),
  }),
  Schema.Struct({
    event: Schema.Literal("pages.navigationChanged"),
    params: Schema.Struct({
      ...AttachedPage,
      url: Schema.String,
      loading: Schema.Boolean,
      canGoBack: Schema.Boolean,
      canGoForward: Schema.Boolean,
    }),
  }),
]);
export type PageLifecycleEvent = typeof PageLifecycleEvent.Type;
export const decodePageLifecycleEvent = Schema.decodeUnknownEffect(PageLifecycleEvent);
