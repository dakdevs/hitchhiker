import type { BrowserConfiguration, BrowserPage, Capability } from "@hitchhiker/core";
import type { Surface } from "@hitchhiker/ui";

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly capabilities: readonly Capability[];
}
export interface PluginApi {
  readonly pages: {
    list(): Promise<readonly BrowserPage[]>;
    open(url: string): Promise<{ readonly pageId: string }>;
    navigate(pageId: string, url: string): Promise<void>;
    close(pageId: string): Promise<void>;
  };
  readonly configuration: {
    get(): Promise<BrowserConfiguration>;
    set(configuration: BrowserConfiguration): Promise<void>;
  };
  readonly ui: {
    /** Legacy whole-window replacement for hosts that do not enable composition. */
    publish(surface: Omit<Surface, "identity">): Promise<{ readonly revision: number }>;
    /** Publish this plugin's configured layout; the host owns identity, slots, and bindings. */
    publishLayout(surface: Omit<Surface, "identity">): Promise<{ readonly revision: number }>;
    /** Publish one host-declared contribution; the host owns its placement and provider identity. */
    publishContribution(
      id: string,
      surface: Omit<Surface, "identity">,
    ): Promise<{ readonly revision: number }>;
    /** Withdraw one host-declared contribution. */
    withdrawContribution(id: string): Promise<{ readonly revision: number }>;
    /** Return to the trusted default UI, or release this caller's contributions in composition mode. */
    release(): Promise<void>;
  };
}
export interface Plugin {
  readonly activate: (api: PluginApi) => void | Promise<void>;
  readonly onEvent?: (event: string, payload: unknown) => void | Promise<void>;
}
interface HostBridge {
  readonly call: <A>(method: string, params: object) => Promise<A>;
}
const api = (host: HostBridge): PluginApi =>
  Object.freeze({
    pages: Object.freeze({
      list: () => host.call<readonly BrowserPage[]>("pages.list", {}),
      open: (url: string) => host.call<{ readonly pageId: string }>("pages.open", { url }),
      navigate: (pageId: string, url: string) => host.call<void>("pages.navigate", { pageId, url }),
      close: (pageId: string) => host.call<void>("pages.close", { pageId }),
    }),
    configuration: Object.freeze({
      get: () => host.call<BrowserConfiguration>("configuration.get", {}),
      set: (configuration: BrowserConfiguration) =>
        host.call<void>("configuration.set", { configuration }),
    }),
    ui: Object.freeze({
      publish: (surface: Omit<Surface, "identity">) =>
        host.call<{ readonly revision: number }>("ui.publish", { surface }),
      publishLayout: (surface: Omit<Surface, "identity">) =>
        host.call<{ readonly revision: number }>("ui.publishLayout", { surface }),
      publishContribution: (id: string, surface: Omit<Surface, "identity">) =>
        host.call<{ readonly revision: number }>("ui.publishContribution", { id, surface }),
      withdrawContribution: (id: string) =>
        host.call<{ readonly revision: number }>("ui.withdrawContribution", { id }),
      release: () => host.call<void>("ui.release", {}),
    }),
  });

/** Bundle this entry point as an IIFE. The host discovers no filesystem entry points. */
export const definePlugin = (plugin: Plugin): void => {
  Object.defineProperty(globalThis, "HitchhikerPlugin", {
    configurable: true,
    value: Object.freeze({
      activate: (host: HostBridge) => plugin.activate(api(host)),
      ...(plugin.onEvent ? { onEvent: plugin.onEvent } : {}),
    }),
  });
};
