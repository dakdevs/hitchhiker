import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { readCompositionRecipe } from "../src/composition-recipe.ts";

test("profile composition is optional, bounded, strict, and never follows a linked recipe", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-composition-recipe-")));
  const directory = join(root, "hitchhiker-plugins");
  const path = join(directory, "composition.json");
  try {
    assert.equal(await Effect.runPromise(readCompositionRecipe(root)), undefined);
    await mkdir(directory);
    const recipe = {
      layout: "split-layout",
      slots: [{ key: "content", contributions: [{ pluginId: "split-left", id: "page" }] }],
    };
    await writeFile(path, JSON.stringify(recipe));
    assert.deepEqual(await Effect.runPromise(readCompositionRecipe(root)), recipe);
    for (const source of [
      "{",
      JSON.stringify({ ...recipe, token: "not-allowed" }),
      " ".repeat(32769),
    ]) {
      await writeFile(path, source);
      await assert.rejects(Effect.runPromise(readCompositionRecipe(root)));
    }
    const target = join(root, "external.json");
    await writeFile(target, JSON.stringify(recipe));
    await rm(path);
    await symlink(target, path);
    await assert.rejects(Effect.runPromise(readCompositionRecipe(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
