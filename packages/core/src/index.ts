/** Public, host-independent browser contracts. Host enforcement remains required. */

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };
const success = <T>(value: T): Result<T> => ({ ok: true, value });
const failure = (...errors: string[]): Result<never> => ({ ok: false, errors });

export type TabLayout = "sidebar" | "top";
export type ColorScheme = "light" | "dark" | "system";
export interface BrowserConfiguration {
  readonly tabLayout: TabLayout;
  readonly colorScheme: ColorScheme;
  readonly sleepAfterMs: number;
  readonly alwaysAwakeOrigins: readonly string[];
}
export const defaultConfiguration: BrowserConfiguration = Object.freeze({
  tabLayout: "sidebar",
  colorScheme: "system",
  sleepAfterMs: 300_000,
  alwaysAwakeOrigins: Object.freeze([]),
});

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
};
const stringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const hasOnlyKeys = (value: JsonRecord, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const configurationKeys = [
  "tabLayout",
  "colorScheme",
  "sleepAfterMs",
  "alwaysAwakeOrigins",
] as const;

/** Strictly parses non-secret settings suitable for local persistence or sharing. */
export const parseConfiguration = (value: unknown): Result<BrowserConfiguration> => {
  if (!isRecord(value)) return failure("Configuration must be an object.");
  if (!hasOnlyKeys(value, configurationKeys))
    return failure("Configuration contains unknown fields.");
  const { tabLayout, colorScheme, sleepAfterMs, alwaysAwakeOrigins } = value;
  if (tabLayout !== "sidebar" && tabLayout !== "top")
    return failure("tabLayout must be sidebar or top.");
  if (colorScheme !== "light" && colorScheme !== "dark" && colorScheme !== "system")
    return failure("colorScheme is invalid.");
  if (
    typeof sleepAfterMs !== "number" ||
    !Number.isSafeInteger(sleepAfterMs) ||
    sleepAfterMs < 10_000 ||
    sleepAfterMs > 86_400_000
  )
    return failure("sleepAfterMs must be between 10000 and 86400000.");
  if (
    !stringArray(alwaysAwakeOrigins) ||
    alwaysAwakeOrigins.length > 500 ||
    !alwaysAwakeOrigins.every(isOrigin)
  )
    return failure("alwaysAwakeOrigins must contain at most 500 http(s) origins.");
  return success(
    Object.freeze({
      tabLayout,
      colorScheme,
      sleepAfterMs,
      alwaysAwakeOrigins: Object.freeze([...new Set(alwaysAwakeOrigins)].sort()),
    }),
  );
};
/** Exports only the four portable configuration fields; browser data never enters this format. */
export const exportConfiguration = (configuration: BrowserConfiguration): Result<string> => {
  const parsed = parseConfiguration({
    tabLayout: configuration.tabLayout,
    colorScheme: configuration.colorScheme,
    sleepAfterMs: configuration.sleepAfterMs,
    alwaysAwakeOrigins: configuration.alwaysAwakeOrigins,
  });
  return parsed.ok ? success(JSON.stringify({ version: 1, configuration: parsed.value })) : parsed;
};
export const importConfiguration = (serialized: string): Result<BrowserConfiguration> => {
  if (serialized.length > 65_536) return failure("Configuration export exceeds 65536 characters.");
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      !isRecord(parsed) ||
      !hasOnlyKeys(parsed, ["version", "configuration"]) ||
      parsed.version !== 1 ||
      !isRecord(parsed.configuration)
    )
      return failure("Unsupported configuration export.");
    return parseConfiguration(parsed.configuration);
  } catch {
    return failure("Configuration export is not valid JSON.");
  }
};

export type TabLifecycle = "loaded" | "sleeping" | "closed";
export interface TabProtections {
  readonly audio: boolean;
  readonly call: boolean;
  readonly download: boolean;
  readonly unsavedInput: boolean;
}
export interface BrowserTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly pinned: boolean;
  readonly active: boolean;
  readonly lifecycle: TabLifecycle;
  readonly lastActivatedAt: number;
  readonly protections: TabProtections;
}
export interface TabState {
  readonly tabs: readonly BrowserTab[];
}
export const browserInternalUrl = (value: string): string | undefined =>
  value.startsWith("hitchhiker://") ? value : undefined;
