import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginApiError,
  type Json,
  type PluginApi,
  type ServiceHandler,
  type ServiceSnapshot,
} from "@hitchhiker/plugin-sdk";
import type { NativeNode, Surface } from "@hitchhiker/ui";

import { createLayoutPlugin } from "../src/layout.ts";
import { createPresenterPlugin } from "../src/presenter.ts";

const available = (value: Json): ServiceSnapshot => ({
  available: true,
  providerGeneration: 1,
  revision: 1,
  value,
});

const nodes = (root: NativeNode): readonly NativeNode[] => {
  const result: NativeNode[] = [root];
  if ("children" in root) for (const child of root.children) result.push(...nodes(child));
  return result;
};

const fakeApi = () => {
  let model: Json = {
    version: 1,
    pagesRevision: 1,
    selection: { kind: "page", pageId: "page-b" },
    pageOrder: ["page-b", "page-a"],
  };
  let pins: ServiceSnapshot = available({
    version: 1,
    pagesRevision: 1,
    pinnedPageIds: ["page-a"],
  });
  let failNavigate = false;
  let failPins = false;
  let configuration: Awaited<ReturnType<PluginApi["configuration"]["get"]>> = {
    colorScheme: "light" as const,
    sleepAfterMs: 300_000,
    alwaysAwakeOrigins: ["https://kept.example"],
  };
  let management = {
    revision: 7,
    plugins: [
      {
        id: "other-plugin",
        name: "Other plugin",
        version: "1.2.3",
        enabled: true,
        running: true,
        capabilities: ["pages.list"] as const,
      },
    ],
  };
  const configurationWrites: unknown[] = [];
  const pluginCalls: { method: string; id?: string; revision?: number }[] = [];
  const contributions = new Map<string, Omit<Surface, "identity">>();
  const layouts: Omit<Surface, "identity">[] = [];
  const publications: { service: string; value: Json }[] = [];
  const calls: { dependency: string; method: string; params: Json }[] = [];
  const pageCalls: { method: string; pageId: string; url?: string }[] = [];
  const pages = [
    {
      id: "page-a",
      profileId: "default",
      url: "https://a.example/",
      title: "A",
      lifecycle: "loaded" as const,
      protections: { audio: false, call: false, download: false, unsavedInput: false },
      loading: false,
      canGoBack: false,
      canGoForward: false,
    },
    {
      id: "page-b",
      profileId: "default",
      url: "https://b.example/",
      title: "B",
      lifecycle: "loaded" as const,
      protections: { audio: false, call: false, download: false, unsavedInput: false },
      loading: false,
      canGoBack: true,
      canGoForward: false,
    },
  ];
  const unexpectedDevTools = async (): Promise<never> => {
    throw new Error("This plugin must not invoke DevTools");
  };
  const api: PluginApi = {
    dom: { snapshot: unexpectedDevTools, click: unexpectedDevTools, fill: unexpectedDevTools },
    devtools: { status: unexpectedDevTools, show: unexpectedDevTools, close: unexpectedDevTools },
    storage: {
      read: async () => ({ revision: 0, value: null }),
      write: async () => ({ revision: 1 }),
    },
    services: {
      publish: async (service, value) => {
        publications.push({ service, value });
        return { revision: publications.length };
      },
      get: async (dependency) =>
        dependency === "model"
          ? available(model)
          : dependency === "pins"
            ? pins
            : available({ version: 1, presentation: "sidebar" }),
      subscribe: async (dependency) =>
        dependency === "model"
          ? available(model)
          : dependency === "pins"
            ? pins
            : available({ version: 1, presentation: "sidebar" }),
      call: async (dependency, method, params) => {
        calls.push({ dependency, method, params });
        if (dependency === "pins" && failPins) {
          failPins = false;
          throw new PluginApiError("denied");
        }
        if (dependency === "model" && method === "select")
          model = {
            ...(model as Record<string, Json>),
            selection: { kind: "page", pageId: (params as { pageId: string }).pageId },
          };
        if (dependency === "model" && method === "new")
          model = { ...(model as Record<string, Json>), selection: { kind: "new-page" } };
        return dependency === "layout"
          ? { version: 1, presentation: (params as { presentation: string }).presentation }
          : null;
      },
    },
    pages: {
      list: async () => [],
      watch: async () => ({ revision: 1, pages }),
      open: async () => ({ pageId: "opened" }),
      navigate: async (pageId, url) => {
        pageCalls.push({ method: "navigate", pageId, url });
        if (failNavigate) {
          failNavigate = false;
          throw new PluginApiError("denied");
        }
      },
      close: async () => undefined,
      back: async (pageId) => {
        pageCalls.push({ method: "back", pageId });
      },
      forward: async (pageId) => {
        pageCalls.push({ method: "forward", pageId });
      },
      reload: async (pageId) => {
        pageCalls.push({ method: "reload", pageId });
      },
      stop: async () => undefined,
    },
    configuration: {
      get: async () => configuration,
      set: async (next) => {
        configurationWrites.push(next);
        configuration = next;
      },
    },
    plugins: {
      snapshot: async () => {
        pluginCalls.push({ method: "snapshot" });
        return management;
      },
      enable: async (id) => {
        pluginCalls.push({ method: "enable", id });
        return management;
      },
      disable: async (id) => {
        pluginCalls.push({ method: "disable", id });
        return management;
      },
      rollback: async (id) => {
        pluginCalls.push({ method: "rollback", id });
        return management;
      },
      uninstall: async (id) => {
        pluginCalls.push({ method: "uninstall", id });
        return management;
      },
      replaceSelf: async (id, revision) => {
        pluginCalls.push({ method: "replaceSelf", id, revision });
        return management;
      },
    },
    ui: {
      publish: async () => ({ revision: 1 }),
      publishLayout: async (surface) => {
        layouts.push(surface);
        return { revision: layouts.length };
      },
      publishContribution: async (id, surface) => {
        contributions.set(id, surface);
        return { revision: contributions.size };
      },
      withdrawContribution: async () => ({ revision: 1 }),
      release: async () => undefined,
    },
  };
  return {
    api,
    calls,
    pageCalls,
    contributions,
    layouts,
    publications,
    configurationWrites,
    pluginCalls,
    setPins(value: ServiceSnapshot) {
      pins = value;
    },
    setModel(value: Json) {
      model = value;
    },
    denyNextNavigate() {
      failNavigate = true;
    },
    denyNextPin() {
      failPins = true;
    },
    setManagement(value: typeof management) {
      management = value;
    },
  };
};

