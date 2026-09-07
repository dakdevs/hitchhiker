import { appendFileSync } from "node:fs";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { BrowserConfiguration } from "@hitchhiker/core";
import { Effect } from "effect";
import { create } from "../../src/grants.ts";
import { runMcpStdio } from "../../src/mcp-stdio.ts";
import type { InstalledPluginPlanInput } from "../../src/installed-plugin-plan.ts";

const directory = process.env.MCP_PLUGIN_GRANTS;
const token = process.env.MCP_PLUGIN_TOKEN;
const marker = process.env.MCP_PLUGIN_MARKER;
if (!directory || !token || !marker)
  throw new Error("plugin MCP fixture environment is incomplete");

const record = (value: unknown) =>
  Effect.sync(() => appendFileSync(marker, `${JSON.stringify(value)}\n`, { mode: 0o600 }));
const configuration: BrowserConfiguration = {
  colorScheme: "system",
  sleepAfterMs: 300_000,
  alwaysAwakeOrigins: [],
};
const artifactHash = "a".repeat(64);
const extensionSnapshot = {
  readOnly: false,
  extensions: [
    {
      installationId: "a".repeat(32),
      digest: "b".repeat(64),
      expectedChromiumId: "c".repeat(32),
      chromiumId: "c".repeat(32),
      name: "Managed extension",
      version: "1.0.0",
      permissions: ["storage"],
      hostPermissions: ["https://example.test/*"],
      optionalPermissions: [],
      optionalHostPermissions: [],
      state: "enabled" as const,
    },
  ],
};

const program = Effect.gen(function* () {
  const grants = yield* create({ directory });
  const plugins =
    process.env.MCP_PLUGIN_API === "none"
      ? undefined
      : {
          stage: (input: unknown) =>
            record({ operation: "stage", input }).pipe(Effect.as({ hash: artifactHash })),
          install: (hash: string, grantId: string) =>
            record({ operation: "install", hash, grantId }).pipe(
              Effect.andThen(
                process.env.MCP_PLUGIN_INSTALL === "fail"
                  ? Effect.fail("install failed")
                  : process.env.MCP_PLUGIN_INSTALL === "never"
                    ? Effect.never
                    : Effect.void,
              ),
            ),
          list: () =>
            record({ operation: "list" }).pipe(
              Effect.as([{ id: "installed-plugin", enabled: true }]),
            ),
          enable: (id: string) => record({ operation: "enable", id }),
          disable: (id: string) => record({ operation: "disable", id }),
          uninstall: (id: string) => record({ operation: "uninstall", id }),
          rollback: (id: string) => record({ operation: "rollback", id }),
          plans:
            process.env.MCP_PLUGIN_PLANS === "yes"
              ? {
                  current: () =>
                    record({ operation: "plan" }).pipe(
                      Effect.as({ revision: 7, enabled: [], serviceBindings: [] }),
                    ),
                  apply: (expectedRevision: number, candidate: InstalledPluginPlanInput) =>
                    record({ operation: "applyPlan", expectedRevision, candidate }).pipe(
                      Effect.as({ ...candidate, revision: expectedRevision + 1 }),
                    ),
                  stageInstall: (hash: string, grantId: string) =>
                    record({ operation: "stageInstall", hash, grantId }).pipe(
                      Effect.andThen(
                        process.env.MCP_PLUGIN_INSTALL === "fail"
                          ? Effect.fail("stage failed")
                          : Effect.void,
                      ),
                    ),
                }
              : undefined,
        };
  const extensions =
    process.env.MCP_EXTENSION_API === "none"
      ? undefined
      : {
          list: () =>
            record({ operation: "extensions.list" }).pipe(
              Effect.andThen(
                process.env.MCP_EXTENSION_OUTPUT === "invalid"
                  ? Effect.succeed({
                      ...extensionSnapshot,
                      status: "raw engine detail",
                      path: "/secret",
                    } as never)
                  : process.env.MCP_EXTENSION_OUTPUT === "fail"
                    ? Effect.fail(new Error("raw engine detail"))
                    : Effect.succeed(extensionSnapshot),
              ),
            ),
          remove: (installationId: string) =>
            record({ operation: "extensions.remove", installationId }).pipe(
              Effect.as({ ...extensionSnapshot, extensions: [] }),
            ),
        };
  const extensionInstallation =
    process.env.MCP_EXTENSION_INSTALLATION === "none"
      ? undefined
      : {
          begin: () =>
            record({ operation: "installation.begin" }).pipe(
              Effect.as({
                operationId: "d".repeat(32),
                state: "receiving" as const,
                upload: { completedFiles: 0, totalBytes: 0 },
              }),
            ),
          beginFile: (operationId: string, path: string, size: number) =>
            record({ operation: "installation.file", operationId, path, size }).pipe(
              Effect.as({
                operationId,
                state: "receiving" as const,
                upload: { completedFiles: 0, totalBytes: 0 },
              }),
            ),
          append: (operationId: string, offset: number, dataBase64: string) =>
            record({ operation: "installation.append", operationId, offset, dataBase64 }).pipe(
              Effect.as({
                operationId,
                state: "receiving" as const,
                upload: { completedFiles: 0, totalBytes: 0 },
              }),
            ),
          finish: (operationId: string) =>
            Effect.succeed({ operationId, state: "validating" as const }),
          status: (operationId: string) =>
            Effect.succeed({ operationId, state: "receiving" as const }),
          list: () => Effect.succeed([]),
          requestReview: (operationId: string) =>
            Effect.succeed({ operationId, state: "awaiting_review" as const }),
          cancel: (operationId: string) =>
            Effect.succeed({ operationId, state: "canceled" as const }),
        };
  yield* runMcpStdio({
    profileId: "profile",
    token,
    grants,
    browser: {
      pages: Effect.succeed([]),
      open: () => Effect.succeed("page"),
      navigate: () => Effect.void,
      close: () => Effect.void,
      configuration: Effect.succeed(configuration),
      configure: () => Effect.void,
      setTabPlacement: () => Effect.void,
    },
    plugins,
    extensions,
    extensionInstallation,
  });
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program, { disableErrorReporting: true });
