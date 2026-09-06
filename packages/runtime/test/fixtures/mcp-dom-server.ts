import { appendFileSync } from "node:fs";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import { create } from "../../src/grants.ts";
import { runMcpStdio } from "../../src/mcp-stdio.ts";
import type { ScopedDomDriver } from "../../src/scoped-dom.ts";

const directory = process.env.MCP_DOM_GRANTS;
const token = process.env.MCP_DOM_TOKEN;
const marker = process.env.MCP_DOM_MARKER;
if (!directory || !token || !marker) throw new Error("missing scoped DOM fixture environment");

const origin = process.env.MCP_DOM_ORIGIN ?? "https://allowed.test";
const append = (value: unknown) => appendFileSync(marker, `${JSON.stringify(value)}\n`);
const document = Object.freeze({
  pageId: "page",
  frameId: "top",
  loaderId: "loader",
  executionContextId: 8,
  uniqueContextId: "unique",
  markerName: "marker",
  markerValue: "value",
});
const capturedNodes =
  process.env.MCP_DOM_LARGE === "one"
    ? Array.from({ length: 512 }, (_, index) => ({
        axId: `large-${index}`,
        role: "button",
        name: `${index}:${'\\"🧭'.repeat(1_300)}`,
        backendNodeId: index + 1,
        kind: "click" as const,
      }))
    : [
        { axId: "root", role: "rootwebarea", kind: "unsupported" as const },
        {
          axId: "save",
          parentAxId: "root",
          role: "button",
          name: "Save draft",
          backendNodeId: 1,
          kind: "click" as const,
        },
        {
          axId: "title",
          parentAxId: "root",
          role: "textbox",
          name: "Title",
          value: "Draft",
          backendNodeId: 2,
          kind: "text" as const,
        },
        {
          axId: "password",
          parentAxId: "root",
          role: "textbox",
          name: "Password",
          value: "private-value",
          backendNodeId: 3,
          kind: "password" as const,
        },
      ];
const dom: ScopedDomDriver | undefined =
  process.env.MCP_DOM_API === "none"
    ? undefined
    : {
        invalidations: Stream.empty,
        capture: (input) =>
          input.authorize(origin).pipe(
            Effect.tap(() => Effect.sync(() => append({ operation: "snapshot" }))),
            Effect.as({
              document,
              origin,
              nodes: capturedNodes,
            }),
          ),
        currentOrigin: () => Effect.succeed(origin),
        click: (_document, node, authorize) =>
          authorize(origin).pipe(
            Effect.andThen(Effect.sync(() => append({ operation: "click", axId: node.axId }))),
          ),
        fill: (_document, node, value, authorize) =>
          authorize(origin).pipe(
            Effect.andThen(
              Effect.sync(() => append({ operation: "fill", axId: node.axId, value })),
            ),
          ),
      };

NodeRuntime.runMain(
  Effect.gen(function* () {
    const grants = yield* create({ directory });
    return yield* runMcpStdio({
      profileId: "profile",
      token,
      grants,
      browser: {
        pages: Effect.succeed([]),
        open: () => Effect.succeed("page"),
        navigate: () => Effect.void,
        close: () => Effect.void,
        configuration: Effect.succeed({
          colorScheme: "system",
          sleepAfterMs: 300_000,
          alwaysAwakeOrigins: [],
        }),
        configure: () => Effect.void,
        setTabPlacement: () => Effect.void,
      },
      ...(dom === undefined ? {} : { dom }),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { disableErrorReporting: true },
);
