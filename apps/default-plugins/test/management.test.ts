import assert from "node:assert/strict";
import test from "node:test";
import type { Json, PluginApi, PluginManagementSnapshot } from "@hitchhiker/plugin-sdk";
import type { NativeNode, Surface } from "@hitchhiker/ui";

import { createPluginManagementPlugin } from "../src/management.ts";

const nodes = (node: NativeNode): readonly NativeNode[] => [
  node,
  ...("children" in node ? node.children.flatMap(nodes) : []),
];
const event = (action: string): Json => ({
  surfaceId: "main",
  revision: 1,
  nodeId: action,
  event: "press",
  payload: { action },
});
const summary = (id: string, enabled = true, previousVersion?: string) => ({
  id,
  name: id,
  version: "1.0.0",
  enabled,
  running: enabled,
  capabilities: [],
  ...(previousVersion === undefined ? {} : { previousVersion }),
});

const fakeApi = () => {
  const publications: { readonly id: string; readonly surface: Omit<Surface, "identity"> }[] = [];
  const calls: string[] = [];
  let snapshot: PluginManagementSnapshot = {
    revision: 4,
    plugins: [
      summary("default-sidebar-tabs"),
      summary("default-top-tabs", false),
      summary("sample", false, "0.9.0"),
    ],
  };
  let fail = false;
  const unexpected = (() => Promise.reject(new Error("Unexpected public API call"))) as never;
  const mutate = (operation: string) => async (id: string) => {
    calls.push(`${operation}:${id}`);
    if (fail) throw new Error("denied private detail");
    snapshot = {
      revision: snapshot.revision + 1,
      plugins: snapshot.plugins.map((entry) =>
        entry.id === id
          ? { ...entry, enabled: operation === "enable", running: operation === "enable" }
          : entry,
      ),
    };
    return snapshot;
  };
  const api: PluginApi = {
    configuration: {
      get: async () => (
        calls.push("configuration.get"),
        { colorScheme: "light" as const, sleepAfterMs: 300_000, alwaysAwakeOrigins: [] }
      ),
      set: unexpected,
    },
    plugins: {
      snapshot: async () => (calls.push("plugins.snapshot"), snapshot),
      enable: mutate("enable"),
      disable: mutate("disable"),
      rollback: mutate("rollback"),
      uninstall: mutate("uninstall"),
      replace: async (sourceId, targetId, expectedRevision) => {
        calls.push(`replace:${sourceId}:${targetId}:${expectedRevision}`);
        if (fail) throw new Error("denied private detail");
        snapshot = {
          revision: expectedRevision + 1,
          plugins: snapshot.plugins.map((entry) =>
            entry.id === sourceId
              ? { ...entry, enabled: false, running: false }
              : entry.id === targetId
                ? { ...entry, enabled: true, running: true }
                : entry,
          ),
        };
        return snapshot;
      },
      replaceSelf: unexpected,
    },
    ui: {
      publish: unexpected,
      publishLayout: unexpected,
      publishContribution: async (id, surface) => (
        publications.push({ id, surface }),
        { revision: publications.length }
      ),
      withdrawContribution: unexpected,
      showRoute: async (id) => (calls.push(`show:${id}`), { revision: 1 }),
      hideRoute: async (id) => (calls.push(`hide:${id}`), { revision: 1 }),
      release: unexpected,
    },
    storage: { read: unexpected, write: unexpected },
    services: { publish: unexpected, get: unexpected, subscribe: unexpected, call: unexpected },
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
    dom: { snapshot: unexpected, click: unexpected, fill: unexpected },
    devtools: { status: unexpected, show: unexpected, close: unexpected },
    extensions: {
      list: unexpected,
      remove: unexpected,
      installation: {
        pickLocal: unexpected,
        begin: unexpected,
        beginFile: unexpected,
        append: unexpected,
        finish: unexpected,
        status: unexpected,
        list: unexpected,
        requestReview: unexpected,
        cancel: unexpected,
      },
    },
  };
  return {
    api,
    calls,
    publications,
    setFail(value: boolean) {
      fail = value;
    },
  };
};

test("plugin management owns its route and dispatches public lifecycle and replacement operations", async () => {
  const fake = fakeApi();
  const manager = createPluginManagementPlugin();
  await manager.activate(fake.api);
  assert.deepEqual(
    fake.publications.slice(0, 2).map((entry) => entry.id),
    ["main", "launcher"],
  );
  await manager.onEvent?.("ui.event", event("plugin-management.open"));
  await manager.onEvent?.("ui.event", event("plugin-management.back"));
  await manager.onEvent?.("ui.event", event("plugin-management.enable:sample"));
  await manager.onEvent?.("ui.event", event("plugin-management.rollback:sample"));
  await manager.onEvent?.("ui.event", event("plugin-management.uninstall:sample"));
  await manager.onEvent?.("ui.event", event("plugin-management.switch-presenter"));
  assert.equal(fake.calls.filter((call) => call === "show:main").length, 2);
  assert.equal(fake.calls.at(-1), "show:main");
  assert(fake.calls.includes("hide:main"));
  assert(fake.calls.includes("enable:sample"));
  assert(fake.calls.includes("rollback:sample"));
  assert(fake.calls.includes("uninstall:sample"));
  assert(fake.calls.includes("replace:default-sidebar-tabs:default-top-tabs:7"));
});

test("denied management actions retain the visible inventory and render a safe error", async () => {
  const fake = fakeApi();
  const manager = createPluginManagementPlugin();
  await manager.activate(fake.api);
  fake.setFail(true);
  await manager.onEvent?.("ui.event", event("plugin-management.disable:sample"));
  await manager.onEvent?.("plugins.changed", {});
  const rendered = nodes(fake.publications.findLast((entry) => entry.id === "main")!.surface.root);
  assert(rendered.some((node) => node.key === "plugin-management-sample-status"));
  assert(rendered.some((node) => node.key === "plugin-management-error"));
  assert.equal(JSON.stringify(rendered).includes("private detail"), false);
});

test("management refreshes from lifecycle events once per coalesced notification without polling", async () => {
  const fake = fakeApi();
  const manager = createPluginManagementPlugin();
  await manager.activate(fake.api);
  const before = fake.calls.filter((call) => call === "plugins.snapshot").length;
  await Promise.all([
    manager.onEvent?.("plugins.changed", {}),
    manager.onEvent?.("configuration.changed", {}),
  ]);
  assert.equal(fake.calls.filter((call) => call === "plugins.snapshot").length, before + 1);
});

test("management only accepts its own lifecycle action namespace", async () => {
  const fake = fakeApi();
  const manager = createPluginManagementPlugin();
  await manager.activate(fake.api);
  const before = fake.calls.length;
  for (const action of [
    "enable:sample",
    "other.plugin-management.enable:sample",
    "plugin-management.enable:../sample",
  ])
    await manager.onEvent?.("ui.event", event(action));
  assert.equal(fake.calls.length, before);
});
