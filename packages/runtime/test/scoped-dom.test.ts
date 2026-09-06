import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, Fiber, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  makeScopedDomSession,
  scopedDomMcpResponseBytes,
  scopedDomOutputLimit,
  ScopedDomError,
  type DomCapture,
  type DomDocumentHandle,
  type ScopedDomDriver,
} from "../src/scoped-dom.ts";

const document: DomDocumentHandle = Object.freeze({
  pageId: "page",
  frameId: "frame",
  loaderId: "loader",
  executionContextId: 7,
  uniqueContextId: "unique",
  markerName: "marker",
  markerValue: "value",
});

const baseCapture: DomCapture = Object.freeze({
  document,
  origin: "https://allowed.test",
  nodes: Object.freeze([
    Object.freeze({
      axId: "root",
      role: "rootwebarea",
      kind: "unsupported" as const,
    }),
    Object.freeze({
      axId: "button",
      parentAxId: "root",
      role: "button",
      name: "Save",
      backendNodeId: 10,
      kind: "click" as const,
    }),
    Object.freeze({
      axId: "text",
      parentAxId: "root",
      role: "textbox",
      name: "Title",
      value: "draft",
      backendNodeId: 11,
      kind: "text" as const,
    }),
    Object.freeze({
      axId: "password",
      parentAxId: "root",
      role: "textbox",
      name: "Password",
      value: "must-not-escape",
      backendNodeId: 12,
      kind: "password" as const,
    }),
    Object.freeze({
      axId: "password-value",
      parentAxId: "password",
      role: "statictext",
      name: "••••••••••••••••",
      kind: "unsupported" as const,
    }),
  ]),
});

const failureCode = <A>(effect: Effect.Effect<A, ScopedDomError>) =>
  effect.pipe(
    Effect.match({
      onFailure: (failure) => failure.code,
      onSuccess: () => "success" as const,
    }),
  );

test("scopes opaque references, redacts passwords, and reauthorizes actions", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let authorizations = 0;
        const clicked: string[] = [];
        const filled: Array<[string, string]> = [];
        const driver: ScopedDomDriver = {
          invalidations: Stream.empty,
          capture: (input) => input.authorize(baseCapture.origin).pipe(Effect.as(baseCapture)),
          currentOrigin: () => Effect.succeed(baseCapture.origin),
          click: (_document, node, authorize) =>
            authorize(baseCapture.origin).pipe(
              Effect.andThen(Effect.sync(() => clicked.push(node.axId))),
            ),
          fill: (_document, node, value, authorize) =>
            authorize(baseCapture.origin).pipe(
              Effect.andThen(Effect.sync(() => filled.push([node.axId, value]))),
            ),
        };
        const authorize = (_capability: "pages.read" | "pages.write", origin: string) =>
          Effect.sync(() => {
            assert.equal(origin, baseCapture.origin);
            authorizations += 1;
          });
        const first = yield* makeScopedDomSession({ driver, authorize });
        const second = yield* makeScopedDomSession({ driver, authorize });
        const snapshot = yield* first.snapshot({ pageId: "page", interactiveOnly: false });
        assert.equal(snapshot.nodes.find((node) => node.name === "Password")?.value, undefined);
        assert.equal(JSON.stringify(snapshot).includes("••"), false);
        const button = snapshot.nodes.find((node) => node.name === "Save")?.ref;
        const text = snapshot.nodes.find((node) => node.name === "Title")?.ref;
        const password = snapshot.nodes.find((node) => node.name === "Password")?.ref;
        assert.ok(button && text && password);

        assert.equal(
          yield* failureCode(second.click({ pageId: "page", ref: button })),
          "stale_ref",
        );
        assert.deepEqual(yield* first.click({ pageId: "page", ref: button }), { clicked: true });
        assert.deepEqual(yield* first.fill({ pageId: "page", ref: text, value: "published" }), {
          filled: true,
        });
        assert.equal(
          yield* failureCode(first.fill({ pageId: "page", ref: password, value: "secret" })),
          "unsupported",
        );
        assert.deepEqual(clicked, ["button"]);
        assert.deepEqual(filled, [["text", "published"]]);
        // capture preauthorization + snapshot authorization and final check + two checks per action.
        assert.equal(authorizations, 9);
      }),
    ),
  );
});

