import assert from "node:assert/strict";
import test from "node:test";
import {
  closePage,
  createViewport,
  detachViewport,
  openPage,
  type BrowserState,
  type Result,
} from "@hitchhiker/core";
import {
  createDefaultInterface,
  reconcileInterface,
  reorderPage,
  selectPage,
  setPagePinned,
} from "../src/index.ts";

const value = <T>(result: Result<T>): T => {
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join(" "));
  if (!result.ok) throw new Error(result.errors.join(" "));
  return result.value;
};

test("two interfaces select stable core pages independently and reject invalid pages", () => {
  const empty: BrowserState = { pages: [], viewports: [] };
  const one = value(openPage(empty, { id: "one", profileId: "main", url: "one.test", now: 1 }));
  const two = value(openPage(one, { id: "two", profileId: "main", url: "two.test", now: 2 }));
  const other = value(
    openPage(two, { id: "other", profileId: "other", url: "other.test", now: 3 }),
  );
  const left = value(createViewport(other, { id: "left", profileId: "main", pageId: "one" }));
  const both = value(createViewport(left, { id: "right", profileId: "main", pageId: "two" }));
  const firstUi = value(selectPage(both, createDefaultInterface("main"), "one"));
  const pinned = value(setPagePinned(both, firstUi, "one", true));
  const withSecondPage = value(selectPage(both, pinned, "two"));
  const selectedPinned = value(selectPage(both, withSecondPage, "one"));
  const secondUi = value(selectPage(both, createDefaultInterface("main"), "two"));
  assert.equal(selectedPinned.selectedPageId, "one");
  assert.equal(secondUi.selectedPageId, "two");
  assert.deepEqual(pinned.pinnedPageIds, ["one"]);
  assert.deepEqual(value(reorderPage(both, selectedPinned, "one", 0)).pageOrder, ["one", "two"]);
  const exactPages = both.pages.map((page) => ({
    id: page.id,
    url: page.url,
    lastUsedAt: page.lastUsedAt,
  }));
  const detached = value(detachViewport(both, "left"));
  assert.deepEqual(
    detached.pages.map((page) => ({ id: page.id, url: page.url, lastUsedAt: page.lastUsedAt })),
    exactPages,
  );
  assert.equal(selectPage(both, createDefaultInterface("other"), "one").ok, false);
  assert.equal(selectPage(both, createDefaultInterface("main"), "missing").ok, false);
  const closed = value(closePage(both, "one"));
  assert.equal(selectPage(closed, createDefaultInterface("main"), "one").ok, false);
  const reconciled = reconcileInterface(closed, selectedPinned);
  assert.deepEqual(reconciled.pageOrder, ["two"]);
  assert.deepEqual(reconciled.pinnedPageIds, []);
  assert.equal(reconciled.selectedPageId, "two");
  assert.equal(selectedPinned.selectedPageId, "one");
});
