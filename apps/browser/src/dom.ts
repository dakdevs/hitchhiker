import {
  EngineConnection,
  EngineError,
  ScopedDomError,
  type DomCapture,
  type DomCapturedNode,
  type DomDocumentHandle,
  type JsonObject,
  type ScopedDomDriver,
} from "@hitchhiker/runtime";
import { Effect, Fiber, Option, Schema, Scope, Semaphore, Stream } from "effect";

const FrameResponse = Schema.Struct({
  frameTree: Schema.Struct({
    frame: Schema.Struct({
      id: Schema.String,
      loaderId: Schema.String,
      securityOrigin: Schema.String,
    }),
  }),
});
const CreatedWorld = Schema.Struct({ executionContextId: Schema.Number });
const ContextCreated = Schema.Struct({
  context: Schema.Struct({
    id: Schema.Number,
    uniqueId: Schema.String,
    name: Schema.String,
    auxData: Schema.Struct({
      frameId: Schema.String,
      isDefault: Schema.optional(Schema.Boolean),
    }),
  }),
});
const RemoteValue = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
});
const AxValue = Schema.Struct({ value: Schema.optional(Schema.Unknown) });
const AxNode = Schema.Struct({
  nodeId: Schema.String,
  parentId: Schema.optional(Schema.String),
  backendDOMNodeId: Schema.optional(Schema.Number),
  frameId: Schema.optional(Schema.String),
  ignored: Schema.optional(Schema.Boolean),
  role: Schema.optional(AxValue),
  name: Schema.optional(AxValue),
  value: Schema.optional(AxValue),
  properties: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.optional(AxValue) })),
  ),
});
const AxTree = Schema.Struct({ nodes: Schema.Array(AxNode) });
const DescribedNode = Schema.Struct({
  node: Schema.Struct({
    nodeName: Schema.String,
    attributes: Schema.optional(Schema.Array(Schema.String)),
  }),
});
const ResolvedNode = Schema.Struct({
  object: Schema.Struct({ objectId: Schema.optional(Schema.String) }),
});
const ActionResult = Schema.Struct({
  result: Schema.Struct({
    value: Schema.optional(
      Schema.Struct({ status: Schema.Literals(["ok", "stale", "covered", "unsupported"]) }),
    ),
  }),
});

const InteractiveRoles = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
]);
const TextRoles = new Set(["textbox", "searchbox"]);
const StateNames = new Set([
  "checked",
  "disabled",
  "expanded",
  "selected",
  "readonly",
  "required",
  "protected",
]);
const TextInputTypes = new Set(["", "text", "email", "url", "tel", "search"]);
const MaxAxNodes = 2_048;

const domError = (code: ScopedDomError["code"], message: string) =>
  new ScopedDomError({ code, message });
const browserError = () =>
  domError("browser_error", "The browser could not complete the DOM operation.");
const staleError = () => domError("stale_ref", "The page reference is stale.");

const mapEngineError = (failure: EngineError): ScopedDomError => {
  const detail = `${failure.code} ${failure.message}`.toLowerCase();
  if (detail.includes("closed") || detail.includes("no page") || detail.includes("not found"))
    return domError("page_gone", "The page is no longer available.");
  if (
    detail.includes("context") ||
    detail.includes("frame") ||
    detail.includes("node") ||
    detail.includes("object")
  )
    return staleError();
  return browserError();
};

const canonicalOrigin = (value: string): string | undefined => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

const textValue = (value: { readonly value?: unknown } | undefined): string | undefined =>
  typeof value?.value === "string" ? value.value : undefined;
const stateValue = (value: unknown): string | undefined => {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number")
    return String(value);
  return undefined;
};
const attributes = (flat: readonly string[] | undefined): ReadonlyMap<string, string> => {
  const result = new Map<string, string>();
  if (flat === undefined || flat.length % 2 !== 0) return result;
  for (let index = 0; index < flat.length; index += 2)
    result.set(flat[index]!.toLowerCase(), flat[index + 1]!);
  return result;
};

