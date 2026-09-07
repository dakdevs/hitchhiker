import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Effect } from "effect";
import {
  loadDefaultPluginBundle,
  packagedDefaultPluginBundleDirectory,
} from "../src/default-plugin-bundle.ts";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";

const execute = promisify(execFile);
const source = fileURLToPath(new URL("../../default-plugins/", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const packagingVerifier = join(repository, "apps/browser/packaging/bundle-macos.mjs");
const ids = [
  "default-tab-model",
  "default-tab-pins",
  "default-browser-layout",
  "default-sidebar-tabs",
  "default-top-tabs",
  "default-devtools",
  "default-extension-management",
];
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
let fixtureRoot: string;
let builtBundle: string;

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "hitchhiker-bundle-reader-"));
  const buildRoot = join(fixtureRoot, "source");
  await cp(source, buildRoot, {
    recursive: true,
    filter: (path) =>
      !["dist", "node_modules", ".turbo"].includes(relative(source, path).split(sep)[0]),
  });
  await symlink(join(source, "node_modules"), join(buildRoot, "node_modules"), "dir");
  await execute(process.execPath, ["build.mjs"], { cwd: buildRoot });
  builtBundle = join(buildRoot, "dist");
});
after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

const withBundle = async (run: (directory: string) => Promise<void>) => {
  const root = await mkdtemp(join(fixtureRoot, "relocated-"));
  try {
    const module = pathToFileURL(
      join(root, "An App.app/Contents/Resources/controller/dist/main.js"),
    );
    const directory = packagedDefaultPluginBundleDirectory(module);
    assert.equal(directory, join(root, "An App.app/Contents/Resources/default-plugins"));
    await mkdir(dirname(directory), { recursive: true });
    await cp(builtBundle, directory, { recursive: true });
    await run(directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const readIndex = async (directory: string) =>
  JSON.parse(await readFile(join(directory, "bundle.json"), "utf8"));
const writeIndex = async (
  directory: string,
  index: { format: unknown; artifacts: unknown; plans: unknown; digest: string },
) => {
  index.digest = hash(
    JSON.stringify({ format: index.format, artifacts: index.artifacts, plans: index.plans }),
  );
  await writeFile(join(directory, "bundle.json"), JSON.stringify(index));
};
const verifyPackagedDefaults = (directory: string) =>
  execute(
    process.execPath,
    [packagingVerifier, "--verify-default-plugins", `--default-plugin-bundle=${directory}`],
    { cwd: repository },
  );

test("reads a real isolated build after resource relocation and stages its complete inventory", () =>
  withBundle(async (directory) => {
    const bundle = await Effect.runPromise(loadDefaultPluginBundle(directory));
    const artifacts = await Effect.runPromise(
      createPluginArtifactStore(join(fixtureRoot, "profile")),
    );
    const staged = await Effect.runPromise(Effect.forEach(bundle.packages, artifacts.stage));
    assert.deepEqual(
      staged.map((artifact) => artifact.manifest.id),
      ids,
    );
    assert.ok(staged.every((artifact) => artifact.code.length > 0));
    assert.deepEqual(
      staged.find((artifact) => artifact.manifest.id === "default-extension-management")?.manifest
        .capabilities,
      [
        "ui.compose",
        "extensions.read",
        "extensions.manage",
        "extensions.install",
        "configuration.read",
      ],
    );
    assert.deepEqual(
      bundle.plans.sidebar.enabled,
      ids.filter((id) => id !== "default-top-tabs"),
    );
    assert.deepEqual(
      bundle.plans.top.enabled,
      ids.filter((id) => id !== "default-sidebar-tabs"),
    );
    for (const placement of ["sidebar", "top"] as const) {
      const plan = bundle.plans[placement];
      assert.deepEqual(
        plan.composition?.slots.map((slot) => slot.key),
        ["tabs", "toolbar", "content"],
      );
      assert.deepEqual(
        plan.serviceBindings.map((binding) => binding.provider),
        [ids[0], ids[1], ids[2], ids[0], ids[2]],
      );
      assert.equal(
        plan.serviceBindings.some(
          (binding) =>
            binding.consumer === "default-extension-management" ||
            binding.provider === "default-extension-management",
        ),
        false,
      );
      assert.deepEqual(plan.composition?.slots[1]?.contributions, [
        { pluginId: `default-${placement}-tabs`, id: "toolbar" },
        { pluginId: "default-devtools", id: "toolbar" },
        { pluginId: "default-extension-management", id: "launcher", optional: true },
      ]);
      assert.deepEqual(plan.composition?.slots[2], {
        key: "content",
        route: {
          fallback: { pluginId: `default-${placement}-tabs`, id: "content" },
        },
        contributions: [
          { pluginId: `default-${placement}-tabs`, id: "content" },
          { pluginId: `default-${placement}-tabs`, id: "settings", optional: true },
          { pluginId: `default-${placement}-tabs`, id: "plugins", optional: true },
          { pluginId: "default-extension-management", id: "main", optional: true },
        ],
      });
    }
  }));

test("packaging accepts the complete fixed V3 manifest inventory", () =>
  withBundle(async (directory) => {
    const result = await verifyPackagedDefaults(directory);
    assert.match(result.stdout, /Verified default plugin distribution/);
  }));

test("packaging rejects rehashed excess extension authority", () =>
  withBundle(async (directory) => {
    const index = await readIndex(directory);
    const artifact = index.artifacts.find(
      ({ id }: { id: string }) => id === "default-extension-management",
    );
    assert.ok(artifact);
    const path = join(directory, artifact.manifest);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.capabilities.push("plugins.manage");
    const bytes = JSON.stringify(manifest);
    await writeFile(path, bytes);
    artifact.manifestSha256 = hash(bytes);
    await writeIndex(directory, index);
    await assert.rejects(
      verifyPackagedDefaults(directory),
      /manifest does not match the fixed V3 declaration/,
    );
  }));

test("rejects changed code before returning any bundle", () =>
  withBundle(async (directory) => {
    await writeFile(join(directory, ids[0], "plugin.js"), "changed code");
    await assert.rejects(Effect.runPromise(loadDefaultPluginBundle(directory)), /hash mismatch/);
  }));

test("rejects rehashed redirected index paths and extra fields", () =>
  withBundle(async (directory) => {
    const index = await readIndex(directory);
    index.artifacts[0].code = "../outside.js";
    await writeIndex(directory, index);
    await assert.rejects(Effect.runPromise(loadDefaultPluginBundle(directory)), /index paths/);
    index.artifacts[0].code = `${ids[0]}/plugin.js`;
    index.unexpected = true;
    await writeIndex(directory, index);
    await assert.rejects(Effect.runPromise(loadDefaultPluginBundle(directory)), /index.*invalid/);
  }));

test("rejects missing or duplicated artifact identities even with a matching digest", () =>
  withBundle(async (directory) => {
    const index = await readIndex(directory);
    const last = index.artifacts.pop();
    await writeIndex(directory, index);
    await assert.rejects(Effect.runPromise(loadDefaultPluginBundle(directory)), /inventory/);
    index.artifacts.push(last);
    index.artifacts[1] = index.artifacts[0];
    await writeIndex(directory, index);
    await assert.rejects(Effect.runPromise(loadDefaultPluginBundle(directory)), /index paths/);
  }));

test("rejects a predecessor bundle format even when its index is rehashed", () =>
  withBundle(async (directory) => {
    const index = await readIndex(directory);
    index.format = 2;
    await writeIndex(directory, index);
    await assert.rejects(Effect.runPromise(loadDefaultPluginBundle(directory)), /index is invalid/);
  }));

test("rejects a rehashed manifest with the wrong identity", () =>
  withBundle(async (directory) => {
    const index = await readIndex(directory);
    const path = join(directory, ids[0], "hitchhiker.plugin.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.id = "different-plugin";
    const bytes = JSON.stringify(manifest);
    await writeFile(path, bytes);
    index.artifacts[0].manifestSha256 = hash(bytes);
    await writeIndex(directory, index);
    await assert.rejects(
      Effect.runPromise(loadDefaultPluginBundle(directory)),
      /manifest identity/,
    );
  }));

test("rejects a rehashed recipe that changes the distribution plan", () =>
  withBundle(async (directory) => {
    const index = await readIndex(directory);
    const path = join(directory, "sidebar/composition.json");
    const composition = JSON.parse(await readFile(path, "utf8"));
    composition.layout = "different-layout";
    const bytes = JSON.stringify(composition);
    await writeFile(path, bytes);
    index.plans.sidebar.compositionSha256 = hash(bytes);
    await writeIndex(directory, index);
    await assert.rejects(
      Effect.runPromise(loadDefaultPluginBundle(directory)),
      /recipe does not match/,
    );
  }));

test("rejects symlinked files, nested directories and the bundle root", () =>
  withBundle(async (directory) => {
    const outside = join(fixtureRoot, "outside");
    await cp(directory, outside, { recursive: true });
    const code = join(directory, ids[0], "plugin.js");
    await rm(code);
    await symlink(join(outside, ids[0], "plugin.js"), code);
    await assert.rejects(Effect.runPromise(loadDefaultPluginBundle(directory)), /regular file/);
    await rm(join(directory, ids[0]), { recursive: true });
    await symlink(join(outside, ids[0]), join(directory, ids[0]), "dir");
    await assert.rejects(
      Effect.runPromise(loadDefaultPluginBundle(directory)),
      /directory is redirected/,
    );
    await rm(directory, { recursive: true });
    await symlink(outside, directory, "dir");
    await assert.rejects(
      Effect.runPromise(loadDefaultPluginBundle(`${directory}/`)),
      /directory.*redirected/,
    );
  }));

test("bounds index and code reads and rejects non-UTF-8 code", () =>
  withBundle(async (directory) => {
    const index = await readIndex(directory);
    const code = join(directory, ids[0], "plugin.js");
    const oversized = Buffer.alloc(512 * 1024 + 1, 32);
    await writeFile(code, oversized);
    index.artifacts[0].codeSha256 = hash(oversized);
    await writeIndex(directory, index);
    await assert.rejects(
      Effect.runPromise(loadDefaultPluginBundle(directory)),
      /bounded regular file/,
    );
    const invalid = Buffer.from([0xff, 0xfe]);
    await writeFile(code, invalid);
    index.artifacts[0].codeSha256 = hash(invalid);
    await writeIndex(directory, index);
    await assert.rejects(
      Effect.runPromise(loadDefaultPluginBundle(directory)),
      /code is not valid UTF-8/,
    );
    await writeFile(join(directory, "bundle.json"), " ".repeat(16 * 1024 + 1));
    await assert.rejects(
      Effect.runPromise(loadDefaultPluginBundle(directory)),
      /bounded regular file/,
    );
  }));

test("does not fall back when the selected bundle is missing or relative", async () => {
  await assert.rejects(
    Effect.runPromise(loadDefaultPluginBundle("apps/default-plugins/dist")),
    /absolute/,
  );
  await assert.rejects(
    Effect.runPromise(loadDefaultPluginBundle(join(fixtureRoot, "missing"))),
    /unavailable/,
  );
});
