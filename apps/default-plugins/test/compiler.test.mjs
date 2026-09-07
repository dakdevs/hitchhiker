import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { Schema } from "effect";
import { compileSchemas } from "../compile-schemas.mjs";
import * as contracts from "../src/contracts.ts";
import * as input from "../src/input-contracts.ts";

const corpus = [
  null,
  true,
  false,
  0,
  -1,
  1,
  "",
  "page",
  [],
  {},
  { pageId: "page" },
  { pageId: "page", extra: true },
  { pageId: "bad/page" },
  { pageId: "page", index: 127 },
  { pageId: "page", index: 128 },
  { pageId: "page", pinned: true },
  { pageId: "page", pinned: "true" },
  { url: "https://example.com/" },
  { url: "x".repeat(8193) },
  { url: "😀".repeat(4097) },
  {
    version: 1,
    pagesRevision: 1,
    selection: { kind: "page", pageId: "page" },
    pageOrder: ["page"],
  },
  { version: 1, pagesRevision: 1, selection: null, pageOrder: ["page", "page"] },
  { version: 1, pagesRevision: 1, pinnedPageIds: ["page"] },
  { version: 1, presentation: "sidebar" },
  { presentation: "top" },
  { action: "page.select:page" },
  { action: "x".repeat(257) },
  { kind: "insert_text", text: "日本語" },
  { kind: "delete_backward", extra: true },
  { dependency: "pins", providerGeneration: 1, revision: 2, available: false },
  {
    surfaceId: "main",
    revision: 1,
    nodeId: "address",
    event: "input",
    payload: { kind: "insert_text", text: "x" },
  },
];
const accepts = (schema, value) => {
  try {
    Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
    return true;
  } catch {
    return false;
  }
};

test("standalone validators retain authored schema semantics without host globals", () => {
  for (const exports of [contracts, input]) {
    const names = Object.entries(exports)
      .filter(([, schema]) => Schema.isSchema(schema))
      .map(([name]) => name);
    const context = {};
    vm.runInNewContext(
      compileSchemas(exports).replaceAll("export const ", "var ") +
        `\nthis.validators = {${names.join(",")}};`,
      context,
      { timeout: 1000 },
    );
    for (const name of names)
      for (const value of corpus)
        assert.equal(
          context.validators[name](value),
          accepts(exports[name], value),
          `${name}: ${JSON.stringify(value).slice(0, 160)}`,
        );
  }
});
