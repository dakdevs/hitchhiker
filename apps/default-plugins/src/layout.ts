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
              column("browser-main", [row("toolbar", []), column("content", [], { flex: 1 })], {
                flex: 1,
                bg: colors.canvas,
              }),
            ],
            { bg: colors.canvas },
          )
        : column(
            "browser-layout",
            [row("toolbar", []), column("tabs", []), column("content", [], { flex: 1 })],
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
  let publishedDark = false;
  const run = serial();

  const publish = async (presentation: LayoutState["presentation"]): Promise<LayoutState> => {
    if (!api) throw new Error("Layout plugin has not activated");
    const next: LayoutState = { version: 1, presentation };
    const configuration = await api.configuration.get();
    const dark = configuration.colorScheme === "dark";
    if (published && state.presentation === presentation && publishedDark === dark) return state;
    await api.ui.publishLayout(renderLayout(presentation, dark));
    await api.services.publish("layout", next as Json);
    state = next;
    published = true;
    publishedDark = dark;
    return state;
  };

  return {
    async activate(host) {
      api = host;
      await run(() => publish(state.presentation));
    },
    onEvent(event) {
      if (event === "configuration.changed")
        return run(() => publish(state.presentation)).then(() => undefined);
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
