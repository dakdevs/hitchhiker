import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserConfiguration } from "@hitchhiker/core";
import type { Json, PluginApi, PluginManagementSnapshot } from "@hitchhiker/plugin-sdk";
import type { NativeNode, Surface } from "@hitchhiker/ui";

import { createSettingsPlugin } from "../src/settings.ts";

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
const plugin = (id: string, enabled = true) => ({
  id,
  name: id,
  version: "1.0.0",
  enabled,
  running: enabled,
  capabilities: [],
});

const fakeApi = () => {
  const publications: { readonly id: string; readonly surface: Omit<Surface, "identity"> }[] = [];
  const calls: string[] = [];
  let configuration: BrowserConfiguration = {
    colorScheme: "light" as const,
    sleepAfterMs: 300_000,
    alwaysAwakeOrigins: ["https://keep.example"],
  };
  let snapshot: PluginManagementSnapshot = {
    revision: 7,
    plugins: [plugin("default-sidebar-tabs"), plugin("default-top-tabs", false)],
  };
  let failSet = false;
  const unexpected = (() => Promise.reject(new Error("Unexpected public API call"))) as never;
  const api: PluginApi = {
    configuration: {
      get: async () => (calls.push("configuration.get"), configuration),
      set: async (next) => {
        calls.push("configuration.set");
        if (failSet) throw new Error("denied private detail");
        configuration = next;
      },
    },
    plugins: {
      snapshot: async () => (calls.push("plugins.snapshot"), snapshot),
      enable: unexpected,
      disable: unexpected,
      rollback: unexpected,
      uninstall: unexpected,
      replace: async (sourceId, targetId, expectedRevision) => {
        calls.push(`replace:${sourceId}:${targetId}:${expectedRevision}`);
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
      publishContribution: async (id, surface) => {
        publications.push({ id, surface });
        return { revision: publications.length };
      },
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
    configuration: () => configuration,
    setFailSet(value: boolean) {
      failSet = value;
    },
    setSnapshot(value: PluginManagementSnapshot) {
      snapshot = value;
    },
  };
};

test("settings owns its route, preserves configuration fields, and replaces the active presenter", async () => {
  const fake = fakeApi();
  const settings = createSettingsPlugin();
  await settings.activate(fake.api);
  assert.deepEqual(
    fake.publications.slice(0, 2).map((entry) => entry.id),
    ["main", "launcher"],
  );
  await settings.onEvent?.("ui.event", event("settings.open"));
  await settings.onEvent?.("ui.event", event("settings.back"));
  await settings.onEvent?.("ui.event", event("settings.color:dark"));
  await settings.onEvent?.("ui.event", event("settings.sleep:60000"));
  await settings.onEvent?.("ui.event", event("settings.switch-presenter"));
  assert.equal(fake.configuration().colorScheme, "dark");
  assert.equal(fake.configuration().sleepAfterMs, 60_000);
  assert.deepEqual(fake.configuration().alwaysAwakeOrigins, ["https://keep.example"]);
  assert.equal(fake.calls.filter((call) => call === "show:main").length, 2);
  assert.equal(fake.calls.at(-1), "show:main");
  assert(fake.calls.includes("hide:main"));
  assert(fake.calls.includes("replace:default-sidebar-tabs:default-top-tabs:7"));
});

test("settings denies failed writes without changing the displayed state or exposing failure details", async () => {
  const fake = fakeApi();
  const settings = createSettingsPlugin();
  await settings.activate(fake.api);
  fake.setFailSet(true);
  await settings.onEvent?.("ui.event", event("settings.color:dark"));
  await settings.onEvent?.("plugins.changed", {});
  const rendered = nodes(fake.publications.findLast((entry) => entry.id === "main")!.surface.root);
  assert.equal(fake.configuration().colorScheme, "light");
  assert(rendered.some((node) => node.key === "settings-error"));
  assert.equal(JSON.stringify(rendered).includes("private detail"), false);
});

test("settings refreshes from configuration and plugin events without polling and hides switching when neither presenter is active", async () => {
  const fake = fakeApi();
  const settings = createSettingsPlugin();
  await settings.activate(fake.api);
  const before = fake.calls.filter((call) => call === "configuration.get").length;
  await Promise.all([
    settings.onEvent?.("configuration.changed", {}),
    settings.onEvent?.("plugins.changed", {}),
  ]);
  assert.equal(fake.calls.filter((call) => call === "configuration.get").length, before + 1);
  fake.setSnapshot({ revision: 8, plugins: [plugin("other", true)] });
  await settings.onEvent?.("plugins.changed", {});
  const rendered = nodes(fake.publications.findLast((entry) => entry.id === "main")!.surface.root);
  assert.equal(
    rendered.some((node) => node.key === "settings-switch-presenter"),
    false,
  );
});

test("settings hides unusable presenter replacements and ignores unrelated actions", async () => {
  const fake = fakeApi();
  const settings = createSettingsPlugin();
  await settings.activate(fake.api);
  for (const plugins of [
    [plugin("default-sidebar-tabs")],
    [plugin("default-sidebar-tabs"), plugin("default-top-tabs")],
    [{ ...plugin("default-sidebar-tabs"), running: false }, plugin("default-top-tabs", false)],
    [plugin("default-sidebar-tabs"), { ...plugin("default-top-tabs", false), removing: true }],
  ]) {
    fake.setSnapshot({ revision: 9, plugins });
    await settings.onEvent?.("plugins.changed", {});
    assert(
      !nodes(fake.publications.findLast((entry) => entry.id === "main")!.surface.root).some(
        (node) => node.key === "settings-switch-presenter",
      ),
    );
  }
  const before = fake.calls.length;
  await settings.onEvent?.("ui.event", event("settings.color:secret"));
  await settings.onEvent?.("ui.event", event("settings.sleep:-1"));
  assert.equal(fake.calls.length, before);
});
