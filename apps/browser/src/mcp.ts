import { Effect } from "effect";
import { EngineError, type McpBrowserApi } from "@hitchhiker/runtime";
import type { BrowserController } from "./controller.ts";

/** The MCP server receives this capability-checked facade, never the native engine connection. */
export const browserMcpApi = (controller: BrowserController): McpBrowserApi => ({
  pages: controller.snapshot.pipe(
    Effect.map((state) => state.pages.filter((page) => page.lifecycle !== "closed")),
  ),
  open: controller.openPage,
  navigate: controller.navigatePage,
  close: controller.closePage,
  history: controller.pageHistory,
  configuration: controller.configuration,
  configure: controller.configure,
  setTabPlacement: (placement) =>
    controller.interfaceMode === "plugins"
      ? Effect.fail(
          new EngineError({
            code: "plugin-owned-interface",
            message:
              "Tab presentation is owned by plugins. Change the plugin composition plan instead.",
          }),
        )
      : controller.dispatch(`settings.tabs.${placement}`),
  customization:
    controller.interfaceMode === "legacy"
      ? {
          settings: controller.portableSettings,
          apply: controller.applyPortableSettings,
        }
      : undefined,
});
