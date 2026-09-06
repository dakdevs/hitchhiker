import { Effect } from "effect";
import type { McpBrowserApi } from "@hitchhiker/runtime";
import type { BrowserController } from "./controller.ts";

/** The MCP server receives this capability-checked facade, never the native engine connection. */
export const browserMcpApi = (controller: BrowserController): McpBrowserApi => ({
  pages: controller.snapshot.pipe(
    Effect.map((state) => state.pages.filter((page) => page.lifecycle !== "closed")),
  ),
  open: controller.openPage,
  navigate: controller.navigatePage,
  close: controller.closePage,
  configuration: controller.configuration,
  configure: controller.configure,
  setTabPlacement: (placement) => controller.dispatch(`settings.tabs.${placement}`),
  customization: {
    settings: controller.portableSettings,
    apply: controller.applyPortableSettings,
  },
});
