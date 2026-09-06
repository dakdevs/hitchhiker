import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserState } from "@hitchhiker/core";
import {
  createDefaultInterface,
  defaultInterfaceConfiguration,
  renderDefaultSurface,
  type DefaultInterfaceState,
} from "../src/index.ts";

const browser = (count: number): BrowserState => ({
  pages: Array.from({ length: count }, (_, index) => ({
    id: `page-${index}`,
    profileId: "main",
    url: `https://example${index}.test/`,
    title: `Page ${index}`,
    lifecycle: "loaded" as const,
    lastUsedAt: index,
    protections: { audio: false, call: false, download: false, unsavedInput: false },
  })),
  viewports: [],
});

const nodes = (node: { readonly kind: string; readonly children?: readonly unknown[] }): number =>
  1 +
  (node.children?.reduce(
    (total, child) =>
      total + nodes(child as { readonly kind: string; readonly children?: readonly unknown[] }),
    0,
  ) ?? 0);

const find = (
  node: { readonly key: string; readonly children?: readonly unknown[] },
  key: string,
):
  | {
      readonly key: string;
      readonly action?: string;
      readonly bg?: string;
      readonly width?: number;
      readonly height?: number;
    }
  | undefined =>
  node.key === key
    ? node
    : node.children
        ?.map((child) =>
          find(child as { readonly key: string; readonly children?: readonly unknown[] }, key),
        )
        .find(Boolean);

test("sidebar surface keeps pinned pages first with stable controls and a viewport binding", () => {
  const state: DefaultInterfaceState = {
    ...createDefaultInterface("main"),
    selectedPageId: "page-1",
    pageOrder: ["page-0", "page-1", "page-2"],
    pinnedPageIds: ["page-2"],
  };
  const surface = renderDefaultSurface(browser(3), state, defaultInterfaceConfiguration, {
    addressDraft: "draft",
  });
  assert.equal(surface.root.kind, "row");
  assert.equal(find(surface.root, "page-select-page-2")?.action, "page.select:page-2");
  assert.equal(find(surface.root, "page-pin-page-2")?.action, "page.unpin:page-2");
  assert.deepEqual(surface.bindings, [{ viewportId: "main-page", pageId: "page-1" }]);
  assert.equal(find(surface.root, "address")?.key, "address");
  assert.equal(find(surface.root, "address")?.action, "browser.navigate");
  assert.equal(find(surface.root, "navigate")?.action, "browser.navigate");
});

test("top placement uses a fixed horizontal tab strip and exposes no binding without a selection", () => {
  const surface = renderDefaultSurface(browser(2), createDefaultInterface("main"), {
    tabPlacement: "top",
  });
  assert.equal(surface.root.kind, "column");
  assert.deepEqual(surface.bindings, []);
  assert.equal(find(surface.root, "pages")?.height, 60);
  assert.ok(find(surface.root, "top-tab-strip"));
  assert.equal(find(surface.root, "page-page-0")?.width, 220);
  assert.ok(find(surface.root, "welcome"));
});

test("large page lists are bounded and provide slice controls", () => {
  const state: DefaultInterfaceState = {
    ...createDefaultInterface("main"),
    selectedPageId: "page-31",
    pageOrder: Array.from({ length: 80 }, (_, index) => `page-${index}`),
  };
  const surface = renderDefaultSurface(browser(80), state, defaultInterfaceConfiguration, {
    pageOffset: 30,
  });
  assert.ok(nodes(surface.root) <= 250);
  assert.equal(find(surface.root, "pages-slice-previous")?.action, "pages.slice.previous");
  assert.equal(find(surface.root, "pages-slice-next")?.action, "pages.slice.next");
  assert.equal(find(surface.root, "page-select-page-30")?.action, "page.select:page-30");
  assert.equal(find(surface.root, "page-select-page-0"), undefined);
});

test("an explicit page slice stays available when it does not contain the selection", () => {
  const state: DefaultInterfaceState = {
    ...createDefaultInterface("main"),
    selectedPageId: "page-79",
    pageOrder: Array.from({ length: 80 }, (_, index) => `page-${index}`),
  };
  const surface = renderDefaultSurface(browser(80), state, defaultInterfaceConfiguration, {
    pageOffset: 0,
  });
  assert.ok(find(surface.root, "page-select-page-0"));
  assert.equal(find(surface.root, "page-select-page-79"), undefined);
  assert.equal(find(surface.root, "pages-slice-next")?.action, "pages.slice.next");
});

test("dark rendering uses public design tokens", () => {
  const surface = renderDefaultSurface(
    browser(1),
    { ...createDefaultInterface("main"), selectedPageId: "page-0", pageOrder: ["page-0"] },
    defaultInterfaceConfiguration,
    { dark: true },
  );
  assert.equal(surface.root.bg, "#212121");
});
