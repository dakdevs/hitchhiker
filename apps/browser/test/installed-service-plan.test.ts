import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { planInstalledServices, requiredDependentClosure } from "../src/installed-service-plan.ts";

const contract = (digest = "a") => ({
  name: "test.service",
  version: "1.0.0",
  digest: digest.repeat(64),
});
const entry = (
  id: string,
  options: {
    enabled?: boolean;
    provides?: readonly string[];
    requires?: readonly { id: string; optional?: boolean; digest?: string }[];
  } = {},
) => ({
  enabled: options.enabled ?? true,
  manifest: {
    id,
    version: "1.0.0",
    name: id,
    capabilities: [],
    provides: (options.provides ?? []).map((service) => ({ id: service, contract: contract() })),
    requires: (options.requires ?? []).map((dependency) => ({
      id: dependency.id,
      optional: dependency.optional ?? false,
      contract: contract(dependency.digest),
    })),
  },
});
const binding = (consumer: string, dependency: string, provider: string, service = dependency) => ({
  consumer,
  dependency,
  provider,
  service,
});
const plan = (
  entries: Parameters<typeof planInstalledServices>[0],
  bindings: Parameters<typeof planInstalledServices>[1],
) => Effect.runPromise(planInstalledServices(entries, bindings));

test("blocks required dependents transitively and returns provider-first runnable order", async () => {
  const result = await plan(
    [entry("a", { requires: [{ id: "b" }] }), entry("b", { requires: [{ id: "c" }] }), entry("c")],
    [binding("a", "b", "b"), binding("b", "c", "missing")],
  );
  assert.deepEqual(result.blocked, ["a", "b"]);
  assert.deepEqual(result.graph.order, ["c"]);
});

test("optional dependencies never block and disabled binding participants are dormant", async () => {
  const result = await plan(
    [
      entry("consumer", { requires: [{ id: "optional", optional: true }] }),
      entry("provider", { enabled: false, provides: ["optional"] }),
    ],
    [binding("consumer", "optional", "provider")],
  );
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.graph.order, ["consumer"]);
  assert.deepEqual(result.graph.bindings, []);
});

test("preserves contract, cycle, and duplicate binding validation for the runnable cohort", async () => {
  await assert.rejects(
    plan(
      [
        entry("consumer", { requires: [{ id: "source", digest: "b" }] }),
        entry("provider", { provides: ["source"] }),
      ],
      [binding("consumer", "source", "provider")],
    ),
  );
  await assert.rejects(
    plan(
      [
        entry("a", { provides: ["a"], requires: [{ id: "b", optional: true }] }),
        entry("b", { provides: ["b"], requires: [{ id: "a", optional: true }] }),
      ],
      [binding("a", "b", "b"), binding("b", "a", "a")],
    ),
  );
  await assert.rejects(
    plan(
      [entry("only")],
      [binding("missing", "source", "none"), binding("missing", "source", "other")],
    ),
  );
});

test("reports exact enabled blocked targets and expands required dependent shutdown", async () => {
  const result = await plan(
    [
      entry("provider", { provides: ["source"] }),
      entry("consumer", { requires: [{ id: "source" }] }),
      entry("disabled", { enabled: false, requires: [{ id: "source" }] }),
    ],
    [binding("consumer", "source", "provider"), binding("disabled", "source", "provider")],
  );
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.graph.order, ["provider", "consumer"]);
  assert.deepEqual([...requiredDependentClosure(result.graph, new Set(["provider"]))].sort(), [
    "consumer",
    "provider",
  ]);
});
