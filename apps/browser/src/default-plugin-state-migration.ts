import type { PluginStorageAdapter } from "@hitchhiker/runtime";
import { Effect, Schema } from "effect";
import type { BrowserPersistence } from "./persistence.ts";

export const DefaultTabModelPluginId = "default-tab-model";
export const DefaultTabPinsPluginId = "default-tab-pins";

const PageId = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/));
const PageIds = Schema.Array(PageId).check(Schema.isMaxLength(128), Schema.isUnique());
const TabState = Schema.Struct({
  version: Schema.Literal(1),
  pagesRevision: Schema.Literal(0),
  selection: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("new-page") }),
    Schema.Struct({ kind: Schema.Literal("page"), pageId: PageId }),
  ]),
  pageOrder: PageIds,
});
const PinState = Schema.Struct({
  version: Schema.Literal(1),
  pagesRevision: Schema.Literal(0),
  pinnedPageIds: PageIds,
});

export type DefaultTabModelState = typeof TabState.Type;
export type DefaultTabPinsState = typeof PinState.Type;

/** The controller supplies a complete, ordered view of the pages that exist now. */
export interface AuthoritativePageSnapshot {
  readonly pageIds: readonly string[];
  readonly pageOrder: readonly string[];
}

export interface DefaultPluginStateMigration {
  readonly model: DefaultTabModelState;
  readonly pins: DefaultTabPinsState;
}

type StorageError = Effect.Error<ReturnType<PluginStorageAdapter["read"]>>;

/** The subset of PluginStorage used by bootstrap, kept structural for the public runtime API. */
export interface DefaultPluginStateStorage {
  readonly forOwner: (pluginId: string) => Effect.Effect<PluginStorageAdapter, StorageError>;
}

export type SeedDisposition = "seeded" | "preserved" | "conflict";

export interface DefaultPluginStateMigrationResult {
  readonly model: SeedDisposition;
  readonly pins: SeedDisposition;
}

const decodePageIds = Schema.decodeUnknownSync(PageIds, { onExcessProperty: "error" });

const validateSnapshot = (snapshot: AuthoritativePageSnapshot) => {
  const pageIds = decodePageIds(snapshot.pageIds);
  const pageOrder = decodePageIds(snapshot.pageOrder);
  if (pageIds.length !== pageOrder.length || pageIds.some((pageId) => !pageOrder.includes(pageId)))
    throw new Error("Authoritative page order must contain each live page exactly once");
  return Object.freeze({ pageIds: Object.freeze(pageIds), pageOrder: Object.freeze(pageOrder) });
};

const uniqueLive = (ids: readonly string[], live: ReadonlySet<string>) =>
  Object.freeze([...new Set(ids.filter((id) => live.has(id)))]);

/**
 * Converts decoded legacy browser persistence into the two default-plugin v1
 * values. It deliberately uses revision zero so plugin activation reconciles it
 * with the controller's current page revision.
 */
export const mapDefaultPluginState = (
  legacy: BrowserPersistence | undefined,
  snapshot: AuthoritativePageSnapshot,
): DefaultPluginStateMigration => {
  const current = validateSnapshot(snapshot);
  const live = new Set(current.pageIds);
  const legacyOrder = legacy ? uniqueLive(legacy.interfaceState.pageOrder, live) : [];
  const pageOrder = Object.freeze([
    ...legacyOrder,
    ...current.pageOrder.filter((pageId) => !legacyOrder.includes(pageId)),
  ]);
  const selected = legacy?.interfaceState.selectedPageId;
  const selection =
    selected !== undefined && live.has(selected)
      ? { kind: "page" as const, pageId: selected }
      : pageOrder[0] !== undefined
        ? { kind: "page" as const, pageId: pageOrder[0] }
        : { kind: "new-page" as const };
  return Object.freeze({
    model: Object.freeze({ version: 1, pagesRevision: 0, selection, pageOrder }),
    pins: Object.freeze({
      version: 1,
      pagesRevision: 0,
      pinnedPageIds: legacy ? uniqueLive(legacy.interfaceState.pinnedPageIds, live) : [],
    }),
  });
};

const seed = Effect.fn("DefaultPluginStateMigration.seed")(function* (
  adapter: PluginStorageAdapter,
  value: DefaultTabModelState | DefaultTabPinsState,
): Effect.fn.Return<SeedDisposition, StorageError> {
  const before = yield* adapter.read();
  if (before.revision !== 0) return "preserved";
  return yield* adapter.write(0, value).pipe(
    Effect.as("seeded" as const),
    Effect.catch((error) => {
      if (error.code !== "conflict") return Effect.fail(error);
      return adapter
        .read()
        .pipe(
          Effect.map((after) =>
            after.revision === 0 ? ("conflict" as const) : ("preserved" as const),
          ),
        );
    }),
  );
});

/**
 * Bootstrap-only persistence adapter. Each owner is seeded independently so a
 * later run can finish pins after a model write has already become durable.
 */
export const seedDefaultPluginState = Effect.fn("DefaultPluginStateMigration.seedAll")(function* (
  storage: DefaultPluginStateStorage,
  migration: DefaultPluginStateMigration,
): Effect.fn.Return<DefaultPluginStateMigrationResult, StorageError> {
  const model = yield* storage.forOwner(DefaultTabModelPluginId);
  const modelResult = yield* seed(model, migration.model);
  const pins = yield* storage.forOwner(DefaultTabPinsPluginId);
  const pinsResult = yield* seed(pins, migration.pins);
  return Object.freeze({ model: modelResult, pins: pinsResult });
});
