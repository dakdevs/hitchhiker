import { Effect, Schema, type Stream } from "effect";

const PluginId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{1,62}$/),
  Schema.isTrimmed(),
);
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const Version = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isTrimmed(),
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
);
const CapabilitySchema = Schema.Literals([
  "pages.list",
  "pages.manage",
  "pages.read",
  "pages.write",
  "ui.compose",
  "configuration.read",
  "configuration.write",
  "plugins.install",
  "plugins.read",
  "plugins.manage",
  "extensions.read",
  "extensions.manage",
  "extensions.install",
  "devtools.manage",
  "storage.local",
  "browser.full-control",
  "cdp.connect",
]);

/** Deliberately excludes artifact paths, hashes, grant IDs, and credentials. */
export const PluginManagementPluginSummarySchema = Schema.Struct({
  id: PluginId,
  name: Text,
  version: Version,
  enabled: Schema.Boolean,
  running: Schema.Boolean,
  removing: Schema.optional(Schema.Boolean),
  capabilities: Schema.Array(CapabilitySchema).check(Schema.isMaxLength(16), Schema.isUnique()),
  previousVersion: Schema.optional(Version),
  lastFailure: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type PluginManagementPluginSummary = typeof PluginManagementPluginSummarySchema.Type;

export const PluginManagementSnapshotSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  plugins: Schema.Array(PluginManagementPluginSummarySchema).check(Schema.isMaxLength(16)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type PluginManagementSnapshot = typeof PluginManagementSnapshotSchema.Type;

/** Trusted, owner-bound port. The dispatcher never accepts a caller identity on the wire. */
export interface PluginManagementApi {
  /** Trusted invalidations, never an SDK method or caller-supplied event source. */
  readonly events?: Stream.Stream<
    { readonly event: "plugins.changed"; readonly payload: Record<string, never> },
    unknown
  >;
  readonly snapshot: () => Effect.Effect<PluginManagementSnapshot, unknown>;
  readonly enable: (id: string) => Effect.Effect<PluginManagementSnapshot, unknown>;
  readonly disable: (id: string) => Effect.Effect<PluginManagementSnapshot, unknown>;
  readonly rollback: (id: string) => Effect.Effect<PluginManagementSnapshot, unknown>;
  readonly uninstall: (id: string) => Effect.Effect<PluginManagementSnapshot, unknown>;
  readonly replace: (
    sourceId: string,
    targetId: string,
    expectedRevision: number,
  ) => Effect.Effect<PluginManagementSnapshot, unknown>;
  readonly replaceSelf: (
    targetId: string,
    expectedRevision: number,
  ) => Effect.Effect<PluginManagementSnapshot, unknown>;
}

export const PluginManagementIdSchema = PluginId;
export const PluginManagementRevisionSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
