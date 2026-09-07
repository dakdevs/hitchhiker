import { definePlugin, type PluginApi } from "@hitchhiker/plugin-sdk";
import { column, text, viewport } from "@hitchhiker/ui";

let api: PluginApi;

const refresh = async () => {
  const pages = (await api.pages.list()).filter((candidate) => candidate.lifecycle !== "closed");
  const page = pages[1];
  await api.ui.publishContribution("page", {
    root: column(
      "panel",
      page
        ? [text("label", `Right: ${page.title}`), viewport("page", "view", { flex: 1 })]
        : [text("label", "Right: no second page available")],
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
