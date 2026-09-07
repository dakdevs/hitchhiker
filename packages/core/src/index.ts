export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (...errors: string[]): Result<never> => ({ ok: false, errors });
type Rec = Record<string, unknown>;
const rec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: Rec, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k));
const id = (v: string): boolean => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(v);
const time = (v: number): boolean => Number.isSafeInteger(v) && v >= 0;
const strings = (v: unknown, max: number): v is readonly string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string");
const origin = (v: string): boolean => {
  try {
    const url = new URL(v);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === v;
  } catch {
    return false;
  }
};

export type ColorScheme = "light" | "dark" | "system";
export interface BrowserConfiguration {
  readonly colorScheme: ColorScheme;
  readonly sleepAfterMs: number;
  readonly alwaysAwakeOrigins: readonly string[];
}
export const defaultConfiguration: BrowserConfiguration = Object.freeze({
  colorScheme: "system",
  sleepAfterMs: 300_000,
  alwaysAwakeOrigins: Object.freeze([]),
});
export const parseConfiguration = (v: unknown): Result<BrowserConfiguration> => {
  if (
    !rec(v) ||
    !exact(v, ["colorScheme", "sleepAfterMs", "alwaysAwakeOrigins"]) ||
    (v.colorScheme !== "light" && v.colorScheme !== "dark" && v.colorScheme !== "system") ||
    typeof v.sleepAfterMs !== "number" ||
    !Number.isSafeInteger(v.sleepAfterMs) ||
    v.sleepAfterMs < 10_000 ||
    v.sleepAfterMs > 86_400_000 ||
    !strings(v.alwaysAwakeOrigins, 500) ||
    !v.alwaysAwakeOrigins.every(origin)
  )
    return fail("Invalid portable configuration.");
  return ok(
    Object.freeze({
      colorScheme: v.colorScheme,
      sleepAfterMs: v.sleepAfterMs,
      alwaysAwakeOrigins: Object.freeze([...new Set(v.alwaysAwakeOrigins)].sort()),
    }),
  );
};
export const exportConfiguration = (configuration: BrowserConfiguration): Result<string> => {
  const parsed = parseConfiguration({
    colorScheme: configuration.colorScheme,
    sleepAfterMs: configuration.sleepAfterMs,
    alwaysAwakeOrigins: configuration.alwaysAwakeOrigins,
  });
  return parsed.ok ? ok(JSON.stringify({ version: 1, configuration: parsed.value })) : parsed;
};
export const importConfiguration = (serialized: string): Result<BrowserConfiguration> => {
  if (serialized.length > 65_536) return fail("Configuration export exceeds 65536 characters.");
  try {
    const v: unknown = JSON.parse(serialized);
    return rec(v) && exact(v, ["version", "configuration"]) && v.version === 1
      ? parseConfiguration(v.configuration)
      : fail("Unsupported configuration export.");
  } catch {
    return fail("Configuration export is not valid JSON.");
  }
};

export type PageLifecycle = "loaded" | "sleeping" | "closed";
export interface PageProtections {
  readonly audio: boolean;
  readonly call: boolean;
  readonly download: boolean;
  readonly unsavedInput: boolean;
}
export interface BrowserPage {
  readonly id: string;
  readonly profileId: string;
  readonly url: string;
  readonly title: string;
  readonly lifecycle: PageLifecycle;
  readonly lastUsedAt: number;
  readonly protections: PageProtections;
}
export interface BrowserViewport {
  readonly id: string;
  readonly profileId: string;
  readonly pageId: string;
}
/** User-visible metadata. Usage timestamps are deliberately excluded from change notifications. */
export interface ObservedPage extends Omit<BrowserPage, "lastUsedAt"> {
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}
export interface PageWatchRequest {
  readonly offset?: number;
  /** Required for continuation chunks; stale revisions reject instead of mixing snapshots. */
  readonly revision?: number;
}
export interface PageWatchSnapshot {
  readonly revision: number;
  readonly pages: readonly ObservedPage[];
  readonly nextOffset?: number;
}
export interface BrowserState {
  readonly pages: readonly BrowserPage[];
  readonly viewports: readonly BrowserViewport[];
}
const noProtection: PageProtections = Object.freeze({
  audio: false,
  call: false,
  download: false,
  unsavedInput: false,
});
export const browserInternalUrl = (v: string): string | undefined =>
  v.startsWith("hitchhiker://") ? v : undefined;
