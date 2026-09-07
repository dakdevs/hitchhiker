import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Exit } from "effect";
import { NodeServices } from "@effect/platform-node";
import { create } from "../src/grants.ts";
import { createPluginStorage } from "../src/plugin-storage.ts";
import { makePageObservations } from "../src/page-observations.ts";
import { createPluginDispatcher } from "../src/plugin-dispatch.ts";

test("plugin state APIs bind identity, reject extra credentials, enforce CAS and revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-state-dispatch-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const grants = yield* create({ directory: join(directory, "grants") });
          const capabilities = ["storage.local", "pages.list", "pages.manage"] as const;
          const issued = yield* grants.issue({
            principal: "state-plugin",
            profileId: "default",
            capabilities,
            origins: [],
          });
          const store = yield* createPluginStorage({ profileRoot: directory });
          const storage = yield* store.forOwner("state-plugin");
          const observations = yield* makePageObservations();
          const subscription = yield* observations.bind("trusted-generation");
          const history: string[] = [];
          const options = {
            manifest: { id: "state-plugin", name: "State", version: "1.0.0", capabilities },
            profileId: "default",
            token: issued.token,
            grants,
            storage,
            pageWatch: subscription.watch,
            browser: {
              pages: Effect.succeed([]),
              open: () => Effect.succeed("page"),
              navigate: () => Effect.void,
              close: () => Effect.void,
              history: (id: string, action: "back" | "forward" | "reload" | "stop") =>
                Effect.sync(() => {
                  history.push(`${id}:${action}`);
                }),
              configuration: Effect.succeed({
                colorScheme: "system",
                sleepAfterMs: 1000,
                alwaysAwakeOrigins: [],
              } as const),
              configure: () => Effect.void,
              setTabPlacement: () => Effect.void,
            },
            publish: () => Effect.succeed(1),
            release: Effect.void,
          };
          const dispatch = createPluginDispatcher(options);
          assert.deepEqual(yield* dispatch("storage.read", {}), { revision: 0, value: null });
          assert.deepEqual(
            yield* dispatch("storage.write", { expectedRevision: 0, value: { order: ["one"] } }),
            { revision: 1 },
          );
          assert.equal(
            (yield* dispatch("storage.write", { expectedRevision: 0, value: null }).pipe(
              Effect.flip,
            )).code,
            "conflict",
          );
          for (const [method, params] of [
            ["storage.read", { owner: "other-plugin" }],
            ["storage.write", { expectedRevision: 1, value: null, profileId: "other" }],
            ["pages.watch", { owner: "other-plugin" }],
            ["pages.back", { pageId: "page", grantId: "other" }],
          ] as const)
            assert(Exit.isFailure(yield* Effect.exit(dispatch(method, params))));
          assert.deepEqual(yield* dispatch("pages.watch", {}), { revision: 0, pages: [] });
          observations.publish([
            {
              id: "page",
              profileId: "default",
              url: "https://example.test/",
              title: "Example",
              lifecycle: "loaded",
              protections: { audio: false, call: false, download: false, unsavedInput: false },
              loading: false,
              canGoBack: false,
              canGoForward: false,
            },
          ]);
          assert.equal(
            (yield* dispatch("pages.watch", { revision: 0 }).pipe(Effect.flip)).code,
            "stale-snapshot",
          );
          for (const action of ["back", "forward", "reload", "stop"])
            yield* dispatch(`pages.${action}`, { pageId: "page" });
          assert.deepEqual(history, ["page:back", "page:forward", "page:reload", "page:stop"]);
          const foreign = createPluginDispatcher({
            ...options,
            manifest: { ...options.manifest, id: "foreign-plugin" },
          });
          assert(Exit.isFailure(yield* Effect.exit(foreign("storage.read", {}))));
          const undeclared = createPluginDispatcher({
            ...options,
            manifest: { ...options.manifest, capabilities: [] },
          });
          assert(Exit.isFailure(yield* Effect.exit(undeclared("storage.read", {}))));
          const unsupported = createPluginDispatcher({
            ...options,
            storage: undefined,
            pageWatch: undefined,
            browser: { ...options.browser, history: undefined },
          });
          for (const [method, params] of [
            ["storage.read", {}],
            ["pages.watch", {}],
            ["pages.back", { pageId: "page" }],
          ] as const)
            assert(Exit.isFailure(yield* Effect.exit(unsupported(method, params))));
          yield* grants.revoke(issued.grant.id);
          for (const [method, params] of [
            ["storage.read", {}],
            ["pages.watch", {}],
            ["pages.back", { pageId: "page" }],
          ] as const)
            assert(Exit.isFailure(yield* Effect.exit(dispatch(method, params))));
          assert.deepEqual(yield* storage.read(), { revision: 1, value: { order: ["one"] } });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
