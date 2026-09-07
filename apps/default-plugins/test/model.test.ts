import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginApiError,
  type Json,
  type ObservedPage,
  type PluginApi,
} from "@hitchhiker/plugin-sdk";
import { createTabModelPlugin } from "../src/tab-model.ts";
import { createTabPinsPlugin } from "../src/tab-pins.ts";
import { PinState, TabState, decode } from "../src/contracts.ts";

const page = (id: string): ObservedPage => ({
  id,
  profileId: "default",
  url: `https://${id}.test/`,
  title: id,
  lifecycle: "loaded",
  protections: { audio: false, call: false, download: false, unsavedInput: false },
  loading: false,
  canGoBack: false,
  canGoForward: false,
});

const fixture = (initial: readonly string[] = ["first", "second"]) => {
  let pages = initial.map(page);
  let pagesRevision = 1;
  let storageRevision = 0;
  let value: Json = null;
  let conflictCount = 0;
  let conflictValue: Json | undefined;
  let deniedWrites = 0;
  let writes = 0;
  let opened = 0;
  let delayOpen = false;
  let delayedOpenId: string | undefined;
  let delayClose = false;
  let delayedCloseId: string | undefined;
  const published: { service: string; value: Json }[] = [];
  const unexpectedDevTools = async (): Promise<never> => {
    throw new Error("This plugin must not invoke DevTools");
  };
  const api: PluginApi = {
    extensions: {
      list: async () => {
        throw new Error("Unexpected extension API call");
      },
      remove: async () => {
        throw new Error("Unexpected extension API call");
      },
    },
    dom: { snapshot: unexpectedDevTools, click: unexpectedDevTools, fill: unexpectedDevTools },
    devtools: { status: unexpectedDevTools, show: unexpectedDevTools, close: unexpectedDevTools },
    storage: {
      async read() {
        return { revision: storageRevision, value };
      },
      async write(expectedRevision, next) {
        writes += 1;
        if (deniedWrites > 0) {
          deniedWrites -= 1;
          throw new PluginApiError("denied");
        }
        if (conflictCount > 0) {
          conflictCount -= 1;
          storageRevision += 1;
          if (conflictValue !== undefined) value = conflictValue;
          throw new PluginApiError("conflict");
        }
        assert.equal(expectedRevision, storageRevision);
        storageRevision += 1;
        value = next;
        return { revision: storageRevision };
      },
    },
    services: {
      async publish(service, next) {
        published.push({ service, value: next });
        return { revision: published.length };
      },
      async get() {
        return { available: false };
      },
      async subscribe() {
        return { available: false };
      },
      async call() {
        return null;
      },
    },
    pages: {
      async list() {
        return pages.map((candidate) => ({ ...candidate, lastUsedAt: 0 }));
      },
      async watch(request = {}) {
        if (request.revision !== undefined && request.revision !== pagesRevision)
          throw new PluginApiError("stale-snapshot");
        return { revision: pagesRevision, pages };
      },
      async open() {
        opened += 1;
        const pageId = `opened-${opened}`;
        if (delayOpen) delayedOpenId = pageId;
        else {
          pages = [...pages, page(pageId)];
          pagesRevision += 1;
        }
        return { pageId };
      },
      async navigate() {},
      async close(pageId) {
        if (delayClose) delayedCloseId = pageId;
        else {
          pages = pages.filter((candidate) => candidate.id !== pageId);
          pagesRevision += 1;
        }
      },
      async back() {},
      async forward() {},
      async reload() {},
      async stop() {},
    },
    configuration: {
      async get() {
        return { colorScheme: "system", sleepAfterMs: 300_000, alwaysAwakeOrigins: [] };
      },
      async set() {},
    },
    plugins: {
      snapshot: async () => ({ revision: 1, plugins: [] }),
      enable: async () => ({ revision: 1, plugins: [] }),
      disable: async () => ({ revision: 1, plugins: [] }),
      rollback: async () => ({ revision: 1, plugins: [] }),
      uninstall: async () => ({ revision: 1, plugins: [] }),
      replaceSelf: async () => ({ revision: 1, plugins: [] }),
    },
    ui: {
      async publish() {
        return { revision: 0 };
      },
      async publishLayout() {
        return { revision: 0 };
      },
      async publishContribution() {
        return { revision: 0 };
      },
      async withdrawContribution() {
        return { revision: 0 };
      },
      async release() {},
    },
  };
  return {
    api,
    published,
    get opened() {
      return opened;
    },
    get writes() {
      return writes;
    },
    set conflicts(count: number) {
      conflictCount = count;
    },
    set conflictState(next: Json | undefined) {
      conflictValue = next;
    },
    set denyWrites(count: number) {
      deniedWrites = count;
    },
    bumpRevision() {
      pagesRevision += 1;
    },
    add(pageId: string) {
      pages = [...pages, page(pageId)];
      pagesRevision += 1;
    },
    set delayedOpen(enabled: boolean) {
      delayOpen = enabled;
    },
    revealOpen() {
      if (delayedOpenId) {
        pages = [...pages, page(delayedOpenId)];
        delayedOpenId = undefined;
        pagesRevision += 1;
      }
    },
    set delayedClose(enabled: boolean) {
      delayClose = enabled;
    },
    revealClose() {
      if (delayedCloseId) {
        pages = pages.filter((candidate) => candidate.id !== delayedCloseId);
        delayedCloseId = undefined;
        pagesRevision += 1;
      }
    },
    remove(pageId: string) {
      pages = pages.filter((candidate) => candidate.id !== pageId);
      pagesRevision += 1;
    },
  };
};

