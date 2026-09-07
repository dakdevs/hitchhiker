import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, Stream } from "effect";
import type { Capability } from "@hitchhiker/core";
import { create, type ManagedGrantStoreApi } from "../src/grants.ts";
import { makePluginDomSession } from "../src/plugin-dom.ts";
import {
  LivePluginManifest,
  createPluginDispatcher,
  type LivePluginManifest as Manifest,
} from "../src/plugin-dispatch.ts";
import { ScopedDomError, type ScopedDomDriver } from "../src/scoped-dom.ts";

const profileId = "default";
const allowedOrigin = "https://allowed.test";
const browser = {
  pages: Effect.succeed([]),
  open: () => Effect.succeed("page"),
  navigate: () => Effect.void,
  close: () => Effect.void,
  configuration: Effect.succeed({
    colorScheme: "system" as const,
    sleepAfterMs: 1,
    alwaysAwakeOrigins: [],
  }),
  configure: () => Effect.void,
  setTabPlacement: () => Effect.void,
};

const makeDriver = (origin = allowedOrigin) => {
  let current = origin;
  let unavailable = false;
  const calls: string[] = [];
  const document = {
    pageId: "page",
    frameId: "frame",
    loaderId: "loader",
    executionContextId: 1,
    uniqueContextId: "context",
    markerName: "marker",
    markerValue: "value",
  };
  const authorize = (callback: (value: string) => Effect.Effect<void, ScopedDomError>) =>
    callback(current);
  const driver: ScopedDomDriver = {
    invalidations: Stream.never,
    capture: ({ authorize: check }) =>
      authorize(check).pipe(
        Effect.tap(() => Effect.sync(() => calls.push("capture"))),
        Effect.as({
          document,
          origin: current,
          nodes: [
            { axId: "root", role: "document", kind: "unsupported" as const },
            {
              axId: "button",
              parentAxId: "root",
              role: "button",
              name: "Submit",
              backendNodeId: 7,
              kind: "click" as const,
            },
          ],
        }),
      ),
    currentOrigin: () =>
      unavailable
        ? Effect.fail(new ScopedDomError({ code: "page_gone", message: "gone" }))
        : Effect.succeed(current),
    click: (_document, _node, check) =>
      authorize(check).pipe(Effect.tap(() => Effect.sync(() => calls.push("click")))),
    fill: (_document, _node, _value, check) =>
      authorize(check).pipe(Effect.tap(() => Effect.sync(() => calls.push("fill")))),
  };
  return {
    driver,
    calls,
    setOrigin: (value: string) => {
      current = value;
    },
    setUnavailable: () => {
      unavailable = true;
    },
  };
};

const manifest = (id: string, capabilities: readonly Capability[]): Manifest =>
  LivePluginManifest.make({ id, version: "1.0.0", name: "DOM plugin", capabilities });

const scopedDispatcher = Effect.fn("test.scopedDispatcher")(function* (input: {
  readonly grants: ManagedGrantStoreApi;
  readonly token: string;
  readonly plugin: Manifest;
  readonly driver: ScopedDomDriver;
}) {
  const dom = yield* makePluginDomSession({
    manifest: input.plugin,
    profileId,
    token: input.token,
    grants: input.grants,
    driver: input.driver,
  });
  return createPluginDispatcher({
    manifest: input.plugin,
    profileId,
    token: input.token,
    grants: input.grants,
    browser,
    publish: () => Effect.succeed(1),
    release: Effect.void,
    dom,
  });
});

