import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { EngineError } from "@hitchhiker/runtime";
import { createExtensionManager } from "../src/extension-manager.ts";
import { createExtensionManagement } from "../src/extension-management.ts";
import type { ExtensionArtifact, ExtensionArtifactStore } from "../src/extension-artifacts.ts";
import type { ProfileWriteLease } from "../src/profile-write-lease.ts";

const id = "a".repeat(32);
const digest = "b".repeat(64);
const chromiumId = "a".repeat(32);
const artifact = (
  profile: string,
  installationId = id,
  expectedChromiumId = chromiumId,
): ExtensionArtifact => ({
  installationId,
  digest,
  expectedChromiumId,
  directory: join(profile, "hitchhiker-extensions", "artifacts", installationId),
  name: "Review me",
  version: "1.0.0",
  permissions: ["storage"],
  host_permissions: ["https://example.test/*"],
  optional_permissions: [],
  optional_host_permissions: [],
});
const lease = (profileRoot: string): ProfileWriteLease => ({
  profileRoot,
  assertHeld: Effect.void,
  withWrite: (operation) => operation,
});
const store = (...values: readonly ExtensionArtifact[]): ExtensionArtifactStore => ({
  stage: () => Effect.succeed(values[0]!),
  read: (actualId, actualDigest) =>
    values.find((value) => actualId === value.installationId && actualDigest === value.digest)
      ? Effect.succeed(
          values.find(
            (value) => actualId === value.installationId && actualDigest === value.digest,
          )!,
        )
      : Effect.fail({ message: "missing", _tag: "ExtensionArtifactError" } as never),
  discardUnused: () => Effect.void,
  collectBeforeReplay: () => Effect.succeed([]),
});
const engine = (
  options: {
    readonly failLoad?: boolean;
    readonly loads?: string[];
    readonly uninstalls?: string[];
  } = {},
) =>
  ({
    loadUnpacked: (directory: string) => {
      options.loads?.push(directory);
      return options.failLoad
        ? Effect.fail(new EngineError({ code: "extension-uncertain", message: "pipe closed" }))
        : Effect.succeed(chromiumId);
    },
    uninstall: (actualId: string) => {
      options.uninstalls?.push(actualId);
      return Effect.void;
    },
  }) as never;
const seedRegistry = async (
  profile: string,
  item: ExtensionArtifact,
  state: "removing" | "removed" | "error",
  errorIntent?: "install" | "remove",
) => {
  const directory = join(profile, "hitchhiker-extensions");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(
    join(directory, "extensions.json"),
    JSON.stringify({
      version: 1,
      extensions: [
        {
          artifact: { ...item, directory: undefined },
          state,
          recoveryAttempts: 0,
          chromiumId,
          ...(errorIntent === undefined ? {} : { errorIntent, error: "previous removal failed" }),
        },
      ],
    }),
    { mode: 0o600 },
  );
  await chmod(join(directory, "extensions.json"), 0o600);
};