const model = (plugin: ReturnType<typeof createTabModelPlugin>) => {
  if (!plugin.services) throw new Error("Model service is unavailable");
  return plugin.services.model;
};

const pins = (plugin: ReturnType<typeof createTabPinsPlugin>) => {
  if (!plugin.services) throw new Error("Pin service is unavailable");
  return plugin.services.pins;
};
const tabResult = (value: Json) => decode(TabState, value);
const pinResult = (value: Json) => decode(PinState, value);

test("tab model opens, selects, reorders, closes, and rejects unknown pages", async () => {
  const host = fixture();
  const plugin = createTabModelPlugin();
  await plugin.activate(host.api);

  assert.deepEqual(
    tabResult(
      await model(plugin)("reorder", { pageId: "second", index: 0 }, { id: "x", generation: 1 }),
    ).pageOrder,
    ["second", "first"],
  );
  host.add("third");
  await plugin.onPagesChanged?.(2);
  const afterExternal = host.published.at(-1);
  assert.ok(afterExternal);
  assert.deepEqual(tabResult(afterExternal.value).pageOrder, ["second", "first", "third"]);
  assert.deepEqual(
    tabResult(await model(plugin)("select", { pageId: "second" }, { id: "x", generation: 1 }))
      .selection,
    {
      kind: "page",
      pageId: "second",
    },
  );
  const opened = await model(plugin)(
    "open",
    { url: "https://opened.test" },
    { id: "x", generation: 1 },
  );
  assert.equal(host.opened, 1);
  assert.deepEqual(tabResult(opened).selection, { kind: "page", pageId: "opened-1" });
  const closed = await model(plugin)("close", { pageId: "opened-1" }, { id: "x", generation: 1 });
  assert.deepEqual(tabResult(closed).selection, { kind: "page", pageId: "third" });
  await assert.rejects(async () => {
    await model(plugin)("select", { pageId: "missing" }, { id: "x", generation: 1 });
  });
  await assert.rejects(async () => {
    await model(plugin)("select", { pageId: "bad id" }, { id: "x", generation: 1 });
  });
  assert.equal(host.opened, 1);
});

test("tab model retries storage conflicts without opening twice and restores saved state", async () => {
  const host = fixture();
  const first = createTabModelPlugin();
  await first.activate(host.api);
  host.conflicts = 1;
  const opened = await model(first)(
    "open",
    { url: "https://opened.test" },
    { id: "x", generation: 1 },
  );
  assert.equal(host.opened, 1);
  assert.deepEqual(tabResult(opened).selection, { kind: "page", pageId: "opened-1" });

  const restarted = createTabModelPlugin();
  await restarted.activate(host.api);
  const restoredEvent = host.published.at(-1);
  assert.ok(restoredEvent);
  const restored = tabResult(restoredEvent.value);
  assert.deepEqual(restored.selection, { kind: "page", pageId: "opened-1" });
  assert.deepEqual(restored.pageOrder, ["first", "second", "opened-1"]);
});

