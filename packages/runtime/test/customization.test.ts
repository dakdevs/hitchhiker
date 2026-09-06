import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit } from "effect";
import {
  decodeCustomizationRecipe,
  exportCustomizationRecipe,
  importCustomizationRecipe,
} from "../src/customization.ts";

const hash = "a".repeat(64);
const recipe = {
  version: 1,
  configuration: {
    colorScheme: "dark",
    sleepAfterMs: 10_000,
    alwaysAwakeOrigins: ["https://b.example", "https://a.example"],
  },
  interface: { tabPlacement: "sidebar" },
  plugins: [
    {
      manifest: {
        id: "alpha-plugin",
        version: "1.0.0",
        name: "Alpha",
        capabilities: ["pages.list"],
      },
      hash,
      enabled: true,
    },
  ],
} as const;
const fails = async (value: unknown) =>
  assert(Exit.isFailure(await Effect.runPromise(Effect.exit(decodeCustomizationRecipe(value)))));

test("customization recipes validate strictly and canonicalize portable fields", async () => {
  const decoded = await Effect.runPromise(decodeCustomizationRecipe(recipe));
  assert.deepEqual(decoded.configuration.alwaysAwakeOrigins, [
    "https://a.example",
    "https://b.example",
  ]);
  await fails({ ...recipe, extra: true });
  await fails({ ...recipe, version: 2 });
  await fails({ ...recipe, interface: { ...recipe.interface, secret: true } });
  await fails({ ...recipe, configuration: { ...recipe.configuration, secret: true } });
  await fails({ ...recipe, plugins: [{ ...recipe.plugins[0], secret: true }] });
  await fails({ ...recipe, plugins: [{ ...recipe.plugins[0], hash: "not-an-artifact" }] });
  await fails({
    ...recipe,
    plugins: [
      { ...recipe.plugins[0], manifest: { ...recipe.plugins[0].manifest, grantId: "private" } },
    ],
  });
  await fails({
    ...recipe,
    plugins: [
      { ...recipe.plugins[0], manifest: { ...recipe.plugins[0].manifest, capabilities: ["nope"] } },
    ],
  });
  await fails({
    ...recipe,
    plugins: [...recipe.plugins, { ...recipe.plugins[0], hash: "b".repeat(64) }],
  });
  await fails({
    ...recipe,
    plugins: Array.from({ length: 65 }, (_, index) => ({
      ...recipe.plugins[0],
      manifest: { ...recipe.plugins[0].manifest, id: `plugin-${index}` },
    })),
  });
});

test("customization recipes round trip without leaking unprojected fields", async () => {
  const source = {
    ...recipe,
    secret: "never",
    configuration: { ...recipe.configuration, credentials: "private" },
    interface: { ...recipe.interface, pages: ["private"] },
    plugins: recipe.plugins.map((plugin) => ({
      ...plugin,
      grantId: "private",
      code: "secret source",
      manifest: { ...plugin.manifest, token: "private" },
    })),
  };
  const before = JSON.stringify(source);
  const serialized = await Effect.runPromise(exportCustomizationRecipe(source));
  assert(!serialized.includes("secret"));
  assert(!serialized.includes("private"));
  const restored = await Effect.runPromise(importCustomizationRecipe(serialized));
  assert.deepEqual(
    restored.plugins.map((plugin) => plugin.manifest.id),
    ["alpha-plugin"],
  );
  const ordered = await Effect.runPromise(
    decodeCustomizationRecipe({
      ...recipe,
      plugins: [
        { ...recipe.plugins[0], manifest: { ...recipe.plugins[0].manifest, id: "zeta-plugin" } },
        recipe.plugins[0],
      ],
    }),
  );
  assert.deepEqual(
    ordered.plugins.map((plugin) => plugin.manifest.id),
    ["alpha-plugin", "zeta-plugin"],
  );
  assert.equal(JSON.stringify(source), before);
  assert(
    Exit.isFailure(
      await Effect.runPromise(Effect.exit(importCustomizationRecipe("x".repeat(131_073)))),
    ),
  );
  const oversized = {
    ...recipe,
    configuration: {
      ...recipe.configuration,
      alwaysAwakeOrigins: Array.from(
        { length: 500 },
        (_, index) => `https://${"a".repeat(240)}${index}.example`,
      ),
    },
  };
  assert(
    Exit.isFailure(await Effect.runPromise(Effect.exit(exportCustomizationRecipe(oversized)))),
  );
});