export const normalizeWebUrl = (v: string): Result<string> => {
  try {
    const url = new URL(v.includes("://") ? v : `https://${v}`);
    return url.protocol === "http:" || url.protocol === "https:"
      ? ok(url.toString())
      : fail("Only http and https URLs can be opened as web pages.");
  } catch {
    return fail("Invalid web URL.");
  }
};
export const openPage = (
  state: BrowserState,
  input: {
    readonly id: string;
    readonly profileId: string;
    readonly url: string;
    readonly title?: string;
    readonly now: number;
  },
): Result<BrowserState> => {
  if (
    !id(input.id) ||
    !id(input.profileId) ||
    !time(input.now) ||
    state.pages.some((p) => p.id === input.id)
  )
    return fail("Invalid page id, profile id, or timestamp.");
  const url = normalizeWebUrl(input.url);
  if (!url.ok) return url;
  const page: BrowserPage = Object.freeze({
    id: input.id,
    profileId: input.profileId,
    url: url.value,
    title: input.title ?? url.value,
    lifecycle: "loaded",
    lastUsedAt: input.now,
    protections: noProtection,
  });
  return ok(Object.freeze({ ...state, pages: Object.freeze([...state.pages, page]) }));
};
export const createViewport = (
  state: BrowserState,
  input: BrowserViewport,
): Result<BrowserState> => {
  const page = state.pages.find((p) => p.id === input.pageId);
  if (
    !id(input.id) ||
    !id(input.profileId) ||
    !page ||
    state.viewports.some((v) => v.id === input.id) ||
    page.profileId !== input.profileId ||
    page.lifecycle !== "loaded"
  )
    return fail("Viewport must bind a live page in its own profile.");
  return ok(
    Object.freeze({
      ...state,
      viewports: Object.freeze([...state.viewports, Object.freeze({ ...input })]),
    }),
  );
};
/** Changes only a viewport binding; it never navigates or destroys either page. */
export const replaceViewportPage = (
  state: BrowserState,
  viewportId: string,
  pageId: string,
): Result<BrowserState> => {
  const viewport = state.viewports.find((v) => v.id === viewportId);
  const page = state.pages.find((p) => p.id === pageId);
  if (!viewport || !page || page.profileId !== viewport.profileId || page.lifecycle !== "loaded")
    return fail("Viewport must bind a live page in its own profile.");
  return ok(
    Object.freeze({
      ...state,
      viewports: Object.freeze(
        state.viewports.map((v) => Object.freeze(v.id === viewportId ? { ...v, pageId } : v)),
      ),
    }),
  );
};
/** Detaching a viewport always retains its page. */
export const detachViewport = (state: BrowserState, viewportId: string): Result<BrowserState> =>
  state.viewports.some((v) => v.id === viewportId)
    ? ok(
        Object.freeze({
          ...state,
          viewports: Object.freeze(state.viewports.filter((v) => v.id !== viewportId)),
        }),
      )
    : fail("Unknown viewport.");
export const closePage = (state: BrowserState, pageId: string): Result<BrowserState> => {
  if (!state.pages.some((p) => p.id === pageId)) return fail("Unknown page.");
  const pages: BrowserPage[] = state.pages.map((p): BrowserPage =>
    p.id === pageId ? Object.freeze({ ...p, lifecycle: "closed" }) : p,
  );
  return ok(
    Object.freeze({
      pages: Object.freeze(pages),
      viewports: Object.freeze(state.viewports.filter((v) => v.pageId !== pageId)),
    }),
  );
};
export const markPageUsed = (
  state: BrowserState,
  pageId: string,
  now: number,
): Result<BrowserState> => {
  if (!time(now) || !state.pages.some((p) => p.id === pageId && p.lifecycle !== "closed"))
    return fail("Page cannot be used.");
  const pages: BrowserPage[] = state.pages.map((p): BrowserPage =>
    p.id === pageId ? Object.freeze({ ...p, lifecycle: "loaded", lastUsedAt: now }) : p,
  );
  return ok(Object.freeze({ ...state, pages: Object.freeze(pages) }));
};
const protectedPage = (page: BrowserPage, state: BrowserState): boolean =>
  state.viewports.some((v) => v.pageId === page.id) ||
  page.protections.audio ||
  page.protections.call ||
  page.protections.download ||
  page.protections.unsavedInput;