test("native invalidation eagerly removes a page's references", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const invalidations = yield* PubSub.bounded<string>({ capacity: 4 });
        const driver: ScopedDomDriver = {
          invalidations: Stream.fromPubSub(invalidations),
          capture: (input) => input.authorize(baseCapture.origin).pipe(Effect.as(baseCapture)),
          currentOrigin: () => Effect.succeed(baseCapture.origin),
          click: () => Effect.void,
          fill: () => Effect.void,
        };
        const session = yield* makeScopedDomSession({
          driver,
          authorize: () => Effect.void,
        });
        yield* Effect.yieldNow;
        const snapshot = yield* session.snapshot({ pageId: "page" });
        const ref = snapshot.nodes.find((node) => node.ref !== undefined)?.ref;
        assert.ok(ref);
        yield* PubSub.publish(invalidations, "page");
        yield* Effect.yieldNow;
        assert.equal(yield* failureCode(session.click({ pageId: "page", ref })), "stale_ref");
      }),
    ),
  );
});

test("invalidation during the final check prevents stale snapshot commit", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const invalidations = yield* PubSub.bounded<string>({ capacity: 4 });
        let authorizations = 0;
        const driver: ScopedDomDriver = {
          invalidations: Stream.fromPubSub(invalidations),
          capture: (input) => input.authorize(baseCapture.origin).pipe(Effect.as(baseCapture)),
          currentOrigin: () => Effect.succeed(baseCapture.origin),
          click: () => Effect.void,
          fill: () => Effect.void,
        };
        const session = yield* makeScopedDomSession({
          driver,
          authorize: () =>
            Effect.gen(function* () {
              authorizations += 1;
              if (authorizations === 3) yield* PubSub.publish(invalidations, "page");
            }),
        });
        yield* Effect.yieldNow;
        assert.equal(yield* failureCode(session.snapshot({ pageId: "page" })), "stale_ref");
        yield* Effect.yieldNow;
        const replacement = yield* session.snapshot({ pageId: "page" });
        const ref = replacement.nodes.find((node) => node.ref !== undefined)?.ref;
        assert.ok(ref);
        assert.deepEqual(yield* session.click({ pageId: "page", ref }), { clicked: true });
      }),
    ),
  );
});

test("snapshot output and reference count stay within public bounds", async () => {
  const largeCapture: DomCapture = {
    ...baseCapture,
    nodes: Object.freeze(
      Array.from({ length: 900 }, (_, index) =>
        Object.freeze({
          axId: `node-${index}`,
          role: "button",
          name: `${index}:${"🧭".repeat(2_000)}`,
          backendNodeId: index + 1,
          kind: "click" as const,
        }),
      ),
    ),
  };
  const snapshot = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* makeScopedDomSession({
          driver: {
            invalidations: Stream.empty,
            capture: (input) => input.authorize(largeCapture.origin).pipe(Effect.as(largeCapture)),
            currentOrigin: () => Effect.succeed(largeCapture.origin),
            click: () => Effect.void,
            fill: () => Effect.void,
          },
          authorize: () => Effect.void,
        });
        return yield* session.snapshot({ pageId: "page", interactiveOnly: false });
      }),
    ),
  );
  assert.equal(snapshot.truncated, true);
  assert.ok(scopedDomMcpResponseBytes(snapshot) <= scopedDomOutputLimit);
  assert.ok(snapshot.nodes.filter((node) => node.ref !== undefined).length <= 512);
  assert.ok(snapshot.nodes.length <= 512);
});

test("orders virtual parents and removes child-frame descendants", async () => {
  const capture: DomCapture = {
    ...baseCapture,
    nodes: [
      {
        axId: "action",
        parentAxId: "virtual",
        role: "button",
        name: "Top action",
        backendNodeId: 4,
        kind: "click",
      },
      { axId: "root", role: "rootwebarea", kind: "unsupported" },
      { axId: "virtual", parentAxId: "root", role: "group", kind: "unsupported" },
      {
        axId: "frame",
        parentAxId: "root",
        role: "iframe",
        name: "Child secret name",
        kind: "unsupported",
        frameBoundary: true,
      },
      {
        axId: "child-secret",
        parentAxId: "frame",
        role: "button",
        name: "Child secret action",
        backendNodeId: 5,
        kind: "click",
      },
    ],
  };
  const snapshot = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* makeScopedDomSession({
          driver: {
            invalidations: Stream.empty,
            capture: (input) => input.authorize(capture.origin).pipe(Effect.as(capture)),
            currentOrigin: () => Effect.succeed(capture.origin),
            click: () => Effect.void,
            fill: () => Effect.void,
          },
          authorize: () => Effect.void,
        });
        return yield* session.snapshot({ pageId: "page", interactiveOnly: false });
      }),
    ),
  );
  assert.equal(snapshot.nodes[2]?.name, "Top action");
  assert.equal(snapshot.nodes[2]?.parent, 1);
  assert.equal(snapshot.nodes[3]?.frameBoundary, "child-frame");
  assert.equal(snapshot.nodes[3]?.name, undefined);
  assert.equal(JSON.stringify(snapshot).includes("Child secret action"), false);
});

