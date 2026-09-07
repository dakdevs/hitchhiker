import { definePlugin } from "@hitchhiker/plugin-sdk";
import { column, dragRegion, row, text, windowChrome, windowControls } from "@hitchhiker/ui";

definePlugin({
  async activate(api) {
    await api.ui.publishLayout({
      root: column(
        "layout",
        [
          row(
            "header",
            [
              windowControls("window-controls"),
              text("title", "Split workspace", { fontSize: 18 }),
              dragRegion("window-drag", { height: windowChrome.height }),
            ],
            { height: windowChrome.height, gap: 8, padding: 4 },
          ),
          row("content", [], { flex: 1, gap: 8, padding: 8 }),
        ],
        { flex: 1 },
      ),
      bindings: [],
    });
  },
});
