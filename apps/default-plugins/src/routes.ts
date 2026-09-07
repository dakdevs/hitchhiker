import type { BrowserConfiguration } from "@hitchhiker/core";
import type { TabPlacement } from "@hitchhiker/default-interface";
import type { PluginManagementSnapshot } from "@hitchhiker/plugin-sdk";
import { button, column, design, lucide, scroll, text, type Surface } from "@hitchhiker/ui";

export type PresenterRoute = "browser" | "settings" | "plugins";

const palette = (configuration: BrowserConfiguration) =>
  configuration.colorScheme === "dark" ? design.dark : design.light;
const routeHeader = (title: string, colors: ReturnType<typeof palette>) =>
  column(
    "management-header",
    [
      button("management-back", "Back", "management.back", {
        variant: "ghost",
        icon: lucide("arrow-left"),
        fg: colors.foreground,
      }),
      text("management-title", title, { fontSize: 18, fg: colors.foreground }),
    ],
    { gap: design.spacing.compact, padding: design.spacing.panel },
  );
const sleepLabel = (milliseconds: number) => {
  if (milliseconds === 60_000) return "1 minute";
  if (milliseconds === 300_000) return "5 minutes";
  if (milliseconds === 900_000) return "15 minutes";
  return "Custom";
};
const option = (
  key: string,
  label: string,
  action: string,
  current: boolean,
  colors: ReturnType<typeof palette>,
) =>
  button(key, label, action, {
    variant: "secondary",
    fg: colors.foreground,
    bg: current ? colors.selected : colors.sidebar,
    ...(current ? { icon: lucide("check") } : {}),
    accessibilityLabel: current ? `${label}, selected` : label,
  });

export const settingsSurface = (
  configuration: BrowserConfiguration,
  presentation: TabPlacement,
  error: string | undefined,
): Omit<Surface, "identity"> => {
  const colors = palette(configuration);
  return {
    root: scroll(
      "settings-route",
      [
        routeHeader("Settings", colors),
        text("settings-color-label", "Color scheme", { fg: colors.foreground }),
        column(
          "settings-color-controls",
          [
            option(
              "settings-color-light",
              "Light",
              "settings.color:light",
              configuration.colorScheme === "light",
              colors,
            ),
            option(
              "settings-color-dark",
              "Dark",
              "settings.color:dark",
              configuration.colorScheme === "dark",
              colors,
            ),
            option(
              "settings-color-system",
              "System",
              "settings.color:system",
              configuration.colorScheme === "system",
              colors,
            ),
          ],
          { gap: design.spacing.compact },
        ),
        text("settings-sleep-label", "Sleep inactive pages after", { fg: colors.foreground }),
        column(
          "settings-sleep-controls",
          [
            option(
              "settings-sleep-1m",
              "1 minute",
              "settings.sleep:60000",
              configuration.sleepAfterMs === 60_000,
              colors,
            ),
            option(
              "settings-sleep-5m",
              "5 minutes",
              "settings.sleep:300000",
              configuration.sleepAfterMs === 300_000,
              colors,
            ),
            option(
              "settings-sleep-15m",
              "15 minutes",
              "settings.sleep:900000",
              configuration.sleepAfterMs === 900_000,
              colors,
            ),
          ],
          { gap: design.spacing.compact },
        ),
        text("settings-current", `Current: ${sleepLabel(configuration.sleepAfterMs)}`, {
          fg: colors.muted,
        }),
        button(
          "settings-switch-presenter",
          presentation === "sidebar" ? "Use top tabs" : "Use sidebar tabs",
          "settings.replace-self",
          { variant: "secondary", fg: colors.foreground },
        ),
        ...(error === undefined ? [] : [text("management-error", error, { fg: colors.muted })]),
      ],
      { flex: 1, padding: design.spacing.panel, gap: design.spacing.panel, bg: colors.canvas },
    ),
    bindings: [],
  };
};

const pluginStatus = (plugin: PluginManagementSnapshot["plugins"][number]) => {
  if (plugin.removing) return "Removing";
  if (!plugin.enabled) return "Disabled";
  if (plugin.running) return "Running";
  return plugin.lastFailure === undefined ? "Starting" : "Suspended";
};

export const pluginsSurface = (
  snapshot: PluginManagementSnapshot | undefined,
  configuration: BrowserConfiguration,
  presentation: TabPlacement,
  error: string | undefined,
): Omit<Surface, "identity"> => {
  const entries = snapshot?.plugins ?? [];
  const colors = palette(configuration);
  return {
    root: scroll(
      "plugins-route",
      [
        routeHeader("Plugins", colors),
        button("plugins-refresh", "Refresh", "plugins.refresh", {
          variant: "secondary",
          fg: colors.foreground,
        }),
        button(
          "plugins-switch-presenter",
          presentation === "sidebar" ? "Use top tabs" : "Use sidebar tabs",
          "plugins.replace-self",
          { variant: "secondary", fg: colors.foreground },
        ),
        ...entries.flatMap((plugin) => [
          text(`plugin-${plugin.id}`, `${plugin.name} ${plugin.version}`, {
            fg: colors.foreground,
          }),
          text(`plugin-${plugin.id}-status`, pluginStatus(plugin), { fg: colors.muted }),
          ...(plugin.enabled
            ? [
                button(`plugin-${plugin.id}-disable`, "Disable", `plugins.disable:${plugin.id}`, {
                  variant: "secondary",
                  fg: colors.foreground,
                }),
              ]
            : [
                button(`plugin-${plugin.id}-enable`, "Enable", `plugins.enable:${plugin.id}`, {
                  variant: "secondary",
                  fg: colors.foreground,
                }),
              ]),
          ...(plugin.previousVersion === undefined
            ? []
            : [
                button(
                  `plugin-${plugin.id}-rollback`,
                  "Rollback",
                  `plugins.rollback:${plugin.id}`,
                  { variant: "secondary", fg: colors.foreground },
                ),
              ]),
          button(`plugin-${plugin.id}-uninstall`, "Remove", `plugins.uninstall:${plugin.id}`, {
            variant: "secondary",
            fg: colors.foreground,
          }),
          ...(plugin.lastFailure === undefined
            ? []
            : [text(`plugin-${plugin.id}-failure`, plugin.lastFailure, { fg: colors.muted })]),
        ]),
        ...(entries.length === 0
          ? [
              text(
                "plugins-empty",
                error === undefined
                  ? "No installed plugins."
                  : "Plugin information is unavailable.",
                { fg: colors.muted },
              ),
            ]
          : []),
        ...(error === undefined ? [] : [text("management-error", error, { fg: colors.muted })]),
      ],
      { flex: 1, padding: design.spacing.panel, gap: design.spacing.compact, bg: colors.canvas },
    ),
    bindings: [],
  };
};
