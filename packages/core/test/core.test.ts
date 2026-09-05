import assert from "node:assert/strict";
import test from "node:test";
import {
  activateTab,
  advancePluginBudget,
  closeTab,
  defaultConfiguration,
  exportConfiguration,
  grantAllows,
  importConfiguration,
  openTab,
  parseConfiguration,
  parseGrant,
  parsePluginManifest,
  revokeGrant,
  selectEvictions,
  setTabPinned,
  type PluginBudgetState,
} from "../src/index.ts";

test("web URLs normalize and reject dangerous schemes", () => {
  const opened = openTab({ tabs: [] }, { id: "first", url: "example.com/a", now: 1 });
  assert.equal(opened.ok, true);
  if (opened.ok) assert.equal(opened.value.tabs[0]?.url, "https://example.com/a");
  assert.equal(
    openTab({ tabs: [] }, { id: "second", url: "javascript:alert(1)", now: 1 }).ok,
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
test("eviction ignores pins but protects active, unsaved tabs", () => {
  let state = openTab({ tabs: [] }, { id: "old", url: "https://old.test", pinned: true, now: 0 });
  assert.equal(state.ok, true);
  if (!state.ok) return;
  const opened = openTab(state.value, { id: "new", url: "https://new.test", now: 10 });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const old = setTabPinned(opened.value, "old", true);
  assert.equal(old.ok, true);
  if (!old.ok) return;
  assert.deepEqual(
    selectEvictions(old.value, { ...defaultConfiguration, sleepAfterMs: 1 }, 100, 2),
    ["old"],
  );
  const active = activateTab(old.value, "old", 101);
  assert.equal(active.ok, true);
  if (active.ok)
    assert.deepEqual(
      selectEvictions(active.value, { ...defaultConfiguration, sleepAfterMs: 1 }, 200, 2),
      ["new"],
    );
});
test("grants enforce profile, origin, expiry, revocation, and separate CDP", () => {
  const parsed = parseGrant({
    id: "mcp",
    principal: "chatgpt",
    profileId: "main",
    capabilities: ["pages.read", "cdp.connect"],
    origins: ["https://example.com"],
    expiresAt: 20,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(
    grantAllows(parsed.value, {
      principal: "chatgpt",
      profileId: "main",
      capability: "pages.read",
      origin: "https://example.com",
      now: 19,
    }),
    true,
  );
  assert.equal(
    grantAllows(parsed.value, {
      principal: "chatgpt",
      profileId: "other",
      capability: "pages.read",
      origin: "https://example.com",
      now: 19,
    }),
    false,
  );
  assert.equal(
    grantAllows(parsed.value, {
      principal: "chatgpt",
      profileId: "main",
      capability: "cdp.connect",
      now: Number.NaN,
    }),
    false,
  );
  assert.equal(revokeGrant(parsed.value, Number.NaN).ok, false);
  assert.equal(
    parseGrant({
      id: "too-many",
      principal: "chatgpt",
      profileId: "main",
      capabilities: Array.from({ length: 33 }, () => "tabs.read"),
      origins: [],
    }).ok,
    false,
  );
  assert.equal(
    grantAllows(parsed.value, {
      principal: "chatgpt",
      profileId: "main",
      capability: "pages.read",
      origin: "https://elsewhere.com",
      now: 19,
    }),
    false,
  );
  assert.equal(
    grantAllows(parsed.value, {
      principal: "chatgpt",
      profileId: "main",
      capability: "cdp.connect",
      now: 19,
    }),
    true,
  );
  assert.equal(
    grantAllows(parsed.value, {
      principal: "chatgpt",
      profileId: "main",
      capability: "cdp.connect",
      now: 20,
    }),
    false,
  );
  const revoked = revokeGrant(parsed.value, 2);
  assert.equal(revoked.ok, true);
  if (!revoked.ok) return;
  assert.equal(
    grantAllows(revoked.value, {
      principal: "chatgpt",
      profileId: "main",
      capability: "cdp.connect",
      now: 3,
    }),
    false,
  );
});
test("configuration exports whitelist fields and imports reject unknown or oversized payloads", () => {
  const structuralConfiguration = { ...defaultConfiguration, cookies: ["secret"] };
  const exported = exportConfiguration(structuralConfiguration);
  assert.equal(exported.ok, true);
  if (exported.ok) assert.equal(exported.value.includes("cookies"), false);
  assert.equal(
    importConfiguration(
      '{"version":1,"configuration":{"tabLayout":"sidebar","colorScheme":"system","sleepAfterMs":10000,"alwaysAwakeOrigins":[]},"cookies":[]}',
    ).ok,
    false,
  );
  assert.equal(
    importConfiguration(
      '{"version":1,"configuration":{"tabLayout":"sidebar","colorScheme":"system","sleepAfterMs":10000,"alwaysAwakeOrigins":[],"token":"secret"}}',
    ).ok,
    false,
  );
  assert.equal(importConfiguration(" ".repeat(65_537)).ok, false);
});
test("declarative plugin proposals bound capabilities", () => {
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
      id: "too-many-capabilities",
      version: "1.0.0",
      capabilities: Array.from({ length: 26 }, () => "tabs"),
      root: { type: "text", value: "safe" },
    }).ok,
    false,
  );
});
test("closing an active tab selects and wakes its adjacent replacement", () => {
  const first = openTab({ tabs: [] }, { id: "first", url: "https://first.test", now: 1 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = openTab(first.value, { id: "second", url: "https://second.test", now: 2 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const closed = closeTab(second.value, "second", 3);
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.deepEqual(
    closed.value.tabs.map((tab) => [tab.id, tab.active, tab.lifecycle]),
    [["first", true, "loaded"]],
  );
});
test("resource policy escalates deterministically and never auto-resumes", () => {
  let state: PluginBudgetState = { status: "healthy", breaches: 0 };
  for (let i = 0; i < 9; i += 1)
    state = advancePluginBudget(state, { cpuPercent: 21, memoryMb: 1 });
  assert.equal(state.status, "suspended");
  assert.equal(advancePluginBudget(state, { cpuPercent: 0, memoryMb: 0 }).status, "suspended");
});
test("invalid telemetry and policy preserve an existing enforcement state", () => {
  const warned: PluginBudgetState = { status: "warned", breaches: 3 };
  assert.equal(
    advancePluginBudget(warned, { cpuPercent: Number.NaN, memoryMb: 0 }).status,
    "warned",
  );
  assert.equal(advancePluginBudget(warned, { cpuPercent: -1, memoryMb: 0 }).status, "warned");
  assert.equal(
    advancePluginBudget(
      warned,
      { cpuPercent: 0, memoryMb: 0 },
      { maxCpuPercent: 20, maxMemoryMb: 1, consecutiveBreaches: Number.NaN },
    ).status,
    "warned",
  );
});
