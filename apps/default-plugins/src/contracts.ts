import { Schema } from "effect";

export const BoundedText = (maximum: number) =>
  Schema.String.check(
    Schema.isMaxLength(maximum, {
      toJsonSchema: () => ({ maxLength: maximum, format: `utf16-max-${maximum}` }),
    }),
  );

export const PageId = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/));
export const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const PageIds = Schema.Array(PageId).check(Schema.isMaxLength(128), Schema.isUnique());
export const Selection = Schema.Union([
  Schema.Null,
  Schema.Struct({ kind: Schema.Literal("new-page") }),
  Schema.Struct({ kind: Schema.Literal("page"), pageId: PageId }),
]);
export const TabState = Schema.Struct({
  version: Schema.Literal(1),
  pagesRevision: Revision,
  selection: Selection,
  pageOrder: PageIds,
});
export type TabState = typeof TabState.Type;
export const PinState = Schema.Struct({
  version: Schema.Literal(1),
  pagesRevision: Revision,
  pinnedPageIds: PageIds,
});
export type PinState = typeof PinState.Type;
export const LayoutState = Schema.Struct({
  version: Schema.Literal(1),
  presentation: Schema.Literals(["sidebar", "top"]),
});
export type LayoutState = typeof LayoutState.Type;
export const Empty = Schema.Record(Schema.String, Schema.Never);
export const Select = Schema.Struct({ pageId: PageId });
export const Open = Schema.Struct({ url: BoundedText(8192) });
export const Reorder = Schema.Struct({
  pageId: PageId,
  index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 127 })),
});
export const Pin = Schema.Struct({ pageId: PageId, pinned: Schema.Boolean });
export const SetPresentation = Schema.Struct({ presentation: Schema.Literals(["sidebar", "top"]) });
export const decode = <A>(schema: Schema.Codec<A>, value: unknown): A =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
