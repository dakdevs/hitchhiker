import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { create } from "../src/grants.ts";
import { createPluginDispatcher } from "../src/plugin-dispatch.ts";

test("services dispatch uses the durable identity and forwards only declared, owner-bound envelopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-services-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        const issued = yield* grants.issue({
          principal: "service-plugin",
          profileId: "default",
          capabilities: [],
          origins: [],
        });
        const calls: Array<readonly [string, unknown]> = [];
        const services = {
          publish: (service: string, value: unknown) =>
            Effect.sync(() => {
              calls.push(["publish", { service, value }]);
              return { revision: 3 };
            }),
          get: (dependency: string) =>
            Effect.sync(() => {
              calls.push(["get", dependency]);
              return { available: false };
            }),
          subscribe: (dependency: string) =>
            Effect.sync(() => {
              calls.push(["subscribe", dependency]);
              return { available: false };
            }),
          call: (dependency: string, method: string, params: unknown) =>
            Effect.sync(() => {
              calls.push(["call", { dependency, method, params }]);
              return { answer: 7 };
            }),
          respond: (response: unknown) =>
            Effect.sync(() => {
              calls.push(["respond", response]);
            }),
        };
        const dispatch = createPluginDispatcher({
          manifest: {
            id: "service-plugin",
            version: "1.0.0",
            name: "Services",
            capabilities: [],
            provides: [
              {
                id: "counter",
                contract: { name: "test.counter", version: "1.0.0", digest: "a".repeat(64) },
              },
            ],
            requires: [
              {
                id: "source",
                optional: true,
                contract: { name: "test.source", version: "1.0.0", digest: "b".repeat(64) },
              },
            ],
          },
          profileId: "default",
          token: issued.token,
          grants,
          browser: {
            pages: Effect.succeed([]),
            open: () => Effect.succeed("one"),
            navigate: () => Effect.void,
            close: () => Effect.void,
            configuration: Effect.succeed({
              colorScheme: "system",
              sleepAfterMs: 1,
              alwaysAwakeOrigins: [],
            } as const),
            configure: () => Effect.void,
            setTabPlacement: () => Effect.void,
          },
          publish: () => Effect.succeed(1),
          release: Effect.void,
          services,
        });
        assert.deepEqual(
          yield* dispatch("services.publish", { service: "counter", value: { count: 1 } }),
          { revision: 3 },
        );
        assert.deepEqual(yield* dispatch("services.get", { dependency: "source" }), {
          available: false,
        });
        assert.deepEqual(yield* dispatch("services.subscribe", { dependency: "source" }), {
          available: false,
        });
        assert.deepEqual(
          yield* dispatch("services.call", {
            dependency: "source",
            method: "read.count",
            params: {},
          }),
          { answer: 7 },
        );
        yield* dispatch("services.respond", { callId: "call-1", result: { ok: true } });
        assert.deepEqual(calls, [
          ["publish", { service: "counter", value: { count: 1 } }],
          ["get", "source"],
          ["subscribe", "source"],
          ["call", { dependency: "source", method: "read.count", params: {} }],
          ["respond", { callId: "call-1", result: { ok: true } }],
        ]);

        for (const [method, params] of [
          ["services.publish", { service: "unknown", value: null }],
          ["services.get", { dependency: "unknown" }],
          ["services.call", { dependency: "source", method: "bad method", params: {} }],
          ["services.respond", { callId: "call-1", result: null, error: "no" }],
          [
            "services.call",
            { dependency: "source", method: "read", params: {}, caller: { id: "spoof" } },
          ],
          [
            "services.publish",
            { service: "counter", value: null, grantId: "spoof", token: "spoof" },
          ],
        ] as const)
          assert(Exit.isFailure(yield* Effect.exit(dispatch(method, params))));
        assert.equal(calls.length, 5);

        const unavailable = createPluginDispatcher({
          manifest: {
            id: "service-plugin",
            version: "1.0.0",
            name: "No services",
            capabilities: [],
          },
          profileId: "default",
          token: issued.token,
          grants,
          browser: {
            pages: Effect.succeed([]),
            open: () => Effect.succeed("one"),
            navigate: () => Effect.void,
            close: () => Effect.void,
            configuration: Effect.succeed({
              colorScheme: "system",
              sleepAfterMs: 1,
              alwaysAwakeOrigins: [],
            } as const),
            configure: () => Effect.void,
            setTabPlacement: () => Effect.void,
          },
          publish: () => Effect.succeed(1),
          release: Effect.void,
        });
        assert(
          Exit.isFailure(yield* Effect.exit(unavailable("services.get", { dependency: "source" }))),
        );
        yield* grants.revoke(issued.grant.id);
        assert(
          Exit.isFailure(yield* Effect.exit(dispatch("services.get", { dependency: "source" }))),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live plugins need matching identity, declared capability and current grant for each operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-grants-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        const issued = yield* grants.issue({
          principal: "sample-plugin",
          profileId: "default",
          capabilities: ["browser.full-control"],
          origins: [],
        });
        let published = 0;
        const options = {
          manifest: {
            id: "sample-plugin",
            version: "1.0.0",
            name: "Sample",
            capabilities: ["pages.list", "ui.compose"] as const,
          },
          profileId: "default",
          token: issued.token,
          grants,
          browser: {
            pages: Effect.succeed([]),
            open: () => Effect.succeed("one"),
            navigate: () => Effect.void,
            close: () => Effect.void,
            configuration: Effect.succeed({
              colorScheme: "system",
              sleepAfterMs: 300000,
              alwaysAwakeOrigins: [],
            } as const),
            configure: () => Effect.void,
            setTabPlacement: () => Effect.void,
          },
          publish: () => Effect.sync(() => ++published),
          release: Effect.void,
        };
        const dispatch = createPluginDispatcher(options);
        assert.deepEqual(yield* dispatch("pages.list", {}), []);
        assert(
          Exit.isFailure(
            yield* Effect.exit(dispatch("pages.open", { url: "https://example.test" })),
          ),
        );
        assert(
          Exit.isFailure(yield* Effect.exit(dispatch("cdp.send", { method: "Browser.close" }))),
        );
        assert.deepEqual(yield* dispatch("ui.publish", { surface: { root: {}, bindings: [] } }), {
          revision: 1,
        });
        const impersonate = createPluginDispatcher({
          ...options,
          manifest: { ...options.manifest, id: "different-plugin" },
        });
        assert(Exit.isFailure(yield* Effect.exit(impersonate("pages.list", {}))));
        yield* grants.revoke(issued.grant.id);
        assert(
          Exit.isFailure(
            yield* Effect.exit(dispatch("ui.publish", { surface: { root: {}, bindings: [] } })),
          ),
        );
        assert.equal(published, 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("composition UI dispatches only host-declared calls with an active ui.compose grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-composition-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        const issued = yield* grants.issue({
          principal: "sample-plugin",
          profileId: "default",
          capabilities: ["ui.compose"],
          origins: [],
        });
        const calls: Array<readonly [string, unknown]> = [];
        const options = {
          manifest: {
            id: "sample-plugin",
            version: "1.0.0",
            name: "Sample",
            capabilities: ["ui.compose"] as const,
          },
          profileId: "default",
          token: issued.token,
          grants,
          browser: {
            pages: Effect.succeed([]),
            open: () => Effect.succeed("one"),
            navigate: () => Effect.void,
            close: () => Effect.void,
            configuration: Effect.succeed({
              colorScheme: "system",
              sleepAfterMs: 300000,
              alwaysAwakeOrigins: [],
            } as const),
            configure: () => Effect.void,
            setTabPlacement: () => Effect.void,
          },
          publish: () => Effect.succeed(99),
          release: Effect.void,
          composition: {
            publishLayout: (surface: unknown) =>
              Effect.sync(() => {
                calls.push(["layout", surface]);
                return 1;
              }),
            publishContribution: (id: string, surface: unknown) =>
              Effect.sync(() => {
                calls.push([`contribution:${id}`, surface]);
                return 2;
              }),
            withdrawContribution: (id: string) =>
              Effect.sync(() => {
                calls.push([`withdraw:${id}`, undefined]);
                return 3;
              }),
          },
        };
        const dispatch = createPluginDispatcher(options);
        assert(
          Exit.isFailure(
            yield* Effect.exit(dispatch("ui.publish", { surface: { root: {}, bindings: [] } })),
          ),
        );
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              dispatch("ui.publishLayout", {
                surface: { root: {}, bindings: [] },
                owner: "spoofed",
              }),
            ),
          ),
        );
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              dispatch("ui.publishLayout", {
                surface: { identity: "spoofed", root: {}, bindings: [] },
              }),
            ),
          ),
        );
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              dispatch("ui.publishContribution", {
                id: "bad id",
                surface: { root: {}, bindings: [] },
              }),
            ),
          ),
        );
        assert.deepEqual(
          yield* dispatch("ui.publishLayout", { surface: { root: "layout", bindings: [] } }),
          {
            revision: 1,
          },
        );
        assert.deepEqual(
          yield* dispatch("ui.publishContribution", {
            id: "main",
            surface: { root: "fragment", bindings: [] },
          }),
          { revision: 2 },
        );
        assert.deepEqual(yield* dispatch("ui.withdrawContribution", { id: "main" }), {
          revision: 3,
        });
        assert.deepEqual(calls, [
          ["layout", { root: "layout", bindings: [] }],
          ["contribution:main", { root: "fragment", bindings: [] }],
          ["withdraw:main", undefined],
        ]);

        const unavailable = createPluginDispatcher({ ...options, composition: undefined });
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              unavailable("ui.publishLayout", { surface: { root: {}, bindings: [] } }),
            ),
          ),
        );
        const undeclared = createPluginDispatcher({
          ...options,
          manifest: { ...options.manifest, capabilities: [] },
        });
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              undeclared("ui.publishContribution", {
                id: "main",
                surface: { root: {}, bindings: [] },
              }),
            ),
          ),
        );
        yield* grants.revoke(issued.grant.id);
        assert(
          Exit.isFailure(yield* Effect.exit(dispatch("ui.withdrawContribution", { id: "main" }))),
        );
        assert.equal(calls.length, 3);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