test("writes prepared before review, then durable enabled intent replays on a new manager", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  try {
    const item = artifact(profile);
    const first = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(item),
        engine: engine(),
      }),
    );
    const preview = await Effect.runPromise(
      first.previewLocal("/local/developer-selected-extension"),
    );
    assert.equal(preview.name, "Review me");
    assert.equal((await Effect.runPromise(first.list()))[0]?.state, "prepared");
    await Effect.runPromise(first.confirmInstall(id, digest));
    assert.equal((await Effect.runPromise(first.list()))[0]?.state, "enabled");
    const loads: string[] = [];
    const second = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(item),
        engine: engine({ loads }),
      }),
    );
    await Effect.runPromise(second.restoreBeforePages());
    assert.deepEqual(loads, [item.directory]);
    const written = JSON.parse(
      await readFile(join(profile, "hitchhiker-extensions", "extensions.json"), "utf8"),
    );
    assert.equal(written.extensions[0].state, "enabled");
    assert.equal(written.extensions[0].artifact.directory, undefined);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("uncertain install retains installing state and blocks all later mutations until restart", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  try {
    const item = artifact(profile);
    const manager = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(item),
        engine: engine({ failLoad: true }),
      }),
    );
    await Effect.runPromise(manager.previewLocal("/local/developer-selected-extension"));
    const result = await Effect.runPromise(manager.confirmInstall(id, digest).pipe(Effect.result));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.restartRequired, true);
    assert.equal((await Effect.runPromise(manager.list()))[0]?.state, "installing");
    const blocked = await Effect.runPromise(manager.remove(id).pipe(Effect.result));
    assert.equal(blocked._tag, "Failure");
    if (blocked._tag === "Failure") assert.equal(blocked.failure.restartRequired, true);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("a prior installing intent gets one startup recovery attempt, then is quarantined", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  try {
    const item = artifact(profile);
    const initial = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(item),
        engine: engine({ failLoad: true }),
      }),
    );
    await Effect.runPromise(initial.previewLocal("/local/developer-selected-extension"));
    await Effect.runPromise(initial.confirmInstall(id, digest).pipe(Effect.result));
    const recovering = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(item),
        engine: engine({ failLoad: true }),
      }),
    );
    await Effect.runPromise(recovering.restoreBeforePages().pipe(Effect.result));
    const quarantined = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(item),
        engine: engine(),
      }),
    );
    await Effect.runPromise(quarantined.restoreBeforePages());
    const entry = (await Effect.runPromise(quarantined.list()))[0];
    assert.equal(entry?.state, "error");
    assert.match(entry?.status ?? "", /explicit local retry/);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("removal intent is durable before uninstall and removed entries never replay", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  try {
    const item = artifact(profile);
    const uninstalls: string[] = [];
    const manager = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(item),
        engine: engine({ uninstalls }),
      }),
    );
    await Effect.runPromise(manager.previewLocal("/local/developer-selected-extension"));
    await Effect.runPromise(manager.confirmInstall(id, digest));
    await Effect.runPromise(manager.remove(id));
    assert.deepEqual(uninstalls, [chromiumId]);
    const loads: string[] = [];
    const restored = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: { ...store(item), collectBeforeReplay: () => Effect.succeed([id]) },
        engine: engine({ loads }),
      }),
    );
    await Effect.runPromise(restored.restoreBeforePages());
    assert.deepEqual(loads, []);
    assert.deepEqual(await Effect.runPromise(restored.list()), []);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("raw CDP read-only handoff serializes after existing work and refuses extensions", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  try {
    const item = artifact(profile);
    const uninstalls: string[] = [];
    const manager = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(item),
        engine: engine({ uninstalls }),
      }),
    );
    await Effect.runPromise(manager.previewLocal("/local/developer-selected-extension"));
    await Effect.runPromise(manager.confirmInstall(id, digest));
    await Effect.runPromise(manager.enterReadOnly());
    assert.equal(await Effect.runPromise(manager.isReadOnly()), true);
    const denied = await Effect.runPromise(
      manager.previewLocal("/local/developer-selected-extension").pipe(Effect.result),
    );
    assert.equal(denied._tag, "Failure");
    const api = createExtensionManagement(manager, () => Effect.void).forOwner(() => Effect.void);
    const inventory = await Effect.runPromise(api.list());
    assert.equal(inventory.readOnly, true);
    assert.equal(inventory.extensions[0]?.state, "enabled");
    await assert.rejects(Effect.runPromise(api.remove(id)), /read-only/);
    assert.deepEqual(uninstalls, []);
    assert.equal((await Effect.runPromise(manager.list()))[0]?.state, "enabled");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("restoring multiple enabled records retains each durable update", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  try {
    const first = artifact(profile);
    const second = artifact(profile, "c".repeat(32));
    const directory = join(profile, "hitchhiker-extensions");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "extensions.json"),
      JSON.stringify({
        version: 1,
        extensions: [
          {
            artifact: { ...first, directory: undefined },
            state: "enabled",
            recoveryAttempts: 0,
            chromiumId,
          },
          {
            artifact: { ...second, directory: undefined },
            state: "enabled",
            recoveryAttempts: 0,
            chromiumId,
          },
        ],
      }),
      { mode: 0o600 },
    );
    await chmod(join(directory, "extensions.json"), 0o600);
    const loads: string[] = [];
    const manager = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(first, second),
        engine: engine({ loads }),
      }),
    );
    await Effect.runPromise(manager.restoreBeforePages());
    assert.deepEqual(loads, [first.directory, second.directory]);
    assert.deepEqual(
      (await Effect.runPromise(manager.list())).map((entry) => entry.state),
      ["enabled", "enabled"],
    );
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("an empty existing registry is corrupt and cannot stage an artifact", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  try {
    const item = artifact(profile);
    const directory = join(profile, "hitchhiker-extensions");
    let staged = false;
    const artifacts: ExtensionArtifactStore = {
      ...store(item),
      stage: () =>
        Effect.sync(() => {
          staged = true;
          return item;
        }),
    };
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "extensions.json"), "", { mode: 0o600 });
    await chmod(join(directory, "extensions.json"), 0o600);
    const manager = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts,
        engine: engine(),
      }),
    );
    const result = await Effect.runPromise(
      manager.previewLocal("/local/developer-selected-extension").pipe(Effect.result),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(staged, false);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("a registry write failure after Chromium load poisons the manager and denies raw CDP handoff", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  const directory = join(profile, "hitchhiker-extensions");
  try {
    const item = artifact(profile);
    const manager = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(item),
        engine: {
          loadUnpacked: () =>
            Effect.promise(async () => {
              await chmod(directory, 0o500);
              return chromiumId;
            }),
          uninstall: () => Effect.void,
        } as never,
      }),
    );
    await Effect.runPromise(manager.previewLocal("/local/developer-selected-extension"));
    const installed = await Effect.runPromise(
      manager.confirmInstall(id, digest).pipe(Effect.result),
    );
    assert.equal(installed._tag, "Failure");
    if (installed._tag === "Failure") assert.equal(installed.failure.restartRequired, true);
    const raw = await Effect.runPromise(manager.enterReadOnly().pipe(Effect.result));
    assert.equal(raw._tag, "Failure");
    if (raw._tag === "Failure") assert.equal(raw.failure.restartRequired, true);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});

