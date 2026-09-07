import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { createGrantStore, type PluginStorageAdapter } from "@hitchhiker/runtime";
import { Effect } from "effect";
import { createPluginArtifactStore, type PluginArtifact } from "../src/plugin-artifacts.ts";
import { createPluginManager, type InstalledPluginActivation } from "../src/plugin-manager.ts";

const manifest = {
  id: "storage-plugin",
  name: "Storage plugin",
  version: "1.0.0",
  capabilities: ["storage.local"] as const,
};

const withProfile = async (run: (profileRoot: string) => Promise<void>) => {
  const profileRoot = await mkdtemp(join(tmpdir(), "hitchhiker-manager-storage-"));
  try {
    await run(profileRoot);
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
};

test("storage survives update, disable, and restart, then uninstall clears it", async () => {
  await withProfile(async (profileRoot) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* createGrantStore({ directory: join(profileRoot, "grants") });
        const parent = yield* grants.issue({
          principal: "installer",
          profileId: "default",
          capabilities: ["plugins.install", "storage.local"],
          origins: [],
        });
        const initialGrant = yield* grants.delegate(parent.token, {
          principal: manifest.id,
          capabilities: manifest.capabilities,
        });
        const artifacts = yield* createPluginArtifactStore(profileRoot);
        const first = yield* artifacts.stage({ manifest, code: "one" });
        const second = yield* artifacts.stage({
          manifest: { ...manifest, version: "2.0.0" },
          code: "two",
        });
        const launches: {
          readonly version: string;
          readonly storage: PluginStorageAdapter;
          readonly value: unknown;
        }[] = [];
        const launch = (
          artifact: PluginArtifact,
          _grantId: string,
          ready: Effect.Effect<void>,
          activation: InstalledPluginActivation,
        ) =>
          Effect.gen(function* () {
            const storage = activation.storage;
            if (!storage) return yield* Effect.die("storage adapter missing");
            launches.push({
              version: artifact.manifest.version,
              storage,
              value: (yield* storage.read()).value,
            });
            yield* ready;
            return yield* Effect.never;
          });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* createPluginManager({
              profileRoot,
              grants,
              launch,
            });
            yield* manager.install(first.hash, initialGrant.id);
            assert.equal(launches.length, 1);
            assert.equal(launches[0].value, null);
            assert.deepEqual(yield* launches[0].storage.write(0, { pinned: ["page-1"] }), {
              revision: 1,
            });

            yield* manager.install(second.hash, initialGrant.id);
            assert.equal(launches.length, 2);
            assert.equal(launches[1].version, "2.0.0");
            assert.deepEqual(launches[1].value, { pinned: ["page-1"] });
            yield* manager.disable(manifest.id);
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* createPluginManager({
              profileRoot,
              grants,
              launch,
            });
            yield* manager.restore();
            assert.equal(launches.length, 2, "disabled plugins do not start during restore");
            yield* manager.enable(manifest.id);
            assert.equal(launches.length, 3);
            assert.deepEqual(launches[2].value, { pinned: ["page-1"] });

            yield* manager.uninstall(manifest.id);
            const freshGrant = yield* grants.delegate(parent.token, {
              principal: manifest.id,
              capabilities: manifest.capabilities,
            });
            yield* manager.install(first.hash, freshGrant.id);
            assert.equal(launches.length, 4);
            assert.equal(launches[3].value, null);
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});

test("storage cleanup failure leaves pending removal that startup finishes after repair", async () => {
  await withProfile(async (profileRoot) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* createGrantStore({ directory: join(profileRoot, "grants") });
        const parent = yield* grants.issue({
          principal: "installer",
          profileId: "default",
          capabilities: ["plugins.install", "storage.local"],
          origins: [],
        });
        const child = yield* grants.delegate(parent.token, {
          principal: manifest.id,
          capabilities: manifest.capabilities,
        });
        const artifacts = yield* createPluginArtifactStore(profileRoot);
        const artifact = yield* artifacts.stage({ manifest, code: "one" });
        let adapter: PluginStorageAdapter | undefined;
        const launch = (
          _artifact: PluginArtifact,
          _grantId: string,
          ready: Effect.Effect<void>,
          activation: InstalledPluginActivation,
        ) =>
          Effect.sync(() => {
            adapter = activation.storage;
          }).pipe(Effect.andThen(ready), Effect.andThen(Effect.never));

        yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* createPluginManager({ profileRoot, grants, launch });
            yield* manager.install(artifact.hash, child.id);
            assert(adapter);
            yield* adapter.write(0, { retained: true });
            const path = join(profileRoot, "hitchhiker-plugins", "storage", `${manifest.id}.json`);
            const outside = join(profileRoot, "outside.json");
            yield* Effect.promise(async () => {
              await rm(path);
              await writeFile(outside, "outside", { mode: 0o600 });
              await symlink(outside, path);
            });
            const error = yield* manager.uninstall(manifest.id).pipe(Effect.flip);
            assert.match(error.message, /remove plugin storage/i);
            const [disabled] = yield* manager.list();
            assert.equal(disabled.enabled, false);
            assert.equal(disabled.running, false);
          }),
        );

        yield* Effect.promise(() =>
          rm(join(profileRoot, "hitchhiker-plugins", "storage", `${manifest.id}.json`)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* createPluginManager({ profileRoot, grants, launch });
            yield* manager.restore();
            assert.deepEqual(yield* manager.list(), []);
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});