test("plugin DOM dispatch keeps each activation's references private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-dom-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        const issued = yield* grants.issue({
          principal: "dom-plugin",
          profileId,
          capabilities: ["pages.read", "pages.write"],
          origins: [allowedOrigin],
        });
        const fake = makeDriver();
        const plugin = manifest("dom-plugin", ["pages.read", "pages.write"]);
        const first = yield* scopedDispatcher({
          grants,
          token: issued.token,
          plugin,
          driver: fake.driver,
        });
        const second = yield* scopedDispatcher({
          grants,
          token: issued.token,
          plugin,
          driver: fake.driver,
        });
        const snapshot = yield* first("dom.snapshot", { pageId: "page" });
        const ref = (snapshot as { nodes: readonly { readonly ref?: string }[] }).nodes[1]?.ref;
        assert.ok(ref);
        assert.deepEqual(yield* first("dom.click", { pageId: "page", ref }), { clicked: true });
        const isolated = yield* Effect.flip(second("dom.click", { pageId: "page", ref }));
        assert.equal(isolated.code, "stale_ref");
        assert.deepEqual(fake.calls, ["capture", "click"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plugin DOM dispatch checks declarations and current origin grants for every operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-dom-auth-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        const issued = yield* grants.issue({
          principal: "dom-plugin",
          profileId,
          capabilities: ["pages.read", "pages.write"],
          origins: [allowedOrigin],
        });
        const fake = makeDriver();
        const readOnly = yield* scopedDispatcher({
          grants,
          token: issued.token,
          plugin: manifest("dom-plugin", ["pages.read"]),
          driver: fake.driver,
        });
        const snapshot = yield* readOnly("dom.snapshot", { pageId: "page" });
        const ref = (snapshot as { nodes: readonly { readonly ref?: string }[] }).nodes[1]?.ref;
        assert.ok(ref);
        const writeDenied = yield* Effect.flip(readOnly("dom.click", { pageId: "page", ref }));
        assert.equal(writeDenied.code, "denied");
        assert.deepEqual(fake.calls, ["capture"]);

        const foreign = makeDriver("https://foreign.test");
        const full = yield* scopedDispatcher({
          grants,
          token: issued.token,
          plugin: manifest("dom-plugin", ["pages.read", "pages.write"]),
          driver: foreign.driver,
        });
        const originDenied = yield* Effect.flip(full("dom.snapshot", { pageId: "page" }));
        assert.equal(originDenied.code, "not_authorized");
        assert.deepEqual(foreign.calls, []);

        const other = yield* grants.issue({
          principal: "other-plugin",
          profileId,
          capabilities: ["pages.read", "pages.write"],
          origins: [allowedOrigin],
        });
        const crossPrincipal = yield* scopedDispatcher({
          grants,
          token: other.token,
          plugin: manifest("dom-plugin", ["pages.read", "pages.write"]),
          driver: fake.driver,
        });
        const principalDenied = yield* Effect.flip(
          crossPrincipal("dom.snapshot", { pageId: "page" }),
        );
        assert.equal(principalDenied.code, "not_authorized");
        assert.deepEqual(fake.calls, ["capture"]);

        assert.equal(
          yield* makePluginDomSession({
            manifest: manifest("no-dom-plugin", []),
            profileId,
            token: issued.token,
            grants,
            driver: fake.driver,
          }),
          undefined,
        );

        const writable = yield* scopedDispatcher({
          grants,
          token: issued.token,
          plugin: manifest("dom-plugin", ["pages.read", "pages.write"]),
          driver: fake.driver,
        });
        const writableSnapshot = yield* writable("dom.snapshot", { pageId: "page" });
        const writableRef = (writableSnapshot as { nodes: readonly { readonly ref?: string }[] })
          .nodes[1]?.ref;
        assert.ok(writableRef);
        yield* grants.revoke(issued.grant.id);
        const revoked = yield* Effect.flip(
          writable("dom.click", { pageId: "page", ref: writableRef }),
        );
        assert.equal(revoked.code, "not_authorized");
        assert.deepEqual(fake.calls, ["capture", "capture"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plugin DOM dispatch rejects malformed inputs and clears references when its activation stops", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-dom-lifecycle-"));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        const issued = yield* grants.issue({
          principal: "dom-plugin",
          profileId,
          capabilities: ["pages.read", "pages.write"],
          origins: [allowedOrigin],
        });
        const fake = makeDriver();
        const plugin = manifest("dom-plugin", ["pages.read", "pages.write"]);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const dispatch = yield* scopedDispatcher({
              grants,
              token: issued.token,
              plugin,
              driver: fake.driver,
            });
            assert(
              Exit.isFailure(
                yield* Effect.exit(dispatch("dom.snapshot", { pageId: "page", extra: true })),
              ),
            );
            assert(
              Exit.isFailure(
                yield* Effect.exit(
                  dispatch("dom.fill", { pageId: "page", ref: "r", value: "x".repeat(16_385) }),
                ),
              ),
            );
            const snapshot = yield* dispatch("dom.snapshot", { pageId: "page" });
            const ref = (snapshot as { nodes: readonly { readonly ref?: string }[] }).nodes[1]?.ref;
            assert.ok(ref);
            return { dispatch, ref, fake };
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    const stopped = await Effect.runPromise(
      Effect.flip(result.dispatch("dom.click", { pageId: "page", ref: result.ref })),
    );
    assert.equal(stopped.code, "stale_ref");
    assert.deepEqual(result.fake.calls, ["capture"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