test("a failed prepared-record write disposes the never-submitted staged artifact", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  const directory = join(profile, "hitchhiker-extensions");
  try {
    const item = artifact(profile);
    let discarded = false;
    const artifacts: ExtensionArtifactStore = {
      read: () => Effect.succeed(item),
      stage: () =>
        Effect.promise(async () => {
          await chmod(directory, 0o500);
          return item;
        }),
      discardUnused: () =>
        Effect.sync(() => {
          discarded = true;
        }),
      collectBeforeReplay: () => Effect.succeed([]),
    };
    const manager = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts,
        engine: engine(),
      }),
    );
    const result = await Effect.runPromise(
      manager.previewLocal("/local/developer-selected-extension").pipe(Effect.result),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(discarded, true);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});

test("a definite Chromium rejection remains reviewable and can be explicitly retried", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  try {
    const item = artifact(profile);
    let attempts = 0;
    const manager = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(item),
        engine: {
          loadUnpacked: () =>
            ++attempts === 1
              ? Effect.fail(
                  new EngineError({ code: "extension-rejected", message: "bad manifest" }),
                )
              : Effect.succeed(chromiumId),
          uninstall: () => Effect.void,
        } as never,
      }),
    );
    await Effect.runPromise(manager.previewLocal("/local/developer-selected-extension"));
    const rejected = await Effect.runPromise(
      manager.confirmInstall(id, digest).pipe(Effect.result),
    );
    assert.equal(rejected._tag, "Failure");
    if (rejected._tag === "Failure") assert.equal(rejected.failure.restartRequired, undefined);
    const errored = (await Effect.runPromise(manager.list()))[0];
    assert.equal(errored?.state, "error");
    assert.equal(errored?.errorIntent, "install");
    assert.equal((await Effect.runPromise(manager.reviewPrepared(id, digest))).name, item.name);
    await Effect.runPromise(manager.confirmInstall(id, digest));
    assert.equal((await Effect.runPromise(manager.list()))[0]?.state, "enabled");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("cancelling a prepared review removes its registry record before artifact cleanup", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  try {
    const item = artifact(profile);
    let registryRemovedBeforeDiscard = false;
    const artifacts: ExtensionArtifactStore = {
      ...store(item),
      discardUnused: () =>
        Effect.promise(async () => {
          const parsed = JSON.parse(
            await readFile(join(profile, "hitchhiker-extensions", "extensions.json"), "utf8"),
          );
          registryRemovedBeforeDiscard = parsed.extensions.length === 0;
        }),
    };
    const manager = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts,
        engine: engine(),
      }),
    );
    await Effect.runPromise(manager.previewLocal("/local/developer-selected-extension"));
    await Effect.runPromise(manager.cancelPreview(id, digest));
    assert.equal(registryRemovedBeforeDiscard, true);
    assert.deepEqual(await Effect.runPromise(manager.list()), []);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("fresh-engine recovery converges interrupted removals and already-absent tombstones without replay", async () => {
  for (const scenario of [
    { label: "crash before uninstall", state: "removing" as const },
    { label: "crash after uninstall before registry save", state: "removing" as const },
    {
      label: "definite prior removal rejection",
      state: "error" as const,
      errorIntent: "remove" as const,
    },
  ]) {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
    try {
      const item = artifact(profile);
      await seedRegistry(profile, item, scenario.state, scenario.errorIntent);
      const loads: string[] = [];
      const uninstalls: string[] = [];
      const manager = await Effect.runPromise(
        createExtensionManager({
          profileRoot: profile,
          lease: lease(profile),
          // This models store confirmation that the artifact was deleted or
          // was already absent after a crash.
          artifacts: { ...store(item), collectBeforeReplay: () => Effect.succeed([id]) },
          engine: engine({ loads, uninstalls }),
        }),
      );
      await Effect.runPromise(manager.restoreBeforePages());
      assert.deepEqual(loads, [], scenario.label);
      assert.deepEqual(uninstalls, [], scenario.label);
      assert.deepEqual(await Effect.runPromise(manager.list()), [], scenario.label);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
});

test("a corrupt registry-directory symlink never changes the target mode", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  const profile = join(root, "profile");
  const target = join(root, "unrelated-target");
  try {
    await mkdir(profile, { mode: 0o700 });
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    await symlink(target, join(profile, "hitchhiker-extensions"));
    const manager = await Effect.runPromise(
      createExtensionManager({
        profileRoot: profile,
        lease: lease(profile),
        artifacts: store(artifact(profile)),
        engine: engine(),
      }).pipe(Effect.result),
    );
    assert.equal(manager._tag, "Failure");
    assert.equal((await stat(target)).mode & 0o777, 0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removal rechecks revoked authority after the manager queue without writing intent", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let hold = false;
        let allowed = true;
        let checks = 0;
        const uninstalls: string[] = [];
        const manager = yield* createExtensionManager({
          profileRoot: profile,
          lease: {
            ...lease(profile),
            withWrite: (operation) =>
              Effect.suspend(() =>
                hold
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(operation),
                    )
                  : operation,
              ),
          },
          artifacts: store(artifact(profile)),
          engine: engine({ uninstalls }),
        });
        yield* manager.previewLocal("/local/developer-selected-extension");
        yield* manager.confirmInstall(id, digest);
        const before = yield* Effect.promise(() =>
          readFile(join(profile, "hitchhiker-extensions", "extensions.json"), "utf8"),
        );
        hold = true;
        const reader = yield* Effect.forkChild(manager.list());
        yield* Deferred.await(entered);
        const removal = yield* Effect.forkChild(
          manager
            .remove(
              id,
              Effect.suspend(() => {
                checks += 1;
                return allowed ? Effect.void : Effect.fail("revoked");
              }),
            )
            .pipe(Effect.result),
        );
        yield* Effect.yieldNow;
        assert.equal(checks, 0);
        allowed = false;
        hold = false;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(reader);
        assert.equal((yield* Fiber.join(removal))._tag, "Failure");
        assert.equal(checks, 1);
        assert.deepEqual(uninstalls, []);
        assert.equal(
          yield* Effect.promise(() =>
            readFile(join(profile, "hitchhiker-extensions", "extensions.json"), "utf8"),
          ),
          before,
        );
      }).pipe(Effect.scoped, Effect.timeout(5_000)),
    );
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("successful removal clears a prior install or remove error intent", async () => {
  for (const intent of ["install", "remove"] as const) {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-extension-manager-")));
    try {
      const item = artifact(profile);
      await seedRegistry(profile, item, "error", intent);
      const uninstalls: string[] = [];
      const manager = await Effect.runPromise(
        createExtensionManager({
          profileRoot: profile,
          lease: lease(profile),
          artifacts: store(item),
          engine: engine({ uninstalls }),
        }),
      );
      await Effect.runPromise(manager.remove(id, Effect.void));
      const entry = (await Effect.runPromise(manager.list()))[0];
      assert.equal(entry?.state, "removed");
      assert.equal(entry?.errorIntent, undefined);
      assert.deepEqual(uninstalls, [chromiumId]);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
});
