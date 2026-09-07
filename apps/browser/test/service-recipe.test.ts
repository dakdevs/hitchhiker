import assert from "node:assert/strict";
import test from "node:test";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { readServiceRecipe } from "../src/service-recipe.ts";

const recipe = {
  bindings: [{ consumer: "consumer", dependency: "source", provider: "provider", service: "feed" }],
};

test("profile services are optional, strict, bounded, and never follow links", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-service-recipe-")));
  const directory = join(root, "hitchhiker-plugins");
  const path = join(directory, "services.json");
  try {
    assert.equal(await Effect.runPromise(readServiceRecipe(root)), undefined);
    await mkdir(directory);
    await writeFile(path, JSON.stringify(recipe));
    assert.deepEqual(await Effect.runPromise(readServiceRecipe(root)), recipe);
    for (const source of [
      "{",
      JSON.stringify({ ...recipe, grantId: "not-allowed" }),
      " ".repeat(32769),
    ]) {
      await writeFile(path, source);
      await assert.rejects(Effect.runPromise(readServiceRecipe(root)));
    }
    const target = join(root, "external.json");
    await writeFile(target, JSON.stringify(recipe));
    await rm(path);
    await symlink(target, path);
    await assert.rejects(Effect.runPromise(readServiceRecipe(root)));
    await rm(path);
    await link(target, path);
    await assert.rejects(Effect.runPromise(readServiceRecipe(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
