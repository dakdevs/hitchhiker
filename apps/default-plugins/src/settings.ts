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
const palette = (configuration: BrowserConfiguration) =>
  configuration.colorScheme === "dark" ? design.dark : design.light;
const fallbackConfiguration: BrowserConfiguration = {
  colorScheme: "system",
  sleepAfterMs: 300_000,
  alwaysAwakeOrigins: [],
};

/** Independent settings route; all configuration and lifecycle work uses the public plugin API. */
export const createSettingsPlugin = (): Plugin => {
  let api: PluginApi | undefined;
  let configuration: BrowserConfiguration | undefined;
  let plugins: PluginManagementSnapshot | undefined;
  let error: string | undefined;
  let refreshQueued = false;
  const run = serial();

  const publish = async (): Promise<void> => {
    if (!api) throw new Error("Settings plugin has not activated");
    const current = configuration ?? fallbackConfiguration;
    const colors = palette(current);
    const replacement = presenterReplacement(plugins);
    const option = (key: string, label: string, action: string, selected: boolean) =>
      button(key, label, action, {
        variant: "secondary",
        fg: colors.foreground,
        bg: selected ? colors.selected : colors.sidebar,
        ...(selected ? { icon: lucide("check") } : {}),
        accessibilityLabel: selected ? `${label}, selected` : label,
      });
    const surface: Omit<Surface, "identity"> = {
      root: scroll(
        "settings-main",
        [
          column(
            "settings-header",
            [
              iconButton("settings-back", "Back", "settings.back", "arrow-left", {
                fg: colors.muted,
              }),
              text("settings-title", "Settings", { fg: colors.foreground, fontSize: 18 }),
            ],
            { gap: design.spacing.compact, padding: design.spacing.panel },
          ),
          text("settings-color-label", "Color scheme", { fg: colors.foreground }),
          column(
            "settings-color-options",
            [
              option(
                "settings-color-light",
                "Light",
                "settings.color:light",
                current.colorScheme === "light",
              ),
              option(
                "settings-color-dark",
                "Dark",
                "settings.color:dark",
                current.colorScheme === "dark",
              ),
              option(
                "settings-color-system",
                "System",
                "settings.color:system",
                current.colorScheme === "system",
              ),
            ],
            { gap: design.spacing.compact },
          ),
          text("settings-sleep-label", "Sleep inactive pages after", { fg: colors.foreground }),
          column(
            "settings-sleep-options",
            [
              option(
                "settings-sleep-1m",
                "1 minute",
                "settings.sleep:60000",
                current.sleepAfterMs === 60_000,
              ),
              option(
                "settings-sleep-5m",
                "5 minutes",
                "settings.sleep:300000",
                current.sleepAfterMs === 300_000,
              ),
              option(
                "settings-sleep-15m",
                "15 minutes",
                "settings.sleep:900000",
                current.sleepAfterMs === 900_000,
              ),
            ],
            { gap: design.spacing.compact },
          ),
          ...(replacement === undefined
            ? []
            : [
                button(
                  "settings-switch-presenter",
                  replacement.label,
                  "settings.switch-presenter",
                  {
                    variant: "secondary",
                    fg: colors.foreground,
                  },
                ),
              ]),
          ...(error === undefined ? [] : [text("settings-error", error, { fg: colors.muted })]),
        ],
        { flex: 1, padding: design.spacing.panel, gap: design.spacing.panel, bg: colors.canvas },
      ),
      bindings: [],
    };
    await api.ui.publishContribution(main, surface);
    await api.ui.publishContribution(launcher, {
      root: iconButton("settings-launcher", "Settings", "settings.open", "settings", {
        fg: colors.foreground,
      }),
      bindings: [],
    });
  };

  const refresh = async (preserveError = false): Promise<void> => {
    if (!api) throw new Error("Settings plugin has not activated");
    try {
      configuration = await api.configuration.get();
      const nextPlugins = await api.plugins.snapshot();
      plugins = { ...nextPlugins, plugins: nextPlugins.plugins.slice(0, maxPlugins) };
      if (!preserveError) error = undefined;
    } catch {
      plugins = undefined;
      error = preserveError
        ? (error ?? "Settings could not refresh.")
        : "Settings could not refresh.";
    }
    await publish();
  };

  const updateConfiguration = async (
    update: (current: BrowserConfiguration) => BrowserConfiguration,
  ): Promise<void> => {
    if (!api) throw new Error("Settings plugin has not activated");
    try {
      const current = await api.configuration.get();
      await api.configuration.set(update(current));
      error = undefined;
    } catch {
      error = "That setting could not be saved.";
      await publish();
      return;
    }
    await refresh();
  };

  const action = async (value: string): Promise<void> => {
    if (!api) throw new Error("Settings plugin has not activated");
    if (value === "settings.open") {
      await api.ui.showRoute(main);
      return;
    }
    if (value === "settings.back") {
      await api.ui.hideRoute(main);
      return;
    }
    if (value.startsWith("settings.color:")) {
      const colorScheme = value.slice("settings.color:".length);
      if (colorScheme === "light" || colorScheme === "dark" || colorScheme === "system")
        return updateConfiguration((current) => ({ ...current, colorScheme }));
      return;
    }
    if (value.startsWith("settings.sleep:")) {
      const sleepAfterMs = Number(value.slice("settings.sleep:".length));
      if ([60_000, 300_000, 900_000].includes(sleepAfterMs))
        return updateConfiguration((current) => ({ ...current, sleepAfterMs }));
      return;
    }
    if (value !== "settings.switch-presenter") return;
    const replacement = presenterReplacement(plugins);
    if (replacement === undefined || plugins === undefined) {
      error = "No default presenter is active.";
      await publish();
      return;
    }
    try {
      await api.plugins.replace(replacement.sourceId, replacement.targetId, plugins.revision);
      error = undefined;
    } catch {
      error = "The presenter could not be switched.";
      await publish();
      return;
    }
    await refresh();
    // Replacing the fallback presenter resets route selection in the host.
    await api.ui.showRoute(main);
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
