import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit } from "effect";
import { decodeNativeSurface } from "../src/surface-validation.ts";

test("decodes bounded Native surfaces and rejects duplicate keys and envelope fields", async () => {
  const surface = {
    root: {
      key: "root",
      kind: "row",
      children: [
        { key: "first", kind: "text", label: "First" },
        { key: "second", kind: "text", label: "Second" },
      ],
    },
    bindings: [],
  };
  assert.deepEqual(await Effect.runPromise(decodeNativeSurface(surface)), surface);

  for (const candidate of [
    { ...surface, extra: true },
    {
      ...surface,
      root: {
        ...surface.root,
        children: [
          { key: "duplicate", kind: "text", label: "First" },
          { key: "duplicate", kind: "text", label: "Second" },
        ],
      },
    },
  ]) {
    const result = await Effect.runPromise(Effect.exit(decodeNativeSurface(candidate)));
    assert(Exit.isFailure(result));
  }
});

test("matches Native string and style bounds before committing", async () => {
  const result = await Effect.runPromise(
    Effect.exit(
      decodeNativeSurface({
        root: { key: "root", kind: "text", label: "copy", width: 8193 },
        bindings: [],
      }),
    ),
  );
  assert(Exit.isFailure(result));
});

test("rejects lone UTF-16 surrogates before Native UTF-8 decoding", async () => {
  for (const root of [
    { kind: "text", key: "\ud800", label: "Label" },
    { kind: "text", key: "text", label: "\ud800" },
    { kind: "button", key: "button", label: "Button", action: "\ud800" },
    { kind: "viewport", key: "view", viewportId: "\ud800" },
  ])
    await assert.rejects(Effect.runPromise(decodeNativeSurface({ root, bindings: [] })));
});

test("rejects page identities the native viewport broker cannot accept", async () => {
  for (const pageId of ["", "../page", "9page", "p".repeat(65), "\ud800"]) {
    await assert.rejects(
      Effect.runPromise(
        decodeNativeSurface({
          root: { kind: "viewport", key: "viewport", viewportId: "view" },
          bindings: [{ viewportId: "view", pageId }],
        }),
      ),
    );
  }
});
