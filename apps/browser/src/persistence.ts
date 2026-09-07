import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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

const Persisted = Schema.Struct({
  version: Schema.Literal(1),
  configuration: Schema.Unknown,
  interface: Schema.Struct({
    tabPlacement: Schema.Literals(["sidebar", "top"]),
    selectedPageId: Schema.optional(Schema.String),
    pageOrder: Schema.Array(Schema.String),
    pinnedPageIds: Schema.Array(Schema.String),
  }),
  pages: Schema.Array(
    Schema.Struct({ id: Schema.String, url: Schema.String, title: Schema.String }),
  ),
});

export interface BrowserPersistence {
  readonly configuration: BrowserConfiguration;
  readonly interfaceConfiguration: DefaultInterfaceConfiguration;
  readonly interfaceState: DefaultInterfaceState;
  readonly pages: readonly { readonly id: string; readonly url: string; readonly title: string }[];
}

const decoder = Schema.decodeUnknownOption(Persisted, { onExcessProperty: "error" });

const decode = (profileId: string, value: unknown): BrowserPersistence | undefined => {
  const decoded = decoder(value);
  if (Option.isNone(decoded) || decoded.value.pages.length > 128) return undefined;
  const configuration = parseConfiguration(decoded.value.configuration);
  if (!configuration.ok) return undefined;
  const ids = new Set<string>();
  for (const page of decoded.value.pages) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(page.id) ||
      ids.has(page.id) ||
      page.url.length > 8192 ||
      Buffer.byteLength(page.title) > 4096 ||
      !normalizeWebUrl(page.url).ok
    )
      return undefined;
    ids.add(page.id);
  }
  return {
    configuration: configuration.value,
    interfaceConfiguration: { tabPlacement: decoded.value.interface.tabPlacement },
    interfaceState: {
      ...createDefaultInterface(profileId),
      ...(decoded.value.interface.selectedPageId !== undefined &&
      ids.has(decoded.value.interface.selectedPageId)
        ? { selectedPageId: decoded.value.interface.selectedPageId }
        : {}),
      pageOrder: Object.freeze(decoded.value.interface.pageOrder.filter((id) => ids.has(id))),
      pinnedPageIds: Object.freeze(
        decoded.value.interface.pinnedPageIds.filter((id) => ids.has(id)),
      ),
    },
    pages: decoded.value.pages.map((page) => ({ ...page })),
  };
};

export const loadBrowserPersistence = (profileRoot: string, profileId: string) =>
  Effect.tryPromise({
    try: async (): Promise<BrowserPersistence | undefined> => {
      const path = `${profileRoot}/${File}`;
      try {
        if ((await stat(path)).size > BigInt(maxBytes)) return undefined;
        const contents = await readFile(path);
        if (contents.byteLength > maxBytes) return undefined;
        return decode(profileId, JSON.parse(contents.toString("utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    catch: (cause) => new Error(`Could not load browser state: ${String(cause)}`),
  });

export const saveBrowserPersistence = (profileRoot: string, state: BrowserPersistence) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        const path = `${profileRoot}/${File}`;
        const json = JSON.stringify({
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
        });
        if (Buffer.byteLength(json) > maxBytes) throw new Error("Browser state exceeds 1 MiB");
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await chmod(profileRoot, 0o700);
        const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, path);
        await chmod(path, 0o600);
      },
      catch: (cause) => new Error(`Could not save browser state: ${String(cause)}`),
    }),
  );
