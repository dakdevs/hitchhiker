import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  diffInstalledPluginPlans,
  InstalledPluginPlanError,
  prepareInstalledPluginPlan,
} from "../src/installed-plugin-plan.ts";

const contract = { name: "example.service", version: "1.0.0", digest: "a".repeat(64) };
const artifact = (
  id: string,
  options: {
    readonly ui?: boolean;
    readonly hash?: string;
    readonly grantId?: string;
    readonly provides?: readonly string[];
    readonly requires?: readonly { readonly id: string; readonly optional?: boolean }[];
  } = {},
) => ({
  hash: options.hash ?? "b".repeat(64),
  grantId: options.grantId ?? `${id}-grant`,
  manifest: {
    id,
    version: "1.0.0",
    name: id,
    capabilities: options.ui ? ["ui.compose"] : [],
    provides: (options.provides ?? []).map((service) => ({ id: service, contract })),
    requires: (options.requires ?? []).map((dependency) => ({
      id: dependency.id,
      optional: dependency.optional ?? false,
      contract,
    })),
  },
});
const binding = (consumer: string, dependency: string, provider: string, service = dependency) => ({
  consumer,
  dependency,
  provider,
  service,
});
const prepare = (input: unknown, entries: unknown) =>
  Effect.runPromise(prepareInstalledPluginPlan(input, entries));

test("prepares a bounded visible plan in combined provider and layout order", async () => {
  const result = await prepare(
    {
      enabled: ["provider", "layout", "contributor"],
      composition: {
        layout: "layout",
        slots: [{ key: "slot", contributions: [{ pluginId: "contributor", id: "panel" }] }],
      },
      serviceBindings: [binding("layout", "model", "provider")],
    },
    [
      artifact("provider", { provides: ["model"] }),
      artifact("layout", { ui: true, requires: [{ id: "model" }] }),
      artifact("contributor", { ui: true }),
    ],
  );
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.order, ["contributor", "provider", "layout"]);
  const preferred = await prepare(
    {
      enabled: ["layout", "contributor"],
      composition: {
        layout: "layout",
        slots: [{ key: "slot", contributions: [{ pluginId: "contributor", id: "panel" }] }],
      },
      serviceBindings: [],
    },
    [artifact("layout", { ui: true }), artifact("contributor", { ui: true })],
  );
  assert.deepEqual(preferred.order, ["layout", "contributor"]);
});

test("rejects malformed, unknown, over-capacity, invalid UI, and service cyclic plans", async () => {
  await assert.rejects(
    prepare({ enabled: [], serviceBindings: [], extra: true }, []),
    (error: unknown) => {
      assert(error instanceof InstalledPluginPlanError);
      assert.match(error.message, /Malformed installed plugin plan/);
      return true;
    },
  );
  await assert.rejects(
    prepare({ enabled: ["missing"], serviceBindings: [] }, []),
    (error: unknown) => {
      assert(error instanceof InstalledPluginPlanError);
      assert.match(error.message, /not installed/);
      return true;
    },
  );
  await assert.rejects(
    prepare({ enabled: ["ui"], serviceBindings: [] }, [artifact("ui", { ui: true })]),
  );
  await assert.rejects(
    prepare({ enabled: ["one"], composition: { layout: "one", slots: [] }, serviceBindings: [] }, [
      artifact("one"),
    ]),
  );
  await assert.rejects(
    prepare(
      {
        enabled: ["plugin-a", "plugin-b", "plugin-c", "plugin-d", "plugin-e", "plugin-f"],
        serviceBindings: [],
      },
      ["plugin-a", "plugin-b", "plugin-c", "plugin-d", "plugin-e", "plugin-f"].map((id) =>
        artifact(id),
      ),
    ),
    (error: unknown) => {
      assert(error instanceof InstalledPluginPlanError);
      assert.match(error.message, /exceeds 5 runnable plugins/);
      return true;
    },
  );
  await assert.rejects(
    prepare(
      {
        enabled: ["plugin-a", "plugin-b"],
        serviceBindings: [
          binding("plugin-a", "source-b", "plugin-b"),
          binding("plugin-b", "source-a", "plugin-a"),
        ],
      },
      [
        artifact("plugin-a", { requires: [{ id: "source-b" }], provides: ["source-a"] }),
        artifact("plugin-b", { requires: [{ id: "source-a" }], provides: ["source-b"] }),
      ],
    ),
    (error: unknown) => {
      assert(error instanceof InstalledPluginPlanError);
      assert.match(error.message, /cycle/);
      return true;
    },
  );

  const contributorProvider = await prepare(
    {
      enabled: ["layout", "contributor"],
      composition: {
        layout: "layout",
        slots: [{ key: "slot", contributions: [{ pluginId: "contributor", id: "panel" }] }],
      },
      serviceBindings: [binding("layout", "data", "contributor")],
    },
    [
      artifact("layout", { ui: true, requires: [{ id: "data" }] }),
      artifact("contributor", { ui: true, provides: ["data"] }),
    ],
  );
  assert.deepEqual(contributorProvider.order, ["contributor", "layout"]);
});

