import { Effect, Schema } from "effect";

const InstallationId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ChromiumId = Schema.String.check(Schema.isPattern(/^[a-p]{32}$/));
const Permission = Schema.String.check(Schema.isMaxLength(2048));
const Permissions = Schema.Array(Permission).check(Schema.isMaxLength(256));
const ExtensionState = Schema.Literals([
  "prepared",
  "installing",
  "enabled",
  "removing",
  "removed",
  "error",
]);
const ErrorIntent = Schema.Literals(["install", "remove"]);

/** Deliberately excludes artifact paths, engine errors, and any review confirmation authority. */
export const ExtensionManagementSummarySchema = Schema.Struct({
  installationId: InstallationId,
  digest: Digest,
  expectedChromiumId: ChromiumId,
  chromiumId: Schema.optional(ChromiumId),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  version: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  permissions: Permissions,
  hostPermissions: Permissions,
  optionalPermissions: Permissions,
  optionalHostPermissions: Permissions,
  state: ExtensionState,
  errorIntent: Schema.optional(ErrorIntent),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExtensionManagementSummary = typeof ExtensionManagementSummarySchema.Type;

export const ExtensionManagementSnapshotSchema = Schema.Struct({
  readOnly: Schema.Boolean,
  extensions: Schema.Array(ExtensionManagementSummarySchema).check(Schema.isMaxLength(16)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExtensionManagementSnapshot = typeof ExtensionManagementSnapshotSchema.Type;

/** Trusted owner-bound port. The application binds profile and identity; neither comes from wire input. */
export interface ExtensionManagementApi {
  readonly list: () => Effect.Effect<ExtensionManagementSnapshot, unknown>;
  readonly remove: (installationId: string) => Effect.Effect<ExtensionManagementSnapshot, unknown>;
}

export const ExtensionManagementInstallationIdSchema = InstallationId;
