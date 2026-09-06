import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Deferred, Effect, Schema, type Scope } from "effect";

export class ProfileWriteLeaseError extends Schema.TaggedError<ProfileWriteLeaseError>()(
  "ProfileWriteLeaseError",
  { message: Schema.String },
) {}

export interface ProfileWriteLease {
  readonly profileRoot: string;
  readonly assertHeld: Effect.Effect<void, ProfileWriteLeaseError>;
  /** Every asynchronous filesystem mutation must settle before the lease can close. */
  readonly withWrite: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProfileWriteLeaseError, R>;
}

const failure = (message: string) => new ProfileWriteLeaseError({ message });

// Effect's process adapter exposes extra pipes, but cannot inherit an existing
// numeric descriptor. This small Node boundary shares the parent's open-file
// description with the bundled native flock helper and always waits for close.
const lockDescriptor = (executable: string, descriptor: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, ["--lock-controller-profile-fd"], {
      stdio: ["ignore", "ignore", "ignore", descriptor],
      env: {},
    });
    let spawnError: Error | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (spawnError || timedOut || code !== 0)
        reject(
          failure(
            code === 75
              ? "This profile is already in use by another browser controller."
              : "Could not acquire the browser controller profile lock.",
          ),
        );
      else resolve();
    });
  });

/** Acquire outside the engine scope, and never unlink the kernel's lock file. */
export const acquireProfileWriteLease = Effect.fn("ProfileWriteLease.acquire")(function* (
  profileRoot: string,
  executable: string,
): Effect.fn.Return<ProfileWriteLease, ProfileWriteLeaseError, Scope.Scope> {
  if (!isAbsolute(profileRoot) || !isAbsolute(executable))
    return yield* failure("Profile and native executable paths must be absolute.");
  const drained = yield* Deferred.make<void>();
  let writers = 0;
  let closing = false;
  const resource = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await mkdir(profileRoot, { recursive: true, mode: 0o700 });
        const canonicalRoot = await realpath(profileRoot);
        const lockPath = join(canonicalRoot, ".hitchhiker-controller.lock");
        const fd = await open(
          lockPath,
          constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const before = await fd.stat({ bigint: true });
          if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || before.nlink !== 1n)
            throw failure("The controller lock must be a private regular file.");
          await fd.chmod(0o600);
          await lockDescriptor(executable, fd.fd);
          const named = await lstat(lockPath, { bigint: true });
          if (named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink())
            throw failure("The controller lock changed during acquisition.");
          return { fd, canonicalRoot, lockPath, dev: before.dev, ino: before.ino };
        } catch (error) {
          await fd.close();
          throw error;
        }
      },
      catch: (error) =>
        error instanceof ProfileWriteLeaseError
          ? error
          : failure("Could not acquire the browser controller profile lock."),
    }),
    ({ fd }) =>
      Effect.sync(() => {
        closing = true;
      }).pipe(
        Effect.andThen(
          Effect.suspend(() => (writers === 0 ? Effect.void : Deferred.await(drained))),
        ),
        Effect.andThen(
          Effect.tryPromise({
            try: () => fd.close(),
            catch: () => failure("Could not close the browser controller profile lock."),
          }).pipe(Effect.orDie),
        ),
      ),
  );
  const assertHeld = Effect.tryPromise({
    try: async () => {
      if (closing) throw failure("The browser controller profile lock is closing.");
      const [fd, named, directory] = await Promise.all([
        resource.fd.stat({ bigint: true }),
        lstat(resource.lockPath, { bigint: true }),
        realpath(resource.canonicalRoot),
      ]);
      if (
        directory !== resource.canonicalRoot ||
        !fd.isFile() ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        fd.dev !== resource.dev ||
        fd.ino !== resource.ino ||
        named.dev !== resource.dev ||
        named.ino !== resource.ino ||
        fd.nlink !== 1n ||
        (fd.mode & 0o777n) !== 0o600n
      )
        throw failure("The browser controller profile lock is invalid.");
    },
    catch: (error) =>
      error instanceof ProfileWriteLeaseError
        ? error
        : failure("The browser controller profile lock is no longer available."),
  });
  return {
    profileRoot: resource.canonicalRoot,
    assertHeld,
    withWrite: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      Effect.uninterruptible(
        Effect.acquireUseRelease(
          Effect.suspend(() => {
            if (closing) return Effect.fail(failure("The profile writer is closing."));
            writers += 1;
            return Effect.void;
          }),
          () => assertHeld.pipe(Effect.andThen(operation)),
          () =>
            Effect.sync(() => {
              writers -= 1;
            }).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  closing && writers === 0 ? Deferred.succeed(drained, undefined) : Effect.void,
                ),
              ),
            ),
        ),
      ),
  };
});
