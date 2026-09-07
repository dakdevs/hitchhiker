import type { Json, Plugin, PluginApi } from "@hitchhiker/plugin-sdk";
import { column, design, row } from "@hitchhiker/ui";

import { LayoutState, SetPresentation, decode } from "./contracts.ts";
import { serial } from "./state-io.ts";

const renderLayout = (presentation: LayoutState["presentation"], dark: boolean) => {
  const colors = dark ? design.dark : design.light;
  return {
    root:
      presentation === "sidebar"
        ? row(
            "browser-layout",
            [
              column("tabs", [], { width: 280, bg: colors.sidebar }),
              column("browser-main", [column("toolbar", []), column("content", [], { flex: 1 })], {
                flex: 1,
                bg: colors.canvas,
              }),
            ],
            { bg: colors.canvas },
          )
        : column(
            "browser-layout",
            [column("toolbar", []), column("tabs", []), column("content", [], { flex: 1 })],
            { flex: 1, bg: colors.canvas },
          ),
    bindings: [],
  };
};

/** The replaceable shell owns geometry only; feature state remains in other plugins. */
export const createLayoutPlugin = (): Plugin => {
  let api: PluginApi | undefined;
  let state: LayoutState = { version: 1, presentation: "sidebar" };
  let published = false;
  const run = serial();

  const publish = async (presentation: LayoutState["presentation"]): Promise<LayoutState> => {
    if (!api) throw new Error("Layout plugin has not activated");
    if (published && state.presentation === presentation) return state;
    const next: LayoutState = { version: 1, presentation };
    const configuration = await api.configuration.get();
    await api.ui.publishLayout(renderLayout(presentation, configuration.colorScheme === "dark"));
    await api.services.publish("layout", next as Json);
    state = next;
    published = true;
    return state;
  };

  return {
    async activate(host) {
      api = host;
      await run(() => publish(state.presentation));
    },
    services: {
      layout(method, params) {
        if (method !== "setPresentation") throw new Error("Unknown layout command");
        const command = decode(SetPresentation, params);
        return run(() => publish(command.presentation)) as Promise<Json>;
      },
    },
  };
};
