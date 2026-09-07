import type { BrowserConfiguration, BrowserPage, Capability } from "@hitchhiker/core";
import type { Surface } from "@hitchhiker/ui";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
export interface ServiceContract {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}
export interface ServiceDeclaration {
  readonly id: string;
  readonly contract: ServiceContract;
}
export type ServiceSnapshot =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly providerGeneration: number;
      readonly revision: number;
      readonly value: Json;
    };
export interface ServiceCaller {
  readonly id: string;
  readonly generation: number;
}
export type ServiceHandler = (
  method: string,
  params: Json,
  caller: ServiceCaller,
) => Json | Promise<Json>;

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly capabilities: readonly Capability[];
  readonly provides?: readonly ServiceDeclaration[];
  readonly requires?: readonly (ServiceDeclaration & { readonly optional?: boolean })[];
}
export interface PluginApi {
  readonly services: {
    publish(service: string, value: Json): Promise<{ readonly revision: number }>;
    get(dependency: string): Promise<ServiceSnapshot>;
    subscribe(dependency: string): Promise<ServiceSnapshot>;
    call(dependency: string, method: string, params: Json): Promise<Json>;
  };
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
  /** Handlers run with this provider's own API authority. Caller identity is informational. */
  readonly services?: Readonly<Record<string, ServiceHandler>>;
  readonly onEvent?: (event: string, payload: unknown) => void | Promise<void>;
}
interface HostBridge {
  readonly call: <A>(method: string, params: object) => Promise<A>;
}
const api = (host: HostBridge): PluginApi =>
  Object.freeze({
    services: Object.freeze({
      publish: (service: string, value: Json) =>
        host.call<{ readonly revision: number }>("services.publish", { service, value }),
      get: (dependency: string) => host.call<ServiceSnapshot>("services.get", { dependency }),
      subscribe: (dependency: string) =>
        host.call<ServiceSnapshot>("services.subscribe", { dependency }),
      call: (dependency: string, method: string, params: Json) =>
        host.call<Json>("services.call", { dependency, method, params }),
    }),
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
  let bridge: HostBridge | undefined;
  Object.defineProperty(globalThis, "HitchhikerPlugin", {
    configurable: true,
    value: Object.freeze({
      activate: (host: HostBridge) => {
        bridge = host;
        return plugin.activate(api(host));
      },
      onEvent: async (event: string, payload: unknown) => {
        if (event !== "service.request") return plugin.onEvent?.(event, payload);
        if (!bridge) throw new Error("Plugin has not activated");
        // This event comes from the trusted broker, which validates its complete envelope.
        const request = payload as {
          callId: string;
          service: string;
          method: string;
          params: Json;
          caller: ServiceCaller;
        };
        let response: { callId: string; result: Json } | { callId: string; error: string };
        try {
          const handler =
            plugin.services && Object.hasOwn(plugin.services, request.service)
              ? plugin.services[request.service]
              : undefined;
          if (!handler) throw new Error("Service is unavailable");
          response = {
            callId: request.callId,
            result: await handler(request.method, request.params, request.caller),
          };
        } catch {
          response = { callId: request.callId, error: "Service command failed" };
        }
        await bridge.call("services.respond", response);
      },
    }),
  });
};
