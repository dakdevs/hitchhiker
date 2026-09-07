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

export type PluginApiErrorCode =
  | "conflict"
  | "denied"
  | "stale-snapshot"
  | "not_authorized"
  | "page_gone"
  | "stale_ref"
  | "covered"
  | "unsupported"
  | "limit"
  | "browser_error";
const errorMessages: Readonly<Record<PluginApiErrorCode, string>> = Object.freeze({
  conflict: "Plugin storage revision changed",
  denied: "Plugin operation was denied or could not complete",
  "stale-snapshot": "Page snapshot changed; restart from offset zero",
  not_authorized: "The plugin is not authorized for this DOM operation",
  page_gone: "The page is no longer available",
  stale_ref: "The DOM reference is stale; take a new snapshot",
  covered: "The target is covered and cannot be interacted with",
  unsupported: "The requested DOM operation is unsupported",
  limit: "The DOM operation exceeded a host limit",
  browser_error: "The browser could not complete the DOM operation",
});
const pluginApiErrorCodes: ReadonlySet<PluginApiErrorCode> = new Set(
  Object.keys(errorMessages) as PluginApiErrorCode[],
);
export class PluginApiError extends Error {
  readonly name = "PluginApiError";
  readonly code: PluginApiErrorCode;
  constructor(code: PluginApiErrorCode) {
    super(errorMessages[code]);
    this.code = code;
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
export type ExtensionState =
  | "prepared"
  | "installing"
  | "enabled"
  | "removing"
  | "removed"
  | "error";
/** Managed extension metadata excludes artifact paths, host errors, and review authority. */
export interface ExtensionManagementSummary {
  readonly installationId: string;
  readonly digest: string;
  readonly expectedChromiumId: string;
  readonly chromiumId?: string;
  readonly name: string;
  readonly version: string;
  readonly permissions: readonly string[];
  readonly hostPermissions: readonly string[];
  readonly optionalPermissions: readonly string[];
  readonly optionalHostPermissions: readonly string[];
  readonly state: ExtensionState;
  readonly errorIntent?: "install" | "remove";
}
export interface ExtensionManagementSnapshot {
  readonly readOnly: boolean;
  readonly extensions: readonly ExtensionManagementSummary[];
}
export interface ExtensionInstallationSnapshot {
  readonly operationId: string;
  readonly state:
    | "choosing"
    | "receiving"
    | "validating"
    | "awaiting_review"
    | "reviewing"
    | "installing"
    | "enabled"
    | "canceled"
    | "rejected"
    | "error"
    | "removed";
  readonly upload?: {
    readonly completedFiles: number;
    readonly totalBytes: number;
    readonly file?: { readonly path: string; readonly size: number; readonly offset: number };
  };
  readonly extension?: ExtensionManagementSummary;
  readonly error?:
    | "validation_failed"
    | "review_failed"
    | "installation_failed"
    | "unavailable"
    | "expired";
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
/** A portable accessibility-tree node. It never exposes browser document or backend handles. */
export interface DomSnapshotNode {
  readonly parent?: number;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly states?: readonly string[];
  readonly ref?: string;
  readonly frameBoundary?: "child-frame";
}
/** A bounded, temporary DOM snapshot for one page. References may expire or become stale. */
export interface DomSnapshot {
  readonly pageId: string;
  readonly snapshotId: string;
  readonly nodes: readonly DomSnapshotNode[];
  readonly truncated: boolean;
}
export interface DomSnapshotRequest {
  readonly pageId: string;
  readonly maxDepth?: number;
  readonly interactiveOnly?: boolean;
}
export interface DomClickRequest {
  readonly pageId: string;
  readonly ref: string;
}
export interface DomFillRequest extends DomClickRequest {
  readonly value: string;
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
  readonly dom: {
    snapshot(request: DomSnapshotRequest): Promise<DomSnapshot>;
    click(request: DomClickRequest): Promise<{ readonly clicked: true }>;
    fill(request: DomFillRequest): Promise<{ readonly filled: true }>;
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
    replace(
      sourceId: string,
      targetId: string,
      expectedRevision: number,
    ): Promise<PluginManagementSnapshot>;
    replaceSelf(targetId: string, expectedRevision: number): Promise<PluginManagementSnapshot>;
  };
  readonly extensions: {
    list(): Promise<ExtensionManagementSnapshot>;
    remove(installationId: string): Promise<ExtensionManagementSnapshot>;
    readonly installation: {
      pickLocal(): Promise<ExtensionInstallationSnapshot>;
      begin(): Promise<ExtensionInstallationSnapshot>;
      beginFile(
        operationId: string,
        path: string,
        size: number,
      ): Promise<ExtensionInstallationSnapshot>;
      append(
        operationId: string,
        offset: number,
        data: Uint8Array,
      ): Promise<ExtensionInstallationSnapshot>;
      finish(operationId: string): Promise<ExtensionInstallationSnapshot>;
      status(operationId: string): Promise<ExtensionInstallationSnapshot>;
      list(): Promise<readonly ExtensionInstallationSnapshot[]>;
      requestReview(operationId: string): Promise<ExtensionInstallationSnapshot>;
      cancel(operationId: string): Promise<ExtensionInstallationSnapshot>;
    };
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
    /** Select this caller's published contribution in its configured route slot. */
    showRoute(id: string): Promise<{ readonly revision: number }>;
    /** Restore the fallback only if this caller's contribution is currently selected. */
    hideRoute(id: string): Promise<{ readonly revision: number }>;
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
const isPluginApiErrorCode = (value: unknown): value is PluginApiErrorCode =>
  typeof value === "string" && pluginApiErrorCodes.has(value as PluginApiErrorCode);
const call = async <A>(host: HostBridge, method: string, params: object): Promise<A> => {
  try {
    return await host.call<A>(method, params);
  } catch (error) {
    const descriptor =
      typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
    const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    throw new PluginApiError(isPluginApiErrorCode(code) ? code : "denied");
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
    dom: Object.freeze({
      snapshot: ({ pageId, maxDepth, interactiveOnly }: DomSnapshotRequest) =>
        call<DomSnapshot>(host, "dom.snapshot", {
          pageId,
          ...(maxDepth === undefined ? {} : { maxDepth }),
          ...(interactiveOnly === undefined ? {} : { interactiveOnly }),
        }),
      click: ({ pageId, ref }: DomClickRequest) =>
        call<{ readonly clicked: true }>(host, "dom.click", { pageId, ref }),
      fill: ({ pageId, ref, value }: DomFillRequest) =>
        call<{ readonly filled: true }>(host, "dom.fill", { pageId, ref, value }),
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
      replace: (sourceId: string, targetId: string, expectedRevision: number) =>
        call<PluginManagementSnapshot>(host, "plugins.replace", {
          sourceId,
          targetId,
          expectedRevision,
        }),
      replaceSelf: (targetId: string, expectedRevision: number) =>
        call<PluginManagementSnapshot>(host, "plugins.replaceSelf", {
          targetId,
          expectedRevision,
        }),
    }),
    extensions: Object.freeze({
      list: () => call<ExtensionManagementSnapshot>(host, "extensions.list", {}),
      remove: (installationId: string) =>
        call<ExtensionManagementSnapshot>(host, "extensions.remove", { installationId }),
      installation: Object.freeze({
        pickLocal: () =>
          call<ExtensionInstallationSnapshot>(host, "extensions.installation.pickLocal", {}),
        begin: () => call<ExtensionInstallationSnapshot>(host, "extensions.installation.begin", {}),
        beginFile: (operationId: string, path: string, size: number) =>
          call<ExtensionInstallationSnapshot>(host, "extensions.installation.beginFile", {
            operationId,
            path,
            size,
          }),
        append: (operationId: string, offset: number, data: Uint8Array) => {
          if (data.byteLength > 65_536)
            return Promise.reject(
              new RangeError("Extension upload chunks may not exceed 65536 bytes"),
            );
          const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
          let encoded = "";
          for (let index = 0; index < data.length; index += 3) {
            const value =
              (data[index]! << 16) | ((data[index + 1] ?? 0) << 8) | (data[index + 2] ?? 0);
            encoded +=
              alphabet[(value >>> 18) & 63]! +
              alphabet[(value >>> 12) & 63]! +
              (index + 1 < data.length ? alphabet[(value >>> 6) & 63]! : "=") +
              (index + 2 < data.length ? alphabet[value & 63]! : "=");
          }
          return call<ExtensionInstallationSnapshot>(host, "extensions.installation.append", {
            operationId,
            offset,
            dataBase64: encoded,
          });
        },
        finish: (operationId: string) =>
          call<ExtensionInstallationSnapshot>(host, "extensions.installation.finish", {
            operationId,
          }),
        status: (operationId: string) =>
          call<ExtensionInstallationSnapshot>(host, "extensions.installation.status", {
            operationId,
          }),
        list: () =>
          call<readonly ExtensionInstallationSnapshot[]>(host, "extensions.installation.list", {}),
        requestReview: (operationId: string) =>
          call<ExtensionInstallationSnapshot>(host, "extensions.installation.requestReview", {
            operationId,
          }),
        cancel: (operationId: string) =>
          call<ExtensionInstallationSnapshot>(host, "extensions.installation.cancel", {
            operationId,
          }),
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
      showRoute: (id: string) => call<{ readonly revision: number }>(host, "ui.showRoute", { id }),
      hideRoute: (id: string) => call<{ readonly revision: number }>(host, "ui.hideRoute", { id }),
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
