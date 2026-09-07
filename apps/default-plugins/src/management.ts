import type { BrowserConfiguration } from "@hitchhiker/core";
import type { Plugin, PluginApi, PluginManagementSnapshot } from "@hitchhiker/plugin-sdk";
import {
  button,
  column,
  design,
  iconButton,
  lucide,
  scroll,
  text,
  type Surface,
} from "@hitchhiker/ui";

import { decode } from "./contracts.ts";
import { Press, UiEvent } from "./input-contracts.ts";
import { serial } from "./state-io.ts";
import { presenterReplacement } from "./management-state.ts";

const main = "main";
const launcher = "launcher";
const maxPlugins = 16;
const actionFrom = (payload: unknown): string | undefined => {
  const event = decode(UiEvent, payload);
  if (event.event !== "press") return;
  return decode(Press, event.payload).action;
};
const fallbackConfiguration: BrowserConfiguration = {
  colorScheme: "system",
  sleepAfterMs: 300_000,
  alwaysAwakeOrigins: [],
};
const status = (plugin: PluginManagementSnapshot["plugins"][number]) => {
  if (plugin.removing) return "Removing";
  if (!plugin.enabled) return "Disabled";
  if (plugin.running) return "Running";
  return plugin.lastFailure === undefined ? "Starting" : "Suspended";
};

