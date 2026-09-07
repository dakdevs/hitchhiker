import { Effect, Schema } from "effect";

export const DevToolsPageIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  Schema.isTrimmed(),
);
export const DevToolsGenerationSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 0xffff_ffff }),
);
export const DevToolsStatusSchema = Schema.Struct({
  pageId: DevToolsPageIdSchema,
  generation: DevToolsGenerationSchema,
  instance: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff_ffff })),
  state: Schema.Literals(["closed", "opening", "open", "closing"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type DevToolsStatus = typeof DevToolsStatusSchema.Type;

export const DevToolsInspectPointSchema = Schema.Struct({
  x: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32_768 })),
  y: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32_768 })),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type DevToolsInspectPoint = typeof DevToolsInspectPointSchema.Type;

/** Trusted controller facade for Chromium's DevTools frontend, never CDP protocol access. */
export interface DevToolsApi {
  readonly status: (pageId: string) => Effect.Effect<DevToolsStatus, unknown>;
  readonly show: (
    pageId: string,
    inspectAt?: DevToolsInspectPoint,
  ) => Effect.Effect<DevToolsStatus, unknown>;
  readonly close: (pageId: string) => Effect.Effect<DevToolsStatus, unknown>;
}
