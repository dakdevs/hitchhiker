import type {
  BrowserConfiguration,
  BrowserPage,
  Capability,
  PageWatchRequest,
  PageWatchSnapshot,
} from "@hitchhiker/core";
import type { Surface } from "@hitchhiker/ui";
export type { ObservedPage, PageWatchRequest, PageWatchSnapshot } from "@hitchhiker/core";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export type PluginApiErrorCode = "conflict" | "denied" | "stale-snapshot";
const errorMessages: Readonly<Record<PluginApiErrorCode, string>> = Object.freeze({
  conflict: "Plugin storage revision changed",
  denied: "Plugin operation was denied or could not complete",
  "stale-snapshot": "Page snapshot changed; restart from offset zero",
});
export class PluginApiError extends Error {
  readonly name = "PluginApiError";
  constructor(readonly code: PluginApiErrorCode) {
    super(errorMessages[code]);
  }
}
export interface ServiceContract {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}
export interface ServiceDeclaration {
  readonly id: string;
  readonly contract: ServiceContract;
}
/** Display-only lifecycle metadata. It never contains artifact hashes or grant credentials. */
export interface PluginManagementPluginSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly removing?: boolean;
  readonly capabilities: readonly Capability[];
  readonly previousVersion?: string;
  readonly lastFailure?: string;
}
export interface PluginManagementSnapshot {
  readonly revision: number;
  readonly plugins: readonly PluginManagementPluginSummary[];
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
export type DevToolsState = "closed" | "opening" | "open" | "closing";
export interface DevToolsStatus {
  readonly pageId: string;
  readonly generation: number;
  /** Zero is the initial closed state; increments for each inspector in a generation. */
  readonly instance: number;
  readonly state: DevToolsState;
}
export interface DevToolsInspectPoint {
  readonly x: number;
  readonly y: number;
}
export interface DevToolsChangedEvent {
  readonly event: "devtools.changed";
  readonly payload: DevToolsStatus;
}

export interface PluginApi {
  readonly storage: {
    read(): Promise<{ readonly revision: number; readonly value: Json }>;
    write(expectedRevision: number, value: Json): Promise<{ readonly revision: number }>;
  };
  readonly services: {
    publish(service: string, value: Json): Promise<{ readonly revision: number }>;
    get(dependency: string): Promise<ServiceSnapshot>;
    subscribe(dependency: string): Promise<ServiceSnapshot>;
    call(dependency: string, method: string, params: Json): Promise<Json>;
  };
  readonly pages: {
    list(): Promise<readonly BrowserPage[]>;
    watch(request?: PageWatchRequest): Promise<PageWatchSnapshot>;
    open(url: string): Promise<{ readonly pageId: string }>;
    navigate(pageId: string, url: string): Promise<void>;
    close(pageId: string): Promise<void>;
    back(pageId: string): Promise<void>;
    forward(pageId: string): Promise<void>;
    reload(pageId: string): Promise<void>;
    stop(pageId: string): Promise<void>;
  };
  readonly configuration: {
    get(): Promise<BrowserConfiguration>;
    set(configuration: BrowserConfiguration): Promise<void>;
  };
  readonly devtools: {
    status(pageId: string): Promise<DevToolsStatus>;
    show(pageId: string, inspectAt?: DevToolsInspectPoint): Promise<DevToolsStatus>;
    close(pageId: string): Promise<DevToolsStatus>;
  };
  readonly plugins: {
    snapshot(): Promise<PluginManagementSnapshot>;
    enable(id: string): Promise<PluginManagementSnapshot>;
    disable(id: string): Promise<PluginManagementSnapshot>;
    rollback(id: string): Promise<PluginManagementSnapshot>;
    uninstall(id: string): Promise<PluginManagementSnapshot>;
    replaceSelf(targetId: string, expectedRevision: number): Promise<PluginManagementSnapshot>;
  };
  readonly ui: {
    /** Legacy whole-window API; aliases publishLayout for the configured layout in composition mode. */
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
  /** Coalesced invalidation after pages.watch(); read a fresh snapshot to obtain current data. */
  readonly onPagesChanged?: (revision: number) => void | Promise<void>;
  readonly onEvent?: (event: string, payload: unknown) => void | Promise<void>;
}
interface HostBridge {
  readonly call: <A>(method: string, params: object) => Promise<A>;
}
const call = async <A>(host: HostBridge, method: string, params: object): Promise<A> => {
  try {
    return await host.call<A>(method, params);
  } catch (error) {
    const descriptor =
      typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
    const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    throw new PluginApiError(code === "conflict" || code === "stale-snapshot" ? code : "denied");
  }
};
const api = (host: HostBridge): PluginApi =>
  Object.freeze({
    storage: Object.freeze({
      read: () =>
        call<{ readonly revision: number; readonly value: Json }>(host, "storage.read", {}),
      write: (expectedRevision: number, value: Json) =>
        call<{ readonly revision: number }>(host, "storage.write", { expectedRevision, value }),
    }),
    services: Object.freeze({
      publish: (service: string, value: Json) =>
        call<{ readonly revision: number }>(host, "services.publish", { service, value }),
      get: (dependency: string) => call<ServiceSnapshot>(host, "services.get", { dependency }),
      subscribe: (dependency: string) =>
        call<ServiceSnapshot>(host, "services.subscribe", { dependency }),
      call: (dependency: string, method: string, params: Json) =>
        call<Json>(host, "services.call", { dependency, method, params }),
    }),
    pages: Object.freeze({
      list: () => call<readonly BrowserPage[]>(host, "pages.list", {}),
      watch: (request: PageWatchRequest = {}) =>
        call<PageWatchSnapshot>(host, "pages.watch", request),
      open: (url: string) => call<{ readonly pageId: string }>(host, "pages.open", { url }),
      navigate: (pageId: string, url: string) =>
        call<void>(host, "pages.navigate", { pageId, url }),
      close: (pageId: string) => call<void>(host, "pages.close", { pageId }),
      back: (pageId: string) => call<void>(host, "pages.back", { pageId }),
      forward: (pageId: string) => call<void>(host, "pages.forward", { pageId }),
      reload: (pageId: string) => call<void>(host, "pages.reload", { pageId }),
      stop: (pageId: string) => call<void>(host, "pages.stop", { pageId }),
    }),
    configuration: Object.freeze({
      get: () => call<BrowserConfiguration>(host, "configuration.get", {}),
      set: (configuration: BrowserConfiguration) =>
        call<void>(host, "configuration.set", { configuration }),
    }),
    devtools: Object.freeze({
      status: (pageId: string) => call<DevToolsStatus>(host, "devtools.status", { pageId }),
      show: (pageId: string, inspectAt?: DevToolsInspectPoint) =>
        call<DevToolsStatus>(host, "devtools.show", {
          pageId,
          ...(inspectAt === undefined ? {} : { inspectAt }),
        }),
      close: (pageId: string) => call<DevToolsStatus>(host, "devtools.close", { pageId }),
    }),
    plugins: Object.freeze({
      snapshot: () => call<PluginManagementSnapshot>(host, "plugins.snapshot", {}),
      enable: (id: string) => call<PluginManagementSnapshot>(host, "plugins.enable", { id }),
      disable: (id: string) => call<PluginManagementSnapshot>(host, "plugins.disable", { id }),
      rollback: (id: string) => call<PluginManagementSnapshot>(host, "plugins.rollback", { id }),
      uninstall: (id: string) => call<PluginManagementSnapshot>(host, "plugins.uninstall", { id }),
      replaceSelf: (targetId: string, expectedRevision: number) =>
        call<PluginManagementSnapshot>(host, "plugins.replaceSelf", {
          targetId,
          expectedRevision,
        }),
    }),
    ui: Object.freeze({
      publish: (surface: Omit<Surface, "identity">) =>
        call<{ readonly revision: number }>(host, "ui.publish", { surface }),
      publishLayout: (surface: Omit<Surface, "identity">) =>
        call<{ readonly revision: number }>(host, "ui.publishLayout", { surface }),
      publishContribution: (id: string, surface: Omit<Surface, "identity">) =>
        call<{ readonly revision: number }>(host, "ui.publishContribution", { id, surface }),
      withdrawContribution: (id: string) =>
        call<{ readonly revision: number }>(host, "ui.withdrawContribution", { id }),
      release: () => call<void>(host, "ui.release", {}),
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
        if (event === "pages.changed" && plugin.onPagesChanged) {
          // The controller supplies this validated envelope after reducing page state.
          const change = payload as { readonly revision: number };
          await plugin.onPagesChanged(change.revision);
        }
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
