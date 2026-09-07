import { definePlugin, type PluginApi } from "@hitchhiker/plugin-sdk";
import {
  button,
  column,
  dragRegion,
  iconButton,
  row,
  text,
  viewport,
  windowChrome,
  windowControls,
} from "@hitchhiker/ui";

let api: PluginApi;
let selected: string[] = [];
const repaint = async () => {
  const pages = (await api.pages.list()).filter((page) => page.lifecycle !== "closed");
  selected = selected.filter((id) => pages.some((page) => page.id === id)).slice(-2);
  if (selected.length === 0 && pages[0]) selected = [pages[0].id];
  await api.ui.publish({
    root: column(
      "canvas",
      [
        row(
          "tools",
          [
            windowControls("window-controls"),
            text("title", "Your browser, your canvas", { fontSize: 18 }),
            dragRegion("window-drag-region", { height: windowChrome.height }),
            iconButton("new", "New page", "new", "plus", {
              width: 28,
              height: windowChrome.height,
            }),
            button("default", "Default interface", "release", { height: windowChrome.height }),
          ],
          { height: windowChrome.height, gap: 4 },
        ),
        row(
          "pages",
          pages.slice(0, 20).map((page) =>
            button(
              `choose-${page.id}`,
              Array.from(page.title).slice(0, 40).join(""),
              `choose:${page.id}`,
              {
                bg: selected.includes(page.id) ? "#e5e5e5" : "#f8f8f8",
                radius: 10,
                width: 160,
              },
            ),
          ),
          { padding: 12, gap: 8, height: 56 },
        ),
        ...(selected.length
          ? [
              row(
                "workspace",
                selected.map((id) => viewport(`page-${id}`, `view-${id}`, { flex: 1 })),
                { flex: 1, gap: 8 },
              ),
            ]
          : [
              text("empty", "Open a page, then select two cards to compare them.", { padding: 24 }),
            ]),
      ],
      { flex: 1, bg: "#fafafa" },
    ),
    bindings: selected.map((id) => ({ pageId: id, viewportId: `view-${id}` })),
  });
};
definePlugin({
  async activate(host) {
    api = host;
    await repaint();
  },
  async onEvent(event, payload) {
    if (
      event === "ui.event" &&
      typeof payload === "object" &&
      payload !== null &&
      "event" in payload &&
      payload.event === "press" &&
      "payload" in payload &&
      typeof payload.payload === "object" &&
      payload.payload !== null &&
      "action" in payload.payload
    ) {
      const action = payload.payload.action;
      if (action === "release") {
        await api.ui.release();
        return;
      }
      if (action === "new") {
        await api.pages.open("https://example.com");
        return;
      }
      if (typeof action === "string" && action.startsWith("choose:")) {
        const id = action.slice(7);
        selected = selected.includes(id)
          ? selected.filter((entry) => entry !== id)
          : [...selected, id].slice(-2);
        await repaint();
      }
    } else if (["pages.created", "pages.closed", "pages.titleChanged"].includes(event))
      await repaint();
  },
});
