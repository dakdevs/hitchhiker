import { Effect, Schema } from "effect";
import { ExtensionManagementSummarySchema } from "./extension-management.ts";

export const ExtensionOperationIdSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
export const ExtensionInstallationSnapshotSchema = Schema.Struct({
  operationId: ExtensionOperationIdSchema,
  state: Schema.Literals([
    "receiving",
    "validating",
    "awaiting_review",
    "reviewing",
    "installing",
    "enabled",
    "canceled",
    "rejected",
    "error",
    "removed",
  ]),
  upload: Schema.optional(
    Schema.Struct({
      completedFiles: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
      totalBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 512 * 1024 * 1024 })),
      file: Schema.optional(
        Schema.Struct({
          path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
          size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 256 * 1024 * 1024 })),
          offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 256 * 1024 * 1024 })),
        }),
      ),
    }),
  ),
  extension: Schema.optional(ExtensionManagementSummarySchema),
  error: Schema.optional(
    Schema.Literals([
      "validation_failed",
      "review_failed",
      "installation_failed",
      "unavailable",
      "expired",
    ]),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExtensionInstallationSnapshot = typeof ExtensionInstallationSnapshotSchema.Type;
export const ExtensionInstallationListSchema = Schema.Array(
  ExtensionInstallationSnapshotSchema,
).check(Schema.isMaxLength(32));

/** Owner-bound application port. Identity, native approval and host paths never come from callers. */
export interface ExtensionInstallationApi {
  readonly begin: () => Effect.Effect<ExtensionInstallationSnapshot, unknown>;
  readonly beginFile: (
    operationId: string,
    path: string,
    size: number,
  ) => Effect.Effect<ExtensionInstallationSnapshot, unknown>;
  readonly append: (
    operationId: string,
    offset: number,
    dataBase64: string,
  ) => Effect.Effect<ExtensionInstallationSnapshot, unknown>;
  readonly finish: (operationId: string) => Effect.Effect<ExtensionInstallationSnapshot, unknown>;
  readonly status: (operationId: string) => Effect.Effect<ExtensionInstallationSnapshot, unknown>;
  readonly list: () => Effect.Effect<readonly ExtensionInstallationSnapshot[], unknown>;
  readonly requestReview: (
    operationId: string,
  ) => Effect.Effect<ExtensionInstallationSnapshot, unknown>;
  readonly cancel: (operationId: string) => Effect.Effect<ExtensionInstallationSnapshot, unknown>;
}