export const selectPageEvictions = (
  state: BrowserState,
  config: BrowserConfiguration,
  now: number,
  limit: number,
): readonly string[] =>
  !time(now) || !Number.isSafeInteger(limit) || limit < 0
    ? []
    : state.pages
        .filter(
          (p) =>
            p.lifecycle === "loaded" &&
            !protectedPage(p, state) &&
            !config.alwaysAwakeOrigins.includes(new URL(p.url).origin) &&
            now - p.lastUsedAt >= config.sleepAfterMs,
        )
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((p) => p.id);
/** Direct sleep transitions skip inactivity age but never sleep visible, protected, or always-awake pages. */
export const sleepPages = (
  state: BrowserState,
  configuration: BrowserConfiguration,
  pageIds: readonly string[],
): BrowserState =>
  Object.freeze({
    ...state,
    pages: Object.freeze(
      state.pages.map((p) =>
        Object.freeze({
          ...p,
          lifecycle:
            pageIds.includes(p.id) &&
            p.lifecycle === "loaded" &&
            !protectedPage(p, state) &&
            !configuration.alwaysAwakeOrigins.includes(new URL(p.url).origin)
              ? "sleeping"
              : p.lifecycle,
        }),
      ),
    ),
  });

export type Capability =
  | "pages.list"
  | "pages.manage"
  | "pages.read"
  | "pages.write"
  | "ui.compose"
  | "configuration.read"
  | "configuration.write"
  | "plugins.install"
  | "plugins.read"
  | "plugins.manage"
  | "extensions.read"
  | "extensions.manage"
  | "devtools.manage"
  | "storage.local"
  | "browser.full-control"
  | "cdp.connect";
export interface CapabilityGrant {
  readonly id: string;
  readonly principal: string;
  readonly profileId: string;
  readonly capabilities: readonly Capability[];
  readonly origins: readonly string[];
  readonly expiresAt?: number;
  readonly revokedAt?: number;
}
const capabilityNames: readonly Capability[] = [
  "pages.list",
  "pages.manage",
  "pages.read",
  "pages.write",
  "ui.compose",
  "configuration.read",
  "configuration.write",
  "plugins.install",
  "plugins.read",
  "plugins.manage",
  "extensions.read",
  "extensions.manage",
  "devtools.manage",
  "storage.local",
  "browser.full-control",
  "cdp.connect",
];
export const parseGrant = (v: unknown): Result<CapabilityGrant> => {
  if (
    !rec(v) ||
    !exact(v, [
      "id",
      "principal",
      "profileId",
      "capabilities",
      "origins",
      "expiresAt",
      "revokedAt",
    ]) ||
    typeof v.id !== "string" ||
    !id(v.id) ||
    typeof v.principal !== "string" ||
    !id(v.principal) ||
    typeof v.profileId !== "string" ||
    !id(v.profileId) ||
    !strings(v.capabilities, 32) ||
    !v.capabilities.every((x): x is Capability => capabilityNames.includes(x as Capability)) ||
    !strings(v.origins, 500) ||
    !v.origins.every(origin) ||
    (v.expiresAt !== undefined && (typeof v.expiresAt !== "number" || !time(v.expiresAt))) ||
    (v.revokedAt !== undefined && (typeof v.revokedAt !== "number" || !time(v.revokedAt)))
  )
    return fail("Invalid capability grant.");
  return ok(
    Object.freeze({
      id: v.id,
      principal: v.principal,
      profileId: v.profileId,
      capabilities: Object.freeze([...new Set(v.capabilities)].sort()) as readonly Capability[],
      origins: Object.freeze([...new Set(v.origins)].sort()),
      ...(v.expiresAt === undefined ? {} : { expiresAt: v.expiresAt }),
      ...(v.revokedAt === undefined ? {} : { revokedAt: v.revokedAt }),
    }),
  );
};
export const revokeGrant = (grant: CapabilityGrant, now: number): Result<CapabilityGrant> =>
  time(now)
    ? ok(Object.freeze({ ...grant, revokedAt: now }))
    : fail("Invalid revocation timestamp.");
export const grantAllows = (
  grant: CapabilityGrant,
  request: {
    readonly principal: string;
    readonly profileId: string;
    readonly capability: Capability;
    readonly origin?: string;
    readonly now: number;
  },
): boolean =>
  time(request.now) &&
  grant.principal === request.principal &&
  grant.profileId === request.profileId &&
  grant.revokedAt === undefined &&
  (grant.expiresAt === undefined || request.now < grant.expiresAt) &&
  (request.capability === "cdp.connect"
    ? grant.capabilities.includes("cdp.connect")
    : grant.capabilities.includes("browser.full-control") ||
      (grant.capabilities.includes(request.capability) &&
        (!request.capability.startsWith("pages.") ||
          request.capability === "pages.list" ||
          request.capability === "pages.manage" ||
          (request.origin !== undefined &&
            origin(request.origin) &&
            grant.origins.includes(request.origin)))));

