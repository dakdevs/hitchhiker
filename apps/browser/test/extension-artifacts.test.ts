import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import {
  createExtensionArtifactStore,
  createExtensionArtifactStoreForTest,
  ExtensionArtifactError,
} from "../src/extension-artifacts.ts";
import { acquireProfileWriteLease, type ProfileWriteLease } from "../src/profile-write-lease.ts";

const exec = promisify(execFile);
const nativeBinary = process.env.HITCHHIKER_NATIVE_BINARY;
const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    manifest_version: 3,
    name: "__MSG_name__",
    version: "1.2.3",
    default_locale: "en",
    permissions: ["storage"],
    ...extra,
  });
const makeStore = (root: string) => Effect.runPromise(createExtensionArtifactStoreForTest(root));
const testLease = (profileRoot: string) =>
  ({
    profileRoot,
    assertHeld: Effect.void,
    withWrite: <A, E, R>(operation: Effect.Effect<A, E, R>) => operation,
  }) satisfies ProfileWriteLease;
const rejected = async (effect: Effect.Effect<unknown, ExtensionArtifactError>) => {
  const error = await Effect.runPromise(effect.pipe(Effect.flip));
  assert.ok(error instanceof ExtensionArtifactError);
};
const withSource = async (run: (profile: string, source: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-extension-artifacts-"));
  const source = join(root, "selected extension");
  await mkdir(join(source, "_locales", "en"), { recursive: true });
  await writeFile(
    join(source, "manifest.json"),
    manifest({ unknown_future_key: { title: "café" } }),
  );
  await writeFile(join(source, "worker.js"), "chrome.storage.local.set({ready: true})");
  await writeFile(join(source, "_locales", "en", "messages.json"), '{"name":{"message":"Café"}}');
  try {
    await run(join(root, "profile with spaces"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("copies Unicode/spaces/_locales and preserves unknown manifest keys without exposing the source", async () => {
  await withSource(async (profile, source) => {
    const store = await makeStore(profile);
    const artifact = await Effect.runPromise(store.stage(source));
    assert.match(artifact.installationId, /^[a-f0-9]{32}$/);
    assert.match(artifact.digest, /^[a-f0-9]{64}$/);
    assert.notEqual(artifact.directory, source);
    assert.equal(artifact.name, "__MSG_name__");
    assert.equal((await stat(artifact.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(artifact.directory, "worker.js"))).mode & 0o777, 0o600);
    assert.equal(
      await readFile(join(artifact.directory, "_locales", "en", "messages.json"), "utf8"),
      '{"name":{"message":"Café"}}',
    );
    await writeFile(join(source, "worker.js"), "changed");
    assert.equal(
      (await Effect.runPromise(store.read(artifact.installationId, artifact.digest))).version,
      "1.2.3",
    );
  });
});

test("accepts well-formed astral Unicode and rejects raw invalid UTF-8 filenames", async () => {
  await withSource(async (profile, source) => {
    await writeFile(
      join(source, "manifest.json"),
      manifest({ name: "Rocket 🚀", permissions: ["tabs🚀"] }),
    );
    await writeFile(join(source, "🚀.js"), "export {};");
    const store = await makeStore(profile);
    assert.equal((await Effect.runPromise(store.stage(source))).name, "Rocket 🚀");
    const invalid = Buffer.concat([
      Buffer.from(source),
      Buffer.from("/"),
      Buffer.from([0xc3, 0x28]),
    ]);
    try {
      await writeFile(invalid, "bad");
      await rejected(store.stage(source));
    } catch (error) {
      // APFS rejects malformed UTF-8 at creation; that is an equivalent earlier boundary.
      assert.equal((error as NodeJS.ErrnoException).code, "EILSEQ");
    }
  });
});

test("derives the Chromium ID from a manifest key before publishing", async () => {
  await withSource(async (profile, source) => {
    await writeFile(join(source, "manifest.json"), manifest({ key: "AQID" }));
    const store = await makeStore(profile);
    const artifact = await Effect.runPromise(store.stage(source));
    assert.equal(artifact.expectedChromiumId, "adjafimgpcmamlejcmfddlakenbeophh");
    assert.equal(
      (await Effect.runPromise(store.read(artifact.installationId, artifact.digest)))
        .expectedChromiumId,
      artifact.expectedChromiumId,
    );
    await writeFile(
      join(source, "manifest.json"),
      manifest({ key: "-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----" }),
    );
    assert.equal(
      (await Effect.runPromise(store.stage(source))).expectedChromiumId,
      artifact.expectedChromiumId,
    );
    for (const key of [
      "AQI",
      "AQI!",
      "-----BEGIN KEY-----AQID",
      "-----BEGIN KEY-----\n-----END KEY-----",
    ]) {
      await writeFile(join(source, "manifest.json"), manifest({ key }));
      await rejected(store.stage(source));
    }
  });
});

test("rejects invalid manifest encodings, MV2, versions, and permission declarations", async () => {
  await withSource(async (profile, source) => {
    const store = await makeStore(profile);
    for (const text of [
      manifest({ manifest_version: 2 }),
      manifest({ version: "1.2.3.4.5" }),
      manifest({ version: "65536" }),
      manifest({ version: "032" }),
      manifest({ permissions: [1] }),
    ]) {
      await writeFile(join(source, "manifest.json"), text);
      await rejected(store.stage(source));
    }
    await writeFile(
      join(source, "manifest.json"),
      '{"manifest_version":3,"name":"\\ud800","version":"1"}',
    );
    await rejected(store.stage(source));
  });
});

test("rejects nested symlinks, FIFOs, and copies hardlinks as independent bytes", async () => {
  await withSource(async (profile, source) => {
    const store = await makeStore(profile);
    const nested = join(source, "nested");
    await mkdir(nested);
    await symlink(join(source, "worker.js"), join(nested, "link.js"));
    await rejected(store.stage(source));
    await rm(join(nested, "link.js"));
    try {
      await exec("mkfifo", [join(nested, "pipe")]);
      await rejected(store.stage(source));
      await rm(join(nested, "pipe"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOSYS") throw error;
    }
    await link(join(source, "worker.js"), join(source, "worker-copy.js"));
    const artifact = await Effect.runPromise(store.stage(source));
    assert.notEqual(
      (await lstat(join(artifact.directory, "worker.js"))).ino,
      (await lstat(join(artifact.directory, "worker-copy.js"))).ino,
    );
  });
});

test("digest is deterministic for identical content, detects tampering, and disposal validates first", async () => {
  await withSource(async (profile, source) => {
    const store = await makeStore(profile);
    const first = await Effect.runPromise(store.stage(source));
    const second = await Effect.runPromise(store.stage(source));
    assert.equal(first.digest, second.digest);
    assert.notEqual(first.installationId, second.installationId);
    await writeFile(join(first.directory, "worker.js"), "tampered");
    await rejected(store.read(first.installationId, first.digest));
    await rejected(store.discardUnused(first.installationId, first.digest));
    await Effect.runPromise(store.discardUnused(second.installationId, second.digest));
    await assert.rejects(lstat(second.directory));
  });
});

test("the cross-process lock is never stale-broken and bounds the published store", async () => {
  await withSource(async (profile, source) => {
    const store = await makeStore(profile);
    const root = join(profile, "hitchhiker-extensions", "artifacts");
    await mkdir(join(root, ".lock"), { recursive: true });
    await rejected(store.stage(source));
    await rm(join(root, ".lock"), { recursive: true });
    const staged = await Promise.all(
      Array.from({ length: 16 }, () => Effect.runPromise(store.stage(source))),
    );
    assert.equal(staged.length, 16);
    await rejected(store.stage(source));
  });
});

test("startup recovery clears only abandoned private scratch once per controller lease", async () => {
  await withSource(async (profile, source) => {
    await makeStore(profile);
    const root = join(profile, "hitchhiker-extensions", "artifacts");
    const published = "a".repeat(32);
    await mkdir(join(root, `.stage-${"b".repeat(32)}`), { recursive: true });
    await mkdir(join(root, `.trash-${"c".repeat(32)}`));
    await mkdir(join(root, ".lock"));
    await mkdir(join(root, published));
    const lease = testLease(profile);
    const store = await Effect.runPromise(
      createExtensionArtifactStoreForTest(profile, { profileLease: lease }),
    );
    assert.deepEqual(await readdir(root), [published]);

    await mkdir(join(root, ".lock"));
    await Effect.runPromise(createExtensionArtifactStoreForTest(profile, { profileLease: lease }));
    await rejected(store.stage(source));
    assert.equal((await lstat(join(root, ".lock"))).isDirectory(), true);
  });
});

test("pre-replay collection reclaims orphan and removed artifacts, then seals the lease phase", async () => {
  await withSource(async (profile, source) => {
    const publishingStore = await makeStore(profile);
    const retained = await Effect.runPromise(publishingStore.stage(source));
    const removed = await Effect.runPromise(publishingStore.stage(source));
    const orphan = await Effect.runPromise(publishingStore.stage(source));
    const lease = testLease(profile);
    const store = await Effect.runPromise(
      createExtensionArtifactStoreForTest(profile, { profileLease: lease }),
    );
    assert.deepEqual(
      await Effect.runPromise(
        store.collectBeforeReplay([retained.installationId], [removed.installationId]),
      ),
      [removed.installationId],
    );
    await assert.rejects(lstat(removed.directory));
    await assert.rejects(lstat(orphan.directory));
    assert.equal((await lstat(retained.directory)).isDirectory(), true);
    await rejected(store.collectBeforeReplay([retained.installationId], []));
  });
});

test("pre-replay collection confirms a removed tombstone whose artifact was already deleted", async () => {
  await withSource(async (profile, source) => {
    const publishingStore = await makeStore(profile);
    const removed = await Effect.runPromise(publishingStore.stage(source));
    await rm(removed.directory, { recursive: true });
    const lease = testLease(profile);
    const store = await Effect.runPromise(
      createExtensionArtifactStoreForTest(profile, { profileLease: lease }),
    );
    assert.deepEqual(
      await Effect.runPromise(store.collectBeforeReplay([], [removed.installationId])),
      [removed.installationId],
    );
  });
});

test(
  "a new real controller lease reclaims an orphan published before its registry record",
  { skip: !nativeBinary || !isAbsolute(nativeBinary), timeout: 30_000 },
  async () => {
    if (!nativeBinary || !isAbsolute(nativeBinary)) return;
    await withSource(async (profile, source) => {
      const [orphan, removed] = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* acquireProfileWriteLease(profile, nativeBinary);
            const store = yield* createExtensionArtifactStore({ profileLease: lease });
            return yield* Effect.all([store.stage(source), store.stage(source)]);
          }),
        ),
      );
      const collected = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* acquireProfileWriteLease(profile, nativeBinary);
            const store = yield* createExtensionArtifactStore({ profileLease: lease });
            return yield* store.collectBeforeReplay([], [removed.installationId]);
          }),
        ),
      );
      assert.deepEqual(collected, [removed.installationId]);
      await assert.rejects(lstat(orphan.directory));
      await assert.rejects(lstat(removed.directory));
    });
  },
);