export const normalizeWebUrl = (value: string): Result<string> => {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "http:" || url.protocol === "https:"
      ? success(url.toString())
      : failure("Only http and https URLs can be opened as web tabs.");
  } catch {
    return failure("Invalid web URL.");
  }
};
const validId = (value: string): boolean => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
const unprotected: TabProtections = Object.freeze({
  audio: false,
  call: false,
  download: false,
  unsavedInput: false,
});
export const openTab = (
  state: TabState,
  input: {
    readonly id: string;
    readonly url: string;
    readonly title?: string;
    readonly pinned?: boolean;
    readonly now: number;
  },
): Result<TabState> => {
  if (!validId(input.id) || state.tabs.some((tab) => tab.id === input.id))
    return failure("Tab id is invalid or already exists.");
  const normalized = normalizeWebUrl(input.url);
  if (!normalized.ok) return normalized;
  if (!Number.isSafeInteger(input.now)) return failure("now must be a safe integer.");
  const tab: BrowserTab = Object.freeze({
    id: input.id,
    url: normalized.value,
    title: input.title ?? normalized.value,
    pinned: input.pinned ?? false,
    active: true,
    lifecycle: "loaded",
    lastActivatedAt: input.now,
    protections: unprotected,
  });
  return success(
    Object.freeze({
      tabs: Object.freeze([
        ...state.tabs.map((item) => Object.freeze({ ...item, active: false })),
        tab,
      ]),
    }),
  );
};
export const activateTab = (state: TabState, id: string, now: number): Result<TabState> => {
  if (
    !Number.isSafeInteger(now) ||
    !state.tabs.some((tab) => tab.id === id && tab.lifecycle !== "closed")
  )
    return failure("Tab cannot be activated.");
  return success(
    Object.freeze({
      tabs: Object.freeze(
        state.tabs.map((tab) =>
          Object.freeze({
            ...tab,
            active: tab.id === id,
            lifecycle: tab.id === id ? "loaded" : tab.lifecycle,
            lastActivatedAt: tab.id === id ? now : tab.lastActivatedAt,
          }),
        ),
      ),
    }),
  );
};
export const setTabPinned = (state: TabState, id: string, pinned: boolean): Result<TabState> =>
  state.tabs.some((tab) => tab.id === id)
    ? success(
        Object.freeze({
          tabs: Object.freeze(
            state.tabs.map((tab) =>
              Object.freeze({ ...tab, pinned: tab.id === id ? pinned : tab.pinned }),
            ),
          ),
        }),
      )
    : failure("Unknown tab.");
export const closeTab = (state: TabState, id: string, now: number): Result<TabState> => {
  if (!Number.isSafeInteger(now) || now < 0)
    return failure("now must be a non-negative safe integer.");
  const closingIndex = state.tabs.findIndex((tab) => tab.id === id);
  if (closingIndex < 0) return failure("Unknown tab.");
  const closing = state.tabs[closingIndex];
  if (!closing) return failure("Unknown tab.");
  const remaining = state.tabs.filter((tab) => tab.id !== id && tab.lifecycle !== "closed");
  const mustSelect = closing.active || !remaining.some((tab) => tab.active);
  const adjacent = remaining[closingIndex] ?? remaining[closingIndex - 1];
  return success(
    Object.freeze({
      tabs: Object.freeze(
        remaining.map((tab) =>
          Object.freeze({
            ...tab,
            active: mustSelect && tab.id === adjacent?.id ? true : mustSelect ? false : tab.active,
            lifecycle: mustSelect && tab.id === adjacent?.id ? "loaded" : tab.lifecycle,
            lastActivatedAt: mustSelect && tab.id === adjacent?.id ? now : tab.lastActivatedAt,
          }),
        ),
      ),
    }),
  );
};
export const reorderTab = (state: TabState, id: string, toIndex: number): Result<TabState> => {
  const fromIndex = state.tabs.findIndex((tab) => tab.id === id);
  if (fromIndex < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= state.tabs.length)
    return failure("Invalid tab reorder.");
  const reordered = [...state.tabs];
  const [tab] = reordered.splice(fromIndex, 1);
  if (!tab) return failure("Unknown tab.");
  reordered.splice(toIndex, 0, tab);
  return success(Object.freeze({ tabs: Object.freeze(reordered) }));
};
const protectedTab = (tab: BrowserTab): boolean =>
  tab.active ||
  tab.protections.audio ||
  tab.protections.call ||
  tab.protections.download ||
  tab.protections.unsavedInput;