export type PluginCapability = "pages" | "navigation" | "settings" | "web-panel" | "automation";
export type NativeNode =
  | { readonly type: "stack"; readonly children: readonly NativeNode[] }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "button"; readonly label: string; readonly action: string };
export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly PluginCapability[];
  readonly root: NativeNode;
}
const pluginNames: readonly PluginCapability[] = [
  "pages",
  "navigation",
  "settings",
  "web-panel",
  "automation",
];
const node = (
  v: unknown,
  depth = 0,
  count: { value: number } = { value: 0 },
): Result<NativeNode> => {
  if (!rec(v) || depth > 12 || ++count.value > 250)
    return fail("Native component tree exceeds limits.");
  if (v.type === "text" && typeof v.value === "string" && v.value.length <= 4000)
    return ok(Object.freeze({ type: "text", value: v.value }));
  if (
    v.type === "button" &&
    typeof v.label === "string" &&
    v.label.length <= 200 &&
    typeof v.action === "string" &&
    id(v.action)
  )
    return ok(Object.freeze({ type: "button", label: v.label, action: v.action }));
  if (v.type === "stack" && Array.isArray(v.children) && v.children.length <= 100) {
    const children: NativeNode[] = [];
    for (const child of v.children) {
      const parsed = node(child, depth + 1, count);
      if (!parsed.ok) return parsed;
      children.push(parsed.value);
    }
    return ok(Object.freeze({ type: "stack", children: Object.freeze(children) }));
  }
  return fail("Invalid native component declaration.");
};
export const parsePluginManifest = (v: unknown): Result<PluginManifest> => {
  if (
    !rec(v) ||
    !exact(v, ["id", "version", "capabilities", "root"]) ||
    typeof v.id !== "string" ||
    !/^[a-z][a-z0-9-]{1,62}$/.test(v.id) ||
    typeof v.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v.version) ||
    !strings(v.capabilities, 25) ||
    !v.capabilities.every((x): x is PluginCapability => pluginNames.includes(x as PluginCapability))
  )
    return fail("Invalid plugin manifest.");
  const root = node(v.root);
  return root.ok
    ? ok(
        Object.freeze({
          id: v.id,
          version: v.version,
          capabilities: Object.freeze(
            [...new Set(v.capabilities)].sort(),
          ) as readonly PluginCapability[],
          root: root.value,
        }),
      )
    : root;
};

export type BudgetStatus = "healthy" | "warned" | "throttled" | "suspended";
export interface ResourceSample {
  readonly cpuPercent: number;
  readonly memoryMb: number;
}
export interface PluginBudgetPolicy {
  readonly maxCpuPercent: number;
  readonly maxMemoryMb: number;
  readonly consecutiveBreaches: number;
}
export interface PluginBudgetState {
  readonly status: BudgetStatus;
  readonly breaches: number;
}
export const defaultPluginBudgetPolicy: PluginBudgetPolicy = Object.freeze({
  maxCpuPercent: 20,
  maxMemoryMb: 150,
  consecutiveBreaches: 3,
});
const validPolicy = (p: PluginBudgetPolicy): boolean =>
  Number.isFinite(p.maxCpuPercent) &&
  p.maxCpuPercent >= 0 &&
  p.maxCpuPercent <= 100 &&
  Number.isFinite(p.maxMemoryMb) &&
  p.maxMemoryMb >= 0 &&
  p.maxMemoryMb <= 1_048_576 &&
  Number.isSafeInteger(p.consecutiveBreaches) &&
  p.consecutiveBreaches > 0 &&
  p.consecutiveBreaches <= 1000;
export const advancePluginBudget = (
  state: PluginBudgetState,
  sample: ResourceSample,
  policy: PluginBudgetPolicy = defaultPluginBudgetPolicy,
): PluginBudgetState => {
  if (
    state.status === "suspended" ||
    !validPolicy(policy) ||
    !Number.isFinite(sample.cpuPercent) ||
    sample.cpuPercent < 0 ||
    !Number.isFinite(sample.memoryMb) ||
    sample.memoryMb < 0
  )
    return state;
  const breaches =
    sample.cpuPercent > policy.maxCpuPercent || sample.memoryMb > policy.maxMemoryMb
      ? state.breaches + 1
      : 0;
  return Object.freeze({
    breaches,
    status:
      breaches >= policy.consecutiveBreaches * 3
        ? "suspended"
        : breaches >= policy.consecutiveBreaches * 2
          ? "throttled"
          : breaches >= policy.consecutiveBreaches
            ? "warned"
            : "healthy",
  });
};
