import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { createPluginArtifactStore, PluginArtifactError } from "../src/plugin-artifacts.ts";

const manifest = {
  capabilities: ["pages.list", "ui.compose"],
  name: "Example plugin",
  version: "1.2.3",
  id: "example-plugin",
};
const code = "throw new Error('this source must never execute while staging');";

const withStore = async (
  run: (root: string, store: Awaited<ReturnType<typeof makeStore>>) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-artifacts-"));
  try {
    await run(root, await makeStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const makeStore = (root: string) => Effect.runPromise(createPluginArtifactStore(root));
const expectArtifactFailure = async (effect: Effect.Effect<unknown, PluginArtifactError>) => {
  const error = await Effect.runPromise(effect.pipe(Effect.flip));
  assert.ok(error instanceof PluginArtifactError);
};

test("stages canonical immutable artifacts without evaluating submitted code", async () => {
  await withStore(async (root, store) => {
    const staged = await Effect.runPromise(store.stage({ manifest, code }));
    assert.match(staged.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(staged.manifest, {
      id: "example-plugin",
      version: "1.2.3",
      name: "Example plugin",
      capabilities: ["pages.list", "ui.compose"],
    });
    assert.equal(staged.code, code);

    const directory = join(root, "hitchhiker-plugins", "artifacts", staged.hash);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "hitchhiker.plugin.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "plugin.js"))).mode & 0o777, 0o600);
    assert.equal(
      await readFile(join(directory, "hitchhiker.plugin.json"), "utf8"),
      '{"capabilities":["pages.list","ui.compose"],"id":"example-plugin","name":"Example plugin","version":"1.2.3"}',
    );
  });
});

test("reuses a valid artifact and refuses to overwrite a tampered artifact", async () => {
  await withStore(async (root, store) => {
    const first = await Effect.runPromise(store.stage({ manifest, code }));
    const second = await Effect.runPromise(store.stage({ manifest: { ...manifest }, code }));
    assert.equal(second.hash, first.hash);

    await writeFile(
      join(root, "hitchhiker-plugins", "artifacts", first.hash, "plugin.js"),
      "tampered",
      "utf8",
    );
    await expectArtifactFailure(store.read(first.hash));
    await expectArtifactFailure(store.stage({ manifest, code }));
    assert.equal(
      await readFile(
        join(root, "hitchhiker-plugins", "artifacts", first.hash, "plugin.js"),
        "utf8",
      ),
      "tampered",
    );
  });
});

test("rejects symlinked files and invalid artifact names", async () => {
  await withStore(async (root, store) => {
    const staged = await Effect.runPromise(store.stage({ manifest, code }));
    const directory = join(root, "hitchhiker-plugins", "artifacts", staged.hash);
    const codePath = join(directory, "plugin.js");
    const outside = join(root, "outside.js");
    await writeFile(outside, "outside", "utf8");
    await unlink(codePath);
    await symlink(outside, codePath);
    assert.equal((await lstat(codePath)).isSymbolicLink(), true);
    await expectArtifactFailure(store.read(staged.hash));
    await expectArtifactFailure(store.read("../".padEnd(64, "x")));
    await expectArtifactFailure(store.read("z".repeat(64)));
  });
});

test("enforces input limits and rejects excess manifest properties", async () => {
  await withStore(async (_root, store) => {
    await expectArtifactFailure(store.stage({ manifest, code: "x".repeat(512 * 1024 + 1) }));
    await expectArtifactFailure(store.stage({ manifest: { ...manifest, ignored: true }, code }));
  });
});

test("rejects malformed and oversized files after staging", async () => {
  await withStore(async (root, store) => {
    const staged = await Effect.runPromise(store.stage({ manifest, code }));
    const directory = join(root, "hitchhiker-plugins", "artifacts", staged.hash);
    await writeFile(join(directory, "hitchhiker.plugin.json"), "{", "utf8");
    await expectArtifactFailure(store.read(staged.hash));

    const fresh = await Effect.runPromise(store.stage({ manifest, code: `${code}// fresh` }));
    await writeFile(
      join(root, "hitchhiker-plugins", "artifacts", fresh.hash, "plugin.js"),
      "x".repeat(512 * 1024 + 1),
    );
    await expectArtifactFailure(store.read(fresh.hash));
  });
});

test("concurrent staging converges on one verified immutable artifact", async () => {
  await withStore(async (_root, store) => {
    const staged = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 12 }, () => store.stage({ manifest, code })),
        { concurrency: 12 },
      ),
    );
    assert.equal(new Set(staged.map((artifact) => artifact.hash)).size, 1);
    const artifact = await Effect.runPromise(store.read(staged[0].hash));
    assert.equal(artifact.code, code);
  });
});
