import { Schema } from "effect";
import { LivePluginManifest } from "./plugin-dispatch.ts";
import { PluginCompositionRecipeSchema } from "./composition-session.ts";
import { ServiceBindingSchema } from "./service-contracts.ts";

const Id = LivePluginManifest.fields.id;
const Revision = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const InstalledPluginPlanInputSchema = Schema.Struct({
  enabled: Schema.Array(Id).check(Schema.isMaxLength(16)),
  composition: Schema.optional(PluginCompositionRecipeSchema),
  serviceBindings: Schema.Array(ServiceBindingSchema).check(Schema.isMaxLength(128)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type InstalledPluginPlanInput = typeof InstalledPluginPlanInputSchema.Type;

export const InstalledPluginPlanSchema = Schema.Struct({
  enabled: Schema.Array(Id).check(Schema.isMaxLength(16)),
  composition: Schema.optional(PluginCompositionRecipeSchema),
  serviceBindings: Schema.Array(ServiceBindingSchema).check(Schema.isMaxLength(128)),
  revision: Revision,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type InstalledPluginPlan = typeof InstalledPluginPlanSchema.Type;
