import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeWebUrl, parseConfiguration, type BrowserConfiguration } from "@hitchhiker/core";
import {
  createDefaultInterface,
  type DefaultInterfaceConfiguration,
  type DefaultInterfaceState,
} from "@hitchhiker/default-interface";
import { Effect, Option, Schema } from "effect";

const maxBytes = 1024 * 1024;
const File = "browser-state.json";
const PageId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
);
const PageIds = Schema.Array(PageId).check(Schema.isMaxLength(128), Schema.isUnique());
const PersistedPage = Schema.Struct({ id: PageId, url: Schema.String, title: Schema.String });
const LegacySeed = Schema.Struct({
  tabPlacement: Schema.Literals(["sidebar", "top"]),
  selectedPageId: Schema.optional(PageId),
  pageOrder: PageIds,
  pinnedPageIds: PageIds,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const PersistedV1 = Schema.Struct({
  version: Schema.Literal(1),
  configuration: Schema.Unknown,
  interface: Schema.Struct({
    tabPlacement: Schema.Literals(["sidebar", "top"]),
    selectedPageId: Schema.optional(Schema.String),
    pageOrder: Schema.Array(Schema.String),
    pinnedPageIds: Schema.Array(Schema.String),
  }),
  pages: Schema.Array(PersistedPage),
});
const PersistedV2 = Schema.Struct({
  version: Schema.Literal(2),
  configuration: Schema.Unknown,
  pages: Schema.Array(PersistedPage),
  legacyBootstrapSeed: Schema.optional(LegacySeed),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export class BrowserPersistenceError extends Schema.TaggedError<BrowserPersistenceError>()(
  "BrowserPersistenceError",
  { message: Schema.String },
) {}

export interface LegacyBootstrapSeed {
  readonly tabPlacement: "sidebar" | "top";
  readonly selectedPageId?: string;
  readonly pageOrder: readonly string[];
  readonly pinnedPageIds: readonly string[];
}
export interface BrowserPersistence {
  readonly configuration: BrowserConfiguration;
  /** Retained only for legacy callers; V2 never restores these fields into a live controller. */
  readonly interfaceConfiguration: DefaultInterfaceConfiguration;
  /** Retained only for legacy callers; V2 synthesizes an empty default interface. */
  readonly interfaceState: DefaultInterfaceState;
  readonly pages: readonly { readonly id: string; readonly url: string; readonly title: string }[];
  readonly format?: 2;
  readonly legacyBootstrapSeed?: LegacyBootstrapSeed;
}

const decodeV1 = Schema.decodeUnknownOption(PersistedV1, { onExcessProperty: "error" });
const decodeV2 = Schema.decodeUnknownOption(PersistedV2, { onExcessProperty: "error" });

const validPages = (
  pages: readonly { readonly id: string; readonly url: string; readonly title: string }[],
) => {
  if (pages.length > 128) return false;
  const ids = new Set<string>();
  for (const page of pages) {
    if (
      ids.has(page.id) ||
      page.url.length > 8192 ||
      Buffer.byteLength(page.title) > 4096 ||
      !normalizeWebUrl(page.url).ok
    )
      return false;
    ids.add(page.id);
  }
  return true;
};
const persistence = (
  profileId: string,
  configuration: BrowserConfiguration,
  pages: readonly { readonly id: string; readonly url: string; readonly title: string }[],
  format?: 2,
  legacyBootstrapSeed?: LegacyBootstrapSeed,
): BrowserPersistence => ({
  configuration,
  interfaceConfiguration: { tabPlacement: "sidebar" },
  interfaceState: createDefaultInterface(profileId),
  pages: pages.map((page) => ({ ...page })),
  ...(format === undefined ? {} : { format }),
  ...(legacyBootstrapSeed === undefined ? {} : { legacyBootstrapSeed }),
});

const decode = (profileId: string, value: unknown): BrowserPersistence | undefined => {
  const v2 = decodeV2(value);
  if (Option.isSome(v2)) {
    const configuration = parseConfiguration(v2.value.configuration);
    if (!configuration.ok || !validPages(v2.value.pages)) return;
    return persistence(
      profileId,
      configuration.value,
      v2.value.pages,
      2,
      v2.value.legacyBootstrapSeed,
    );
  }
  const v1 = decodeV1(value);
  if (Option.isNone(v1)) return;
  const configuration = parseConfiguration(v1.value.configuration);
  if (!configuration.ok || !validPages(v1.value.pages)) return;
  const ids = new Set(v1.value.pages.map((page) => page.id));
  return {
    configuration: configuration.value,
    interfaceConfiguration: { tabPlacement: v1.value.interface.tabPlacement },
    interfaceState: {
      ...createDefaultInterface(profileId),
      ...(v1.value.interface.selectedPageId !== undefined &&
      ids.has(v1.value.interface.selectedPageId)
        ? { selectedPageId: v1.value.interface.selectedPageId }
        : {}),
      pageOrder: Object.freeze(v1.value.interface.pageOrder.filter((id) => ids.has(id))),
      pinnedPageIds: Object.freeze(v1.value.interface.pinnedPageIds.filter((id) => ids.has(id))),
    },
    pages: v1.value.pages.map((page) => ({ ...page })),
  };
};

/** V1 fields become a one-time seed; V2 only returns its explicitly retained seed. */
export const legacyBootstrapSeedOf = (
  persisted: BrowserPersistence | undefined,
): LegacyBootstrapSeed | undefined => {
  if (persisted === undefined) return undefined;
  if (persisted.format === 2) return persisted.legacyBootstrapSeed;
  return {
    tabPlacement: persisted.interfaceConfiguration.tabPlacement,
    ...(persisted.interfaceState.selectedPageId === undefined
      ? {}
      : { selectedPageId: persisted.interfaceState.selectedPageId }),
    pageOrder: Object.freeze([...new Set(persisted.interfaceState.pageOrder)]),
    pinnedPageIds: Object.freeze([...new Set(persisted.interfaceState.pinnedPageIds)]),
  };
};

export const loadBrowserPersistence = (profileRoot: string, profileId: string) =>
  Effect.tryPromise({
    try: async (): Promise<BrowserPersistence | undefined> => {
      const path = `${profileRoot}/${File}`;
      try {
        if ((await stat(path)).size > BigInt(maxBytes))
          throw new Error("Browser state is oversized");
        const contents = await readFile(path);
        if (contents.byteLength > maxBytes) throw new Error("Browser state is oversized");
        const decoded = decode(profileId, JSON.parse(contents.toString("utf8")));
        if (decoded === undefined) throw new Error("Browser state is invalid");
        return decoded;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    catch: (cause) =>
      new BrowserPersistenceError({ message: `Could not load browser state: ${String(cause)}` }),
  });

export const saveBrowserPersistence = (profileRoot: string, state: BrowserPersistence) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        const path = `${profileRoot}/${File}`;
        const json = JSON.stringify(
          state.format === 2
            ? {
                version: 2,
                configuration: state.configuration,
                pages: state.pages,
                ...(state.legacyBootstrapSeed === undefined
                  ? {}
                  : { legacyBootstrapSeed: state.legacyBootstrapSeed }),
              }
            : {
                version: 1,
                configuration: state.configuration,
                interface: {
                  tabPlacement: state.interfaceConfiguration.tabPlacement,
                  ...(state.interfaceState.selectedPageId === undefined
                    ? {}
                    : { selectedPageId: state.interfaceState.selectedPageId }),
                  pageOrder: state.interfaceState.pageOrder,
                  pinnedPageIds: state.interfaceState.pinnedPageIds,
                },
                pages: state.pages,
              },
        );
        if (Buffer.byteLength(json) > maxBytes) throw new Error("Browser state exceeds 1 MiB");
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await chmod(profileRoot, 0o700);
        const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
          await writeFile(temporary, json, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
            flush: true,
          });
          await rename(temporary, path);
          const directory = await open(profileRoot, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          await rm(temporary, { force: true });
        }
      },
      catch: (cause) =>
        new BrowserPersistenceError({ message: `Could not save browser state: ${String(cause)}` }),
    }),
  );
