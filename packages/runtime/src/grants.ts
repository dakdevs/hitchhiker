import type { Capability, CapabilityGrant } from "@hitchhiker/core";
import { grantAllows, parseGrant, revokeGrant } from "@hitchhiker/core";
import {
  Clock,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Option,
  PubSub,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

const StoreFile = "grants.json";
const MutationLockDirectory = ".write-lock";
const MaxStoreBytes = 1024 * 1024;
const MaxGrants = 1024;
const MutationLockTimeoutMs = 1_000;
const MutationLockRetryMs = 25;

export class GrantStoreError extends Schema.TaggedError<GrantStoreError>()("GrantStoreError", {
  code: Schema.String,
  message: Schema.String,
}) {}

const failure = (code: string, message: string) => new GrantStoreError({ code, message });

export interface GrantIssue {
  readonly principal: string;
  readonly profileId: string;
  readonly capabilities: readonly Capability[];
  readonly origins: readonly string[];
  readonly expiresAt?: number;
}

export interface GrantAuthorization {
  readonly profileId: string;
  readonly capability: Capability;
  readonly origin?: string;
}

export interface GrantAuthentication {
  readonly profileId: string;
}

export interface AuthorizedGrant {
  readonly principal: string;
  readonly grant: CapabilityGrant;
}

export interface GrantRevocation {
  readonly id: string;
  readonly revokedAt: number;
}

export interface GrantStoreApi {
  readonly issue: (
    input: GrantIssue,
  ) => Effect.Effect<{ readonly token: string; readonly grant: CapabilityGrant }, GrantStoreError>;
  readonly revoke: (id: string) => Effect.Effect<CapabilityGrant, GrantStoreError>;
  readonly list: () => Effect.Effect<readonly CapabilityGrant[], GrantStoreError>;
  readonly authorize: (
    token: string,
    request: GrantAuthorization,
  ) => Effect.Effect<AuthorizedGrant, GrantStoreError>;
  /** Validates one durable credential without granting any capability. */
  readonly authenticate: (
    token: string,
    request: GrantAuthentication,
  ) => Effect.Effect<AuthorizedGrant, GrantStoreError>;
  readonly revocations: Stream.Stream<GrantRevocation>;
}

export class GrantStore extends Context.Service<GrantStore, GrantStoreApi>()(
  "@hitchhiker/runtime/GrantStore",
) {}

interface StoredGrant {
  readonly grant: CapabilityGrant;
  readonly issuedAt: number;
  readonly tokenHash: string;
}

interface StoredState {
  readonly version: 1;
  readonly grants: readonly StoredGrant[];
}

interface RevocationMutation {
  readonly grant: CapabilityGrant;
  readonly changed: boolean;
}

const PersistedGrant = Schema.Struct({
  grant: Schema.Unknown,
  issuedAt: Schema.Int,
  tokenHash: Schema.String,
});
const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  grants: Schema.Array(PersistedGrant),
});
const decodePersistedState = Schema.decodeUnknownOption(PersistedState, {
  onExcessProperty: "error",
});

