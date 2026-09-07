import assert from "node:assert/strict";
import test from "node:test";
import {
  advancePluginBudget,
  createViewport,
  defaultConfiguration,
  detachViewport,
  exportConfiguration,
  grantAllows,
  importConfiguration,
  markPageUsed,
  openPage,
  parseConfiguration,
  parseGrant,
  parsePluginManifest,
  replaceViewportPage,
  revokeGrant,
  selectPageEvictions,
  sleepPages,
  type BrowserState,
  type PluginBudgetState,
  type Result,
} from "../src/index.ts";

const empty: BrowserState = { pages: [], viewports: [] };
const value = <T>(result: Result<T>): T => {
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join(" "));
  if (!result.ok) throw new Error(result.errors.join(" "));
  return result.value;
};

test("pages normalize web URLs and reject dangerous schemes", () => {
  const state = value(
    openPage(empty, { id: "first", profileId: "main", url: "example.com/a", now: 1 }),
  );
  assert.equal(state.pages[0]?.url, "https://example.com/a");
  assert.equal(
    openPage(empty, { id: "second", profileId: "main", url: "javascript:alert(1)", now: 1 }).ok,
    false,
  );
  assert.equal(
    parseConfiguration({
      ...defaultConfiguration,
      alwaysAwakeOrigins: ["https://example.com/path"],
    }).ok,
    false,
  );
});

test("two visible pages are independent and hidden unprotected pages sleep oldest first", () => {
  const first = value(openPage(empty, { id: "old", profileId: "main", url: "old.test", now: 0 }));
  const second = value(openPage(first, { id: "new", profileId: "main", url: "new.test", now: 10 }));
  const visible = value(createViewport(second, { id: "left", profileId: "main", pageId: "old" }));
  const bothVisible = value(
    createViewport(visible, { id: "right", profileId: "main", pageId: "new" }),
  );
  assert.deepEqual(
    selectPageEvictions(bothVisible, { ...defaultConfiguration, sleepAfterMs: 1 }, 100, 2),
    [],
  );
  const hidden = value(detachViewport(bothVisible, "left"));
  assert.deepEqual(
    selectPageEvictions(hidden, { ...defaultConfiguration, sleepAfterMs: 1 }, 100, 2),
    ["old"],
  );
  const sleeping = sleepPages(hidden, defaultConfiguration, ["old"]);
  assert.equal(
    createViewport(sleeping, { id: "woken", profileId: "main", pageId: "old" }).ok,
    false,
  );
  const woken = value(markPageUsed(sleeping, "old", 101));
  assert.equal(
    value(createViewport(woken, { id: "woken", profileId: "main", pageId: "old" })).viewports
      .length,
    2,
  );
  const protectedState: BrowserState = {
    ...hidden,
    pages: hidden.pages.map((page) =>
      page.id === "old"
        ? { ...page, protections: { ...page.protections, unsavedInput: true } }
        : page,
    ),
  };
  assert.deepEqual(
    selectPageEvictions(protectedState, { ...defaultConfiguration, sleepAfterMs: 1 }, 100, 2),
    [],
  );
  assert.equal(
    sleepPages(protectedState, defaultConfiguration, ["old"]).pages.find(
      (page) => page.id === "old",
    )?.lifecycle,
    "loaded",
  );
});

test("viewport replacement and detachment retain exact pages and enforce profile isolation", () => {
  const one = value(openPage(empty, { id: "one", profileId: "main", url: "one.test", now: 1 }));
  const two = value(openPage(one, { id: "two", profileId: "main", url: "two.test", now: 2 }));
  const other = value(
    openPage(two, { id: "other", profileId: "other", url: "other.test", now: 3 }),
  );
  const withView = value(createViewport(other, { id: "view", profileId: "main", pageId: "one" }));
  const before = withView.pages.map((page) => ({
    id: page.id,
    url: page.url,
    lastUsedAt: page.lastUsedAt,
  }));
  const replaced = value(replaceViewportPage(withView, "view", "two"));
  assert.deepEqual(
    replaced.pages.map((page) => ({ id: page.id, url: page.url, lastUsedAt: page.lastUsedAt })),
    before,
  );
  assert.equal(replaced.viewports[0]?.pageId, "two");
  assert.equal(replaceViewportPage(replaced, "view", "other").ok, false);
  const detached = value(detachViewport(replaced, "view"));
  assert.deepEqual(
    detached.pages.map((page) => ({ id: page.id, url: page.url, lastUsedAt: page.lastUsedAt })),
    before,
  );
  assert.deepEqual(detached.viewports, []);
});

