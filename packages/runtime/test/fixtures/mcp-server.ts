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
  process.env.MCP_CAPABILITIES === "none" ? [] : ["pages.list"];
const slowMs = Number(process.env.MCP_SLOW_MS ?? "0");
const dispatchMarker = process.env.MCP_DISPATCH_MARKER;
const finalizerMarker = process.env.MCP_FINALIZER_MARKER;
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
  revocations: Stream.empty,
};

const program = runMcpStdio({
  profileId: "main",
  token: "preissued",
  grants,
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
