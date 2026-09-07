import assert from "node:assert/strict";
import test from "node:test";
import type { DevToolsStatus, Json, PluginApi, ServiceSnapshot } from "@hitchhiker/plugin-sdk";
import { design, type NativeNode, type Surface } from "@hitchhiker/ui";

import { createDevToolsPlugin } from "../src/devtools.ts";

const model = (selection: Json): Json => ({
  version: 1,
  pagesRevision: 1,
  selection,
  pageOrder: ["page-a", "page-b"],
});

const available = (value: Json): ServiceSnapshot => ({
  available: true,
  providerGeneration: 1,
  revision: 1,
  value,
});

const nodes = (root: NativeNode): readonly NativeNode[] => [
  root,
  ...("children" in root ? root.children.flatMap(nodes) : []),
];

const uiEvent = (action: string): Json => ({
  surfaceId: "main",
  revision: 1,
  nodeId: action,
  event: "press",
  payload: { action },
});

const state = (pageId: string, value: DevToolsStatus["state"], instance = 1): DevToolsStatus => ({
  pageId,
  generation: 1,
  instance,
  state: value,
});

const fakeApi = () => {
  let modelValue: Json = model({ kind: "page", pageId: "page-a" });
  let failShow = false;
  let failModelRead = false;
  let colorScheme: "light" | "dark" = "light";
  const calls: string[] = [];
  const statuses = new Map<string, DevToolsStatus>([
    ["page-a", state("page-a", "closed")],
    ["page-b", state("page-b", "open")],
  ]);
  const publications: Omit<Surface, "identity">[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected public API call");
  };
  const api: PluginApi = {
    storage: { read: unexpected, write: unexpected },
    services: {
      publish: unexpected,
      get: async (dependency: string) => {
        calls.push(`get:${dependency}`);
        if (failModelRead) throw new Error("model unavailable");
        return available(modelValue);
      },
      subscribe: async (dependency: string) => {
        calls.push(`subscribe:${dependency}`);
        return available(modelValue);
      },
      call: unexpected,
    },
    pages: {
      list: unexpected,
      watch: unexpected,
      open: unexpected,
      navigate: unexpected,
      close: unexpected,
      back: unexpected,
      forward: unexpected,
      reload: unexpected,
      stop: unexpected,
    },
    configuration: {
      get: async () => {
        calls.push("configuration.get");
        return { colorScheme, sleepAfterMs: 300_000, alwaysAwakeOrigins: [] };
      },
      set: unexpected,
    },
    devtools: {
      status: async (pageId: string) => {
        calls.push(`status:${pageId}`);
        return statuses.get(pageId)!;
      },
      show: async (pageId: string) => {
        calls.push(`show:${pageId}`);
        if (failShow) throw new Error("revoked");
        const next = state(pageId, "open", (statuses.get(pageId)?.instance ?? 0) + 1);
        statuses.set(pageId, next);
        return next;
      },
      close: async (pageId: string) => {
        calls.push(`close:${pageId}`);
        const next = state(pageId, "closed", statuses.get(pageId)?.instance ?? 1);
        statuses.set(pageId, next);
        return next;
      },
    },
    plugins: {
      snapshot: unexpected,
      enable: unexpected,
      disable: unexpected,
      rollback: unexpected,
      uninstall: unexpected,
      replaceSelf: unexpected,
    },
    ui: {
      publish: unexpected,
      publishLayout: unexpected,
      publishContribution: async (_id: string, surface: Omit<Surface, "identity">) => {
        publications.push(surface);
        return { revision: publications.length };
      },
      withdrawContribution: unexpected,
      release: unexpected,
    },
  };
  return {
    api,
    calls,
    publications,
    setModel(value: Json) {
      modelValue = value;
    },
    setFailShow(value: boolean) {
      failShow = value;
    },
    setFailModelRead(value: boolean) {
      failModelRead = value;
    },
    setColorScheme(value: "light" | "dark") {
      colorScheme = value;
    },
  };
};

test("DevTools toolbar uses only the model service and public inspector calls", async () => {
  const fake = fakeApi();
  const plugin = createDevToolsPlugin();
  await plugin.activate(fake.api);

  assert.deepEqual(fake.calls, [
    "subscribe:model",
    "subscribe:layout",
    "configuration.get",
    "get:model",
    "status:page-a",
  ]);
  const toolbar = fake.publications.at(-1)!;
  const rendered = nodes(toolbar.root);
  assert.ok(rendered.some((node) => node.key === "default-devtools-inspect"));
  assert.equal(
    rendered.some((node) => node.key === "default-devtools-close"),
    false,
  );

  await plugin.onEvent?.("ui.event", uiEvent("default-devtools.inspect"));
  assert.ok(fake.calls.includes("show:page-a"));
  assert.ok(fake.calls.includes("status:page-a"));
  await plugin.onEvent?.("ui.event", uiEvent("default-devtools.close"));
  assert.ok(fake.calls.includes("close:page-a"));
});