const ClickFunction = `function(markerName, markerValue) {
  const N = Node.prototype;
  const E = Element.prototype;
  const H = HTMLElement.prototype;
  const D = Document.prototype;
  const connected = Object.getOwnPropertyDescriptor(N, "isConnected").get;
  const owner = Object.getOwnPropertyDescriptor(N, "ownerDocument").get;
  const parent = Object.getOwnPropertyDescriptor(N, "parentNode").get;
  const rect = E.getBoundingClientRect;
  const style = globalThis.getComputedStyle;
  const atPoint = D.elementFromPoint;
  if (globalThis[markerName] !== markerValue || owner.call(this) !== document || !connected.call(this)) return { status: "stale" };
  if (!(this instanceof HTMLElement) || E.matches.call(this, ":disabled")) return { status: "unsupported" };
  E.scrollIntoView.call(this, { block: "center", inline: "center", behavior: "instant" });
  if (globalThis[markerName] !== markerValue || owner.call(this) !== document || !connected.call(this)) return { status: "stale" };
  const css = style(this);
  const box = rect.call(this);
  if (css.display === "none" || css.visibility === "hidden" || css.pointerEvents === "none" || box.width <= 0 || box.height <= 0) return { status: "covered" };
  let hit = atPoint.call(document, box.left + box.width / 2, box.top + box.height / 2);
  while (hit && hit !== this) {
    const direct = parent.call(hit);
    if (direct) hit = direct;
    else {
      const root = N.getRootNode.call(hit);
      hit = root && root.host instanceof Element ? root.host : null;
    }
  }
  if (hit !== this) return { status: "covered" };
  H.click.call(this);
  return { status: "ok" };
}`;

const FillFunction = `function(markerName, markerValue, nextValue) {
  const N = Node.prototype;
  const connected = Object.getOwnPropertyDescriptor(N, "isConnected").get;
  const owner = Object.getOwnPropertyDescriptor(N, "ownerDocument").get;
  if (globalThis[markerName] !== markerValue || owner.call(this) !== document || !connected.call(this)) return { status: "stale" };
  let prototype;
  if (this instanceof HTMLInputElement) {
    const type = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "type").get.call(this).toLowerCase();
    if (type === "password" || !["", "text", "email", "url", "tel", "search"].includes(type)) return { status: "unsupported" };
    if (Element.prototype.matches.call(this, ":disabled") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "readOnly").get.call(this)) return { status: "unsupported" };
    prototype = HTMLInputElement.prototype;
  } else if (this instanceof HTMLTextAreaElement) {
    if (Element.prototype.matches.call(this, ":disabled") || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "readOnly").get.call(this)) return { status: "unsupported" };
    prototype = HTMLTextAreaElement.prototype;
  } else return { status: "unsupported" };
  HTMLElement.prototype.focus.call(this);
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(this, nextValue);
  EventTarget.prototype.dispatchEvent.call(this, new Event("input", { bubbles: true }));
  EventTarget.prototype.dispatchEvent.call(this, new Event("change", { bubbles: true }));
  return { status: "ok" };
}`;

export interface BrowserDomOptions {
  readonly protectWrite: (pageId: string) => Effect.Effect<void, EngineError>;
}