test("grants enforce origin, expiry, revocation, full control, and separate CDP", () => {
  const scoped = value(
    parseGrant({
      id: "mcp",
      principal: "chatgpt",
      profileId: "main",
      capabilities: ["pages.read", "cdp.connect"],
      origins: ["https://example.com"],
      expiresAt: 20,
    }),
  );
  assert.equal(
    grantAllows(scoped, {
      principal: "chatgpt",
      profileId: "main",
      capability: "pages.read",
      origin: "https://example.com",
      now: 19,
    }),
    true,
  );
  assert.equal(
    grantAllows(scoped, {
      principal: "chatgpt",
      profileId: "other",
      capability: "pages.read",
      origin: "https://example.com",
      now: 19,
    }),
    false,
  );
  assert.equal(
    grantAllows(scoped, {
      principal: "chatgpt",
      profileId: "main",
      capability: "pages.read",
      origin: "https://elsewhere.com",
      now: 19,
    }),
    false,
  );
  assert.equal(
    grantAllows(scoped, {
      principal: "chatgpt",
      profileId: "main",
      capability: "cdp.connect",
      now: 19,
    }),
    true,
  );
  assert.equal(
    grantAllows(scoped, {
      principal: "chatgpt",
      profileId: "main",
      capability: "cdp.connect",
      now: 20,
    }),
    false,
  );
  assert.equal(
    grantAllows(scoped, {
      principal: "chatgpt",
      profileId: "main",
      capability: "cdp.connect",
      now: Number.NaN,
    }),
    false,
  );
  const revoked = value(revokeGrant(scoped, 2));
  assert.equal(
    grantAllows(revoked, {
      principal: "chatgpt",
      profileId: "main",
      capability: "cdp.connect",
      now: 3,
    }),
    false,
  );
  assert.equal(revokeGrant(scoped, Number.NaN).ok, false);
  const full = value(
    parseGrant({
      id: "full",
      principal: "local",
      profileId: "main",
      capabilities: ["browser.full-control"],
      origins: [],
    }),
  );
  assert.equal(
    grantAllows(full, {
      principal: "local",
      profileId: "main",
      capability: "pages.write",
      origin: "https://unlisted.test",
      now: 1,
    }),
    true,
  );
  assert.equal(
    grantAllows(full, {
      principal: "local",
      profileId: "main",
      capability: "devtools.manage",
      now: 1,
    }),
    true,
  );
  assert.equal(
    grantAllows(full, { principal: "local", profileId: "main", capability: "cdp.connect", now: 1 }),
    false,
  );
  const storage = value(
    parseGrant({
      id: "storage",
      principal: "local",
      profileId: "main",
      capabilities: ["storage.local"],
      origins: [],
    }),
  );
  assert.equal(
    grantAllows(storage, {
      principal: "local",
      profileId: "main",
      capability: "storage.local",
      now: 1,
    }),
    true,
  );
  assert.equal(
    parseGrant({
      id: "many",
      principal: "local",
      profileId: "main",
      capabilities: Array.from({ length: 33 }, () => "pages.list"),
      origins: [],
    }).ok,
    false,
  );
});

test("configuration exports only portable fields and imports reject malformed data", () => {
  const exported = value(exportConfiguration({ ...defaultConfiguration, cookies: ["secret"] }));
  assert.equal(exported.includes("cookies"), false);
  assert.equal(
    importConfiguration(
      '{"version":1,"configuration":{"colorScheme":"system","sleepAfterMs":10000,"alwaysAwakeOrigins":[]},"tokens":[]}',
    ).ok,
    false,
  );
  assert.equal(
    importConfiguration(
      '{"version":1,"configuration":{"colorScheme":"system","sleepAfterMs":10000,"alwaysAwakeOrigins":[],"token":"secret"}}',
    ).ok,
    false,
  );
  assert.equal(importConfiguration(" ".repeat(65_537)).ok, false);
});

test("plugin declarations and resource policy have deterministic bounds", () => {
  assert.equal(
    parsePluginManifest({
      id: "bad",
      version: "1.0",
      capabilities: [],
      root: { type: "script", value: "x" },
    }).ok,
    false,
  );
  assert.equal(
    parsePluginManifest({
      id: "many",
      version: "1.0.0",
      capabilities: Array.from({ length: 26 }, () => "pages"),
      root: { type: "text", value: "safe" },
    }).ok,
    false,
  );
  let budget: PluginBudgetState = { status: "healthy", breaches: 0 };
  for (let index = 0; index < 9; index += 1)
    budget = advancePluginBudget(budget, { cpuPercent: 21, memoryMb: 1 });
  assert.equal(budget.status, "suspended");
  assert.equal(advancePluginBudget(budget, { cpuPercent: 0, memoryMb: 0 }).status, "suspended");
  const warned: PluginBudgetState = { status: "warned", breaches: 3 };
  assert.equal(
    advancePluginBudget(warned, { cpuPercent: Number.NaN, memoryMb: 0 }).status,
    "warned",
  );
  assert.equal(
    advancePluginBudget(
      warned,
      { cpuPercent: 0, memoryMb: 0 },
      { maxCpuPercent: 20, maxMemoryMb: 1, consecutiveBreaches: Number.NaN },
    ).status,
    "warned",
  );
});
