import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { button, column, input, text, viewport, type NativeNode } from "@hitchhiker/ui";
import { composePluginSurface, routeCompositionEvent } from "../src/composition.ts";

const owner = (id: string, generation = 1) => ({ id, generation });
const surface = (root: NativeNode, pageId?: string) => ({
  root,
  bindings: pageId ? [{ viewportId: "view", pageId }] : [],
});
const fixture = () => ({
  layout: {
    owner: owner("layout"),
    surface: surface(column("root", [column("tools", []), column("body", [])])),
  },
  slots: [
    {
      key: "tools",
      contributions: [
        {
          owner: owner("first-plugin"),
          id: "tools",
          surface: surface(button("control", "First", "activate")),
        },
        {
          owner: owner("second-plugin"),
          id: "tools",
          surface: surface(button("control", "Second", "activate")),
        },
      ],
    },
  ],
});
const flattened = (root: NativeNode): NativeNode[] => [
  root,
  ...("children" in root ? root.children.flatMap(flattened) : []),
];

test("composition namespaces colliding local controls and routes only matching actions", async () => {
  const result = await Effect.runPromise(composePluginSurface(fixture()));
  const controls = flattened(result.surface.root).filter((node) => node.kind === "button");
  assert.deepEqual(
    controls.map((node) => node.label),
    ["First", "Second"],
  );
  assert.notEqual(controls[0].key, controls[1].key);
  assert.notEqual(controls[0].action, controls[1].action);
  const event = {
    surfaceId: "main" as const,
    revision: 1,
    event: "press" as const,
    nodeId: controls[0].key,
    payload: { action: controls[0].action },
  };
  const routed = routeCompositionEvent(result.routes, event);
  assert.equal(routed?.owner.id, "first-plugin");
  assert.equal(routed?.event.nodeId, "control");
  assert.equal(routed?.event.payload.action, "activate");
  assert.equal(
    routeCompositionEvent(result.routes, { ...event, payload: { action: controls[1].action } }),
    undefined,
  );
  assert.equal(routeCompositionEvent(result.routes, { ...event, nodeId: "control" }), undefined);
  assert.equal(routeCompositionEvent(result.routes, { ...event, event: "input" }), undefined);
});

test("unrelated fragment updates preserve keys, layout identity and viewport bindings", async () => {
  const compose = (label: string, generation = 1) =>
    composePluginSurface({
      ...fixture(),
      slots: [
        {
          key: "tools",
          contributions: [
            {
              owner: owner("tools-plugin", generation),
              id: "tools",
              surface: surface(input("input", "Address", label)),
            },
          ],
        },
        {
          key: "body",
          contributions: [
            {
              owner: owner("page-plugin"),
              id: "page",
              surface: surface(viewport("page", "view"), "live-page"),
            },
          ],
        },
      ],
    });
  const a = await Effect.runPromise(compose("a"));
  const b = await Effect.runPromise(compose("b"));
  assert.deepEqual(a.surface.bindings, b.surface.bindings);
  assert.equal(a.surface.bindings[0].pageId, "live-page");
  assert.equal(a.surface.identity, b.surface.identity);
  assert.deepEqual([...a.routes.keys()], [...b.routes.keys()]);
  const restarted = await Effect.runPromise(compose("b", 2));
  const oldKey = [...a.routes.keys()][0];
  assert.equal(restarted.routes.has(oldKey), false);
  assert.equal(
    routeCompositionEvent(restarted.routes, {
      surfaceId: "main",
      revision: 2,
      nodeId: oldKey,
      event: "input",
      payload: { text: "stale" },
    }),
    undefined,
  );
});

test("slot order is explicit and missing, occupied or duplicated slots are rejected", async () => {
  const original = fixture();
  original.slots[0].contributions.reverse();
  const result = await Effect.runPromise(composePluginSurface(original));
  assert.deepEqual(
    flattened(result.surface.root)
      .filter((node) => node.kind === "button")
      .map((node) => node.label),
    ["Second", "First"],
  );
  for (const bad of [
    { ...fixture(), slots: [{ ...fixture().slots[0], key: "missing" }] },
    { ...fixture(), slots: [{ ...fixture().slots[0], key: "root" }] },
    { ...fixture(), slots: [fixture().slots[0], fixture().slots[0]] },
  ])
    await assert.rejects(Effect.runPromise(composePluginSurface(bad)));
});

test("duplicate contributions and conflicting owner generations fail before composition", async () => {
  const f = fixture();
  for (const contributions of [
    [f.slots[0].contributions[0], f.slots[0].contributions[0]],
    [
      f.slots[0].contributions[0],
      { ...f.slots[0].contributions[0], id: "other", owner: owner("first-plugin", 2) },
    ],
  ])
    await assert.rejects(
      Effect.runPromise(composePluginSurface({ ...f, slots: [{ key: "tools", contributions }] })),
    );
});

test("expanded surfaces retain global node and distinct-page limits", async () => {
  const contributions = Array.from({ length: 3 }, (_, i) => ({
    owner: owner(`plugin-${i}`),
    id: "content",
    surface: surface(
      column(
        "list",
        Array.from({ length: 90 }, (_, j) => text(`item-${j}`, "Item")),
      ),
    ),
  }));
  await assert.rejects(
    Effect.runPromise(
      composePluginSurface({ ...fixture(), slots: [{ key: "body", contributions }] }),
    ),
  );
  const repeatedPage = ["first-plugin", "second-plugin"].map((id) => ({
    owner: owner(id),
    id: "page",
    surface: surface(viewport("page", "view"), "same-page"),
  }));
  await assert.rejects(
    Effect.runPromise(
      composePluginSurface({ ...fixture(), slots: [{ key: "body", contributions: repeatedPage }] }),
    ),
  );
  const distinct = repeatedPage.map((entry, i) => ({
    ...entry,
    surface: surface(viewport("page", "view"), `page-${i}`),
  }));
  const valid = await Effect.runPromise(
    composePluginSurface({ ...fixture(), slots: [{ key: "body", contributions: distinct }] }),
  );
  assert.equal(new Set(valid.surface.bindings.map((binding) => binding.viewportId)).size, 2);
});

test("malformed surfaces and owner configuration are rejected", async () => {
  for (const value of [
    { ...fixture(), extra: true },
    { ...fixture(), layout: { ...fixture().layout, owner: owner("layout", 0) } },
    {
      ...fixture(),
      layout: {
        ...fixture().layout,
        surface: {
          root: { kind: "text", key: "x", label: "x", path: "/tmp/secret" },
          bindings: [],
        },
      },
    },
  ])
    await assert.rejects(Effect.runPromise(composePluginSurface(value)));
});
