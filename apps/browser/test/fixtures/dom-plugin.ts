import { definePlugin, PluginApiError, type Json, type PluginApi } from "@hitchhiker/plugin-sdk";

let api: PluginApi;
let pageId: string;
let fieldRef: string | undefined;
const save = async (value: Json) => {
  const previous = await api.storage.read();
  await api.storage.write(previous.revision, value);
};

definePlugin({
  async activate(browser) {
    api = browser;
    const page = (await api.pages.list())[0];
    if (!page) throw new Error("Fixture page is missing");
    pageId = page.id;
    await api.ui.publish({
      root: {
        kind: "column",
        key: "fixture",
        flex: 1,
        children: [
          { kind: "button", key: "exercise", label: "Exercise DOM", action: "dom.exercise" },
          { kind: "button", key: "stale", label: "Use old reference", action: "dom.stale" },
          { kind: "button", key: "origin", label: "Read moved page", action: "dom.origin" },
          { kind: "viewport", key: "page", viewportId: "page", flex: 1 },
        ],
      },
      bindings: [{ viewportId: "page", pageId }],
    });
  },
  async onEvent(event, payload) {
    if (
      event !== "ui.event" ||
      typeof payload !== "object" ||
      payload === null ||
      !("payload" in payload) ||
      typeof payload.payload !== "object" ||
      payload.payload === null ||
      !("action" in payload.payload)
    )
      return;
    const action = payload.payload.action;
    if (action !== "dom.exercise" && action !== "dom.stale" && action !== "dom.origin") return;
    try {
      if (action === "dom.exercise") {
        const snapshot = await api.dom.snapshot({ pageId, interactiveOnly: true });
        fieldRef = snapshot.nodes.find(
          (node) => node.role === "textbox" && node.name === "Name",
        )?.ref;
        const buttonRef = snapshot.nodes.find(
          (node) => node.role === "button" && node.name === "Submit",
        )?.ref;
        if (!fieldRef || !buttonRef) throw new Error("Expected actionable snapshot references");
        await api.dom.fill({ pageId, ref: fieldRef, value: "Hitchhiker" });
        await api.dom.click({ pageId, ref: buttonRef });
        await save({ phase: "exercised", snapshotId: snapshot.snapshotId });
      } else if (action === "dom.stale") {
        if (!fieldRef) throw new Error("Missing prior reference");
        await api.dom.fill({ pageId, ref: fieldRef, value: "must not appear" });
        await save({ phase: "unexpected-stale-success" });
      } else {
        await api.dom.snapshot({ pageId });
        await save({ phase: "unexpected-origin-success" });
      }
    } catch (error) {
      await save({
        phase: action,
        code: error instanceof PluginApiError ? error.code : "fixture-error",
        detail: error instanceof Error ? error.message : "Unknown fixture failure",
      });
    }
  },
});
