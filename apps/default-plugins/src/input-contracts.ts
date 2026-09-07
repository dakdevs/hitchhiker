import { Schema } from "effect";
import { BoundedText } from "./contracts.ts";

export const Press = Schema.Struct({ action: BoundedText(256) });
export const Input = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("insert_text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literals([
      "delete_backward",
      "delete_forward",
      "delete_word_backward",
      "delete_word_forward",
      "delete_to_start",
      "delete_to_line_start",
      "clear",
      "commit_composition",
      "cancel_composition",
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("move_caret"),
    direction: Schema.Literals(["previous", "next", "previous_word", "next_word", "start", "end"]),
    extend: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("set_selection"),
    anchor: Schema.Number,
    focus: Schema.Number,
    affinity: Schema.Literals(["upstream", "downstream"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("set_composition"),
    text: Schema.String,
    cursor: Schema.Union([Schema.Number, Schema.Null]),
  }),
]);
export const UiEvent = Schema.Struct({
  surfaceId: Schema.Literal("main"),
  revision: Schema.Int,
  nodeId: BoundedText(256),
  event: Schema.Literals(["press", "input", "viewport", "error"]),
  payload: Schema.Unknown,
});
export const ServiceStateEvent = Schema.Struct({
  dependency: Schema.Literals(["model", "pins", "layout"]),
  providerGeneration: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  revision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  available: Schema.Boolean,
});