test("diff restarts required dependency closures but retains optional and slot-remapped workers", async () => {
  const baseEntries = [
    artifact("provider", { provides: ["source"] }),
    artifact("consumer", { requires: [{ id: "source" }] }),
  ];
  const previous = await prepare(
    {
      enabled: ["provider", "consumer"],
      serviceBindings: [binding("consumer", "source", "provider")],
    },
    baseEntries,
  );
  const changed = await prepare(
    {
      enabled: ["provider", "consumer"],
      serviceBindings: [binding("consumer", "source", "provider")],
    },
    [artifact("provider", { provides: ["source"], hash: "c".repeat(64) }), baseEntries[1]!],
  );
  assert.deepEqual(diffInstalledPluginPlans(previous, changed), {
    stop: ["consumer", "provider"],
    start: ["provider", "consumer"],
  });

  const optionalEntries = [
    artifact("one", { provides: ["source"] }),
    artifact("two", { provides: ["source"] }),
    artifact("consumer", { requires: [{ id: "source", optional: true }] }),
  ];
  const optionalOld = await prepare(
    {
      enabled: ["one", "two", "consumer"],
      serviceBindings: [binding("consumer", "source", "one")],
    },
    optionalEntries,
  );
  const optionalNew = await prepare(
    {
      enabled: ["one", "two", "consumer"],
      serviceBindings: [binding("consumer", "source", "two")],
    },
    optionalEntries,
  );
  assert.deepEqual(diffInstalledPluginPlans(optionalOld, optionalNew), { stop: [], start: [] });

  const requiredOld = await prepare(
    {
      enabled: ["one", "two", "consumer"],
      serviceBindings: [binding("consumer", "source", "one")],
    },
    [
      artifact("one", { provides: ["source"] }),
      artifact("two", { provides: ["source"] }),
      artifact("consumer", { requires: [{ id: "source" }] }),
    ],
  );
  const requiredNew = await prepare(
    {
      enabled: ["one", "two", "consumer"],
      serviceBindings: [binding("consumer", "source", "two")],
    },
    [
      artifact("one", { provides: ["source"] }),
      artifact("two", { provides: ["source"] }),
      artifact("consumer", { requires: [{ id: "source" }] }),
    ],
  );
  assert.deepEqual(diffInstalledPluginPlans(requiredOld, requiredNew), {
    stop: ["consumer"],
    start: ["consumer"],
  });

  const visibleEntries = [artifact("layout", { ui: true }), artifact("panel", { ui: true })];
  const visible = (
    slots: readonly { readonly key: string; readonly contributions: readonly unknown[] }[],
  ) =>
    prepare(
      {
        enabled: ["layout", "panel"],
        composition: { layout: "layout", slots },
        serviceBindings: [],
      },
      visibleEntries,
    );
  const remappedOld = await visible([
    { key: "left", contributions: [{ pluginId: "panel", id: "main" }] },
    { key: "right", contributions: [] },
  ]);
  const remappedNew = await visible([
    { key: "left", contributions: [] },
    { key: "right", contributions: [{ pluginId: "panel", id: "main" }] },
  ]);
  assert.deepEqual(diffInstalledPluginPlans(remappedOld, remappedNew), { stop: [], start: [] });
  const changedId = await visible([
    { key: "left", contributions: [{ pluginId: "panel", id: "other" }] },
    { key: "right", contributions: [] },
  ]);
  assert.deepEqual(diffInstalledPluginPlans(remappedOld, changedId), {
    stop: ["panel"],
    start: ["panel"],
  });
  const changedRole = await prepare(
    {
      enabled: ["layout", "panel"],
      composition: {
        layout: "panel",
        slots: [{ key: "left", contributions: [{ pluginId: "layout", id: "main" }] }],
      },
      serviceBindings: [],
    },
    visibleEntries,
  );
  assert.deepEqual(diffInstalledPluginPlans(remappedOld, changedRole), {
    stop: ["panel", "layout"],
    start: ["panel", "layout"],
  });
  const changedSlots = await visible([
    { key: "other", contributions: [{ pluginId: "panel", id: "main" }] },
  ]);
  assert.deepEqual(diffInstalledPluginPlans(remappedOld, changedSlots), {
    stop: ["layout"],
    start: ["layout"],
  });
});
