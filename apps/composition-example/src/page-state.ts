import { definePlugin, PluginApiError, type PluginApi } from "@hitchhiker/plugin-sdk";

let api: PluginApi;
let storageRevision = 0;
let activations = 0;
let observedRevision = -1;
let pageId: string;

definePlugin({
  async activate(host) {
    api = host;
    const stored = await api.storage.read();
    storageRevision = stored.revision;
    if (
      stored.value &&
      typeof stored.value === "object" &&
      !Array.isArray(stored.value) &&
      "activations" in stored.value &&
      typeof stored.value.activations === "number"
    )
      activations = stored.value.activations;
    activations += 1;
    const initial = await api.pages.watch();
    observedRevision = initial.revision;
    pageId = initial.pages[0]?.id ?? (await api.pages.open("https://example.com/")).pageId;
    await api.pages.reload(pageId);
    const written = await api.storage.write(storageRevision, {
      activations,
      pageId,
      observedRevision,
    });
    try {
      await api.storage.write(storageRevision, null);
      throw new Error("Stale storage revision was accepted");
    } catch (error) {
      if (!(error instanceof PluginApiError) || error.code !== "conflict") throw error;
    }
    storageRevision = written.revision;
  },
  async onPagesChanged(revision) {
    if (revision <= observedRevision) return;
    const snapshot = await api.pages.watch();
    observedRevision = snapshot.revision;
    const page = snapshot.pages.find((entry) => entry.id === pageId);
    const written = await api.storage.write(storageRevision, {
      activations,
      pageId,
      observedRevision,
      observedUrl: page?.url ?? null,
    });
    storageRevision = written.revision;
  },
});
