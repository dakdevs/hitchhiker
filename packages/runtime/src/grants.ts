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
const MaxDelegationDepth = 8;

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

export interface GrantDelegation {
  readonly principal: string;
  readonly capabilities: readonly Capability[];
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
  /** Trusted in-process lookup. Never pass a wire-supplied grant ID to this API. */
  readonly authenticateGrant: (
    id: string,
    request: GrantAuthentication,
  ) => Effect.Effect<AuthorizedGrant, GrantStoreError>;
  /** Trusted in-process authorization. Wire boundaries must use the bearer-token API above. */
  readonly authorizeGrant: (
    id: string,
    request: GrantAuthorization,
  ) => Effect.Effect<AuthorizedGrant, GrantStoreError>;
  readonly delegate: (
    token: string,
    input: GrantDelegation,
  ) => Effect.Effect<CapabilityGrant, GrantStoreError>;
  /** Trusted manager delegation. Never accept parentId from plugin or MCP wire input. */
  readonly delegateGrant: (
    parentId: string,
    input: GrantDelegation,
  ) => Effect.Effect<CapabilityGrant, GrantStoreError>;
  readonly revocations: Stream.Stream<GrantRevocation>;
}

/** Trusted distribution startup only. Deliberately absent from the wire-facing service API. */
export interface ManagedGrantStoreApi extends GrantStoreApi {
  readonly ensureManaged: (
    key: string,
    input: GrantIssue,
  ) => Effect.Effect<CapabilityGrant, GrantStoreError>;
}

export class GrantStore extends Context.Service<GrantStore, GrantStoreApi>()(
  "@hitchhiker/runtime/GrantStore",
) {}

interface StoredGrant {
  readonly grant: CapabilityGrant;
  readonly issuedAt: number;
  readonly tokenHash: string;
  readonly parentId?: string;
  readonly managedKey?: string;
}

interface StoredState {
  readonly version: 1;
  readonly grants: readonly StoredGrant[];
}

interface RevocationMutation {
  readonly grant: CapabilityGrant;
  readonly changed: boolean;
}

const ManagedKey = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9._/-]{0,127}$/),
  Schema.isTrimmed(),
);
const decodeManagedKey = Schema.decodeUnknownEffect(ManagedKey);
const PersistedGrant = Schema.Struct({
  grant: Schema.Unknown,
  issuedAt: Schema.Int,
  tokenHash: Schema.String,
  parentId: Schema.optional(Schema.String),
  managedKey: Schema.optional(ManagedKey),
});
const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  grants: Schema.Array(PersistedGrant),
});
const DelegationInput = Schema.Struct({
  principal: Schema.String,
  capabilities: Schema.Array(
    Schema.Literals([
      "pages.list",
      "pages.manage",
      "pages.read",
      "pages.write",
      "ui.compose",
      "configuration.read",
      "configuration.write",
      "plugins.install",
      "plugins.read",
      "plugins.manage",
      "extensions.read",
      "extensions.manage",
      "extensions.install",
      "devtools.manage",
      "storage.local",
      "browser.full-control",
      "cdp.connect",
    ]),
  ),
});
const decodePersistedState = Schema.decodeUnknownOption(PersistedState, {
  onExcessProperty: "error",
});

