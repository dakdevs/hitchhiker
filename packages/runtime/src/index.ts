export { EngineConnection, EngineError } from "./engine.ts";
export type { EngineOptions, EngineEvent, JsonObject } from "./engine.ts";
export { NativeSurface } from "./surface.ts";
export type { SurfaceEvent } from "./surface.ts";
export { GrantStore, GrantStoreError, create as createGrantStore } from "./grants.ts";
export type {
  GrantStoreApi,
  GrantIssue,
  GrantAuthentication,
  GrantAuthorization,
  GrantDelegation,
  AuthorizedGrant,
} from "./grants.ts";
export { openCdpRelay, CdpRelayError } from "./cdp-relay.ts";
export type { CdpRelay, CdpRelayOptions } from "./cdp-relay.ts";
export { mcpStdioInputLimit, runMcpStdio } from "./mcp-stdio.ts";
export { McpActionError, registerBrowserMcp } from "./mcp.ts";
export type { McpBrowserApi, McpOptions, McpPluginApi } from "./mcp.ts";
export {
  activatePage,
  decodePageResourceEvent,
  freezePage,
  PageResourceEvent,
  PageResourceSignal,
  rememberPageResources,
  selectPageFreezes,
} from "./page-resources.ts";
export type { PageLifecycleTransport, PageResourceKnowledge } from "./page-resources.ts";

export { spawnPluginHost, PluginHostError } from "./plugin.ts";
export type { PluginHostOptions } from "./plugin.ts";
export { LivePluginManifest, PluginCallError, createPluginDispatcher } from "./plugin-dispatch.ts";
export type { PluginDispatchOptions } from "./plugin-dispatch.ts";
export { runLivePlugin } from "./plugin-session.ts";
export type { LivePluginOptions } from "./plugin-session.ts";