test("pins persist valid pages and remove a closed pin on refresh", async () => {
  const host = fixture();
  const plugin = createTabPinsPlugin();
  await plugin.activate(host.api);
  const set = await pins(plugin)(
    "set",
    { pageId: "first", pinned: true },
    { id: "x", generation: 1 },
  );
  assert.deepEqual(pinResult(set).pinnedPageIds, ["first"]);
  await assert.rejects(async () => {
    await pins(plugin)("set", { pageId: "missing", pinned: true }, { id: "x", generation: 1 });
  });
  host.remove("first");
  await plugin.onPagesChanged?.(2);
  assert.deepEqual(host.published.at(-1)?.value, {
    version: 1,
    pagesRevision: 2,
    pinnedPageIds: [],
  });
});

test("metadata-only notifications publish a current revision without rewriting durable feature state", async () => {
  const host = fixture();
  const plugin = createTabModelPlugin();
  await plugin.activate(host.api);
  const writes = host.writes;
  host.bumpRevision();
  await plugin.onPagesChanged?.(2);
  assert.equal(host.writes, writes);
  const notification = host.published.at(-1);
  assert.ok(notification);
  assert.equal(tabResult(notification.value).pagesRevision, 2);
});

test("a denied feature write leaves the published tab state unchanged", async () => {
  const host = fixture();
  const plugin = createTabModelPlugin();
  await plugin.activate(host.api);
  host.denyWrites = 1;
  await assert.rejects(async () => {
    await model(plugin)("select", { pageId: "first" }, { id: "x", generation: 1 });
  });
  const unchanged = host.published.at(-1);
  assert.ok(unchanged);
  assert.deepEqual(tabResult(unchanged.value).selection, {
    kind: "new-page",
  });
});

test("delayed open selects only after observation and delayed close stays removed", async () => {
  const host = fixture();
  const plugin = createTabModelPlugin();
  await plugin.activate(host.api);
  host.delayedOpen = true;
  await model(plugin)("open", { url: "https://opened.test" }, { id: "x", generation: 1 });
  const beforeOpen = host.published.at(-1);
  assert.ok(beforeOpen);
  assert.deepEqual(tabResult(beforeOpen.value).selection, { kind: "new-page" });
  await model(plugin)("select", { pageId: "first" }, { id: "x", generation: 1 });
  host.revealOpen();
  await plugin.onPagesChanged?.(2);
  const afterOpen = host.published.at(-1);
  assert.ok(afterOpen);
  assert.deepEqual(tabResult(afterOpen.value).selection, { kind: "page", pageId: "first" });
  host.delayedClose = true;
  const closed = await model(plugin)("close", { pageId: "opened-1" }, { id: "x", generation: 1 });
  assert.ok(!tabResult(closed).pageOrder.includes("opened-1"));
  await plugin.onPagesChanged?.(2);
  assert.ok(!tabResult(host.published.at(-1)!.value).pageOrder.includes("opened-1"));
  host.revealClose();
  await plugin.onPagesChanged?.(3);
});

test("conflict retries retain independent durable model and pin changes", async () => {
  const tabsHost = fixture();
  const tabs = createTabModelPlugin();
  await tabs.activate(tabsHost.api);
  tabsHost.conflictState = {
    version: 1,
    pagesRevision: 1,
    selection: { kind: "new-page" },
    pageOrder: ["second", "first"],
  };
  tabsHost.conflicts = 1;
  const selected = await model(tabs)("select", { pageId: "first" }, { id: "x", generation: 1 });
  assert.deepEqual(tabResult(selected).pageOrder, ["second", "first"]);
  assert.deepEqual(tabResult(selected).selection, { kind: "page", pageId: "first" });

  const pinsHost = fixture();
  const pinPlugin = createTabPinsPlugin();
  await pinPlugin.activate(pinsHost.api);
  pinsHost.conflictState = {
    version: 1,
    pagesRevision: 1,
    pinnedPageIds: ["second"],
  };
  pinsHost.conflicts = 1;
  const pinned = await pins(pinPlugin)(
    "set",
    { pageId: "first", pinned: true },
    { id: "x", generation: 1 },
  );
  assert.deepEqual(pinResult(pinned).pinnedPageIds, ["second", "first"]);
});