const parseStoredState = (value: unknown): StoredState | undefined => {
  const decoded = decodePersistedState(value);
  if (Option.isNone(decoded) || decoded.value.grants.length > MaxGrants) return undefined;
  const grantIds = new Set<string>();
  const tokenHashes = new Set<string>();
  const managedKeys = new Set<string>();
  const grants: StoredGrant[] = [];
  for (const record of decoded.value.grants) {
    if (record.issuedAt < 0 || !/^[a-f0-9]{64}$/.test(record.tokenHash)) return undefined;
    const grant = parseGrant(record.grant);
    if (!grant.ok || grantIds.has(grant.value.id) || tokenHashes.has(record.tokenHash))
      return undefined;
    if (record.managedKey !== undefined) {
      if (record.parentId !== undefined || managedKeys.has(record.managedKey)) return undefined;
      managedKeys.add(record.managedKey);
    }
    grantIds.add(grant.value.id);
    tokenHashes.add(record.tokenHash);
    grants.push(
      Object.freeze({
        grant: grant.value,
        issuedAt: record.issuedAt,
        tokenHash: record.tokenHash,
        ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
        ...(record.managedKey === undefined ? {} : { managedKey: record.managedKey }),
      }),
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
  ManagedGrantStoreApi,
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
          if (next !== state) yield* write(next);
          return result;
        }),
      ),
    );

  const active = (grant: CapabilityGrant, profileId: string, at: number) =>
    grant.profileId === profileId &&
    grant.revokedAt === undefined &&
    (grant.expiresAt === undefined || at < grant.expiresAt);
  const sameValues = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  const canDelegateCapability = (grant: CapabilityGrant, capability: Capability) =>
    capability !== "cdp.connect" &&
    (grant.capabilities.includes("browser.full-control") ||
      grant.capabilities.includes(capability));
  const validateStoredGrant = Effect.fn("GrantStore.validateStoredGrant")(function* (
    state: StoredState,
    leaf: StoredGrant,
    profileId: string,
    at: number,
  ) {
    if (!active(leaf.grant, profileId, at))
      return yield* failure("denied", "Grant does not allow this request");
    const seen = new Set<string>([leaf.grant.id]);
    let child = leaf;
    let depth = 1;
    while (child.parentId !== undefined) {
      if (depth >= MaxDelegationDepth || seen.has(child.parentId))
        return yield* failure("denied", "Grant delegation chain is invalid");
      const parent = state.grants.find((candidate) => candidate.grant.id === child.parentId);
      if (parent === undefined || !active(parent.grant, profileId, at))
        return yield* failure("denied", "Grant delegation chain is not authorized");
      if (
        !grantAllows(parent.grant, {
          principal: parent.grant.principal,
          profileId,
          capability: "plugins.install",
          now: at,
        }) ||
        child.grant.profileId !== parent.grant.profileId ||
        child.grant.expiresAt !== parent.grant.expiresAt ||
        !sameValues(child.grant.origins, parent.grant.origins) ||
        !child.grant.capabilities.every((capability) =>
          canDelegateCapability(parent.grant, capability),
        )
      )
        return yield* failure("denied", "Grant delegation chain is not authorized");
      seen.add(parent.grant.id);
      child = parent;
      depth++;
    }
    return { depth };
  });

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

  const ensureManaged = Effect.fn("GrantStore.ensureManaged")(function* (
    key: string,
    input: GrantIssue,
  ) {
    const managedKey = yield* decodeManagedKey(key).pipe(
      Effect.mapError(() => failure("invalid-grant", "Managed grant key is invalid")),
    );
    // Validate the full request before consulting the key; never broaden a prior grant.
    const candidate = parseGrant({
      id: "managed-validation",
      principal: input.principal,
      profileId: input.profileId,
      capabilities: input.capabilities,
      origins: input.origins,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    if (!candidate.ok) return yield* failure("invalid-grant", candidate.errors.join(" "));
    return yield* mutate<CapabilityGrant>((state) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const existing = state.grants.find((entry) => entry.managedKey === managedKey);
        if (existing) {
          const grant = existing.grant;
          const request = candidate.value;
          if (
            grant.principal !== request.principal ||
            grant.profileId !== request.profileId ||
            grant.expiresAt !== request.expiresAt ||
            !sameValues([...grant.capabilities].sort(), [...request.capabilities].sort()) ||
            !sameValues([...grant.origins].sort(), [...request.origins].sort())
          )
            return yield* failure(
              "managed-conflict",
              "Managed grant key belongs to another request",
            );
          yield* validateStoredGrant(state, existing, request.profileId, now);
          return [grant, state] as const;
        }
        if (!active(candidate.value, input.profileId, now))
          return yield* failure("denied", "Managed grant request has expired");
        if (state.grants.length >= MaxGrants)
          return yield* failure("limit", "Grant store has reached its grant limit");
        const grant = Object.freeze({
          ...candidate.value,
          id: `g${hex(yield* randomBytes(16))}`,
        });
        const entry: StoredGrant = Object.freeze({
          grant,
          issuedAt: now,
          managedKey,
          // No bearer escapes this operation; startup authenticates the returned ID in-process.
          tokenHash: yield* hashToken(tokenText(yield* randomBytes(32))),
        });
        return [
          grant,
          Object.freeze({ version: 1 as const, grants: Object.freeze([...state.grants, entry]) }),
        ] as const;
      }),
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
    lookup: { readonly token: string } | { readonly id: string },
    profileId: string,
  ) {
    if ("token" in lookup && !/^[A-Za-z0-9_-]{43}$/.test(lookup.token))
      return yield* failure("denied", "Grant token is not authorized");
    const hash = "token" in lookup ? yield* hashToken(lookup.token) : undefined;
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const state = yield* load();
        const entry = state.grants.find((candidate) =>
          "id" in lookup ? candidate.grant.id === lookup.id : candidate.tokenHash === hash,
        );
        if (!entry) return yield* failure("denied", "Grant token is not authorized");
        const now = yield* Clock.currentTimeMillis;
        yield* validateStoredGrant(state, entry, profileId, now);
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
    const { principal, grant } = yield* authenticateStored({ token }, request.profileId);
    return { principal, grant };
  });

  const authenticateGrant = Effect.fn("GrantStore.authenticateGrant")(function* (
    id: string,
    request: GrantAuthentication,
  ) {
    const { principal, grant } = yield* authenticateStored({ id }, request.profileId);
    return { principal, grant };
  });

  const authorize = Effect.fn("GrantStore.authorize")(function* (
    token: string,
    request: GrantAuthorization,
  ) {
    const authenticated = yield* authenticateStored({ token }, request.profileId);
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

  const authorizeGrant = Effect.fn("GrantStore.authorizeGrant")(function* (
    id: string,
    request: GrantAuthorization,
  ) {
    const authenticated = yield* authenticateStored({ id }, request.profileId);
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

  const decodeDelegation = (input: GrantDelegation) =>
    Schema.decodeUnknownEffect(DelegationInput, { onExcessProperty: "error" })(input).pipe(
      Effect.mapError(() => failure("invalid-grant", "Invalid delegated grant request")),
    );
  const delegateFrom = Effect.fn("GrantStore.delegateFrom")(function* (
    lookup: { readonly tokenHash: string } | { readonly id: string },
    input: GrantDelegation,
  ) {
    const decoded = yield* decodeDelegation(input);
    if (decoded.capabilities.includes("cdp.connect"))
      return yield* failure("denied", "Plugins cannot receive CDP authority");
    const id = `g${hex(yield* randomBytes(16))}`;
    const discardedToken = tokenText(yield* randomBytes(32));
    const tokenHash = yield* hashToken(discardedToken);
    const now = yield* Clock.currentTimeMillis;
    return yield* mutate((state) =>
      Effect.gen(function* () {
        const parent = state.grants.find((candidate) =>
          "id" in lookup
            ? candidate.grant.id === lookup.id
            : candidate.tokenHash === lookup.tokenHash,
        );
        if (parent === undefined) return yield* failure("denied", "Parent grant is not authorized");
        const validated = yield* validateStoredGrant(state, parent, parent.grant.profileId, now);
        if (validated.depth >= MaxDelegationDepth)
          return yield* failure("denied", "Grant delegation depth limit reached");
        if (
          !grantAllows(parent.grant, {
            principal: parent.grant.principal,
            profileId: parent.grant.profileId,
            capability: "plugins.install",
            now,
          }) ||
          !decoded.capabilities.every((capability) =>
            canDelegateCapability(parent.grant, capability),
          )
        )
          return yield* failure("denied", "Parent grant cannot delegate requested capabilities");
        const candidate = parseGrant({
          id,
          principal: decoded.principal,
          profileId: parent.grant.profileId,
          capabilities: decoded.capabilities,
          origins: parent.grant.origins,
          ...(parent.grant.expiresAt === undefined ? {} : { expiresAt: parent.grant.expiresAt }),
        });
        if (!candidate.ok) return yield* failure("invalid-grant", candidate.errors.join(" "));
        if (state.grants.length >= MaxGrants)
          return yield* failure("limit", "Grant store has reached its grant limit");
        const stored = Object.freeze({
          grant: candidate.value,
          issuedAt: now,
          tokenHash,
          parentId: parent.grant.id,
        });
        return [
          candidate.value,
          Object.freeze({
            version: 1 as const,
            grants: Object.freeze([...state.grants, stored]),
          }),
        ] as const;
      }),
    );
  });

  const delegate = Effect.fn("GrantStore.delegate")(function* (
    token: string,
    input: GrantDelegation,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return yield* failure("denied", "Grant token is not authorized");
    return yield* delegateFrom({ tokenHash: yield* hashToken(token) }, input);
  });

  const delegateGrant = (parentId: string, input: GrantDelegation) =>
    delegateFrom({ id: parentId }, input);

  return {
    issue,
    ensureManaged,
    revoke,
    list,
    authenticate,
    authenticateGrant,
    authorize,
    authorizeGrant,
    delegate,
    delegateGrant,
    revocations: Stream.fromPubSub(revocations),
  };
});
