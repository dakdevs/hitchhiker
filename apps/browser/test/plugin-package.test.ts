import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { readPluginPackage } from "../src/plugin-package.ts";

test("developer plugin reader accepts regular bounded files and rejects package escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-package-"));
  const packagePath = join(root, "package");
  await mkdir(join(packagePath, "dist"), { recursive: true });
  await writeFile(join(packagePath, "hitchhiker.plugin.json"), "{}");
  await writeFile(join(packagePath, "dist/plugin.js"), "compiled");
  try {
    assert.deepEqual(await Effect.runPromise(readPluginPackage(packagePath)), {
      manifest: "{}",
      code: "compiled",
    });
    await writeFile(join(root, "outside.js"), "outside must not be read");
    await rm(join(packagePath, "dist/plugin.js"));
    await symlink(join(root, "outside.js"), join(packagePath, "dist/plugin.js"));
    await assert.rejects(
      Effect.runPromise(readPluginPackage(packagePath)),
      /bounded regular files/,
    );
    await rm(join(packagePath, "dist"), { recursive: true });
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside/plugin.js"), "outside");
    await symlink(join(root, "outside"), join(packagePath, "dist"));
    await assert.rejects(
      Effect.runPromise(readPluginPackage(packagePath)),
      /bounded regular files/,
    );
    await rm(join(packagePath, "dist"));
    await mkdir(join(packagePath, "dist"));
    await writeFile(join(packagePath, "dist/plugin.js"), "x".repeat(512 * 1024 + 1));
    await assert.rejects(
      Effect.runPromise(readPluginPackage(packagePath)),
      /bounded regular files/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
