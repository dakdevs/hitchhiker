import { Clock, Effect, Schema, Scope, Semaphore, Stream } from "effect";

export const scopedDomOutputLimit = 256 * 1024;
const MaxNodes = 512;
const MaxCaptureNodes = 2_048;
const MaxPageRefs = 512;
const MaxRefs = 4_096;
const MaxPages = 8;
const RefTtlMs = 60_000;
const MaxStringBytes = 4 * 1024;

export type ScopedDomCapability = "pages.read" | "pages.write";

export class ScopedDomError extends Schema.TaggedError<ScopedDomError>()("ScopedDomError", {
  code: Schema.Literals([
    "not_authorized",
    "page_gone",
    "stale_ref",
    "covered",
    "unsupported",
    "limit",
    "browser_error",
  ]),
  message: Schema.String,
}) {}

export interface DomDocumentHandle {
  readonly pageId: string;
  readonly frameId: string;
  readonly loaderId: string;
  readonly executionContextId: number;
  readonly uniqueContextId: string;
  readonly markerName: string;
  readonly markerValue: string;
}

export type DomNodeKind = "click" | "text" | "password" | "unsupported";

export interface DomCapturedNode {
  readonly axId: string;
  readonly parentAxId?: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly states?: readonly string[];
  readonly backendNodeId?: number;
  readonly kind: DomNodeKind;
  readonly frameBoundary?: true;
}

export interface DomCapture {
  readonly document: DomDocumentHandle;
  readonly origin: string;
  readonly nodes: readonly DomCapturedNode[];
}

/** Trusted adapter. Its implementation may use only literal, internally owned CDP commands. */
export interface ScopedDomDriver {
  /** Document-invalidating native events. A session uses these only as eager cleanup hints. */
  readonly invalidations: Stream.Stream<string>;
  readonly capture: (input: {
    readonly pageId: string;
    readonly maxDepth: number;
    readonly interactiveOnly: boolean;
    /** Called after authoritative document identification and before page content is read. */
    readonly authorize: (origin: string) => Effect.Effect<void, ScopedDomError>;
  }) => Effect.Effect<DomCapture, ScopedDomError>;
  readonly currentOrigin: (document: DomDocumentHandle) => Effect.Effect<string, ScopedDomError>;
  readonly click: (
    document: DomDocumentHandle,
    node: DomCapturedNode,
    authorize: (origin: string) => Effect.Effect<void, ScopedDomError>,
  ) => Effect.Effect<void, ScopedDomError>;
  readonly fill: (
    document: DomDocumentHandle,
    node: DomCapturedNode,
    value: string,
    authorize: (origin: string) => Effect.Effect<void, ScopedDomError>,
  ) => Effect.Effect<void, ScopedDomError>;
}

export interface PageSnapshotNode {
  readonly parent?: number;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly states?: readonly string[];
  readonly ref?: string;
  readonly frameBoundary?: "child-frame";
}

export interface PageSnapshot {
  readonly pageId: string;
  readonly snapshotId: string;
  readonly nodes: readonly PageSnapshotNode[];
  readonly truncated: boolean;
}

export interface ScopedDomSession {
  readonly snapshot: (input: {
    readonly pageId: string;
    readonly maxDepth?: number;
    readonly interactiveOnly?: boolean;
  }) => Effect.Effect<PageSnapshot, ScopedDomError>;
  readonly click: (input: {
    readonly pageId: string;
    readonly ref: string;
  }) => Effect.Effect<{ readonly clicked: true }, ScopedDomError>;
  readonly fill: (input: {
    readonly pageId: string;
    readonly ref: string;
    readonly value: string;
  }) => Effect.Effect<{ readonly filled: true }, ScopedDomError>;
}

interface StoredRef {
  readonly expiresAt: number;
  readonly document: DomDocumentHandle;
  readonly node: DomCapturedNode;
}

