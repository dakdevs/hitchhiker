import { appendFileSync, writeFileSync } from "node:fs";
import { Effect, Stream } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import type { Capability, BrowserConfiguration } from "@hitchhiker/core";
import type { GrantStoreApi } from "../../src/grants.ts";
import { runMcpStdio } from "../../src/mcp-stdio.ts";

const configuration: BrowserConfiguration = {
  colorScheme: "system",
  sleepAfterMs: 300_000,
  alwaysAwakeOrigins: [],
};
const capabilities: readonly Capability[] =
  process.env.MCP_CAPABILITIES === "none"
    ? []
    : process.env.MCP_CAPABILITIES === "manage"
      ? ["pages.manage"]
      : process.env.MCP_CAPABILITIES === "devtools"
        ? ["devtools.manage"]
        : ["pages.list"];
const slowMs = Number(process.env.MCP_SLOW_MS ?? "0");
const dispatchMarker = process.env.MCP_DISPATCH_MARKER;
const finalizerMarker = process.env.MCP_FINALIZER_MARKER;
const historyMarker = process.env.MCP_HISTORY_MARKER;
let authorizations = 0;
const grants: GrantStoreApi = {
  issue: () => Effect.die("fixture never issues grants"),
  revoke: () => Effect.die("fixture never revokes grants"),
  list: () => Effect.succeed([]),
  authenticate: (token, request) =>
    token === "preissued" && request.profileId === "main"
      ? Effect.succeed({
          principal: "fixture",
          grant: {
            id: "fixture",
            principal: "fixture",
            profileId: "main",
            capabilities,
            origins: [],
          },
        })
      : Effect.fail({ _tag: "GrantStoreError", code: "denied", message: "denied" } as never),
  authenticateGrant: () => Effect.die("fixture never trusts grant IDs"),
  authorize: (token, request) =>
    token === "preissued" &&
    capabilities.includes(request.capability) &&
    (process.env.MCP_REVOKE_AFTER !== "one" || authorizations++ === 0)
      ? Effect.succeed({
          principal: "fixture",
          grant: {
            id: "fixture",
            principal: "fixture",
            profileId: "main",
            capabilities,
            origins: [],
          },
        })
      : Effect.fail({ _tag: "GrantStoreError", code: "denied", message: "denied" } as never),
  authorizeGrant: () => Effect.die("fixture never trusts grant IDs"),
  delegate: () => Effect.die("fixture never delegates grants"),
  delegateGrant: () => Effect.die("fixture never delegates grants"),
  revocations: Stream.empty,
};

const program = runMcpStdio({
  profileId: "main",
  token: "preissued",
  grants,
  ...(process.env.MCP_DEVTOOLS === "yes"
    ? {
        devtools: {
          status: (pageId: string) =>
            Effect.succeed({ pageId, generation: 1, instance: 0, state: "closed" as const }),
          show: (pageId: string, _point?: { x: number; y: number }) =>
            Effect.succeed({ pageId, generation: 1, instance: 1, state: "open" as const }),
          close: (pageId: string) =>
            Effect.succeed({ pageId, generation: 1, instance: 1, state: "closed" as const }),
        },
      }
    : {}),
  browser: {
    pages: Effect.gen(function* () {
      yield* Effect.logInfo("Fixture page operation");
      if (dispatchMarker) appendFileSync(dispatchMarker, "pages\n");
      if (Number.isFinite(slowMs) && slowMs > 0) yield* Effect.sleep(slowMs);
      return [];
    }),
    open: () => Effect.succeed("page"),
    navigate: () => Effect.void,
    close: () => Effect.void,
    ...(process.env.MCP_HISTORY === "yes"
      ? {
          history: (pageId: string, action: "back" | "forward" | "reload" | "stop") =>
            Effect.sync(() => {
              if (historyMarker) appendFileSync(historyMarker, `${pageId}:${action}\n`);
            }),
        }
      : {}),
    configuration: Effect.succeed(configuration),
    configure: () => Effect.void,
    setTabPlacement: () => Effect.void,
  },
}).pipe(
  Effect.ensuring(
    Effect.sync(() => {
      if (finalizerMarker) writeFileSync(finalizerMarker, "cleaned\n", { mode: 0o600 });
    }),
  ),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });

// Tests use stderr only for an explicit post-bootstrap readiness signal. MCP
// stdout stays exclusively JSON-RPC frames, while operation deadlines begin
// after the fixture has entered the runtime event loop.
if (process.env.MCP_READY === "yes")
  setImmediate(() => process.stderr.write("HITCHHIKER_MCP_FIXTURE_READY\n"));
