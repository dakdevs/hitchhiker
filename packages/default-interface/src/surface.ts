import type { BrowserPage, BrowserState } from "@hitchhiker/core";
import {
  button,
  column,
  design,
  dragRegion,
  iconButton,
  input,
  listItem,
  row,
  scroll,
  text,
  viewport,
  windowChrome,
  windowControls,
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
  | "interface.tabs.toggle"
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
  toggleTabs: "interface.tabs.toggle" as const,
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
  /** Whether page tabs are currently rendered; the host owns this transient presentation state. */
  readonly tabsVisible?: boolean;
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

const pageLabel = (page: BrowserPage): string =>
  Array.from(page.title || page.url)
    .slice(0, 100)
    .join("");

const pageIcon = (page: BrowserPage) =>
  page.lifecycle === "sleeping" ? "app:lucide-moon" : "app:lucide-globe";

const siteInitials = (url: string): string => {
  // Pages arrive with host-normalized HTTP(S) URLs. The isolated UI worker has no URL global.
  const hostname = /^https?:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/:?#]+)/i
    .exec(url)?.[1]
    ?.replace(/^www\./i, "");
  const characters = Array.from((hostname ?? "").replace(/[^\p{L}\p{N}]/gu, ""));
  return characters[0]?.toLocaleUpperCase() || "?";
};

const pageSlice = (
  pages: readonly BrowserPage[],
  selectedPageId: string | undefined,
  options: DefaultSurfaceRenderOptions,
) => {
  const offset = safeOffset(
    options.pageOffset,
    pages.length,
    pages.findIndex((page) => page.id === selectedPageId),
  );
  return { offset, visible: pages.slice(offset, offset + pageSliceSize) };
};

const topTabControls = (
  pages: readonly BrowserPage[],
  pinnedPageIds: readonly string[],
  selectedPageId: string | undefined,
  options: DefaultSurfaceRenderOptions,
  colors: Palette,
  placement: DefaultInterfaceConfiguration["tabPlacement"],
): readonly NativeNode[] => {
  const { offset, visible } = pageSlice(pages, selectedPageId, options);
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
            pageLabel(page),
            defaultSurfaceActions.selectPage(page.id),
            {
              flex: 1,
              fg: selected ? colors.foreground : colors.muted,
              bg: selected ? colors.selected : undefined,
              radius: design.radius.control,
              icon: pageIcon(page),
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

const sidebarTabControls = (
  pages: readonly BrowserPage[],
  pinnedPageIds: readonly string[],
  selectedPageId: string | undefined,
  options: DefaultSurfaceRenderOptions,
  colors: Palette,
): readonly NativeNode[] => {
  const { offset, visible } = pageSlice(pages, selectedPageId, options);
  const pinned = new Set(pinnedPageIds);
  const pinnedPages = visible.filter((page) => pinned.has(page.id));
  const regularPages = visible.filter((page) => !pinned.has(page.id));
  const controls: NativeNode[] = [];
  if (offset > 0)
    controls.push(
      iconButton(
        "pages-slice-previous",
        "Previous pages",
        defaultSurfaceActions.previousSlice,
        "chevron-down",
        { ...compactControlStyle(colors), width: 32 },
      ),
    );
  if (pinnedPages.length > 0) {
    const rows: NativeNode[] = [];
    for (let index = 0; index < pinnedPages.length; index += 6) {
      rows.push(
        row(
          `pinned-page-row-${index / 6}`,
          pinnedPages.slice(index, index + 6).map((page) => {
            const selected = page.id === selectedPageId;
            return button(
              `page-select-${page.id}`,
              siteInitials(page.url),
              defaultSurfaceActions.selectPage(page.id),
              {
                width: 40,
                height: 38,
                padding: 4,
                bg: selected ? colors.selected : undefined,
                fg: selected ? colors.foreground : colors.muted,
                radius: design.radius.panel,
                accessibilityLabel: pageLabel(page),
                variant: "secondary",
              },
            );
          }),
          { gap: design.spacing.compact },
        ),
      );
    }
    controls.push(column("pinned-pages", rows, { gap: design.spacing.compact }));
    const selectedPinned = pinnedPages.find((page) => page.id === selectedPageId);
    if (selectedPinned)
      controls.push(
        row(
          `pinned-page-detail-${selectedPinned.id}`,
          [
            listItem(
              `page-select-${selectedPinned.id}-detail`,
              pageLabel(selectedPinned),
              defaultSurfaceActions.selectPage(selectedPinned.id),
              {
                flex: 1,
                height: 32,
                icon: pageIcon(selectedPinned),
                bg: colors.selected,
                fg: colors.foreground,
                radius: design.radius.control,
              },
            ),
            iconButton(
              `page-pin-${selectedPinned.id}`,
              "Unpin",
              defaultSurfaceActions.unpinPage(selectedPinned.id),
              "pin",
              compactControlStyle(colors),
            ),
            iconButton(
              `page-close-${selectedPinned.id}`,
              "Close",
              defaultSurfaceActions.closePage(selectedPinned.id),
              "x",
              compactControlStyle(colors),
            ),
          ],
          {
            height: 32,
            gap: design.spacing.compact,
            bg: colors.selected,
            radius: design.radius.control,
          },
        ),
      );
  }
  for (const page of regularPages) {
    const selected = page.id === selectedPageId;
    controls.push(
      row(
        `page-${page.id}`,
        [
          listItem(
            `page-select-${page.id}`,
            pageLabel(page),
            defaultSurfaceActions.selectPage(page.id),
            {
              flex: 1,
              height: 32,
              icon: pageIcon(page),
              bg: selected ? colors.selected : undefined,
              fg: selected ? colors.foreground : colors.muted,
              radius: design.radius.control,
            },
          ),
          ...(selected
            ? [
                iconButton(
                  `page-pin-${page.id}`,
                  "Pin",
                  defaultSurfaceActions.pinPage(page.id),
                  "pin",
                  compactControlStyle(colors),
                ),
                iconButton(
                  `page-close-${page.id}`,
                  "Close",
                  defaultSurfaceActions.closePage(page.id),
                  "x",
                  compactControlStyle(colors),
                ),
              ]
            : []),
        ],
        {
          height: 32,
          gap: design.spacing.compact,
          bg: selected ? colors.selected : undefined,
          radius: design.radius.control,
        },
      ),
    );
  }
  if (offset + pageSliceSize < pages.length)
    controls.push(
      iconButton(
        "pages-slice-next",
        "Next pages",
        defaultSurfaceActions.nextSlice,
        "chevron-down",
        { ...compactControlStyle(colors), width: 32 },
      ),
    );
  controls.push(
    listItem("sidebar-new-page", "New Tab", defaultSurfaceActions.newPage, {
      height: 32,
      icon: "app:lucide-plus",
      fg: colors.muted,
      radius: design.radius.control,
    }),
  );
  return controls;
};

const compactControlStyle = (colors: Palette, height = 28) => ({
  width: 28,
  height,
  fg: colors.muted,
  radius: design.radius.control,
});

const compactHeaderControls = (
  colors: Palette,
  includeFlexibleDragRegion: boolean,
): readonly NativeNode[] => [
  windowControls("window-controls"),
  iconButton(
    "sidebar-toggle",
    "Toggle tabs",
    defaultSurfaceActions.toggleTabs,
    "panel-left",
    compactControlStyle(colors, windowChrome.height),
  ),
  iconButton(
    "back",
    "Back",
    defaultSurfaceActions.back,
    "arrow-left",
    compactControlStyle(colors, windowChrome.height),
  ),
  iconButton(
    "forward",
    "Forward",
    defaultSurfaceActions.forward,
    "arrow-right",
    compactControlStyle(colors, windowChrome.height),
  ),
  dragRegion("window-drag-region", {
    height: windowChrome.height,
    ...(includeFlexibleDragRegion ? {} : { width: 44, flex: 0 }),
  }),
];

const toolbar = (address: string, colors: Palette, fillWidth = false): NativeNode =>
  row(
    "toolbar",
    [
      iconButton(
        "reload",
        "Reload",
        defaultSurfaceActions.reload,
        "rotate-cw",
        compactControlStyle(colors),
      ),
      input("address", "Address", address, {
        flex: 1,
        height: 28,
        action: defaultSurfaceActions.navigate,
        placeholder: "Search or enter an address",
        bg: colors.sidebar,
        fg: colors.foreground,
        radius: design.radius.control,
      }),
      iconButton("navigate", "Navigate", defaultSurfaceActions.navigate, "search", {
        ...compactControlStyle(colors),
        fg: colors.foreground,
      }),
      iconButton("new-page", "New page", defaultSurfaceActions.newPage, "plus", {
        ...compactControlStyle(colors),
        fg: colors.foreground,
      }),
      iconButton(
        "plugins",
        "Plugins",
        defaultSurfaceActions.plugins,
        "puzzle",
        compactControlStyle(colors),
      ),
      iconButton(
        "settings",
        "Settings",
        defaultSurfaceActions.settings,
        "settings",
        compactControlStyle(colors),
      ),
    ],
    {
      ...(fillWidth ? { flex: 1 } : {}),
      height: windowChrome.height,
      padding: design.spacing.compact,
      gap: design.spacing.compact,
      bg: colors.canvas,
    },
  );

/** Renders the complete Native shell for one interface instance without changing browser state. */
export const renderDefaultSurface = (
  browser: BrowserState,
  state: DefaultInterfaceState,
  configuration: DefaultInterfaceConfiguration,
  options: DefaultSurfaceRenderOptions = {},
): Surface => {
  const colors = options.dark ? design.dark : design.light;
  const tabsVisible = options.tabsVisible ?? true;
  const pages = orderedPages(browser, state);
  const selectedPage = pages.find((page) => page.id === state.selectedPageId);
  const tabs = tabsVisible
    ? configuration.tabPlacement === "sidebar"
      ? sidebarTabControls(pages, state.pinnedPageIds, selectedPage?.id, options, colors)
      : topTabControls(
          pages,
          state.pinnedPageIds,
          selectedPage?.id,
          options,
          colors,
          configuration.tabPlacement,
        )
    : [];
  const pageList =
    configuration.tabPlacement === "sidebar"
      ? scroll("pages", [column("sidebar-page-list", tabs, { gap: design.spacing.compact })], {
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
    configuration.tabPlacement === "sidebar" && tabsVisible
      ? row(
          "default-surface",
          [
            column(
              "sidebar",
              [
                row("sidebar-header", compactHeaderControls(colors, true), {
                  height: windowChrome.height,
                  gap: design.spacing.compact,
                  bg: colors.sidebar,
                }),
                pageList,
              ],
              { width: 280, bg: colors.sidebar },
            ),
            column("main", [controls, content], { flex: 1, bg: colors.canvas }),
          ],
          { bg: colors.canvas },
        )
      : column(
          "default-surface",
          [
            row(
              "window-header",
              [
                ...compactHeaderControls(colors, false),
                toolbar(options.addressDraft ?? selectedPage?.url ?? "", colors, true),
              ],
              {
                height: windowChrome.height,
                gap: design.spacing.compact,
                bg: colors.canvas,
              },
            ),
            ...(tabsVisible && configuration.tabPlacement === "top" ? [pageList] : []),
            content,
          ],
          { flex: 1, bg: colors.canvas },
        );
  return Object.freeze({
    root,
    bindings: selectedPage
      ? Object.freeze([{ viewportId: mainViewportId, pageId: selectedPage.id }])
      : Object.freeze([]),
  });
};
