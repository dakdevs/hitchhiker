import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { Clock, Effect, Schema, Scope, Semaphore } from "effect";
import type { ProfileWriteLease } from "./profile-write-lease.ts";

const MaxSessions = 1;
const MaxFileBytes = 256 * 1024 * 1024;
const MaxTotalBytes = 512 * 1024 * 1024;
const MaxChunkBytes = 64 * 1024;
const MaxEncodedChunkBytes = Math.ceil(MaxChunkBytes / 3) * 4;
const MaxEntries = 10_000;
const MaxDepth = 64;
const MaxPathBytes = 4096;
const MaxManifestBytes = 1024 * 1024;
const UploadId = /^[a-f0-9]{32}$/;
const liveLeases = new WeakSet<ProfileWriteLease>();

export class ExtensionUploadError extends Schema.TaggedError<ExtensionUploadError>()(
  "ExtensionUploadError",
  { message: Schema.String },
) {}
const fail = (message: string) => new ExtensionUploadError({ message });

export interface ExtensionUploadSnapshot {
  readonly uploadId: string;
  readonly state: "receiving" | "consuming";
  readonly file?: { readonly path: string; readonly size: number; readonly offset: number };
  readonly completedFiles: number;
  readonly totalBytes: number;
}
export interface ExtensionUploadOwner {
  readonly begin: () => Effect.Effect<ExtensionUploadSnapshot, ExtensionUploadError>;
  readonly beginFile: (
    id: string,
    path: string,
    size: number,
  ) => Effect.Effect<ExtensionUploadSnapshot, ExtensionUploadError>;
  readonly append: (
    id: string,
    offset: number,
    dataBase64: string,
  ) => Effect.Effect<ExtensionUploadSnapshot, ExtensionUploadError>;
  readonly status: (id: string) => Effect.Effect<ExtensionUploadSnapshot, ExtensionUploadError>;
  readonly cancel: (id: string) => Effect.Effect<void, ExtensionUploadError>;
  /** Trusted coordinator-only handoff. The callback must copy the upload before it settles. */
  readonly consume: <A, E>(
    id: string,
    operation: (privateDirectory: string) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ExtensionUploadError>;
}
export interface ExtensionUploadStore {
  readonly forOwner: (
    authorize: Effect.Effect<void, unknown>,
  ) => Effect.Effect<ExtensionUploadOwner, never, Scope.Scope>;
  /** Coordinator calls this periodically; receiving uploads expire after 10m idle or 60m absolute. */
  readonly expire: () => Effect.Effect<void, ExtensionUploadError>;
}
type File = {
  path: string;
  size: number;
  offset: number;
  handle: Awaited<ReturnType<typeof open>>;
  dev: bigint;
  ino: bigint;
  last?: { offset: number; bytes: Buffer };
};
type Session = {
  id: string;
  directory: string;
  directoryDev: bigint;
  directoryIno: bigint;
  owner: Set<string>;
  state: "receiving" | "consuming";
  total: number;
  completed: Set<string>;
  file?: File;
  /** Receipt survives completion only until the next file begins, for at-least-once chunk delivery. */
  receipt?: { offset: number; bytes: Buffer };
  entries: Set<string>;
  createdAt: number;
  touchedAt: number;
};

const validPath = (path: string) => {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    [...path].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    }) ||
    !path.isWellFormed()
  )
    return false;
  const parts = path.split("/");
  return (
    parts.every((part) => part && part !== "." && part !== "..") &&
    parts.length <= MaxDepth &&
    Buffer.byteLength(path) <= MaxPathBytes
  );
};
const decode = (value: string) => {
  if (
    value.length === 0 ||
    value.length > MaxEncodedChunkBytes ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
};

export const createExtensionUploadStore = Effect.fn("ExtensionUploadStore.create")(
  function* (options: {
    readonly profileLease: ProfileWriteLease;
    /** @internal Portable tests may reduce expiry durations. */
    readonly testIdleMs?: number;
    /** @internal Portable tests may reduce expiry durations. */
    readonly testAbsoluteMs?: number;
    /** @internal Portable tests may reduce the entry ceiling. */
    readonly testMaxEntries?: number;
    /** @internal Portable tests may reduce byte ceilings. */
    readonly testMaxFileBytes?: number;
    readonly testMaxTotalBytes?: number;
    readonly testMaxManifestBytes?: number;
  }): Effect.fn.Return<ExtensionUploadStore, ExtensionUploadError, Scope.Scope> {
    const profileRoot = options.profileLease.profileRoot;
    if (!isAbsolute(profileRoot)) return yield* fail("Upload root must be absolute");
    yield* Effect.tryPromise({
      try: async () => {
        if ((await realpath(profileRoot)) !== profileRoot) throw new Error();
      },
      catch: () => fail("Profile root is not canonical"),
    });
    if (liveLeases.has(options.profileLease))
      return yield* fail("Upload storage is already active");
    // A profile lease belongs to one controller lifetime. Keeping this weak marker prevents a
    // second startup path from treating a live upload as an orphan and deleting it.
    liveLeases.add(options.profileLease);
    const root = join(profileRoot, "hitchhiker-extension-uploads");
    const sessions = new Map<string, Session>();
    let rootIdentity: { dev: bigint; ino: bigint } | undefined;
    const idleMs = options.testIdleMs ?? 10 * 60_000;
    const absoluteMs = options.testAbsoluteMs ?? 60 * 60_000;
    const entryLimit = options.testMaxEntries ?? MaxEntries;
    const fileLimit = options.testMaxFileBytes ?? MaxFileBytes;
    const totalLimit = options.testMaxTotalBytes ?? MaxTotalBytes;
    const manifestLimit = options.testMaxManifestBytes ?? MaxManifestBytes;
    if (
      !Number.isSafeInteger(idleMs) ||
      !Number.isSafeInteger(absoluteMs) ||
      !Number.isSafeInteger(entryLimit) ||
      !Number.isSafeInteger(fileLimit) ||
      !Number.isSafeInteger(totalLimit) ||
      !Number.isSafeInteger(manifestLimit) ||
      idleMs < 0 ||
      absoluteMs < 0 ||
      entryLimit < 1 ||
      entryLimit > MaxEntries ||
      fileLimit < 0 ||
      fileLimit > MaxFileBytes ||
      totalLimit < 0 ||
      totalLimit > MaxTotalBytes ||
      manifestLimit < 0 ||
      manifestLimit > MaxManifestBytes
    )
      return yield* fail("Upload expiry limits are invalid");
    const lock = yield* Semaphore.make(1);

    const privateWrite = <A>(operation: Effect.Effect<A, ExtensionUploadError>) =>
      options.profileLease
        .withWrite(operation)
        .pipe(Effect.mapError(() => fail("Private upload storage is unavailable")));
    const assertRoot = () =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(root, { recursive: true, mode: 0o700 });
          const [named, resolved] = await Promise.all([
            lstat(root, { bigint: true }),
            realpath(root),
          ]);
          if (
            !named.isDirectory() ||
            named.isSymbolicLink() ||
            named.uid !== BigInt(process.getuid!()) ||
            (named.mode & 0o777n) !== 0o700n ||
            resolved !== root ||
            (rootIdentity !== undefined &&
              (named.dev !== rootIdentity.dev || named.ino !== rootIdentity.ino))
          )
            throw new Error();
          return { dev: named.dev, ino: named.ino };
        },
        catch: () => fail("Private upload storage is invalid"),
      });
    const assertDirectory = (s: Session) =>
      Effect.tryPromise({
        try: async () => {
          if (relative(root, s.directory) !== s.id) throw new Error();
          const [named, resolved] = await Promise.all([
            lstat(s.directory, { bigint: true }),
            realpath(s.directory),
          ]);
          if (
            !named.isDirectory() ||
            named.isSymbolicLink() ||
            named.uid !== BigInt(process.getuid!()) ||
            (named.mode & 0o777n) !== 0o700n ||
            resolved !== s.directory ||
            named.dev !== s.directoryDev ||
            named.ino !== s.directoryIno
          )
            throw new Error();
        },
        catch: () => fail("Private upload storage is invalid"),
      });
    const snapshot = (s: Session): ExtensionUploadSnapshot =>
      Object.freeze({
        uploadId: s.id,
        state: s.state,
        ...(s.file
          ? { file: Object.freeze({ path: s.file.path, size: s.file.size, offset: s.file.offset }) }
          : {}),
        completedFiles: s.completed.size,
        totalBytes: s.total,
      });
    const cleanup = (s: Session) =>
      Effect.tryPromise({
        try: async () => {
          await s.file?.handle.close();
          await assertRoot().pipe(Effect.runPromise);
          await assertDirectory(s).pipe(Effect.runPromise);
          await rm(s.directory, { recursive: true, force: true });
        },
        catch: () => fail("Could not clean up upload"),
      }).pipe(Effect.asVoid);
    const remove = (s: Session) => {
      sessions.delete(s.id);
      s.owner.delete(s.id);
    };
    const expireLocked = (now: number) =>
      Effect.forEach([...sessions.values()], (s) =>
        s.state === "receiving" && (now - s.touchedAt >= idleMs || now - s.createdAt >= absoluteMs)
          ? cleanup(s).pipe(Effect.tap(() => Effect.sync(() => remove(s))))
          : Effect.void,
      ).pipe(Effect.asVoid);

    yield* privateWrite(
      assertRoot().pipe(
        Effect.tap((identity) =>
          Effect.sync(() => {
            rootIdentity = identity;
          }),
        ),
        Effect.andThen(
          Effect.tryPromise({
            try: async () => {
              for (const entry of await readdir(root, { withFileTypes: true })) {
                if (UploadId.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink())
                  await rm(join(root, entry.name), { recursive: true, force: true });
              }
            },
            catch: () => fail("Could not prepare private upload storage"),
          }),
        ),
      ),
    );

    const owned = <A>(
      closed: () => boolean,
      authorize: Effect.Effect<void, unknown>,
      action: (now: number) => Effect.Effect<A, ExtensionUploadError>,
    ) =>
      Effect.suspend(() =>
        closed()
          ? Effect.fail(fail("Upload owner is closed"))
          : authorize.pipe(
              Effect.mapError(() => fail("Upload is not authorized")),
              Effect.andThen(
                lock.withPermit(
                  Effect.suspend(() =>
                    closed()
                      ? Effect.fail(fail("Upload owner is closed"))
                      : authorize.pipe(
                          Effect.mapError(() => fail("Upload is not authorized")),
                          Effect.andThen(Clock.currentTimeMillis),
                          Effect.flatMap((now) =>
                            privateWrite(expireLocked(now).pipe(Effect.andThen(action(now)))),
                          ),
                        ),
                  ),
                ),
              ),
            ),
      );
    const find = (id: string) => (UploadId.test(id) ? sessions.get(id) : undefined);

    const forOwner = (authorize: Effect.Effect<void, unknown>) =>
      Effect.gen(function* () {
        const mine = new Set<string>();
        let closed = false;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          }).pipe(
            Effect.andThen(
              lock.withPermit(
                Effect.forEach([...mine], (id) => {
                  const s = sessions.get(id);
                  return s?.state === "receiving"
                    ? privateWrite(cleanup(s)).pipe(
                        Effect.tap(() => Effect.sync(() => remove(s))),
                        Effect.catch(() => Effect.void),
                      )
                    : Effect.void;
                }).pipe(Effect.asVoid),
              ),
            ),
          ),
        );
        const isClosed = () => closed;
        return {
          begin: () =>
            owned(isClosed, authorize, (now) =>
              assertRoot().pipe(
                Effect.andThen(
                  Effect.tryPromise({
                    try: async () => {
                      if (sessions.size >= MaxSessions) throw new Error();
                      const id = crypto.randomUUID().replaceAll("-", "");
                      const directory = join(root, id);
                      await mkdir(directory, { mode: 0o700 });
                      const named = await lstat(directory, { bigint: true });
                      if (
                        !named.isDirectory() ||
                        named.isSymbolicLink() ||
                        (named.mode & 0o777n) !== 0o700n
                      )
                        throw new Error();
                      const s: Session = {
                        id,
                        directory,
                        directoryDev: named.dev,
                        directoryIno: named.ino,
                        owner: mine,
                        state: "receiving",
                        total: 0,
                        completed: new Set(),
                        entries: new Set(),
                        createdAt: now,
                        touchedAt: now,
                      };
                      sessions.set(id, s);
                      mine.add(id);
                      return snapshot(s);
                    },
                    catch: () => fail("Could not begin extension upload"),
                  }),
                ),
              ),
            ),
          beginFile: (id, path, size) =>
            owned(isClosed, authorize, (now) =>
              Effect.tryPromise({
                try: async () => {
                  const s = find(id);
                  if (
                    !s ||
                    !mine.has(id) ||
                    s.state !== "receiving" ||
                    !validPath(path) ||
                    !Number.isSafeInteger(size) ||
                    size < 0
                  )
                    throw new Error();
                  if (s.file) {
                    if (s.file.path === path && s.file.size === size) return snapshot(s);
                    throw new Error();
                  }
                  if (
                    s.completed.has(path) ||
                    size > fileLimit ||
                    size > totalLimit ||
                    s.total + size > totalLimit ||
                    (path === "manifest.json" && size > manifestLimit)
                  )
                    throw new Error();
                  await assertRoot().pipe(Effect.runPromise);
                  await assertDirectory(s).pipe(Effect.runPromise);
                  const parts = path.split("/");
                  const newEntries = new Set(s.entries);
                  for (let i = 1; i < parts.length; i++)
                    newEntries.add(parts.slice(0, i).join("/"));
                  newEntries.add(path);
                  if (newEntries.size > entryLimit) throw new Error();
                  for (let i = 1; i < parts.length; i++) {
                    const parent = join(s.directory, ...parts.slice(0, i));
                    await mkdir(parent, { recursive: true, mode: 0o700 });
                    const named = await lstat(parent, { bigint: true });
                    if (
                      !named.isDirectory() ||
                      named.isSymbolicLink() ||
                      (named.mode & 0o777n) !== 0o700n
                    )
                      throw new Error();
                  }
                  const target = join(s.directory, path);
                  if (relative(s.directory, target) !== path) throw new Error();
                  const handle = await open(
                    target,
                    constants.O_WRONLY |
                      constants.O_CREAT |
                      constants.O_EXCL |
                      constants.O_NOFOLLOW,
                    0o600,
                  );
                  const opened = await handle.stat({ bigint: true });
                  if (
                    !opened.isFile() ||
                    opened.nlink !== 1n ||
                    (opened.mode & 0o777n) !== 0o600n
                  ) {
                    await handle.close();
                    throw new Error();
                  }
                  s.entries = newEntries;
                  s.receipt = undefined;
                  s.file = { path, size, offset: 0, handle, dev: opened.dev, ino: opened.ino };
                  s.total += size;
                  s.touchedAt = now;
                  if (size === 0) {
                    await handle.sync();
                    await handle.close();
                    s.completed.add(path);
                    s.file = undefined;
                  }
                  return snapshot(s);
                },
                catch: () => fail("Invalid extension upload file"),
              }),
            ),
          append: (id, offset, dataBase64) =>
            owned(isClosed, authorize, (now) =>
              Effect.tryPromise({
                try: async () => {
                  const s = find(id);
                  const bytes = decode(dataBase64);
                  if (
                    !s ||
                    !mine.has(id) ||
                    !bytes ||
                    bytes.length > MaxChunkBytes ||
                    !Number.isSafeInteger(offset)
                  )
                    throw new Error();
                  if (!s.file) {
                    if (
                      s.receipt &&
                      offset === s.receipt.offset &&
                      Buffer.compare(s.receipt.bytes, bytes) === 0
                    )
                      return snapshot(s);
                    throw new Error();
                  }
                  const file = s.file;
                  await assertRoot().pipe(Effect.runPromise);
                  await assertDirectory(s).pipe(Effect.runPromise);
                  if (offset === file.offset) {
                    if (file.offset + bytes.length > file.size) throw new Error();
                    const named = await lstat(join(s.directory, file.path), { bigint: true });
                    const opened = await file.handle.stat({ bigint: true });
                    if (
                      !named.isFile() ||
                      named.isSymbolicLink() ||
                      named.nlink !== 1n ||
                      named.dev !== file.dev ||
                      named.ino !== file.ino ||
                      opened.dev !== file.dev ||
                      opened.ino !== file.ino ||
                      opened.nlink !== 1n
                    )
                      throw new Error();
                    let written = 0;
                    while (written < bytes.length) {
                      const result = await file.handle.write(
                        bytes,
                        written,
                        bytes.length - written,
                        file.offset + written,
                      );
                      if (result.bytesWritten <= 0) throw new Error();
                      written += result.bytesWritten;
                    }
                    file.last = { offset, bytes };
                    file.offset += bytes.length;
                    s.touchedAt = now;
                    if (file.offset === file.size) {
                      await file.handle.sync();
                      await file.handle.close();
                      s.completed.add(file.path);
                      s.receipt = file.last;
                      s.file = undefined;
                    }
                    return snapshot(s);
                  }
                  if (
                    file.last &&
                    offset === file.last.offset &&
                    Buffer.compare(file.last.bytes, bytes) === 0
                  )
                    return snapshot(s);
                  throw new Error();
                },
                catch: () => fail("Invalid extension upload chunk"),
              }),
            ),
          status: (id) =>
            Effect.suspend(() =>
              isClosed()
                ? Effect.fail(fail("Upload owner is closed"))
                : authorize.pipe(
                    Effect.mapError(() => fail("Upload is not authorized")),
                    Effect.andThen(
                      Effect.suspend(() =>
                        isClosed()
                          ? Effect.fail(fail("Upload owner is closed"))
                          : authorize.pipe(
                              Effect.mapError(() => fail("Upload is not authorized")),
                              Effect.andThen(() => {
                                const session = find(id);
                                return session && mine.has(id) && session.state === "consuming"
                                  ? privateWrite(assertRoot()).pipe(Effect.as(snapshot(session)))
                                  : owned(isClosed, authorize, (now) =>
                                      assertRoot().pipe(
                                        Effect.andThen(() => {
                                          const receiving = find(id);
                                          if (receiving && mine.has(id)) {
                                            receiving.touchedAt = now;
                                            return Effect.succeed(snapshot(receiving));
                                          }
                                          return Effect.fail(fail("Upload is unavailable"));
                                        }),
                                      ),
                                    );
                              }),
                            ),
                      ),
                    ),
                  ),
            ),
          cancel: (id) =>
            owned(isClosed, authorize, () => {
              const s = find(id);
              if (!s || !mine.has(id) || s.state !== "receiving")
                return Effect.fail(fail("Upload is unavailable"));
              return cleanup(s).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    remove(s);
                  }),
                ),
              );
            }),
          consume: (id, operation) => consumeOwned(mine, isClosed, authorize, id, operation),
        } satisfies ExtensionUploadOwner;
      });

    const consumeOwned = <A, E>(
      mine: Set<string>,
      isClosed: () => boolean,
      authorize: Effect.Effect<void, unknown>,
      id: string,
      operation: (directory: string) => Effect.Effect<A, E>,
    ) => {
      const prepare = Effect.suspend(() =>
        isClosed()
          ? Effect.fail(fail("Upload owner is closed"))
          : authorize.pipe(
              Effect.mapError(() => fail("Upload is not authorized")),
              Effect.andThen(
                lock.withPermit(
                  Effect.suspend(() =>
                    isClosed()
                      ? Effect.fail(fail("Upload owner is closed"))
                      : authorize.pipe(
                          Effect.mapError(() => fail("Upload is not authorized")),
                          Effect.andThen(Clock.currentTimeMillis),
                          Effect.flatMap((now) =>
                            privateWrite(
                              assertRoot().pipe(
                                Effect.andThen(expireLocked(now)),
                                Effect.andThen(
                                  Effect.gen(function* () {
                                    const session = find(id);
                                    if (
                                      !session ||
                                      !mine.has(id) ||
                                      session.state !== "receiving" ||
                                      session.file ||
                                      !session.completed.has("manifest.json") ||
                                      session.total > totalLimit
                                    )
                                      return yield* fail("Upload is incomplete");
                                    yield* assertDirectory(session);
                                    session.state = "consuming";
                                    return session;
                                  }),
                                ),
                              ),
                            ),
                          ),
                        ),
                  ),
                ),
              ),
            ),
      );
      return prepare.pipe(
        Effect.flatMap((session) =>
          Effect.suspend(() => operation(session.directory)).pipe(
            Effect.ensuring(
              lock.withPermit(
                privateWrite(cleanup(session)).pipe(
                  Effect.tap(() => Effect.sync(() => remove(session))),
                  Effect.orDie,
                ),
              ),
            ),
          ),
        ),
      );
    };
    const expire = () =>
      lock.withPermit(
        Clock.currentTimeMillis.pipe(Effect.flatMap((now) => privateWrite(expireLocked(now)))),
      );
    return { forOwner, expire };
  },
  Effect.scoped,
);