/** Closed adapter from stable pages to fixed, page-scoped CDP operations. */
export const makeBrowserDomDriver = Effect.fn("makeBrowserDomDriver")(function* (
  options: BrowserDomOptions,
) {
  const engine = yield* EngineConnection;
  const registryLock = yield* Semaphore.make(1);
  const pageLocks = new Map<string, { readonly lock: typeof registryLock; users: number }>();
  const documents = new Map<string, DomDocumentHandle>();
  const driverWorldName = `hitchhiker-scoped-dom-${crypto.randomUUID()}`;
  const lockFor = Effect.fn("BrowserDom.lockFor")(function* (pageId: string) {
    return yield* registryLock.withPermit(
      Effect.gen(function* () {
        const existing = pageLocks.get(pageId);
        if (existing !== undefined) {
          existing.users += 1;
          return existing.lock;
        }
        const created = yield* Semaphore.make(1);
        pageLocks.set(pageId, { lock: created, users: 1 });
        return created;
      }),
    );
  });
  const releaseLock = (pageId: string) =>
    registryLock.withPermit(
      Effect.sync(() => {
        const entry = pageLocks.get(pageId);
        if (entry === undefined) return;
        entry.users -= 1;
        if (entry.users === 0) pageLocks.delete(pageId);
      }),
    );
  const cdp = (pageId: string, method: string, params: JsonObject = {}) =>
    engine.request("cdp.send", { pageId, method, params }).pipe(Effect.mapError(mapEngineError));
  const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => browserError()));
  const frame = Effect.fn("BrowserDom.frame")(function* (pageId: string) {
    const reply = yield* cdp(pageId, "Page.getFrameTree").pipe(
      Effect.flatMap((value) => decode(FrameResponse, value)),
    );
    const top = reply.frameTree.frame;
    const origin = canonicalOrigin(top.securityOrigin);
    if (origin === undefined)
      return yield* domError("unsupported", "This page origin is unsupported.");
    return { frameId: top.id, loaderId: top.loaderId, origin };
  });
  const evaluateValue = Effect.fn("BrowserDom.evaluateValue")(function* (
    document: DomDocumentHandle,
    expression: string,
  ) {
    const reply = yield* cdp(document.pageId, "Runtime.evaluate", {
      expression,
      uniqueContextId: document.uniqueContextId,
      returnByValue: true,
      awaitPromise: false,
      allowUnsafeEvalBlockedByCSP: false,
    }).pipe(Effect.flatMap((value) => decode(RemoteValue, value)));
    return reply.result.value;
  });
  const validateDocument = Effect.fn("BrowserDom.validateDocument")(function* (
    document: DomDocumentHandle,
  ) {
    const top = yield* frame(document.pageId);
    if (top.frameId !== document.frameId || top.loaderId !== document.loaderId)
      return yield* staleError();
    const expression = `({ marker: globalThis[${JSON.stringify(document.markerName)}], origin: location.origin })`;
    const value = yield* evaluateValue(document, expression);
    const decoded = yield* decode(
      Schema.Struct({ marker: Schema.String, origin: Schema.String }),
      value,
    );
    const origin = canonicalOrigin(decoded.origin);
    if (decoded.marker !== document.markerValue || origin === undefined || origin !== top.origin)
      return yield* staleError();
    return origin;
  });
  const waitForWorld = (pageId: string, frameId: string, name: string) =>
    engine.events.pipe(
      Stream.filter(
        (event) =>
          event.event === "cdp.event" &&
          event.params.pageId === pageId &&
          event.params.method === "Runtime.executionContextCreated",
      ),
      Stream.mapEffect((event) => decode(ContextCreated, event.params.params)),
      Stream.filter(
        ({ context }) =>
          context.name === name &&
          context.auxData.frameId === frameId &&
          context.auxData.isDefault !== true,
      ),
      Stream.take(1),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(browserError()),
          onSome: Effect.succeed,
        }),
      ),
      Effect.timeoutOrElse({ duration: 5_000, orElse: () => Effect.fail(browserError()) }),
    );

  const captureUnlocked = Effect.fn("BrowserDom.capture")(function* (input: {
    readonly pageId: string;
    readonly maxDepth: number;
    readonly interactiveOnly: boolean;
    readonly authorize: (origin: string) => Effect.Effect<void, ScopedDomError>;
  }): Effect.fn.Return<DomCapture, ScopedDomError, Scope.Scope> {
    yield* cdp(input.pageId, "Page.enable");
    yield* cdp(input.pageId, "DOM.enable");
    const top = yield* frame(input.pageId);
    let document = documents.get(input.pageId);
    if (
      document !== undefined &&
      (document.frameId !== top.frameId || document.loaderId !== top.loaderId)
    ) {
      documents.delete(input.pageId);
      document = undefined;
    }
    let origin: string;
    if (document === undefined) {
      if (documents.size >= 128)
        return yield* domError("limit", "The scoped document cache is full.");
      const eventFiber = yield* Effect.forkScoped(
        waitForWorld(input.pageId, top.frameId, driverWorldName),
        { startImmediately: true },
      );
      yield* cdp(input.pageId, "Runtime.enable");
      const created = yield* cdp(input.pageId, "Page.createIsolatedWorld", {
        frameId: top.frameId,
        worldName: driverWorldName,
        grantUniveralAccess: false,
      }).pipe(Effect.flatMap((value) => decode(CreatedWorld, value)));
      const context = (yield* Fiber.join(eventFiber)).context;
      if (
        context.id !== created.executionContextId ||
        context.uniqueId.length === 0 ||
        context.name !== driverWorldName ||
        context.auxData.frameId !== top.frameId
      )
        return yield* browserError();
      const markerName = `__hitchhiker_${crypto.randomUUID().replaceAll("-", "")}`;
      const markerValue = crypto.randomUUID();
      document = Object.freeze({
        pageId: input.pageId,
        frameId: top.frameId,
        loaderId: top.loaderId,
        executionContextId: context.id,
        uniqueContextId: context.uniqueId,
        markerName,
        markerValue,
      });
      const installed = yield* evaluateValue(
        document,
        `Object.defineProperty(globalThis, ${JSON.stringify(markerName)}, { value: ${JSON.stringify(markerValue)}, configurable: false }); ({ marker: globalThis[${JSON.stringify(markerName)}], origin: location.origin })`,
      );
      const identified = yield* decode(
        Schema.Struct({ marker: Schema.String, origin: Schema.String }),
        installed,
      );
      const installedOrigin = canonicalOrigin(identified.origin);
      if (
        identified.marker !== markerValue ||
        installedOrigin === undefined ||
        installedOrigin !== top.origin
      )
        return yield* staleError();
      origin = installedOrigin;
      documents.set(input.pageId, document);
    } else origin = yield* validateDocument(document);
    yield* input.authorize(origin);

    let accessibilityMayBeEnabled = false;
    const tree = yield* Effect.gen(function* () {
      // Set this before sending enable. Engine request cancellation can discard a late reply
      // after Chromium has applied the command, while requests on the connection stay ordered.
      accessibilityMayBeEnabled = true;
      yield* cdp(input.pageId, "Accessibility.enable");
      return yield* cdp(input.pageId, "Accessibility.getFullAXTree", {
        frameId: top.frameId,
        depth: input.maxDepth,
      }).pipe(Effect.flatMap((value) => decode(AxTree, value)));
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          accessibilityMayBeEnabled
            ? cdp(input.pageId, "Accessibility.disable").pipe(
                Effect.timeout("1 second"),
                Effect.tapError(() =>
                  Effect.logWarning("Could not disable the scoped accessibility domain"),
                ),
                Effect.ignore,
                Effect.uninterruptible,
              )
            : Effect.void,
        ),
      ),
    );
    if (tree.nodes.length > MaxAxNodes)
      return yield* domError("limit", "The page snapshot exceeds its node limit.");
    if (tree.nodes.some((node) => node.frameId !== undefined && node.frameId !== top.frameId))
      return yield* browserError();

    const described = new Map<
      number,
      { readonly nodeName: string; readonly attributes?: readonly string[] }
    >();
    const describeIds = [
      ...new Set(
        tree.nodes.flatMap((node) => {
          const role = textValue(node.role)?.toLowerCase();
          const protectedValue = node.properties?.some(
            (property) => property.name === "protected" && property.value?.value === true,
          );
          return node.backendDOMNodeId !== undefined &&
            role !== undefined &&
            (TextRoles.has(role) ||
              InteractiveRoles.has(role) ||
              textValue(node.value) !== undefined ||
              protectedValue)
            ? [node.backendDOMNodeId]
            : [];
        }),
      ),
    ];
    if (describeIds.length > 512)
      return yield* domError("limit", "The page has too many text controls to inspect safely.");
    yield* Effect.forEach(
      describeIds,
      (backendNodeId) =>
        cdp(input.pageId, "DOM.describeNode", { backendNodeId, depth: 0, pierce: false }).pipe(
          Effect.flatMap((value) => decode(DescribedNode, value)),
          Effect.tap(({ node }) => Effect.sync(() => described.set(backendNodeId, node))),
        ),
      { concurrency: 4, discard: true },
    );

    const allNodes: DomCapturedNode[] = tree.nodes.map((node) => {
      const role = textValue(node.role)?.toLowerCase() ?? "unknown";
      const frameBoundary =
        role === "iframe" || (role === "webarea" && node.nodeId !== tree.nodes[0]?.nodeId);
      let kind: DomCapturedNode["kind"] = InteractiveRoles.has(role) ? "click" : "unsupported";
      const protectedValue = node.properties?.some(
        (property) => property.name === "protected" && property.value?.value === true,
      );
      if (protectedValue) kind = "password";
      if (node.backendDOMNodeId !== undefined) {
        const details = described.get(node.backendDOMNodeId);
        const attrs = attributes(details?.attributes);
        const tag = details?.nodeName.toLowerCase();
        const type = attrs.get("type")?.toLowerCase() ?? "";
        if (tag === "input" && type === "password") kind = "password";
        else if (
          !protectedValue &&
          (tag === "textarea" || (tag === "input" && TextInputTypes.has(type)))
        )
          kind = "text";
      }
      const states = node.properties?.flatMap((property) => {
        if (!StateNames.has(property.name)) return [];
        const value = stateValue(property.value?.value);
        return value === undefined ? [] : [`${property.name}:${value}`];
      });
      return Object.freeze({
        axId: node.nodeId,
        ...(node.parentId === undefined ? {} : { parentAxId: node.parentId }),
        role,
        ...(!frameBoundary && textValue(node.name) !== undefined
          ? { name: textValue(node.name) }
          : {}),
        ...(!frameBoundary && kind === "text" && textValue(node.value) !== undefined
          ? { value: textValue(node.value) }
          : {}),
        ...(states === undefined || states.length === 0 ? {} : { states: Object.freeze(states) }),
        ...(!frameBoundary && node.backendDOMNodeId !== undefined
          ? { backendNodeId: node.backendDOMNodeId }
          : {}),
        kind: frameBoundary ? "unsupported" : kind,
        ...(frameBoundary ? { frameBoundary: true as const } : {}),
      });
    });
    const nodes = input.interactiveOnly
      ? (() => {
          const byId = new Map(allNodes.map((node) => [node.axId, node]));
          const keep = new Set(
            allNodes
              .filter((node) => node.kind !== "unsupported" || node.frameBoundary)
              .map((node) => node.axId),
          );
          for (const node of allNodes) {
            if (!keep.has(node.axId)) continue;
            let parent = node.parentAxId;
            while (parent !== undefined && !keep.has(parent)) {
              keep.add(parent);
              parent = byId.get(parent)?.parentAxId;
            }
          }
          return allNodes.filter((node) => keep.has(node.axId));
        })()
      : allNodes;
    yield* validateDocument(document);
    return Object.freeze({ document, origin, nodes: Object.freeze(nodes) });
  });

  const useNode = Effect.fn("BrowserDom.useNode")(function* (
    document: DomDocumentHandle,
    node: DomCapturedNode,
    operation: "click" | "fill",
    authorize: (origin: string) => Effect.Effect<void, ScopedDomError>,
    value?: string,
  ) {
    const backendNodeId = node.backendNodeId;
    if (backendNodeId === undefined) return yield* staleError();
    yield* validateDocument(document);
    const objectGroup = `hitchhiker-dom-${crypto.randomUUID()}`;
    return yield* Effect.gen(function* () {
      const resolved = yield* cdp(document.pageId, "DOM.resolveNode", {
        backendNodeId,
        executionContextId: document.executionContextId,
        objectGroup,
      }).pipe(Effect.flatMap((reply) => decode(ResolvedNode, reply)));
      const objectId = resolved.object.objectId;
      if (objectId === undefined) return yield* staleError();
      const originBeforeProtection = yield* validateDocument(document);
      yield* authorize(originBeforeProtection);
      yield* options.protectWrite(document.pageId).pipe(Effect.mapError(mapEngineError));
      const origin = yield* validateDocument(document);
      yield* authorize(origin);
      const reply = yield* cdp(document.pageId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: operation === "click" ? ClickFunction : FillFunction,
        arguments: [
          { value: document.markerName },
          { value: document.markerValue },
          ...(operation === "fill" ? [{ value: value ?? "" }] : []),
        ],
        returnByValue: true,
        awaitPromise: false,
        silent: true,
      }).pipe(Effect.flatMap((result) => decode(ActionResult, result)));
      const status = reply.result.value?.status;
      if (status === "ok") return;
      if (status === "covered") return yield* domError("covered", "The page element is covered.");
      if (status === "unsupported")
        return yield* domError("unsupported", "This page element is unsupported.");
      return yield* staleError();
    }).pipe(
      Effect.ensuring(
        cdp(document.pageId, "Runtime.releaseObjectGroup", { objectGroup }).pipe(
          Effect.tapError(() => Effect.logWarning("Could not release a scoped DOM object group")),
          Effect.ignore,
        ),
      ),
    );
  });

  const underPageLock = <A, E>(pageId: string, operation: Effect.Effect<A, E>) =>
    lockFor(pageId).pipe(
      Effect.flatMap((lock) => lock.withPermit(operation)),
      Effect.ensuring(releaseLock(pageId)),
    );
  const invalidations = engine.events.pipe(
    Stream.filter(
      (event) =>
        typeof event.params.pageId === "string" &&
        (event.event === "pages.closed" ||
          event.event === "pages.navigationChanged" ||
          (event.event === "cdp.event" &&
            typeof event.params.method === "string" &&
            [
              "Runtime.executionContextDestroyed",
              "Runtime.executionContextsCleared",
              "Page.frameDetached",
              "Page.frameNavigated",
            ].includes(event.params.method))),
    ),
    Stream.map((event) => event.params.pageId as string),
  );
  yield* Effect.forkScoped(
    engine.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          const pageId = typeof event.params.pageId === "string" ? event.params.pageId : undefined;
          if (pageId === undefined) return;
          const document = documents.get(pageId);
          if (document === undefined) return;
          if (event.event === "pages.closed") {
            documents.delete(pageId);
            return;
          }
          if (event.event !== "cdp.event" || typeof event.params.method !== "string") return;
          const params = event.params.params;
          if (params === null || typeof params !== "object" || Array.isArray(params)) return;
          const fields = params as Record<string, unknown>;
          if (event.params.method === "Runtime.executionContextsCleared") documents.delete(pageId);
          else if (
            event.params.method === "Runtime.executionContextDestroyed" &&
            (fields.executionContextId === document.executionContextId ||
              fields.executionContextUniqueId === document.uniqueContextId)
          )
            documents.delete(pageId);
          else if (
            event.params.method === "Page.frameDetached" &&
            fields.frameId === document.frameId
          )
            documents.delete(pageId);
          else if (event.params.method === "Page.frameNavigated") {
            const navigated = fields.frame;
            if (
              navigated !== null &&
              typeof navigated === "object" &&
              !Array.isArray(navigated) &&
              (navigated as Record<string, unknown>).id === document.frameId &&
              (navigated as Record<string, unknown>).loaderId !== document.loaderId
            )
              documents.delete(pageId);
          }
        }),
      ),
    ),
    { startImmediately: true },
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      documents.clear();
      pageLocks.clear();
    }),
  );
  return {
    invalidations,
    capture: (input) => underPageLock(input.pageId, Effect.scoped(captureUnlocked(input))),
    currentOrigin: (document) => underPageLock(document.pageId, validateDocument(document)),
    click: (document, node, authorize) =>
      underPageLock(document.pageId, useNode(document, node, "click", authorize)),
    fill: (document, node, value, authorize) =>
      underPageLock(document.pageId, useNode(document, node, "fill", authorize, value)),
  } satisfies ScopedDomDriver;
});
