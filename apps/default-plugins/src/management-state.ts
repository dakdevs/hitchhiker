import type { PluginManagementSnapshot } from "@hitchhiker/plugin-sdk";

/** A default-only convenience; custom browser models need not expose either presenter. */
export const presenterReplacement = (snapshot: PluginManagementSnapshot | undefined) => {
  const plugins = snapshot?.plugins ?? [];
  for (const [sourceId, targetId, label] of [
    ["default-sidebar-tabs", "default-top-tabs", "Use top tabs"],
    ["default-top-tabs", "default-sidebar-tabs", "Use sidebar tabs"],
  ] as const) {
    const source = plugins.find((plugin) => plugin.id === sourceId);
    const target = plugins.find((plugin) => plugin.id === targetId);
    if (
      source?.enabled &&
      source.running &&
      !source.removing &&
      target &&
      !target.enabled &&
      !target.removing
    )
      return { sourceId, targetId, label };
  }
};
