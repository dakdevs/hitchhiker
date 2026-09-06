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
        assert.deepEqual(yield* dispatch("ui.publish", { surface: {} }), { revision: 1 });
        const impersonate = createPluginDispatcher({
          ...options,
          manifest: { ...options.manifest, id: "different-plugin" },
        });
        assert(Exit.isFailure(yield* Effect.exit(impersonate("pages.list", {}))));
        yield* grants.revoke(issued.grant.id);
        assert(Exit.isFailure(yield* Effect.exit(dispatch("ui.publish", { surface: {} }))));
        assert.equal(published, 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