const uiEvent = (event: "press" | "input", nodeId: string, payload: Json) => ({
  surfaceId: "main",
  revision: 1,
  nodeId,
  event,
  payload,
});

const withoutUrlGlobal = async (work: () => Promise<void>) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "URL");
  Object.defineProperty(globalThis, "URL", { configurable: true, value: undefined });
  try {
    await work();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "URL", descriptor);
    else Reflect.deleteProperty(globalThis, "URL");
  }
};

test("layout publishes stable slots and changes geometry through its public service", async () => {
  const fake = fakeApi();
  const plugin = createLayoutPlugin();
  await plugin.activate(fake.api);
  assert.deepEqual(
    nodes(fake.layouts[0]!.root).map((node) => node.key),
    ["browser-layout", "tabs", "browser-main", "toolbar", "content"],
  );
  const handler = plugin.services?.layout as ServiceHandler;
  assert.deepEqual(
    await handler("setPresentation", { presentation: "top" }, { id: "presenter", generation: 1 }),
    {
      version: 1,
      presentation: "top",
    },
  );
  assert.deepEqual(
    nodes(fake.layouts[1]!.root).map((node) => node.key),
    ["browser-layout", "toolbar", "tabs", "content"],
  );
  assert.deepEqual(fake.publications.at(-1), {
    service: "layout",
    value: { version: 1, presentation: "top" },
  });
  await handler("setPresentation", { presentation: "top" }, { id: "presenter", generation: 1 });
  assert.equal(fake.layouts.length, 2);
  assert.equal(fake.publications.length, 2);
  await fake.api.configuration.set({
    ...(await fake.api.configuration.get()),
    colorScheme: "dark",
  });
  await handler("setPresentation", { presentation: "top" }, { id: "presenter", generation: 1 });
  assert.equal(fake.layouts.length, 3);
  assert.equal(fake.layouts.at(-1)?.root.bg, "#212121");
  assert.deepEqual(fake.layouts.at(-1)?.bindings, []);
});