test("DevTools follows selection changes and suppresses controls for a closed new-page selection", async () => {
  const fake = fakeApi();
  const plugin = createDevToolsPlugin();
  await plugin.activate(fake.api);
  fake.setModel(model({ kind: "page", pageId: "page-b" }));
  await plugin.onEvent?.("service.state", {
    dependency: "model",
    providerGeneration: 1,
    revision: 2,
    available: true,
  });
  assert.equal(
    nodes(fake.publications.at(-1)!.root).some((node) => node.key === "default-devtools-close"),
    true,
  );

  fake.setModel(model({ kind: "new-page" }));
  await plugin.onEvent?.("service.state", {
    dependency: "model",
    providerGeneration: 1,
    revision: 3,
    available: true,
  });
  const beforeActions = fake.calls.filter((call) => call.startsWith("show:")).length;
  await plugin.onEvent?.("ui.event", uiEvent("default-devtools.inspect"));
  assert.equal(fake.calls.filter((call) => call.startsWith("show:")).length, beforeActions);
  assert.equal(
    nodes(fake.publications.at(-1)!.root).some((node) => node.key === "default-devtools-inspect"),
    false,
  );
});

test("stale DevTools events refresh the current selection rather than their old page", async () => {
  const fake = fakeApi();
  const plugin = createDevToolsPlugin();
  await plugin.activate(fake.api);
  fake.setModel(model({ kind: "page", pageId: "page-b" }));
  await plugin.onEvent?.("devtools.changed", state("page-a", "closed"));
  assert.equal(fake.calls.at(-1), "status:page-b");
  assert.equal(
    nodes(fake.publications.at(-1)!.root).some((node) => node.key === "default-devtools-close"),
    true,
  );
});

test("a layout notification refreshes compact controls with the current color scheme", async () => {
  const fake = fakeApi();
  const plugin = createDevToolsPlugin();
  await plugin.activate(fake.api);
  fake.setColorScheme("dark");
  await plugin.onEvent?.("service.state", {
    dependency: "layout",
    providerGeneration: 1,
    revision: 2,
    available: true,
  });
  const inspect = nodes(fake.publications.at(-1)!.root).find(
    (node) => node.key === "default-devtools-inspect",
  );
  assert.equal(inspect?.fg, design.dark.foreground);
});

test("an action reads the latest model and never mutates a cached page after model read failure", async () => {
  const fake = fakeApi();
  const plugin = createDevToolsPlugin();
  await plugin.activate(fake.api);

  fake.setModel(model({ kind: "page", pageId: "page-b" }));
  await plugin.onEvent?.("ui.event", uiEvent("default-devtools.inspect"));
  assert.ok(fake.calls.includes("show:page-b"));
  assert.equal(fake.calls.includes("show:page-a"), false);

  const beforeActions = fake.calls.filter((call) => /^(show|close):/.test(call)).length;
  fake.setFailModelRead(true);
  await plugin.onEvent?.("ui.event", uiEvent("default-devtools.close"));
  assert.equal(fake.calls.filter((call) => /^(show|close):/.test(call)).length, beforeActions);
  assert.ok(
    nodes(fake.publications.at(-1)!.root).some((node) => node.key === "default-devtools-error"),
  );
});

test("a revoked inspector action leaves the toolbar active and a later action can recover", async () => {
  const fake = fakeApi();
  const plugin = createDevToolsPlugin();
  await plugin.activate(fake.api);
  fake.setFailShow(true);
  await plugin.onEvent?.("ui.event", uiEvent("default-devtools.inspect"));
  assert.ok(
    nodes(fake.publications.at(-1)!.root).some((node) => node.key === "default-devtools-error"),
  );

  fake.setFailShow(false);
  await plugin.onEvent?.("ui.event", uiEvent("default-devtools.inspect"));
  assert.equal(
    nodes(fake.publications.at(-1)!.root).some((node) => node.key === "default-devtools-error"),
    false,
  );
  assert.equal(
    nodes(fake.publications.at(-1)!.root).some((node) => node.key === "default-devtools-close"),
    true,
  );
});