test("rejects duplicate, cyclic, orphaned, and malformed accessibility identities atomically", async () => {
  for (const nodes of [
    [
      { axId: "same", role: "button", kind: "click" as const },
      { axId: "same", role: "button", kind: "click" as const },
    ],
    [
      { axId: "one", parentAxId: "two", role: "group", kind: "unsupported" as const },
      { axId: "two", parentAxId: "one", role: "group", kind: "unsupported" as const },
    ],
    [{ axId: "orphan", parentAxId: "missing", role: "button", kind: "click" as const }],
    [{ axId: "bad-backend", role: "button", backendNodeId: -1, kind: "click" as const }],
  ]) {
    let capture: DomCapture = baseCapture;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver: ScopedDomDriver = {
            invalidations: Stream.empty,
            capture: (input) => input.authorize(capture.origin).pipe(Effect.as(capture)),
            currentOrigin: () => Effect.succeed(capture.origin),
            click: () => Effect.void,
            fill: () => Effect.void,
          };
          const session = yield* makeScopedDomSession({ driver, authorize: () => Effect.void });
          const good = yield* session.snapshot({ pageId: "page" });
          const existingRef = good.nodes.find((node) => node.ref !== undefined)?.ref;
          assert.ok(existingRef);
          capture = { ...baseCapture, nodes };
          assert.equal(
            yield* failureCode(session.snapshot({ pageId: "page", interactiveOnly: false })),
            "browser_error",
          );
          assert.deepEqual(yield* session.click({ pageId: "page", ref: existingRef }), {
            clicked: true,
          });
        }),
      ),
    );
  }
});

test("expires refs and evicts the oldest page namespace at bounded capacity", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const driver: ScopedDomDriver = {
          invalidations: Stream.empty,
          capture: (input) =>
            input.authorize(baseCapture.origin).pipe(
              Effect.as({
                ...baseCapture,
                document: { ...document, pageId: input.pageId },
              }),
            ),
          currentOrigin: () => Effect.succeed(baseCapture.origin),
          click: () => Effect.void,
          fill: () => Effect.void,
        };
        const session = yield* makeScopedDomSession({ driver, authorize: () => Effect.void });
        const expiring = yield* session.snapshot({ pageId: "expires" });
        const expiringRef = expiring.nodes.find((node) => node.ref !== undefined)?.ref;
        assert.ok(expiringRef);
        yield* TestClock.adjust(60_001);
        assert.equal(
          yield* failureCode(session.click({ pageId: "expires", ref: expiringRef })),
          "stale_ref",
        );

        const pageRefs = new Map<string, string>();
        for (let index = 0; index < 9; index++) {
          const pageId = `page-${index}`;
          const snapshot = yield* session.snapshot({ pageId });
          pageRefs.set(pageId, snapshot.nodes.find((node) => node.ref !== undefined)!.ref!);
        }
        assert.equal(
          yield* failureCode(session.click({ pageId: "page-0", ref: pageRefs.get("page-0")! })),
          "stale_ref",
        );
        assert.deepEqual(yield* session.click({ pageId: "page-8", ref: pageRefs.get("page-8")! }), {
          clicked: true,
        });
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});

test("cancellation releases the session lock and ignores a late uninterruptible capture", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const lateReply = yield* Deferred.make<void>();
        let first = true;
        let currentChecks = 0;
        const driver: ScopedDomDriver = {
          invalidations: Stream.empty,
          capture: (input) => {
            const authorize = input.authorize(baseCapture.origin);
            if (!first) return authorize.pipe(Effect.as(baseCapture));
            first = false;
            return authorize.pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.uninterruptible(Deferred.await(lateReply))),
              Effect.as(baseCapture),
            );
          },
          currentOrigin: () =>
            Effect.sync(() => {
              currentChecks += 1;
              return baseCapture.origin;
            }),
          click: () => Effect.void,
          fill: () => Effect.void,
        };
        const session = yield* makeScopedDomSession({ driver, authorize: () => Effect.void });
        const cancelled = yield* session.snapshot({ pageId: "page" }).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const interruption = yield* Fiber.interrupt(cancelled).pipe(Effect.forkScoped);
        yield* Deferred.succeed(lateReply, undefined);
        yield* Fiber.join(interruption);
        assert.equal(currentChecks, 0, "cancelled capture did not reach commit validation");
        const replacement = yield* session.snapshot({ pageId: "page" }).pipe(Effect.timeout(500));
        assert.ok(replacement.nodes.some((node) => node.ref !== undefined));
        assert.equal(currentChecks, 1);
      }),
    ),
  );
});
