import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionInstallationSnapshot,
  ExtensionManagementSnapshot,
  Json,
  PluginApi,
} from "@hitchhiker/plugin-sdk";
import { design, type NativeNode, type Surface } from "@hitchhiker/ui";

import { createExtensionManagementPlugin } from "../src/extensions.ts";

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
const job = (state: ExtensionInstallationSnapshot["state"]): ExtensionInstallationSnapshot => ({
  operationId: "a".repeat(32),
  state,
});

const fakeApi = () => {
  const publications: { readonly id: string; readonly surface: Omit<Surface, "identity"> }[] = [];
  const calls: string[] = [];
  let inventory: ExtensionManagementSnapshot = {
    readOnly: false,
    extensions: [
      {
        installationId: "extension-a",
        digest: "a".repeat(64),
        expectedChromiumId: "expected-a",
        name: "Example extension",
        version: "1.0.0",
        permissions: [],
        hostPermissions: [],
        optionalPermissions: [],
        optionalHostPermissions: [],
        state: "enabled",
      },
    ],
  };
  let jobs: readonly ExtensionInstallationSnapshot[] = [job("awaiting_review")];
  let fail = false;
  let colorScheme: "light" | "dark" = "light";
  const unexpected = (() => Promise.reject(new Error("Unexpected public API call"))) as never;
  const api: PluginApi = {
    extensions: {
      list: async () => {
        calls.push("extensions.list");
        if (fail) throw new Error("revoked");
        return inventory;
      },
      remove: async (id) => {
        calls.push(`remove:${id}`);
        if (fail) throw new Error("revoked");
        inventory = { ...inventory, extensions: [] };
        return inventory;
      },
      installation: {
        pickLocal: async () => {
          calls.push("pickLocal");
          return job("validating");
        },
        begin: unexpected,
        beginFile: unexpected,
        append: unexpected,
        finish: unexpected,
        status: unexpected,
        list: async () => {
          calls.push("installation.list");
          return jobs;
        },
        requestReview: async (id) => {
          calls.push(`review:${id}`);
          if (fail) throw new Error("revoked");
          jobs = [job("reviewing")];
          return jobs[0]!;
        },
        cancel: async (id) => {
          calls.push(`cancel:${id}`);
          if (fail) throw new Error("revoked");
          jobs = [job("canceled")];
          return jobs[0]!;
        },
      },
    },
    configuration: {
      get: async () => {
        calls.push("configuration.get");
        return { colorScheme, sleepAfterMs: 300_000, alwaysAwakeOrigins: [] };
      },
      set: unexpected,
    },
    ui: {
      publish: unexpected,
      publishLayout: unexpected,
      publishContribution: async (id, surface) => {
        calls.push(`publish:${id}`);
        publications.push({ id, surface });
        return { revision: publications.length };
      },
      withdrawContribution: unexpected,
      showRoute: async (id) => {
        calls.push(`show:${id}`);
        return { revision: 1 };
      },
      hideRoute: async (id) => {
        calls.push(`hide:${id}`);
        return { revision: 1 };
      },
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
    plugins: {
      snapshot: unexpected,
      enable: unexpected,
      disable: unexpected,
      rollback: unexpected,
      uninstall: unexpected,
      replaceSelf: unexpected,
    },
  };
  return {
    api,
    calls,
    publications,
    setColorScheme(value: "light" | "dark") {
      colorScheme = value;
    },
    setJobs(value: readonly ExtensionInstallationSnapshot[]) {
      jobs = value;
    },
    setFail(value: boolean) {
      fail = value;
    },
    setReadOnly(value: boolean) {
      inventory = { ...inventory, readOnly: value };
    },
  };
};

test("extension management publishes its route before launcher and uses only extension APIs", async () => {
  const fake = fakeApi();
  const plugin = createExtensionManagementPlugin();
  await plugin.activate(fake.api);
  assert.deepEqual(
    fake.publications.slice(0, 2).map((entry) => entry.id),
    ["main", "launcher"],
  );
  const rendered = nodes(fake.publications.at(-2)!.surface.root);
  assert(rendered.some((node) => node.key === "extension-remove-extension-a"));
  assert(rendered.some((node) => node.key.startsWith("extension-review-")));
  assert(
    fake.calls.every((call) =>
      /^(configuration\.get|extensions\.list|installation\.list|publish:)/.test(call),
    ),
  );
});

test("extension actions refresh safely and owner invalidations coalesce through the serial queue", async () => {
  const fake = fakeApi();
  const plugin = createExtensionManagementPlugin();
  await plugin.activate(fake.api);
  const id = "a".repeat(32);
  await plugin.onEvent?.("ui.event", event("extensions.open"));
  await plugin.onEvent?.("ui.event", event(`extensions.review:${id}`));
  await plugin.onEvent?.("ui.event", event(`extensions.cancel:${id}`));
  await plugin.onEvent?.("ui.event", event("extensions.remove:extension-a"));
  await plugin.onEvent?.("ui.event", event("extensions.pick-local"));
  await plugin.onEvent?.("ui.event", event("extensions.back"));
  await Promise.all([
    plugin.onEvent?.("extensions.installation.changed", {}),
    plugin.onEvent?.("extensions.installation.changed", {}),
  ]);
  assert(fake.calls.includes("show:main"));
  assert(fake.calls.includes(`review:${id}`));
  assert(fake.calls.includes(`cancel:${id}`));
  assert(fake.calls.includes("remove:extension-a"));
  assert(fake.calls.includes("pickLocal"));
  assert(fake.calls.includes("hide:main"));
  assert.equal(
    fake.calls.some((call) => call.includes("status") || call.includes("begin")),
    false,
  );
});

test("refresh failures render a safe error without exposing installation internals", async () => {
  const fake = fakeApi();
  const plugin = createExtensionManagementPlugin();
  await plugin.activate(fake.api);
  fake.setJobs([
    {
      ...job("error"),
      upload: {
        completedFiles: 1,
        totalBytes: 4,
        file: { path: "private/path", size: 4, offset: 2 },
      },
    },
  ]);
  fake.setFail(true);
  await plugin.onEvent?.("extensions.installation.changed", {});
  const rendered = nodes(fake.publications.at(-2)!.surface.root);
  assert(rendered.some((node) => node.key === "extensions-error"));
  assert.equal(JSON.stringify(fake.publications.at(-2)!.surface).includes("private/path"), false);
});

test("denied actions retain a safe error, and choosing, error, and read-only states remain actionable correctly", async () => {
  const fake = fakeApi();
  const plugin = createExtensionManagementPlugin();
  await plugin.activate(fake.api);
  fake.setJobs([job("choosing"), job("error")]);
  fake.setReadOnly(true);
  await plugin.onEvent?.("extensions.installation.changed", {});
  let rendered = nodes(fake.publications.at(-2)!.surface.root);
  assert(rendered.some((node) => node.key.startsWith("extension-cancel-")));
  assert.equal(
    rendered.some((node) => node.key === "extensions-pick-local"),
    false,
  );
  fake.setFail(true);
  await plugin.onEvent?.("ui.event", event("extensions.remove:extension-a"));
  await plugin.onEvent?.("ui.event", event(`extensions.review:${"a".repeat(32)}`));
  rendered = nodes(fake.publications.at(-2)!.surface.root);
  assert(rendered.some((node) => node.key === "extensions-error"));
  assert.equal(
    rendered.some((node) => "label" in node && node.label.includes("revoked")),
    false,
  );
});

test("configuration invalidation recolors the independent extension screen and launcher", async () => {
  const fake = fakeApi();
  const plugin = createExtensionManagementPlugin();
  await plugin.activate(fake.api);
  fake.setColorScheme("dark");
  fake.setFail(true); // Unavailable inventory must not prevent the independent palette refresh.
  await plugin.onEvent?.("configuration.changed", {});
  assert.equal(
    fake.publications.findLast((entry) => entry.id === "main")!.surface.root.bg,
    "#212121",
  );
  assert.equal(
    fake.publications.findLast((entry) => entry.id === "launcher")!.surface.root.fg,
    design.dark.foreground,
  );
  assert.equal(
    fake.calls.some((call) => call.startsWith("show:")),
    false,
  );
});
