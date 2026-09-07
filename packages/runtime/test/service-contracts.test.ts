import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Schema } from "effect";
import {
  ServicePluginDescriptorSchema,
  ServiceRequirementSchema,
  validateServiceGraph,
} from "../src/service-contracts.ts";

const contract = {
  name: "hitchhiker.page.model",
  version: "1.0.0",
  digest: "a".repeat(64),
};
const plugin = (
  id: string,
  provides: readonly string[] = [],
  requires: readonly { readonly id: string; readonly optional?: boolean }[] = [],
) => ({
  id,
  provides: provides.map((service) => ({ id: service, contract })),
  requires: requires.map((dependency) => ({ ...dependency, contract })),
});
const graph = (installed: unknown, bindings: unknown) =>
  Effect.runPromise(validateServiceGraph(installed, bindings));

test("service declaration schemas are strict and default optional requirements to false", () => {
  const requirement = Schema.decodeUnknownSync(ServiceRequirementSchema, {
    onExcessProperty: "error",
  })({ id: "pages", contract });
  assert.equal(requirement.optional, false);
  assert.throws(() =>
    Schema.decodeUnknownSync(ServicePluginDescriptorSchema, { onExcessProperty: "error" })({
      id: "plugin",
      provides: [],
      requires: [],
      extra: true,
    }),
  );
  for (const malformed of [
    { ...contract, name: "Hitchhiker.pages" },
    { ...contract, version: "1.0" },
    { ...contract, digest: "A".repeat(64) },
  ])
    assert.throws(() =>
      Schema.decodeUnknownSync(ServiceRequirementSchema)({ id: "pages", contract: malformed }),
    );
});

test("validates shared providers and returns deterministic provider-first order", async () => {
  const result = await graph(
    [
      plugin("zeta", [], [{ id: "pages" }]),
      plugin("alpha", ["pages"]),
      plugin("beta", [], [{ id: "pages" }]),
      plugin("orphan"),
    ],
    [
      { consumer: "zeta", dependency: "pages", provider: "alpha", service: "pages" },
      { consumer: "beta", dependency: "pages", provider: "alpha", service: "pages" },
    ],
  );
  assert.deepEqual(result.order, ["alpha", "beta", "orphan", "zeta"]);
  assert.equal(result.bindings.length, 2);
  assert.equal(result.plugins.length, 4);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.order));
  assert(Object.isFrozen(result.bindings));
});

test("rejects duplicate aliases, invalid endpoints, contract mismatches, and missing requirements", async () => {
  const installed = [plugin("provider", ["pages"]), plugin("consumer", [], [{ id: "pages" }])];
  const cases: readonly unknown[][] = [
    [
      { consumer: "consumer", dependency: "pages", provider: "provider", service: "pages" },
      { consumer: "consumer", dependency: "pages", provider: "provider", service: "pages" },
    ],
    [{ consumer: "consumer", dependency: "pages", provider: "missing", service: "pages" }],
    [{ consumer: "consumer", dependency: "missing", provider: "provider", service: "pages" }],
    [],
  ];
  for (const bindings of cases) await assert.rejects(graph(installed, bindings));
  await assert.rejects(
    graph(
      [
        plugin("provider", ["pages"]),
        {
          ...plugin("consumer", [], [{ id: "pages" }]),
          requires: [{ id: "pages", contract: { ...contract, digest: "b".repeat(64) } }],
        },
      ],
      [{ consumer: "consumer", dependency: "pages", provider: "provider", service: "pages" }],
    ),
  );
});

test("rejects self bindings and cycles including optional bound dependencies", async () => {
  await assert.rejects(
    graph(
      [plugin("solo", ["pages"], [{ id: "pages" }])],
      [{ consumer: "solo", dependency: "pages", provider: "solo", service: "pages" }],
    ),
  );
  await assert.rejects(
    graph(
      [plugin("alpha", ["a"], [{ id: "b", optional: true }]), plugin("beta", ["b"], [{ id: "a" }])],
      [
        { consumer: "alpha", dependency: "b", provider: "beta", service: "b" },
        { consumer: "beta", dependency: "a", provider: "alpha", service: "a" },
      ],
    ),
  );
});

test("bounds declarations and bindings", async () => {
  await assert.rejects(
    graph(
      Array.from({ length: 33 }, (_, index) => plugin(`p${index}`)),
      [],
    ),
  );
  await assert.rejects(
    graph(
      [
        plugin(
          "provider",
          Array.from({ length: 9 }, (_, i) => `s${i}`),
        ),
      ],
      [],
    ),
  );
  await assert.rejects(
    graph(
      [plugin("provider", ["pages"]), plugin("consumer", [], [{ id: "pages", optional: true }])],
      Array.from({ length: 129 }, () => ({
        consumer: "consumer",
        dependency: "pages",
        provider: "provider",
        service: "pages",
      })),
    ),
  );
});