test("sidebar presenter publishes screenshot-compatible fragments and routes selection", async () => {
  const fake = fakeApi();
  const plugin = createPresenterPlugin("sidebar");
  await withoutUrlGlobal(() => Promise.resolve(plugin.activate(fake.api)));
  assert.equal(fake.contributions.get("tabs")?.root.key, "sidebar");
  assert.equal(fake.contributions.get("toolbar")?.root.key, "toolbar");
  assert.equal(fake.contributions.get("content")?.root.key, "main-page");
  assert.deepEqual(fake.contributions.get("content")?.bindings, [
    { viewportId: "main-page", pageId: "page-b" },
  ]);
  const toolbarNodes = nodes(fake.contributions.get("toolbar")!.root);
  assert.equal(toolbarNodes.find((node) => node.key === "plugins")?.kind, "button");
  assert.equal(toolbarNodes.find((node) => node.key === "settings")?.kind, "button");
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("press", "page-select-page-a", { action: "page.select:page-a" }),
  );
  assert.deepEqual(fake.calls.at(-1), {
    dependency: "model",
    method: "select",
    params: { pageId: "page-a" },
  });
  assert.deepEqual(fake.contributions.get("content")?.bindings, [
    { viewportId: "main-page", pageId: "page-a" },
  ]);
});

test("presenter management routes replace the viewport and Back restores the selected page", async () => {
  const fake = fakeApi();
  const plugin = createPresenterPlugin("sidebar");
  await plugin.activate(fake.api);
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("press", "settings", { action: "interface.settings" }),
  );
  assert.equal(fake.contributions.get("content")?.root.key, "settings-route");
  assert.deepEqual(fake.contributions.get("content")?.bindings, []);
  await plugin.onPagesChanged?.(2);
  assert.equal(fake.contributions.get("content")?.root.key, "settings-route");
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("press", "settings-color-dark", { action: "settings.color:dark" }),
  );
  assert.deepEqual(fake.configurationWrites.at(-1), {
    colorScheme: "dark",
    sleepAfterMs: 300_000,
    alwaysAwakeOrigins: ["https://kept.example"],
  });
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("press", "management-back", { action: "management.back" }),
  );
  assert.equal(fake.contributions.get("content")?.root.key, "main-page");
  assert.deepEqual(fake.contributions.get("content")?.bindings, [
    { viewportId: "main-page", pageId: "page-b" },
  ]);
});

test("management routes refresh tab state and navigation uses a selection changed while Settings is open", async () => {
  const fake = fakeApi();
  const plugin = createPresenterPlugin("sidebar");
  await plugin.activate(fake.api);
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("press", "settings", { action: "interface.settings" }),
  );
  fake.setModel({
    version: 1,
    pagesRevision: 2,
    selection: { kind: "page", pageId: "page-a" },
    pageOrder: ["page-a", "page-b"],
  });
  await plugin.onEvent?.("service.state", {
    dependency: "model",
    providerGeneration: 1,
    revision: 2,
    available: true,
  });
  assert.equal(fake.contributions.get("content")?.root.key, "settings-route");
  assert.ok(
    nodes(fake.contributions.get("tabs")!.root).some((node) => node.key === "page-select-page-a"),
  );
  await plugin.onEvent?.("ui.event", uiEvent("input", "address", { kind: "clear" }));
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("input", "address", { kind: "insert_text", text: "example.com" }),
  );
  await plugin.onEvent?.("ui.event", uiEvent("press", "navigate", { action: "browser.navigate" }));
  assert.equal(fake.contributions.get("content")?.root.key, "main-page");
  assert.deepEqual(fake.pageCalls.at(-1), {
    method: "navigate",
    pageId: "page-a",
    url: "https://example.com",
  });
});

test("presenter forwards bounded lifecycle operations and refreshes the revision before switching", async () => {
  const fake = fakeApi();
  const plugin = createPresenterPlugin("sidebar");
  await plugin.activate(fake.api);
  await plugin.onEvent?.("ui.event", uiEvent("press", "plugins", { action: "interface.plugins" }));
  assert.equal(fake.contributions.get("content")?.root.key, "plugins-route");
  assert.deepEqual(fake.contributions.get("content")?.bindings, []);
  for (const action of [
    "plugins.disable:other-plugin",
    "plugins.rollback:other-plugin",
    "plugins.uninstall:other-plugin",
  ])
    await plugin.onEvent?.("ui.event", uiEvent("press", action, { action }));
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("press", "plugins-switch-presenter", { action: "plugins.replace-self" }),
  );
  assert.deepEqual(fake.pluginCalls, [
    { method: "snapshot" },
    { method: "disable", id: "other-plugin" },
    { method: "rollback", id: "other-plugin" },
    { method: "uninstall", id: "other-plugin" },
    { method: "snapshot" },
    { method: "replaceSelf", id: "default-top-tabs", revision: 7 },
  ]);
});

