export { EngineConnection, EngineError } from "./engine.ts";
export { createPluginStorage } from "./plugin-storage.ts";
export type { PluginStorageAdapter } from "./plugin-storage.ts";
export type { EngineOptions, EngineEvent, JsonObject, RawCdpConnection } from "./engine.ts";
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
export { mcpStdioInputLimit, mcpStdioMaxStringIdBytes, runMcpStdio } from "./mcp-stdio.ts";
export { McpActionError, registerBrowserMcp } from "./mcp.ts";
export type { McpBrowserApi, McpOptions, McpPluginApi } from "./mcp.ts";
export {
  CustomizationError,
  decodeCustomizationRecipe,
  exportCustomizationRecipe,
  importCustomizationRecipe,
} from "./customization.ts";
export type { CustomizationRecipe, PortableSettings } from "./customization.ts";
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
export {
  makeScopedDomSession,
  scopedDomMcpResponseBytes,
  scopedDomOutputLimit,
  ScopedDomError,
} from "./scoped-dom.ts";
export type {
  DomCapture,
  DomCapturedNode,
  DomDocumentHandle,
  DomNodeKind,
  PageSnapshot,
  PageSnapshotNode,
  ScopedDomCapability,
  ScopedDomDriver,
  ScopedDomSession,
} from "./scoped-dom.ts";

export { spawnPluginHost, PluginHostError } from "./plugin.ts";
export type { PluginHostOptions } from "./plugin.ts";
export { LivePluginManifest, PluginCallError, createPluginDispatcher } from "./plugin-dispatch.ts";
export type { PluginDispatchOptions } from "./plugin-dispatch.ts";
export { runLivePlugin } from "./plugin-session.ts";
export type { LivePluginOptions } from "./plugin-session.ts";
export {
  ServiceContractSchema,
  ServiceProviderSchema,
  ServiceRequirementSchema,
  ServicePluginDescriptorSchema,
  ServiceBindingSchema,
  ServiceContractError,
  validateServiceGraph,
} from "./service-contracts.ts";
export type {
  ServiceContract,
  ServiceProvider,
  ServiceRequirement,
  ServicePluginDescriptor,
  ServiceBinding,
  ResolvedServiceBinding,
  ServiceGraph,
} from "./service-contracts.ts";
export { createServiceAuthority } from "./service-authority.ts";
export type { ServiceParty, EffectiveAuthority } from "./service-authority.ts";
export {
  makePageObservations,
  PageWatchRequestSchema,
  PageChangedSchema,
} from "./page-observations.ts";
export type { PageWatchSubscription } from "./page-observations.ts";
export { createPluginServiceBroker, ServiceBrokerError } from "./plugin-service-broker.ts";
export type {
  PluginServiceBroker,
  ServiceBrokerOptions,
  ServiceBrokerAuthority,
  ServiceOwner,
  ServiceState,
  ServiceEvent,
} from "./plugin-service-broker.ts";

export { composePluginSurface, routeCompositionEvent } from "./composition.ts";
export type { CompositionOwner, CompositionRoute, ComposedPluginSurface } from "./composition.ts";
export { makePluginComposition, PluginCompositionRecipeSchema } from "./composition-session.ts";
export type {
  PluginCompositionRecipe,
  PluginCompositionSession,
  MakePluginCompositionOptions,
} from "./composition-session.ts";

export {
  NativePageGeneration,
  AttachedPageGeneration,
  PageLifecycleEvent,
  decodePageLifecycleEvent,
} from "./page-lifecycle.ts";
