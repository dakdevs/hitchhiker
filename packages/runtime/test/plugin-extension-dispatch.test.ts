import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import type { Capability } from "@hitchhiker/core";
import { Effect, Exit } from "effect";
import { create } from "../src/grants.ts";
import type {
  ExtensionManagementApi,
  ExtensionManagementSnapshot,
} from "../src/extension-management.ts";
import { createPluginDispatcher } from "../src/plugin-dispatch.ts";

const installationId = "a".repeat(32);
const snapshot: ExtensionManagementSnapshot = {
  readOnly: false,
  extensions: [
    {
      installationId,
      digest: "b".repeat(64),
      expectedChromiumId: "c".repeat(32),
      name: "Managed extension",
      version: "1.0.0",
      permissions: ["storage"],
      hostPermissions: [],
      optionalPermissions: [],
      optionalHostPermissions: [],
      state: "enabled",
    },
  ],
};
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

test("plugin extension dispatch rechecks declared, durable, and principal authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-extensions-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        const calls: string[] = [];
        const port: ExtensionManagementApi = {
          list: () => Effect.sync(() => (calls.push("list"), snapshot)),
          remove: (id) => Effect.sync(() => (calls.push(`remove:${id}`), snapshot)),
        };
        const dispatchFor = (
          capabilities: readonly Capability[],
          token: string,
          id = "extension-plugin",
        ) =>
          createPluginDispatcher({
            manifest: { id, name: "Extensions", version: "1.0.0", capabilities },
            profileId: "profile",
            token,
            grants,
            browser,
            publish: () => Effect.succeed(1),
            release: Effect.void,
            extensions: port,
          });
        const reader = yield* grants.issue({
          principal: "extension-plugin",
          profileId: "profile",
          capabilities: ["extensions.read"],
          origins: [],
        });
        const dispatch = dispatchFor(["extensions.read"], reader.token);
        assert.deepEqual(yield* dispatch("extensions.list", {}), snapshot);
        assert(
          Exit.isFailure(yield* Effect.exit(dispatch("extensions.remove", { installationId }))),
        );
        assert(
          Exit.isFailure(yield* Effect.exit(dispatch("extensions.list", { caller: "spoof" }))),
        );
        yield* grants.revoke(reader.grant.id);
        assert(Exit.isFailure(yield* Effect.exit(dispatch("extensions.list", {}))));
        const manager = yield* grants.issue({
          principal: "extension-plugin",
          profileId: "profile",
          capabilities: ["extensions.manage"],
          origins: [],
        });
        assert.deepEqual(
          yield* dispatchFor(["extensions.manage"], manager.token)("extensions.remove", {
            installationId,
          }),
          snapshot,
        );
        const full = yield* grants.issue({
          principal: "extension-plugin",
          profileId: "profile",
          capabilities: ["browser.full-control"],
          origins: [],
        });
        assert.deepEqual(
          yield* dispatchFor(["browser.full-control"], full.token)("extensions.list", {}),
          snapshot,
        );
        assert.deepEqual(
          yield* dispatchFor(["browser.full-control"], full.token)("extensions.remove", {
            installationId,
          }),
          snapshot,
        );
        const other = yield* grants.issue({
          principal: "other",
          profileId: "profile",
          capabilities: ["extensions.read"],
          origins: [],
        });
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              dispatchFor(["extensions.read"], other.token)("extensions.list", {}),
            ),
          ),
        );
        assert.deepEqual(calls, [
          "list",
          `remove:${installationId}`,
          "list",
          `remove:${installationId}`,
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plugin extension dispatch fails closed for absent, malformed, cross-profile, and unsafe backends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-plugin-extensions-strict-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        const issued = yield* grants.issue({
          principal: "extension-plugin",
          profileId: "profile",
          capabilities: ["extensions.read", "extensions.manage"],
          origins: [],
        });
        const make = (extensions?: ExtensionManagementApi, token = issued.token) =>
          createPluginDispatcher({
            manifest: {
              id: "extension-plugin",
              name: "Extensions",
              version: "1.0.0",
              capabilities: ["extensions.read", "extensions.manage"],
            },
            profileId: "profile",
            token,
            grants,
            browser,
            publish: () => Effect.succeed(1),
            release: Effect.void,
            ...(extensions === undefined ? {} : { extensions }),
          });
        const absent = make();
        assert(Exit.isFailure(yield* Effect.exit(absent("extensions.list", {}))));
        assert(Exit.isFailure(yield* Effect.exit(absent("extensions.remove", { installationId }))));

        let calls = 0;
        const valid: ExtensionManagementApi = {
          list: () => Effect.sync(() => (calls++, snapshot)),
          remove: () => Effect.sync(() => (calls++, snapshot)),
        };
        const dispatch = make(valid);
        for (const params of [
          {},
          { installationId: "bad" },
          { installationId, extra: true },
          { installationId, path: "/tmp/extension" },
        ])
          assert(Exit.isFailure(yield* Effect.exit(dispatch("extensions.remove", params))));
        assert.equal(calls, 0);

        const wrongProfile = yield* grants.issue({
          principal: "extension-plugin",
          profileId: "other-profile",
          capabilities: ["extensions.read", "extensions.manage"],
          origins: [],
        });
        assert(
          Exit.isFailure(
            yield* Effect.exit(make(valid, wrongProfile.token)("extensions.list", {})),
          ),
        );
        assert.equal(calls, 0);

        const unsafe: ExtensionManagementApi = {
          list: () =>
            Effect.succeed({ ...snapshot, status: "raw engine detail", path: "/secret" } as never),
          remove: () => Effect.fail(new Error("raw engine detail")),
        };
        const malformed = yield* Effect.flip(make(unsafe)("extensions.list", {}));
        assert.equal(malformed.code, "denied");
        assert.equal(malformed.message.includes("raw engine detail"), false);
        const failed = yield* Effect.flip(make(unsafe)("extensions.remove", { installationId }));
        assert.equal(failed.code, "denied");
        assert.equal(failed.message.includes("raw engine detail"), false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