test("presenter routes address, history, tab, pin, and reorder actions through public APIs", async () => {
  const fake = fakeApi();
  const plugin = createPresenterPlugin("sidebar");
  await plugin.activate(fake.api);
  await plugin.onEvent?.("ui.event", uiEvent("input", "address", { kind: "clear" }));
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("input", "address", { kind: "insert_text", text: "search words" }),
  );
  await plugin.onEvent?.("ui.event", uiEvent("press", "navigate", { action: "browser.navigate" }));
  assert.deepEqual(fake.pageCalls.at(-1), {
    method: "navigate",
    pageId: "page-b",
    url: "https://duckduckgo.com/?q=search%20words",
  });
  for (const action of ["browser.back", "browser.forward", "browser.reload"])
    await plugin.onEvent?.("ui.event", uiEvent("press", action, { action }));
  assert.deepEqual(
    fake.pageCalls.slice(-3).map((call) => call.method),
    ["back", "forward", "reload"],
  );
  for (const action of [
    "page.close:page-a",
    "page.pin:page-a",
    "page.unpin:page-a",
    "page.reorder:page-a:0",
  ])
    await plugin.onEvent?.("ui.event", uiEvent("press", action, { action }));
  assert.deepEqual(
    fake.calls.slice(-4).map(({ dependency, method }) => [dependency, method]),
    [
      ["model", "close"],
      ["pins", "set"],
      ["pins", "set"],
      ["model", "reorder"],
    ],
  );
  await plugin.onEvent?.("ui.event", uiEvent("press", "new-page", { action: "browser.new-page" }));
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("input", "address", { kind: "insert_text", text: "example.com" }),
  );
  await plugin.onEvent?.("ui.event", uiEvent("press", "navigate", { action: "browser.navigate" }));
  assert.deepEqual(fake.calls.at(-1), {
    dependency: "model",
    method: "open",
    params: { url: "https://example.com" },
  });
});

test("top presenter is a real alternative and optional pin loss removes pin actions", async () => {
  const fake = fakeApi();
  const plugin = createPresenterPlugin("top");
  await plugin.activate(fake.api);
  assert.equal(fake.contributions.get("tabs")?.root.key, "pages");
  assert.equal(fake.contributions.get("toolbar")?.root.key, "window-header");
  assert.ok(
    nodes(fake.contributions.get("tabs")!.root).some((node) => node.key.startsWith("page-pin-")),
  );
  fake.setPins({ available: false });
  await plugin.onEvent?.("service.state", {
    dependency: "pins",
    providerGeneration: 0,
    revision: 0,
    available: false,
  });
  assert.equal(
    nodes(fake.contributions.get("tabs")!.root).some((node) => node.key.startsWith("page-pin-")),
    false,
  );
  assert.deepEqual(fake.contributions.get("content")?.bindings, [
    { viewportId: "main-page", pageId: "page-b" },
  ]);
});

test("expected public UI action failures retain the presenter and permit a later navigation", async () => {
  const fake = fakeApi();
  const plugin = createPresenterPlugin("sidebar");
  await plugin.activate(fake.api);
  await plugin.onEvent?.("ui.event", uiEvent("input", "address", { kind: "clear" }));
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("input", "address", { kind: "insert_text", text: "https://" }),
  );
  fake.denyNextNavigate();
  await plugin.onEvent?.("ui.event", uiEvent("press", "navigate", { action: "browser.navigate" }));
  assert.equal(fake.contributions.get("content")?.root.key, "main-page");
  assert.ok(
    nodes(fake.contributions.get("toolbar")!.root).some(
      (node) => node.kind === "input" && node.value === "https://",
    ),
  );
  await plugin.onEvent?.("ui.event", uiEvent("input", "address", { kind: "clear" }));
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("input", "address", { kind: "insert_text", text: "example.com" }),
  );
  await plugin.onEvent?.("ui.event", uiEvent("press", "navigate", { action: "browser.navigate" }));
  assert.equal(fake.pageCalls.at(-1)?.url, "https://example.com");
});

test("an optional pin provider lost between render and press does not tear down the presenter", async () => {
  const fake = fakeApi();
  const plugin = createPresenterPlugin("sidebar");
  await plugin.activate(fake.api);
  fake.setPins({ available: false });
  fake.denyNextPin();
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("press", "page-pin-page-a", { action: "page.pin:page-a" }),
  );
  await plugin.onEvent?.(
    "ui.event",
    uiEvent("press", "page-select-page-a", { action: "page.select:page-a" }),
  );
  assert.deepEqual(fake.contributions.get("content")?.bindings, [
    { viewportId: "main-page", pageId: "page-a" },
  ]);
});