test("enforces small configured byte, entry, depth, and path limits without large fixtures", async () => {
  await withSource(async (profile, source) => {
    const store = await Effect.runPromise(
      createExtensionArtifactStoreForTest(profile, {
        fileBytes: 8,
        totalBytes: 20,
        entries: 3,
        depth: 1,
        pathBytes: 12,
        manifestBytes: 512,
      }),
    );
    await rejected(store.stage(source));
    await rm(join(source, "worker.js"));
    await writeFile(join(source, "x".repeat(20)), "x");
    await rejected(store.stage(source));
  });
});

test("rejects a mutated staged copy or source before atomic publication and cleans its private stage", async () => {
  await withSource(async (profile, source) => {
    for (const mutate of [
      async (stage: string) => writeFile(join(stage, "worker.js"), "tampered stage"),
      async (_stage: string) => writeFile(join(source, "worker.js"), "changed source"),
    ]) {
      const store = await Effect.runPromise(
        createExtensionArtifactStoreForTest(profile, { beforePublish: mutate }),
      );
      await rejected(store.stage(source));
      const root = join(profile, "hitchhiker-extensions", "artifacts");
      assert.equal(
        (await readdir(root)).some((name) => name.startsWith(".stage-")),
        false,
      );
      await writeFile(join(source, "worker.js"), "chrome.storage.local.set({ready: true})");
    }
  });
});
