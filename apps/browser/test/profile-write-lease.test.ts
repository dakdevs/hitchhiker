import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Exit, Fiber, Scope } from "effect";
import { acquireProfileWriteLease } from "../src/profile-write-lease.ts";

const executable = process.env.HITCHHIKER_NATIVE_BINARY;
const native = { skip: !executable || process.platform !== "darwin", timeout: 15_000 };
const acquire = (profile: string, scope: Scope.Scope) =>
  Effect.runPromise(
    acquireProfileWriteLease(profile, executable!).pipe(Effect.provideService(Scope.Scope, scope)),
  );
const close = (scope: Scope.Scope) => Effect.runPromise(Scope.close(scope, Exit.void));
const cannotAcquire = async (profile: string) => {
  const result = await Effect.runPromise(
    acquireProfileWriteLease(profile, executable!).pipe(Effect.scoped, Effect.result),
  );
  assert.equal(result._tag, "Failure");
};

test(
  "the parent descriptor retains the kernel lease after its native helper exits",
  native,
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "hitchhiker-controller-lease-"));
    const scope = await Effect.runPromise(Scope.make());
    try {
      const lease = await acquire(profile, scope);
      await Effect.runPromise(lease.assertHeld);
      await cannotAcquire(profile);
      await close(scope);
      const next = await Effect.runPromise(Scope.make());
      try {
        await acquire(profile, next);
        assert.equal(
          (await stat(join(profile, ".hitchhiker-controller.lock"))).mode & 0o777,
          0o600,
        );
      } finally {
        await close(next);
      }
    } finally {
      await close(scope);
      await rm(profile, { recursive: true, force: true });
    }
  },
);

test(
  "closing and cancellation wait for actual filesystem work before releasing the lease",
  native,
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "hitchhiker-controller-drain-"));
    const scope = await Effect.runPromise(Scope.make());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    try {
      const lease = await acquire(profile, scope);
      const writer = Effect.runFork(
        lease.withWrite(
          Effect.promise(async () => {
            await writeFile(join(profile, "transaction"), "started");
            started();
            await gate;
            await writeFile(join(profile, "transaction"), "settled");
          }),
        ),
      );
      await pending;
      let cancelled = false;
      const cancellation = Effect.runPromise(Fiber.interrupt(writer)).then(() => {
        cancelled = true;
      });
      let closed = false;
      const closing = close(scope).then(() => {
        closed = true;
      });
      await cannotAcquire(profile);
      assert.equal(cancelled, false);
      assert.equal(closed, false);
      release();
      await Promise.all([cancellation, closing]);
      assert.equal(await readFile(join(profile, "transaction"), "utf8"), "settled");
      const next = await Effect.runPromise(Scope.make());
      try {
        await acquire(profile, next);
      } finally {
        await close(next);
      }
    } finally {
      release();
      await close(scope);
      await rm(profile, { recursive: true, force: true });
    }
  },
);

test("lock paths reject symlinks and hardlinks without changing the target", native, async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-controller-link-"));
  const profile = join(root, "profile");
  const target = join(root, "unrelated");
  const lock = join(profile, ".hitchhiker-controller.lock");
  await mkdir(profile);
  await writeFile(target, "unchanged", { mode: 0o644 });
  try {
    await symlink(target, lock);
    await cannotAcquire(profile);
    await rm(lock);
    await link(target, lock);
    await cannotAcquire(profile);
    assert.equal(await readFile(target, "utf8"), "unchanged");
    assert.equal((await stat(target)).mode & 0o777, 0o644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "a killed controller releases its descriptor lease without deleting a sentinel",
  native,
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "hitchhiker-controller-crash-"));
    const module = new URL("../src/profile-write-lease.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `
    import { Effect } from 'effect';
    import { acquireProfileWriteLease } from ${JSON.stringify(module)};
    setInterval(() => {}, 1_000);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* acquireProfileWriteLease(process.env.LEASE_PROFILE, process.env.HITCHHIKER_NATIVE_BINARY);
      process.stdout.write('ready\\n');
      yield* Effect.never;
    })));
  `,
      ],
      {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, LEASE_PROFILE: profile },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("lease holder did not become ready")),
          5_000,
        );
        child.stdout!.once("data", (chunk: Buffer) => {
          clearTimeout(timer);
          assert.equal(chunk.toString(), "ready\n");
          resolve();
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      await cannotAcquire(profile);
      child.kill("SIGKILL");
      await exited;
      const scope = await Effect.runPromise(Scope.make());
      try {
        await acquire(profile, scope);
      } finally {
        await close(scope);
      }
    } finally {
      child.kill("SIGKILL");
      await exited;
      await rm(profile, { recursive: true, force: true });
    }
  },
);
