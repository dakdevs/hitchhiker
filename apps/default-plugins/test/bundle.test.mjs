import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = join(directory, "..");
const bundleDirectory = join(packageDirectory, "dist");
const artifactIds = [
  "default-tab-model",
  "default-tab-pins",
  "default-browser-layout",
  "default-sidebar-tabs",
  "default-top-tabs",
  "default-devtools",
  "default-extension-management",
  "default-settings",
  "default-plugin-management",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("build emits the fixed, digest-bound default plugin bundle", async () => {
  await execute(process.execPath, ["build.mjs"], { cwd: packageDirectory });
  const indexPath = join(bundleDirectory, "bundle.json");
  const firstIndex = await readFile(indexPath);
  await execute(process.execPath, ["build.mjs"], { cwd: packageDirectory });
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  assert.deepEqual(
    await readFile(indexPath),
    firstIndex,
    "repeated builds must preserve the index",
  );
  assert.deepEqual(Object.keys(index).sort(), ["artifacts", "digest", "format", "plans"]);
  assert.equal(index.format, 4);
  assert.equal(
    index.digest,
    sha256(
      JSON.stringify({ format: index.format, artifacts: index.artifacts, plans: index.plans }),
    ),
  );
  assert.deepEqual(
    index.artifacts.map(({ id }) => id),
    artifactIds,
  );
  for (const artifact of index.artifacts) {
    assert.deepEqual(Object.keys(artifact).sort(), [
      "code",
      "codeSha256",
      "id",
      "manifest",
      "manifestSha256",
    ]);
    assert.equal(artifact.manifest, `${artifact.id}/hitchhiker.plugin.json`);
    assert.equal(artifact.code, `${artifact.id}/plugin.js`);
    const [manifest, code] = await Promise.all([
      readFile(join(bundleDirectory, artifact.manifest)),
      readFile(join(bundleDirectory, artifact.code)),
    ]);
    assert.equal(sha256(manifest), artifact.manifestSha256);
    assert.equal(sha256(code), artifact.codeSha256);
    assert.equal(JSON.parse(manifest).id, artifact.id);
  }
  for (const placement of ["sidebar", "top"]) {
    const plan = index.plans[placement];
    assert.deepEqual(Object.keys(plan).sort(), [
      "composition",
      "compositionSha256",
      "services",
      "servicesSha256",
    ]);
    assert.equal(plan.composition, `${placement}/composition.json`);
    assert.equal(plan.services, `${placement}/services.json`);
    const [composition, services] = await Promise.all([
      readFile(join(bundleDirectory, plan.composition)),
      readFile(join(bundleDirectory, plan.services)),
    ]);
    assert.equal(sha256(composition), plan.compositionSha256);
    assert.equal(sha256(services), plan.servicesSha256);
    const presenter = `default-${placement}-tabs`;
    const recipe = JSON.parse(composition);
    const serviceRecipe = JSON.parse(services);
    assert.equal(recipe.layout, "default-browser-layout");
    assert.deepEqual(
      recipe.slots.map((slot) => [slot.key, slot.contributions]),
      [
        ["tabs", [{ pluginId: presenter, id: "tabs" }]],
        [
          "toolbar",
          [
            { pluginId: presenter, id: "toolbar" },
            { pluginId: "default-devtools", id: "toolbar" },
            { pluginId: "default-extension-management", id: "launcher", optional: true },
            { pluginId: "default-settings", id: "launcher", optional: true },
            { pluginId: "default-plugin-management", id: "launcher", optional: true },
          ],
        ],
        [
          "content",
          [
            { pluginId: presenter, id: "content" },
            { pluginId: "default-extension-management", id: "main", optional: true },
            { pluginId: "default-settings", id: "main", optional: true },
            { pluginId: "default-plugin-management", id: "main", optional: true },
          ],
        ],
      ],
    );
    assert.deepEqual(recipe.slots[2].route, { fallback: { pluginId: presenter, id: "content" } });
    assert.deepEqual(serviceRecipe.bindings, [
      { consumer: presenter, dependency: "model", provider: "default-tab-model", service: "model" },
      { consumer: presenter, dependency: "pins", provider: "default-tab-pins", service: "pins" },
      {
        consumer: presenter,
        dependency: "layout",
        provider: "default-browser-layout",
        service: "layout",
      },
      {
        consumer: "default-devtools",
        dependency: "model",
        provider: "default-tab-model",
        service: "model",
      },
      {
        consumer: "default-devtools",
        dependency: "layout",
        provider: "default-browser-layout",
        service: "layout",
      },
    ]);
  }
});
