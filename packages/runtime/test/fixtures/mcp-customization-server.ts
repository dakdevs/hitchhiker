import { appendFileSync } from "node:fs";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { create } from "../../src/grants.ts";
import { runMcpStdio } from "../../src/mcp-stdio.ts";

const directory = process.env.MCP_CUSTOMIZATION_GRANTS;
const token = process.env.MCP_CUSTOMIZATION_TOKEN;
const marker = process.env.MCP_CUSTOMIZATION_MARKER;
if (!directory || !token || !marker)
  throw new Error("customization fixture environment is incomplete");
const record = (operation: string, value?: unknown) =>
  Effect.sync(() =>
    appendFileSync(marker, `${JSON.stringify({ operation, value })}\n`, { mode: 0o600 }),
  );
const requirement = {
  manifest: {
    id: "portable-plugin",
    version: "1.0.0",
    name: "Portable",
    capabilities: ["pages.list"] as const,
    token: "secret-manifest-value",
  },
  hash: "a".repeat(64),
  enabled: true,
  grantId: "secret-grant",
  code: "secret-source",
};
const program = Effect.gen(function* () {
  const grants = yield* create({ directory });
  yield* runMcpStdio({
    profileId: "profile",
    token,
    grants,
    browser: {
      pages: Effect.succeed([]),
      open: () => Effect.succeed("page"),
      navigate: () => Effect.void,
      close: () => Effect.void,
      configuration: Effect.die("unused"),
      configure: () => record("configure"),
      setTabPlacement: () => record("placement"),
      customization: {
        settings: record("settings").pipe(
          Effect.as({
            configuration: {
              colorScheme: "dark" as const,
              sleepAfterMs: 10_000,
              alwaysAwakeOrigins: ["https://saved.example"],
            },
            interface: { tabPlacement: "top" as const },
          }),
        ),
        apply: (settings) => record("apply", settings),
      },
    },
    plugins: {
      stage: () => record("stage").pipe(Effect.as({ hash: "b".repeat(64) })),
      install: () => record("install"),
      list: () => record("list").pipe(Effect.as([])),
      enable: () => record("enable"),
      disable: () => record("disable"),
      uninstall: () => record("uninstall"),
      rollback: () => record("rollback"),
      ...(process.env.MCP_CUSTOMIZATION_REQUIREMENTS === "none"
        ? {}
        : { requirements: () => record("requirements").pipe(Effect.as([requirement])) }),
    },
  });
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
NodeRuntime.runMain(program, { disableErrorReporting: true });
