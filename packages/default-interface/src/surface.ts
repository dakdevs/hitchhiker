import type { BrowserPage, BrowserState } from "@hitchhiker/core";
import {
  button,
  column,
  design,
  input,
  row,
  scroll,
  spacer,
  text,
  viewport,
  type NativeNode,
  type Surface,
} from "@hitchhiker/ui";

import type { DefaultInterfaceConfiguration, DefaultInterfaceState } from "./index.ts";

/**
 * Action strings emitted by the first-party surface. The host broker owns their effects;
 * this package only renders declarative controls and never talks to a browser engine.
 */
export type DefaultSurfaceAction =
  | "browser.back"
  | "browser.forward"
  | "browser.reload"
  | "browser.navigate"
  | "browser.new-page"
  | "interface.settings"
  | "interface.plugins"
  | "pages.slice.previous"
  | "pages.slice.next"
  | `page.select:${string}`
  | `page.close:${string}`
  | `page.pin:${string}`
  | `page.unpin:${string}`;

/** Stable action names and page-scoped action encoders for a host event broker. */
export const defaultSurfaceActions = Object.freeze({
  back: "browser.back" as const,
  forward: "browser.forward" as const,
  reload: "browser.reload" as const,
  navigate: "browser.navigate" as const,
  newPage: "browser.new-page" as const,
  settings: "interface.settings" as const,
  plugins: "interface.plugins" as const,
  previousSlice: "pages.slice.previous" as const,
  nextSlice: "pages.slice.next" as const,
  selectPage: (pageId: string): DefaultSurfaceAction => `page.select:${pageId}`,
  closePage: (pageId: string): DefaultSurfaceAction => `page.close:${pageId}`,
  pinPage: (pageId: string): DefaultSurfaceAction => `page.pin:${pageId}`,
  unpinPage: (pageId: string): DefaultSurfaceAction => `page.unpin:${pageId}`,
});

export interface DefaultSurfaceRenderOptions {
  /** Draft input is controlled by the host broker and submits the public navigate action. */
  readonly addressDraft?: string;
  readonly dark?: boolean;
  /** Zero-based page offset; each surface renders no more than thirty page controls. */
  readonly pageOffset?: number;
}

const pageSliceSize = 30;
const mainViewportId = "main-page";
type Palette = typeof design.light | typeof design.dark;

const livePages = (browser: BrowserState, profileId: string): readonly BrowserPage[] =>
  browser.pages.filter((page) => page.profileId === profileId && page.lifecycle !== "closed");

const orderedPages = (
  browser: BrowserState,
  state: DefaultInterfaceState,
): readonly BrowserPage[] => {
  const pages = livePages(browser, state.profileId);
  const byId = new Map(pages.map((page) => [page.id, page]));
  const orderedIds = [...state.pageOrder, ...pages.map((page) => page.id)].filter(
    (id, index, ids) => byId.has(id) && ids.indexOf(id) === index,
  );
  const pinIds = state.pinnedPageIds.filter((id) => byId.has(id));
  const pinSet = new Set(pinIds);
  return [...pinIds, ...orderedIds.filter((id) => !pinSet.has(id))]
    .map((id) => byId.get(id))
    .filter((page): page is BrowserPage => page !== undefined);
};

const safeOffset = (
  offset: number | undefined,
  pageCount: number,
  selectedIndex: number,
): number => {
  if (offset !== undefined) {
    const requested = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    return Math.min(requested, Math.max(0, pageCount - pageSliceSize));
  }
  return Math.floor(Math.max(0, selectedIndex) / pageSliceSize) * pageSliceSize;
};

const tabControls = (
  pages: readonly BrowserPage[],
  pinnedPageIds: readonly string[],
  selectedPageId: string | undefined,
  options: DefaultSurfaceRenderOptions,
  colors: Palette,
  placement: DefaultInterfaceConfiguration["tabPlacement"],
): readonly NativeNode[] => {
  const offset = safeOffset(
    options.pageOffset,
    pages.length,
    pages.findIndex((page) => page.id === selectedPageId),
  );
  const visible = pages.slice(offset, offset + pageSliceSize);
  const pinned = new Set(pinnedPageIds);
  const controls: NativeNode[] = [];
  if (offset > 0)
    controls.push(
      button("pages-slice-previous", "Previous pages", defaultSurfaceActions.previousSlice, {
        icon: "app:lucide-chevron-down",
        fg: colors.muted,
        radius: design.radius.control,
      }),
    );
  for (const page of visible) {
    const selected = page.id === selectedPageId;
    const isPinned = pinned.has(page.id);
    controls.push(
      row(
        `page-${page.id}`,
        [
          button(
            `page-select-${page.id}`,
            Array.from(page.title || page.url)
              .slice(0, 100)
              .join(""),
            defaultSurfaceActions.selectPage(page.id),
            {
              flex: 1,
              fg: selected ? colors.foreground : colors.muted,
              bg: selected ? colors.selected : undefined,
              radius: design.radius.control,
              icon: page.lifecycle === "sleeping" ? "app:lucide-moon" : "app:lucide-globe",
            },
          ),
          button(
            `page-pin-${page.id}`,
            isPinned ? "Unpin" : "Pin",
            isPinned
              ? defaultSurfaceActions.unpinPage(page.id)
              : defaultSurfaceActions.pinPage(page.id),
            {
              width: 44,
              icon: "app:lucide-pin",
              fg: colors.muted,
              radius: design.radius.control,
            },
          ),
          button(`page-close-${page.id}`, "Close", defaultSurfaceActions.closePage(page.id), {
            width: 44,
            icon: "app:lucide-x",
            fg: colors.muted,
            radius: design.radius.control,
          }),
        ],
        placement === "top"
          ? { width: 220, gap: design.spacing.compact }
          : { gap: design.spacing.compact },
      ),
    );
  }
  if (offset + pageSliceSize < pages.length)
    controls.push(
      button("pages-slice-next", "Next pages", defaultSurfaceActions.nextSlice, {
        icon: "app:lucide-chevron-down",
        fg: colors.muted,
        radius: design.radius.control,
      }),
    );
  return controls;
};