/** Candidates are oldest-first; pins deliberately convey placement only, not memory priority. */
export const selectEvictions = (
  state: TabState,
  configuration: BrowserConfiguration,
  now: number,
  limit: number,
): readonly string[] =>
  state.tabs
    .filter(
      (tab) =>
        tab.lifecycle === "loaded" &&
        !protectedTab(tab) &&
        !configuration.alwaysAwakeOrigins.includes(new URL(tab.url).origin) &&
        now - tab.lastActivatedAt >= configuration.sleepAfterMs,
    )
    .sort(
      (left, right) =>
        left.lastActivatedAt - right.lastActivatedAt || left.id.localeCompare(right.id),
    )
    .slice(0, Math.max(0, limit))
    .map((tab) => tab.id);
export const sleepTabs = (state: TabState, ids: readonly string[]): TabState =>
  Object.freeze({
    tabs: Object.freeze(
      state.tabs.map((tab) =>
        Object.freeze({
          ...tab,
          lifecycle: ids.includes(tab.id) && !protectedTab(tab) ? "sleeping" : tab.lifecycle,
        }),
      ),
    ),
  });

export type Capability =
  | "tabs.read"
  | "tabs.write"
  | "pages.read"
  | "pages.write"
  | "configuration.write"
  | "plugins.install"
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
const allCapabilities: readonly Capability[] = [
  "tabs.read",
  "tabs.write",
  "pages.read",
  "pages.write",
  "configuration.write",
  "plugins.install",
  "browser.full-control",
  "cdp.connect",
];
export const parseGrant = (value: unknown): Result<CapabilityGrant> => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !validId(value.id) ||
    typeof value.principal !== "string" ||
    !validId(value.principal) ||
    typeof value.profileId !== "string" ||
    !validId(value.profileId) ||
    !stringArray(value.capabilities) ||
    value.capabilities.length > 32 ||
    !value.capabilities.every((entry): entry is Capability =>
      allCapabilities.includes(entry as Capability),
    ) ||
    !stringArray(value.origins) ||
    value.origins.length > 500 ||
    !value.origins.every(isOrigin)
  )
    return failure("Invalid capability grant.");
  const expiresAt = value.expiresAt;
  const revokedAt = value.revokedAt;
  if (
    (expiresAt !== undefined &&
      (!Number.isSafeInteger(expiresAt) || typeof expiresAt !== "number" || expiresAt < 0)) ||
    (revokedAt !== undefined &&
      (!Number.isSafeInteger(revokedAt) || typeof revokedAt !== "number" || revokedAt < 0))
  )
    return failure("Invalid grant timestamp.");
  return success(
    Object.freeze({
      id: value.id,
      principal: value.principal,
      profileId: value.profileId,
      capabilities: Object.freeze([...new Set(value.capabilities)].sort()) as readonly Capability[],
      origins: Object.freeze([...new Set(value.origins)].sort()),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(revokedAt === undefined ? {} : { revokedAt }),
    }),
  );
};
export const revokeGrant = (grant: CapabilityGrant, now: number): Result<CapabilityGrant> =>
  Number.isSafeInteger(now) && now >= 0
    ? success(Object.freeze({ ...grant, revokedAt: now }))
    : failure("now must be a non-negative safe integer.");
export const grantAllows = (
  grant: CapabilityGrant,
  request: {
    readonly principal: string;
    readonly profileId: string;
    readonly capability: Capability;
    readonly origin?: string;
    readonly now: number;
  },
): boolean => {
  if (
    !Number.isSafeInteger(request.now) ||
    request.now < 0 ||
    grant.principal !== request.principal ||
    grant.profileId !== request.profileId ||
    grant.revokedAt !== undefined ||
    (grant.expiresAt !== undefined && request.now >= grant.expiresAt)
  )
    return false;
  if (request.capability === "cdp.connect") return grant.capabilities.includes("cdp.connect");
  if (grant.capabilities.includes("browser.full-control")) return true;
  if (!grant.capabilities.includes(request.capability)) return false;
  return (
    !request.capability.startsWith("pages.") ||
    (request.origin !== undefined &&
      isOrigin(request.origin) &&
      grant.origins.includes(request.origin))
  );
};

