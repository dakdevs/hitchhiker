import { definePlugin, type Json } from "@hitchhiker/plugin-sdk";

definePlugin({
  async activate(api) {
    const before = await api.extensions.list();
    const target = before.extensions.find((entry) => entry.name === "Plugin extension fixture");
    if (!target) throw new Error("Fixture extension is unavailable");
    const after = await api.extensions.remove(target.installationId);
    const current = await api.storage.read();
    await api.storage.write(current.revision, {
      phase: "removed",
      target: target.installationId,
      before: before.extensions.length,
      after: after.extensions.length,
    } satisfies Json);
  },
});