const toolbar = (address: string, colors: Palette): NativeNode =>
  row(
    "toolbar",
    [
      button("back", "Back", defaultSurfaceActions.back, {
        icon: "app:lucide-arrow-left",
        fg: colors.muted,
      }),
      button("forward", "Forward", defaultSurfaceActions.forward, {
        icon: "app:lucide-arrow-right",
        fg: colors.muted,
      }),
      button("reload", "Reload", defaultSurfaceActions.reload, {
        icon: "app:lucide-rotate-cw",
        fg: colors.muted,
      }),
      input("address", "Address", address, {
        flex: 1,
        action: defaultSurfaceActions.navigate,
        placeholder: "Search or enter an address",
        bg: colors.sidebar,
        fg: colors.foreground,
        radius: design.radius.control,
      }),
      button("navigate", "Navigate", defaultSurfaceActions.navigate, {
        icon: "app:lucide-search",
        fg: colors.foreground,
      }),
      button("new-page", "New page", defaultSurfaceActions.newPage, {
        icon: "app:lucide-plus",
        fg: colors.foreground,
      }),
      button("plugins", "Plugins", defaultSurfaceActions.plugins, {
        icon: "app:lucide-puzzle",
        fg: colors.muted,
      }),
      button("settings", "Settings", defaultSurfaceActions.settings, {
        icon: "app:lucide-settings",
        fg: colors.muted,
      }),
    ],
    { padding: design.spacing.control, gap: design.spacing.compact, bg: colors.canvas },
  );

/** Renders the complete Native shell for one interface instance without changing browser state. */
export const renderDefaultSurface = (
  browser: BrowserState,
  state: DefaultInterfaceState,
  configuration: DefaultInterfaceConfiguration,
  options: DefaultSurfaceRenderOptions = {},
): Surface => {
  const colors = options.dark ? design.dark : design.light;
  const pages = orderedPages(browser, state);
  const selectedPage = pages.find((page) => page.id === state.selectedPageId);
  const tabs = tabControls(
    pages,
    state.pinnedPageIds,
    selectedPage?.id,
    options,
    colors,
    configuration.tabPlacement,
  );
  const pageList =
    configuration.tabPlacement === "sidebar"
      ? scroll("pages", tabs, {
          flex: 1,
          gap: design.spacing.compact,
          padding: design.spacing.control,
          bg: colors.sidebar,
        })
      : scroll(
          "pages",
          [
            row("top-tab-strip", tabs, {
              gap: design.spacing.compact,
              padding: design.spacing.control,
              bg: colors.sidebar,
            }),
          ],
          { height: 60, bg: colors.sidebar },
        );
  const content = selectedPage
    ? viewport("main-page", mainViewportId, { flex: 1, bg: colors.canvas })
    : column(
        "welcome",
        [
          text("welcome-title", "Welcome to Hitchhiker", { fg: colors.foreground, fontSize: 18 }),
          text("welcome-copy", "Open a page to start browsing.", { fg: colors.muted }),
        ],
        {
          flex: 1,
          padding: design.spacing.section,
          gap: design.spacing.control,
          bg: colors.canvas,
        },
      );
  const controls = toolbar(options.addressDraft ?? selectedPage?.url ?? "", colors);
  const root =
    configuration.tabPlacement === "sidebar"
      ? row(
          "default-surface",
          [
            column(
              "sidebar",
              [
                row(
                  "sidebar-header",
                  [
                    text("brand", "Hitchhiker", { fg: colors.foreground, fontSize: 16 }),
                    spacer("brand-space"),
                  ],
                  { padding: design.spacing.panel, bg: colors.sidebar },
                ),
                pageList,
              ],
              { width: 248, bg: colors.sidebar },
            ),
            column("main", [controls, content], { flex: 1, bg: colors.canvas }),
          ],
          { bg: colors.canvas },
        )
      : column("default-surface", [pageList, controls, content], { flex: 1, bg: colors.canvas });
  return Object.freeze({
    root,
    bindings: selectedPage
      ? Object.freeze([{ viewportId: mainViewportId, pageId: selectedPage.id }])
      : Object.freeze([]),
  });
};