export type PluginCapability = "tabs" | "navigation" | "settings" | "web-panel" | "automation";
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
const pluginCapabilities: readonly PluginCapability[] = [
  "tabs",
  "navigation",
  "settings",
  "web-panel",
  "automation",
];
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const parseNativeNode = (
  value: unknown,
  depth = 0,
  count: { value: number } = { value: 0 },
): Result<NativeNode> => {
  if (!isRecord(value) || depth > 12 || ++count.value > 250)
    return failure("Native component tree exceeds limits.");
  if (value.type === "text" && typeof value.value === "string" && value.value.length <= 4_000)
    return success(Object.freeze({ type: "text", value: value.value }));
  if (
    value.type === "button" &&
    typeof value.label === "string" &&
    value.label.length <= 200 &&
    typeof value.action === "string" &&
    validId(value.action)
  )
    return success(Object.freeze({ type: "button", label: value.label, action: value.action }));
  if (value.type === "stack" && Array.isArray(value.children) && value.children.length <= 100) {
    const children: NativeNode[] = [];
    for (const child of value.children) {
      const parsed = parseNativeNode(child, depth + 1, count);
      if (!parsed.ok) return parsed;
      children.push(parsed.value);
    }
    return success(Object.freeze({ type: "stack", children: Object.freeze(children) }));
  }
  return failure("Invalid native component declaration.");
};
/** Describes a declarative UI proposal; it neither executes a plugin nor grants host access. */
export const parsePluginManifest = (value: unknown): Result<PluginManifest> => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[a-z][a-z0-9-]{1,62}$/.test(value.id) ||
    typeof value.version !== "string" ||
    !versionPattern.test(value.version) ||
    !stringArray(value.capabilities) ||
    value.capabilities.length > 25 ||
    !value.capabilities.every((entry): entry is PluginCapability =>
      pluginCapabilities.includes(entry as PluginCapability),
    )
  )
    return failure("Invalid plugin manifest.");
  const root = parseNativeNode(value.root);
  if (!root.ok) return root;
  return success(
    Object.freeze({
      id: value.id,
      version: value.version,
      capabilities: Object.freeze(
        [...new Set(value.capabilities)].sort(),
      ) as readonly PluginCapability[],
      root: root.value,
    }),
  );
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
const validBudgetPolicy = (policy: PluginBudgetPolicy): boolean =>
  Number.isFinite(policy.maxCpuPercent) &&
  policy.maxCpuPercent >= 0 &&
  policy.maxCpuPercent <= 100 &&
  Number.isFinite(policy.maxMemoryMb) &&
  policy.maxMemoryMb >= 0 &&
  policy.maxMemoryMb <= 1_048_576 &&
  Number.isSafeInteger(policy.consecutiveBreaches) &&
  policy.consecutiveBreaches > 0 &&
  policy.consecutiveBreaches <= 1_000;
const validBudgetSample = (sample: ResourceSample): boolean =>
  Number.isFinite(sample.cpuPercent) &&
  sample.cpuPercent >= 0 &&
  Number.isFinite(sample.memoryMb) &&
  sample.memoryMb >= 0;
/** Policy state only. A trusted host must measure and enforce CPU, memory, and suspension. */
export const advancePluginBudget = (
  state: PluginBudgetState,
  sample: ResourceSample,
  policy: PluginBudgetPolicy = defaultPluginBudgetPolicy,
): PluginBudgetState => {
  if (state.status === "suspended") return state;
  if (!validBudgetPolicy(policy) || !validBudgetSample(sample)) return state;
  const breached = sample.cpuPercent > policy.maxCpuPercent || sample.memoryMb > policy.maxMemoryMb;
  const breaches = breached ? state.breaches + 1 : 0;
  const status: BudgetStatus =
    breaches >= policy.consecutiveBreaches * 3
      ? "suspended"
      : breaches >= policy.consecutiveBreaches * 2
        ? "throttled"
        : breaches >= policy.consecutiveBreaches
          ? "warned"
          : "healthy";
  return Object.freeze({ status, breaches });
};