const parseStoredState = (value: unknown): StoredState | undefined => {
  const decoded = decodePersistedState(value);
  if (Option.isNone(decoded) || decoded.value.grants.length > MaxGrants) return undefined;
  const grantIds = new Set<string>();
  const tokenHashes = new Set<string>();
  const grants: StoredGrant[] = [];
  for (const record of decoded.value.grants) {
    if (record.issuedAt < 0 || !/^[a-f0-9]{64}$/.test(record.tokenHash)) return undefined;
    const grant = parseGrant(record.grant);
    if (!grant.ok || grantIds.has(grant.value.id) || tokenHashes.has(record.tokenHash))
      return undefined;
    grantIds.add(grant.value.id);
    tokenHashes.add(record.tokenHash);
    grants.push(
      Object.freeze({ grant: grant.value, issuedAt: record.issuedAt, tokenHash: record.tokenHash }),
    );
  }
  return Object.freeze({ version: 1, grants: Object.freeze(grants) });
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const tokenText = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const persistentError = (message: string) => failure("persistence", message);

export const create = Effect.fn("GrantStore.create")(function* ({
  directory,
}: {
  readonly directory: string;
}): Effect.fn.Return<
  GrantStoreApi,
  GrantStoreError,
  FileSystem.FileSystem | Crypto.Crypto | Scope.Scope
> {
  // This semaphore serializes local callers. The directory lock below also
  // serializes independent CLI/browser processes.
  if (directory.length === 0)
    return yield* failure("configuration", "Grant store directory is required");
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  // This is a best-effort invalidation hint for relays. Authorization always
  // rereads durable state, so dropping a notification cannot retain authority.
  const revocations = yield* PubSub.dropping<GrantRevocation>({ capacity: 256 });
  yield* Effect.addFinalizer(() => PubSub.shutdown(revocations));
  const path = `${directory}/${StoreFile}`;
  const mutationLockPath = `${directory}/${MutationLockDirectory}`;
  const randomBytes = (size: number) =>
    crypto
      .randomBytes(size)
      .pipe(Effect.mapError(() => failure("crypto", "Could not generate grant secret")));
  const hashToken = (token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
      Effect.map(hex),
      Effect.mapError(() => failure("crypto", "Could not hash grant token")),
    );

  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
    Effect.flatMap(() => fs.chmod(directory, 0o700)),
    Effect.mapError(() => persistentError("Could not create private grant store directory")),
  );

  const load = Effect.fn("GrantStore.load")(function* (): Effect.fn.Return<
    StoredState,
    GrantStoreError
  > {
    const exists = yield* fs
      .exists(path)
      .pipe(Effect.mapError(() => persistentError("Could not inspect grant store")));
    if (!exists) return Object.freeze({ version: 1, grants: Object.freeze([]) });
    const info = yield* fs
      .stat(path)
      .pipe(Effect.mapError(() => persistentError("Could not inspect grant store")));
    if (info.size > BigInt(MaxStoreBytes))
      return yield* failure("invalid-store", "Grant store exceeds its size limit");
    const bytes = yield* fs
      .readFile(path)
      .pipe(Effect.mapError(() => persistentError("Could not read grant store")));
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return yield* failure("invalid-store", "Grant store is not valid JSON");
    }
    const state = parseStoredState(value);
    return state === undefined
      ? yield* failure("invalid-store", "Grant store has an invalid schema")
      : state;
  });

  const write = Effect.fn("GrantStore.write")(function* (
    state: StoredState,
  ): Effect.fn.Return<void, GrantStoreError> {
    const encoded = new TextEncoder().encode(JSON.stringify(state));
    if (encoded.length > MaxStoreBytes)
      return yield* failure("persistence", "Grant store exceeds its size limit");
    const temporary = `${path}.${hex(yield* randomBytes(8))}.tmp`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs
          .open(temporary, { flag: "wx", mode: 0o600 })
          .pipe(
            Effect.mapError(() => persistentError("Could not create grant store temporary file")),
          );
        yield* file
          .writeAll(encoded)
          .pipe(Effect.mapError(() => persistentError("Could not write grant store")));
        yield* file.sync.pipe(Effect.mapError(() => persistentError("Could not sync grant store")));
      }),
    );
    yield* fs
      .chmod(temporary, 0o600)
      .pipe(Effect.mapError(() => persistentError("Could not protect grant store")));
    yield* fs
      .rename(temporary, path)
      .pipe(Effect.mapError(() => persistentError("Could not atomically replace grant store")));
    yield* fs
      .chmod(path, 0o600)
      .pipe(Effect.mapError(() => persistentError("Could not protect grant store")));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directoryHandle = yield* fs
          .open(directory, { flag: "r" })
          .pipe(Effect.mapError(() => persistentError("Could not open grant store directory")));
        yield* directoryHandle.sync.pipe(
          Effect.mapError(() => persistentError("Could not sync grant store directory")),
        );
      }),
    );
  });

  const acquireMutationLock = Effect.fn("GrantStore.acquireMutationLock")(
    function* (): Effect.fn.Return<void, GrantStoreError> {
      const startedAt = yield* Clock.currentTimeMillis;
      for (;;) {
        const acquired = yield* fs.makeDirectory(mutationLockPath, { mode: 0o700 }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            error.reason._tag === "AlreadyExists"
              ? Effect.succeed(false)
              : Effect.fail(persistentError("Could not acquire grant store mutation lock")),
          ),
        );
        if (acquired) return;
        if ((yield* Clock.currentTimeMillis) - startedAt >= MutationLockTimeoutMs)
          return yield* failure(
            "locked",
            "Grant store mutation lock is held; stop all writers before manually removing a stale .write-lock directory",
          );
        yield* Effect.sleep(MutationLockRetryMs);
      }
    },
  );

  const withMutationLock = <A>(effect: Effect.Effect<A, GrantStoreError>) =>
    Effect.scoped(
      Effect.acquireRelease(acquireMutationLock(), () =>
        fs.remove(mutationLockPath, { recursive: true }).pipe(
          Effect.mapError(() => persistentError("Could not release grant store mutation lock")),
          Effect.orDie,
        ),
      ).pipe(Effect.flatMap(() => effect)),
    );

  const mutate = <A>(
    operation: (state: StoredState) => Effect.Effect<readonly [A, StoredState], GrantStoreError>,
  ) =>
    lock.withPermit(
      withMutationLock(
        Effect.gen(function* () {
          // The state is deliberately reread after the cross-process lock.
          const state = yield* load();
          const [result, next] = yield* operation(state);
          yield* write(next);
          return result;
        }),
      ),
    );

  const issue = Effect.fn("GrantStore.issue")(function* (input: GrantIssue) {
    const now = yield* Clock.currentTimeMillis;
    const id = `g${hex(yield* randomBytes(16))}`;
    const candidate = parseGrant({
      id,
      principal: input.principal,
      profileId: input.profileId,
      capabilities: input.capabilities,
      origins: input.origins,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    if (!candidate.ok) return yield* failure("invalid-grant", candidate.errors.join(" "));
    const token = tokenText(yield* randomBytes(32));
    const stored = Object.freeze({
      grant: candidate.value,
      issuedAt: now,
      tokenHash: yield* hashToken(token),
    });
    return yield* mutate((state) =>
      state.grants.length >= MaxGrants
        ? Effect.fail(failure("limit", "Grant store has reached its grant limit"))
        : Effect.succeed([
            { token, grant: candidate.value },
            Object.freeze({
              version: 1 as const,
              grants: Object.freeze([...state.grants, stored]),
            }),
          ] as const),
    );
  });

  const revoke = Effect.fn("GrantStore.revoke")(function* (id: string) {
    const now = yield* Clock.currentTimeMillis;
    const revoked = yield* mutate<RevocationMutation>((state) => {
      const index = state.grants.findIndex((entry) => entry.grant.id === id);
      if (index < 0) return Effect.fail(failure("not-found", "Grant was not found"));
      if (state.grants[index]!.grant.revokedAt !== undefined)
        return Effect.succeed<readonly [RevocationMutation, StoredState]>([
          { grant: state.grants[index]!.grant, changed: false },
          state,
        ]);
      const result = revokeGrant(state.grants[index]!.grant, now);
      if (!result.ok) return Effect.fail(failure("invalid-grant", result.errors.join(" ")));
      const nextEntry = Object.freeze({ ...state.grants[index]!, grant: result.value });
      const grants = [...state.grants];
      grants[index] = nextEntry;
      return Effect.succeed<readonly [RevocationMutation, StoredState]>([
        { grant: result.value, changed: true },
        Object.freeze({ version: 1 as const, grants: Object.freeze(grants) }),
      ]);
    });
    if (revoked.changed) PubSub.publishUnsafe(revocations, { id, revokedAt: now });
    return revoked.grant;
  });

  const list = () =>
    lock.withPermit(load().pipe(Effect.map((state) => state.grants.map((entry) => entry.grant))));
  const authenticateStored = Effect.fn("GrantStore.authenticateStored")(function* (
    token: string,
    profileId: string,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return yield* failure("denied", "Grant token is not authorized");
    const hash = yield* hashToken(token);
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const state = yield* load();
        const entry = state.grants.find((candidate) => candidate.tokenHash === hash);
        if (!entry) return yield* failure("denied", "Grant token is not authorized");
        const now = yield* Clock.currentTimeMillis;
        if (
          entry.grant.profileId !== profileId ||
          entry.grant.revokedAt !== undefined ||
          (entry.grant.expiresAt !== undefined && now >= entry.grant.expiresAt)
        )
          return yield* failure("denied", "Grant does not allow this request");
        // The principal is an audit label from trusted issuance, not an external
        // authentication assertion.
        return { principal: entry.grant.principal, grant: entry.grant, now };
      }),
    );
  });

  const authenticate = Effect.fn("GrantStore.authenticate")(function* (
    token: string,
    request: GrantAuthentication,
  ) {
    const { principal, grant } = yield* authenticateStored(token, request.profileId);
    return { principal, grant };
  });

  const authorize = Effect.fn("GrantStore.authorize")(function* (
    token: string,
    request: GrantAuthorization,
  ) {
    const authenticated = yield* authenticateStored(token, request.profileId);
    if (
      !grantAllows(authenticated.grant, {
        principal: authenticated.principal,
        ...request,
        now: authenticated.now,
      })
    )
      return yield* failure("denied", "Grant does not allow this request");
    return { principal: authenticated.principal, grant: authenticated.grant };
  });

  return {
    issue,
    revoke,
    list,
    authenticate,
    authorize,
    revocations: Stream.fromPubSub(revocations),
  };
});