/** Independent plugin lifecycle route with bounded public inventory and owner-scoped navigation. */
export const createPluginManagementPlugin = (): Plugin => {
  let api: PluginApi | undefined;
  let snapshot: PluginManagementSnapshot | undefined;
  let configuration: BrowserConfiguration | undefined;
  let error: string | undefined;
  let refreshQueued = false;
  const run = serial();

  const publish = async (): Promise<void> => {
    if (!api) throw new Error("Plugin management has not activated");
    const colors =
      (configuration ?? fallbackConfiguration).colorScheme === "dark" ? design.dark : design.light;
    const replacement = presenterReplacement(snapshot);
    const entries = (snapshot?.plugins ?? []).slice(0, maxPlugins);
    const surface: Omit<Surface, "identity"> = {
      root: scroll(
        "plugin-management-main",
        [
          column(
            "plugin-management-header",
            [
              iconButton("plugin-management-back", "Back", "plugin-management.back", "arrow-left", {
                fg: colors.muted,
              }),
              text("plugin-management-title", "Plugins", { fg: colors.foreground, fontSize: 18 }),
            ],
            { gap: design.spacing.compact, padding: design.spacing.panel },
          ),
          button("plugin-management-refresh", "Refresh", "plugin-management.refresh", {
            variant: "secondary",
            fg: colors.foreground,
          }),
          ...(replacement === undefined
            ? []
            : [
                button(
                  "plugin-management-switch-presenter",
                  replacement.label,
                  "plugin-management.switch-presenter",
                  {
                    variant: "secondary",
                    fg: colors.foreground,
                  },
                ),
              ]),
          ...entries.flatMap((plugin) => [
            text(`plugin-management-${plugin.id}`, `${plugin.name} ${plugin.version}`, {
              fg: colors.foreground,
            }),
            text(`plugin-management-${plugin.id}-status`, status(plugin), { fg: colors.muted }),
            button(
              `plugin-management-${plugin.id}-${plugin.enabled ? "disable" : "enable"}`,
              plugin.enabled ? "Disable" : "Enable",
              `plugin-management.${plugin.enabled ? "disable" : "enable"}:${plugin.id}`,
              {
                variant: "secondary",
                fg: colors.foreground,
                accessibilityLabel: `${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`,
              },
            ),
            ...(plugin.previousVersion === undefined
              ? []
              : [
                  button(
                    `plugin-management-${plugin.id}-rollback`,
                    "Rollback",
                    `plugin-management.rollback:${plugin.id}`,
                    { variant: "secondary", fg: colors.foreground },
                  ),
                ]),
            button(
              `plugin-management-${plugin.id}-uninstall`,
              "Remove",
              `plugin-management.uninstall:${plugin.id}`,
              {
                variant: "secondary",
                fg: colors.foreground,
                icon: lucide("x"),
                accessibilityLabel: `Remove ${plugin.name}`,
              },
            ),
          ]),
          ...(entries.length === 0
            ? [text("plugin-management-empty", "No installed plugins.", { fg: colors.muted })]
            : []),
          ...(error === undefined
            ? []
            : [text("plugin-management-error", error, { fg: colors.muted })]),
        ],
        { flex: 1, padding: design.spacing.panel, gap: design.spacing.compact, bg: colors.canvas },
      ),
      bindings: [],
    };
    await api.ui.publishContribution(main, surface);
    await api.ui.publishContribution(launcher, {
      root: iconButton(
        "plugin-management-launcher",
        "Plugins",
        "plugin-management.open",
        "puzzle",
        {
          fg: colors.foreground,
        },
      ),
      bindings: [],
    });
  };

  const refresh = async (preserveError = false): Promise<void> => {
    if (!api) throw new Error("Plugin management has not activated");
    try {
      configuration = await api.configuration.get();
      const nextSnapshot = await api.plugins.snapshot();
      snapshot = { ...nextSnapshot, plugins: nextSnapshot.plugins.slice(0, maxPlugins) };
      if (!preserveError) error = undefined;
    } catch {
      error = preserveError
        ? (error ?? "Plugins could not refresh.")
        : "Plugins could not refresh.";
    }
    await publish();
  };

  const mutate = async (
    operation: () => Promise<PluginManagementSnapshot>,
    restoreRoute = false,
  ): Promise<void> => {
    try {
      await operation();
      error = undefined;
    } catch {
      error = "That plugin action could not complete.";
      await publish();
      return;
    }
    await refresh();
    if (restoreRoute) await api!.ui.showRoute(main);
  };

  const action = async (value: string): Promise<void> => {
    if (!api) throw new Error("Plugin management has not activated");
    if (value === "plugin-management.open") {
      await api.ui.showRoute(main);
      return;
    }
    if (value === "plugin-management.back") {
      await api.ui.hideRoute(main);
      return;
    }
    if (value === "plugin-management.refresh") return refresh();
    if (value === "plugin-management.switch-presenter") {
      const replacement = presenterReplacement(snapshot);
      if (replacement === undefined || snapshot === undefined) {
        error = "No default presenter is active.";
        return publish();
      }
      return mutate(
        () => api!.plugins.replace(replacement.sourceId, replacement.targetId, snapshot!.revision),
        true,
      );
    }
    const match =
      /^plugin-management\.(enable|disable|rollback|uninstall):([a-z][a-z0-9-]{1,62})$/.exec(value);
    if (!match) return;
    const [, operation, id] = match;
    if (operation === "enable") return mutate(() => api!.plugins.enable(id));
    if (operation === "disable") return mutate(() => api!.plugins.disable(id));
    if (operation === "rollback") return mutate(() => api!.plugins.rollback(id));
    return mutate(() => api!.plugins.uninstall(id));
  };

  const invalidate = (): Promise<void> | undefined => {
    if (refreshQueued) return;
    refreshQueued = true;
    return run(async () => {
      refreshQueued = false;
      await refresh(true);
    });
  };

  return {
    async activate(host) {
      api = host;
      await run(refresh);
    },
    onEvent(event, payload) {
      if (event === "configuration.changed" || event === "plugins.changed") return invalidate();
      if (event !== "ui.event") return;
      try {
        const value = actionFrom(payload);
        return value === undefined
          ? undefined
          : run(() => action(value)).catch(async () => {
              error = "That action could not complete.";
              await publish();
            });
      } catch {
        // The host validates UI event envelopes before delivery.
      }
    },
  };
};