interface StoredPage {
  readonly token: object;
  readonly refs: Map<string, StoredRef>;
}

const error = (code: ScopedDomError["code"], message: string) =>
  new ScopedDomError({ code, message });

const randomId = (prefix: string) => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const truncated = value.slice(0, low);
  return truncated.endsWith("\ud800") || /[\ud800-\udbff]$/.test(truncated)
    ? truncated.slice(0, -1)
    : truncated;
};

const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Conservative JSON-RPC response shape used while building a bounded structured tool result. */
export const scopedDomMcpResponseBytes = (snapshot: PageSnapshot) => {
  const structuredContent = { result: snapshot };
  return (
    encodedBytes({
      jsonrpc: "2.0",
      // Every one-byte control character expands to six bytes in JSON. The stdio
      // boundary admits at most 64 UTF-8 bytes and rejects larger request IDs.
      id: "\u0000".repeat(64),
      result: {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: false,
      },
    }) + 1
  ); // newline-delimited transport terminator
};

/** Creates one finite reference namespace. Call once per externally authorized connection. */
export const makeScopedDomSession = Effect.fn("makeScopedDomSession")(function* (options: {
  readonly driver: ScopedDomDriver;
  readonly authorize: (
    capability: ScopedDomCapability,
    origin: string,
  ) => Effect.Effect<void, ScopedDomError>;
}): Effect.fn.Return<ScopedDomSession, never, Scope.Scope> {
  const pages = new Map<string, StoredPage>();
  const currentTokens = new Map<string, object>();
  const lock = yield* Semaphore.make(1);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      pages.clear();
      currentTokens.clear();
    }),
  );
  yield* Effect.forkScoped(
    options.driver.invalidations.pipe(
      Stream.runForEach((pageId) =>
        Effect.suspend(() => {
          const committed = pages.get(pageId);
          if (committed === undefined && !currentTokens.has(pageId)) return Effect.void;
          const invalidationToken = {};
          currentTokens.set(pageId, invalidationToken);
          return lock.withPermit(
            Effect.sync(() => {
              if (committed !== undefined && pages.get(pageId)?.token === committed.token)
                pages.delete(pageId);
              if (currentTokens.get(pageId) === invalidationToken && !pages.has(pageId))
                currentTokens.delete(pageId);
            }),
          );
        }),
      ),
    ),
    { startImmediately: true },
  );

  const authorizeCurrent = Effect.fn("ScopedDom.authorizeCurrent")(function* (
    capability: ScopedDomCapability,
    document: DomDocumentHandle,
  ) {
    const origin = yield* options.driver.currentOrigin(document);
    yield* options.authorize(capability, origin);
    return origin;
  });

  const findRef = Effect.fn("ScopedDom.findRef")(function* (pageId: string, ref: string) {
    const entry = pages.get(pageId)?.refs.get(ref);
    const now = yield* Clock.currentTimeMillis;
    if (!entry || entry.expiresAt <= now) {
      pages.get(pageId)?.refs.delete(ref);
      return yield* error("stale_ref", "The page reference is stale.");
    }
    return entry;
  });

  const snapshotUnlocked = Effect.fn("ScopedDom.snapshot")(function* (
    input: {
      readonly pageId: string;
      readonly maxDepth?: number;
      readonly interactiveOnly?: boolean;
    },
    token: object,
  ) {
    const maxDepth = input.maxDepth ?? 8;
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 8)
      return yield* error("limit", "The requested snapshot depth is invalid.");
    const capture = yield* options.driver.capture({
      pageId: input.pageId,
      maxDepth,
      interactiveOnly: input.interactiveOnly ?? true,
      authorize: (origin) => options.authorize("pages.read", origin),
    });
    // Deliver cancellation that arrived while a native request was uninterruptible
    // before building or committing a reference table from its late reply.
    yield* Effect.yieldNow;
    yield* options.authorize("pages.read", capture.origin);

    const now = yield* Clock.currentTimeMillis;
    const snapshotId = randomId("s");
    const refs = new Map<string, StoredRef>();
    const nodes: PageSnapshotNode[] = [];
    const indices = new Map<string, number>();
    if (capture.nodes.length > MaxCaptureNodes)
      return yield* error("limit", "The page snapshot exceeds its capture limit.");
    const byAxId = new Map<string, DomCapturedNode>();
    for (const node of capture.nodes) {
      if (
        node.axId.length === 0 ||
        node.axId.length > 512 ||
        byAxId.has(node.axId) ||
        (node.backendNodeId !== undefined &&
          (!Number.isSafeInteger(node.backendNodeId) || node.backendNodeId <= 0))
      )
        return yield* error(
          "browser_error",
          "The browser returned an invalid accessibility graph.",
        );
      byAxId.set(node.axId, node);
    }
    for (const node of capture.nodes)
      if (node.parentAxId !== undefined && !byAxId.has(node.parentAxId))
        return yield* error(
          "browser_error",
          "The browser returned an invalid accessibility graph.",
        );
    const ordered: DomCapturedNode[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (node: DomCapturedNode): boolean => {
      if (visited.has(node.axId)) return true;
      if (visiting.has(node.axId)) return false;
      visiting.add(node.axId);
      if (node.parentAxId !== undefined) {
        const parent = byAxId.get(node.parentAxId);
        if (parent === undefined || !visit(parent)) return false;
      }
      visiting.delete(node.axId);
      visited.add(node.axId);
      ordered.push(node);
      return true;
    };
    if (capture.nodes.some((node) => !visit(node)))
      return yield* error("browser_error", "The browser returned an invalid accessibility graph.");
    const passwordIds = new Set(
      ordered.filter((node) => node.kind === "password").map((node) => node.axId),
    );
    const frameBoundaryIds = new Set(
      ordered.filter((node) => node.frameBoundary).map((node) => node.axId),
    );
    const safeNodes = ordered.filter((node) => {
      let parent = node.parentAxId;
      const visited = new Set<string>();
      while (parent !== undefined && !visited.has(parent)) {
        if (passwordIds.has(parent) || frameBoundaryIds.has(parent)) return false;
        visited.add(parent);
        parent = byAxId.get(parent)?.parentAxId;
      }
      return true;
    });
    let truncated = safeNodes.length > MaxNodes;
    for (const source of safeNodes.slice(0, MaxNodes)) {
      const parent = source.parentAxId === undefined ? undefined : indices.get(source.parentAxId);
      const ref =
        source.backendNodeId !== undefined &&
        source.kind !== "unsupported" &&
        !source.frameBoundary &&
        refs.size < MaxPageRefs
          ? randomId("r")
          : undefined;
      const candidate: PageSnapshotNode = {
        ...(parent === undefined ? {} : { parent }),
        role: truncateUtf8(source.role, MaxStringBytes),
        ...(source.name === undefined || source.frameBoundary
          ? {}
          : { name: truncateUtf8(source.name, MaxStringBytes) }),
        ...(source.value === undefined || source.kind === "password" || source.frameBoundary
          ? {}
          : { value: truncateUtf8(source.value, MaxStringBytes) }),
        ...(source.states === undefined
          ? {}
          : {
              states: Object.freeze(
                source.states.slice(0, 32).map((state) => truncateUtf8(state, 256)),
              ),
            }),
        ...(ref === undefined ? {} : { ref }),
        ...(source.frameBoundary ? { frameBoundary: "child-frame" as const } : {}),
      };
      const next: PageSnapshot = {
        pageId: input.pageId,
        snapshotId,
        nodes: [...nodes, candidate],
        truncated,
      };
      if (scopedDomMcpResponseBytes(next) > scopedDomOutputLimit) {
        truncated = true;
        break;
      }
      indices.set(source.axId, nodes.length);
      nodes.push(candidate);
      if (ref !== undefined)
        refs.set(ref, {
          expiresAt: now + RefTtlMs,
          document: capture.document,
          node: source,
        });
    }
    if (safeNodes.length > nodes.length) truncated = true;

    // A read grant may be revoked or the document may navigate while building output.
    yield* authorizeCurrent("pages.read", capture.document);
    yield* Effect.yieldNow;
    if (currentTokens.get(input.pageId) !== token)
      return yield* error("stale_ref", "The page changed while its snapshot was captured.");
    if (!pages.has(input.pageId) && pages.size >= MaxPages) {
      const oldestPage = pages.keys().next().value;
      if (oldestPage !== undefined) {
        const removed = pages.get(oldestPage);
        pages.delete(oldestPage);
        if (removed !== undefined && currentTokens.get(oldestPage) === removed.token)
          currentTokens.delete(oldestPage);
      }
    }
    let retainedRefs = [...pages.entries()].reduce(
      (total, [pageId, state]) => total + (pageId === input.pageId ? 0 : state.refs.size),
      0,
    );
    if (retainedRefs + refs.size > MaxRefs) {
      for (const pageId of pages.keys()) {
        if (pageId === input.pageId) continue;
        const state = pages.get(pageId);
        const removed = state?.refs.size ?? 0;
        pages.delete(pageId);
        if (state !== undefined && currentTokens.get(pageId) === state.token)
          currentTokens.delete(pageId);
        retainedRefs -= removed;
        if (retainedRefs + refs.size <= MaxRefs) break;
      }
    }
    pages.set(input.pageId, { token, refs });
    return Object.freeze({
      pageId: input.pageId,
      snapshotId,
      nodes: Object.freeze(nodes.map((node) => Object.freeze(node))),
      truncated,
    });
  });

  const clickUnlocked = Effect.fn("ScopedDom.click")(function* (input: {
    readonly pageId: string;
    readonly ref: string;
  }) {
    const entry = yield* findRef(input.pageId, input.ref);
    yield* authorizeCurrent("pages.write", entry.document);
    yield* options.driver.click(entry.document, entry.node, (origin) =>
      options.authorize("pages.write", origin),
    );
    yield* Effect.yieldNow;
    yield* authorizeCurrent("pages.write", entry.document);
    return { clicked: true as const };
  });

  const fillUnlocked = Effect.fn("ScopedDom.fill")(function* (input: {
    readonly pageId: string;
    readonly ref: string;
    readonly value: string;
  }) {
    if (Buffer.byteLength(input.value) > 16 * 1024)
      return yield* error("limit", "The fill value exceeds 16 KiB.");
    const entry = yield* findRef(input.pageId, input.ref);
    if (entry.node.kind === "password")
      return yield* error("unsupported", "Password fields are unsupported.");
    if (entry.node.kind !== "text")
      return yield* error("unsupported", "This reference cannot be filled.");
    yield* authorizeCurrent("pages.write", entry.document);
    yield* options.driver.fill(entry.document, entry.node, input.value, (origin) =>
      options.authorize("pages.write", origin),
    );
    yield* Effect.yieldNow;
    yield* authorizeCurrent("pages.write", entry.document);
    return { filled: true as const };
  });

  return {
    snapshot: (input) =>
      lock.withPermit(
        Effect.suspend(() => {
          const previous = pages.get(input.pageId);
          const token = {};
          let committed = false;
          currentTokens.set(input.pageId, token);
          return snapshotUnlocked(input, token).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                committed = true;
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (committed || currentTokens.get(input.pageId) !== token) return;
                if (previous === undefined) currentTokens.delete(input.pageId);
                else currentTokens.set(input.pageId, previous.token);
              }),
            ),
          );
        }),
      ),
    click: (input) => lock.withPermit(clickUnlocked(input)),
    fill: (input) => lock.withPermit(fillUnlocked(input)),
  };
});
