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
  });
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program, { disableErrorReporting: true });
