import {
  definePlugin,
  type DevToolsStatus,
  type ObservedPage,
  type PluginApi,
} from "@hitchhiker/plugin-sdk";
import { column, design, iconButton, listItem, row, scroll, text, viewport } from "@hitchhiker/ui";

const pageLimit = 128;
const shortened = (value: string, length = 56) =>
  Array.from(value).slice(0, length).join("") + (Array.from(value).length > length ? "…" : "");

const eventAction = (event: unknown): string | undefined => {
  if (typeof event !== "object" || event === null || !("event" in event) || event.event !== "press")
    return;
  if (!("payload" in event) || typeof event.payload !== "object" || event.payload === null) return;
  return "action" in event.payload && typeof event.payload.action === "string"
    ? event.payload.action
    : undefined;
};

/** Reads one bounded, revision-consistent page snapshot through the public SDK. */
const readPages = async (api: PluginApi): Promise<readonly ObservedPage[]> => {
  const first = await api.pages.watch();
  const pages = [...first.pages];
  let offset = first.nextOffset;
  while (offset !== undefined) {
    if (pages.length >= pageLimit)
      throw new Error("The page list exceeds the DevTools plugin limit.");
    const next = await api.pages.watch({ offset, revision: first.revision });
    if (
      next.revision !== first.revision ||
      (next.nextOffset !== undefined && next.nextOffset <= offset)
    )
      throw new Error("The page list changed while it was loading.");
    pages.push(...next.pages);
    offset = next.nextOffset;
  }
  if (pages.length > pageLimit) throw new Error("The page list exceeds the DevTools plugin limit.");
  return pages.filter((page) => page.lifecycle !== "closed");
};

const statusLabel = (status: DevToolsStatus | undefined) =>
  status === undefined ? "Inspector status is unavailable." : `Inspector ${status.state}.`;

let api: PluginApi | undefined;
let pages: readonly ObservedPage[] = [];
let selectedPageId: string | undefined;
let status: DevToolsStatus | undefined;
let error: string | undefined;
let tail: Promise<unknown> = Promise.resolve();

const selectedPage = () => pages.find((page) => page.id === selectedPageId);

const publish = async () => {
  if (!api) throw new Error("Developer tools have not activated.");
  const selected = selectedPage();
  const colors = design.light;
  await api.ui.publish({
    root: column(
      "devtools-root",
      [
        row(
          "devtools-header",
          [
            text("devtools-title", "Developer tools", { fontSize: 18, fg: colors.foreground }),
            text("devtools-phase", selected === undefined ? "Choose a page" : statusLabel(status), {
              fg: colors.muted,
              flex: 1,
            }),
            iconButton("devtools-refresh", "Refresh status", "devtools.refresh", "rotate-cw", {
              fg: colors.foreground,
            }),
            iconButton("devtools-show", "Inspect selected page", "devtools.show", "search", {
              fg: colors.foreground,
            }),
            iconButton("devtools-close", "Close inspector", "devtools.close", "x", {
              fg: colors.foreground,
            }),
          ],
          { gap: design.spacing.compact, padding: design.spacing.panel },
        ),
        ...(error === undefined
          ? []
          : [text("devtools-error", error, { fg: colors.muted, padding: design.spacing.panel })]),
        row(
          "devtools-workspace",
          [
            scroll(
              "devtools-pages",
              pages.map((page) =>
                listItem(
                  `devtools-page-${page.id}`,
                  shortened(page.title || page.url),
                  `devtools.select:${page.id}`,
                  page.id === selectedPageId ? { bg: colors.selected } : {},
                ),
              ),
              {
                width: 240,
                padding: design.spacing.compact,
                gap: design.spacing.compact,
                bg: colors.sidebar,
              },
            ),
            ...(selected === undefined
              ? [
                  text("devtools-empty", "Choose an open page to inspect it.", {
                    flex: 1,
                    padding: design.spacing.panel,
                    fg: colors.muted,
                  }),
                ]
              : [viewport("devtools-viewport", "devtools-selected-page", { flex: 1 })]),
          ],
          { flex: 1 },
        ),
      ],
      { flex: 1, bg: colors.canvas },
    ),
    bindings:
      selected === undefined ? [] : [{ viewportId: "devtools-selected-page", pageId: selected.id }],
  });
};

const refresh = async (reloadPages: boolean) => {
  if (!api) throw new Error("Developer tools have not activated.");
  try {
    if (reloadPages) {
      pages = await readPages(api);
      if (!pages.some((page) => page.id === selectedPageId)) selectedPageId = pages[0]?.id;
    }
    status = selectedPageId === undefined ? undefined : await api.devtools.status(selectedPageId);
    error = undefined;
  } catch {
    error = "Developer tools could not refresh.";
  }
  await publish();
};

const enqueue = (work: () => Promise<void>) => {
  const result = tail.then(work);
  tail = result.catch(() => undefined);
  return result;
};

const action = async (value: string) => {
  if (!api) throw new Error("Developer tools have not activated.");
  if (value.startsWith("devtools.select:")) {
    const id = value.slice("devtools.select:".length);
    if (!pages.some((page) => page.id === id)) {
      error = "That page is no longer open.";
      await publish();
      return;
    }
    selectedPageId = id;
    await refresh(false);
    return;
  }
  if (value === "devtools.refresh") {
    await refresh(true);
    return;
  }
  const selected = selectedPage();
  if (!selected) {
    error = "Choose an open page first.";
    await publish();
    return;
  }
  try {
    if (value === "devtools.show") status = await api.devtools.show(selected.id);
    else if (value === "devtools.close") status = await api.devtools.close(selected.id);
    else return;
    error = undefined;
  } catch {
    error = "Developer tools action was denied or could not complete.";
  }
  await publish();
};

definePlugin({
  async activate(host) {
    api = host;
    await enqueue(() => refresh(true));
  },
  async onEvent(event, payload) {
    if (event === "ui.event") {
      const value = eventAction(payload);
      if (value !== undefined) await enqueue(() => action(value));
      return;
    }
    if (event === "pages.changed") {
      await enqueue(() => refresh(true));
      return;
    }
    if (event === "devtools.changed") await enqueue(() => refresh(false));
  },
});
