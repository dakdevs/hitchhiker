import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { create } from "../src/grants.ts";
import { createPluginDispatcher } from "../src/plugin-dispatch.ts";

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
