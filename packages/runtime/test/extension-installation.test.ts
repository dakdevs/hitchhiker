import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { create } from "../src/grants.ts";
import type { ExtensionInstallationApi } from "../src/extension-installation.ts";
import { createPluginDispatcher } from "../src/plugin-dispatch.ts";

const operationId = "a".repeat(32);
const snapshot = {
  operationId,
  state: "receiving" as const,
  upload: { completedFiles: 0, totalBytes: 0 },
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

test("extension installation dispatch routes bounded operations and fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-extension-installation-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        const calls: string[] = [];
        const port: ExtensionInstallationApi = {
          begin: () => Effect.sync(() => (calls.push("begin"), snapshot)),
          beginFile: (_id, path) => Effect.sync(() => (calls.push(`file:${path}`), snapshot)),
          append: () => Effect.sync(() => (calls.push("append"), snapshot)),
          finish: () => Effect.succeed(snapshot),
          status: () => Effect.succeed(snapshot),
          list: () => Effect.succeed([snapshot]),
          requestReview: () => Effect.succeed(snapshot),
          cancel: () => Effect.succeed(snapshot),
        };
        const issued = yield* grants.issue({
          principal: "plugin",
          profileId: "profile",
          capabilities: ["extensions.install"],
          origins: [],
        });
        const make = (
          token = issued.token,
          installation: ExtensionInstallationApi | undefined = port,
        ) =>
          createPluginDispatcher({
            manifest: {
              id: "plugin",
              name: "Plugin",
              version: "1.0.0",
              capabilities: ["extensions.install"],
            },
            profileId: "profile",
            token,
            grants,
            browser,
            publish: () => Effect.succeed(1),
            release: Effect.void,
            ...(installation ? { extensionInstallation: installation } : {}),
          });
        const dispatch = make();
        assert.deepEqual(yield* dispatch("extensions.installation.begin", {}), snapshot);
        assert.deepEqual(
          yield* dispatch("extensions.installation.beginFile", {
            operationId,
            path: "manifest.json",
            size: 0,
          }),
          snapshot,
        );
        assert.deepEqual(
          yield* dispatch("extensions.installation.append", {
            operationId,
            offset: 0,
            dataBase64: "/w==",
          }),
          snapshot,
        );
        for (const method of [
          "extensions.installation.finish",
          "extensions.installation.status",
          "extensions.installation.requestReview",
          "extensions.installation.cancel",
        ])
          assert.deepEqual(yield* dispatch(method, { operationId }), snapshot);
        assert.deepEqual(yield* dispatch("extensions.installation.list", {}), [snapshot]);
        for (const input of [
          { operationId, path: "x", size: 0, extra: true },
          { operationId, offset: 0, dataBase64: "a".repeat(87_385) },
          { operationId: "bad" },
        ])
          assert(
            Exit.isFailure(
              yield* Effect.exit(dispatch("extensions.installation.beginFile", input)),
            ),
          );
        const absent = createPluginDispatcher({
          manifest: {
            id: "plugin",
            name: "Plugin",
            version: "1.0.0",
            capabilities: ["extensions.install"],
          },
          profileId: "profile",
          token: issued.token,
          grants,
          browser,
          publish: () => Effect.succeed(1),
          release: Effect.void,
        });
        assert(Exit.isFailure(yield* Effect.exit(absent("extensions.installation.begin", {}))));
        const malformed: ExtensionInstallationApi = {
          ...port,
          begin: () => Effect.succeed({ ...snapshot, nonce: "secret", path: "/private" } as never),
        };
        const unsafe = yield* Effect.flip(
          make(issued.token, malformed)("extensions.installation.begin", {}),
        );
        assert.equal(unsafe.code, "denied");
        assert.equal(unsafe.message.includes("secret"), false);
        yield* grants.revoke(issued.grant.id);
        assert(Exit.isFailure(yield* Effect.exit(dispatch("extensions.installation.begin", {}))));
        const wrongPrincipal = yield* grants.issue({
          principal: "other",
          profileId: "profile",
          capabilities: ["extensions.install"],
          origins: [],
        });
        assert(
          Exit.isFailure(
            yield* Effect.exit(make(wrongPrincipal.token)("extensions.installation.begin", {})),
          ),
        );
        assert.deepEqual(calls, ["begin", "file:manifest.json", "append"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
