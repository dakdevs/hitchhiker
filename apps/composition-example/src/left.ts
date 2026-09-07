import { definePlugin, type PluginApi } from "@hitchhiker/plugin-sdk";
import { column, text, viewport } from "@hitchhiker/ui";

let api: PluginApi;

const refresh = async () => {
  const page = (await api.pages.list()).find((candidate) => candidate.lifecycle !== "closed");
  await api.ui.publishContribution("page", {
    root: column(
      "panel",
      page
        ? [text("label", `Left: ${page.title}`), viewport("page", "view", { flex: 1 })]
        : [text("label", "Left: no page available")],
      { flex: 1, gap: 8, padding: 8 },
    ),
    bindings: page ? [{ viewportId: "view", pageId: page.id }] : [],
  });
};

definePlugin({
  async activate(host) {
    api = host;
    await refresh();
  },
  async onEvent(event) {
    if (event.startsWith("pages.")) await refresh();
  },
});
