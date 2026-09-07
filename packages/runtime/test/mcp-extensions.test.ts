import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NodeServices } from "@effect/platform-node";
import type { Capability } from "@hitchhiker/core";
import { Effect } from "effect";
import { create } from "../src/grants.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-plugins-server.ts", import.meta.url));
const installationId = "a".repeat(32);

const provision = async (directory: string, capabilities: readonly Capability[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const grants = yield* create({ directory });
      return yield* grants.issue({
        principal: "mcp-client",
        profileId: "profile",
        capabilities,
        origins: [],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
const connect = async (
  directory: string,
  token: string,
  marker: string,
  extra: NodeJS.ProcessEnv = {},
) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", fixture],
    env: {
      ...process.env,
      MCP_PLUGIN_GRANTS: directory,
      MCP_PLUGIN_TOKEN: token,
      MCP_PLUGIN_MARKER: marker,
      ...extra,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "extension-tools-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
};
const records = (path: string) =>
  readFile(path, "utf8").then(
    (value) =>
      value
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    () => [] as unknown[],
  );

test("MCP extension tools are optional and separately authorize read and remove", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-extensions-"));
  try {
    const directory = join(root, "grants");
    const marker = join(root, "marker");
    const none = await provision(directory, ["extensions.read"]);
    const absent = await connect(directory, none.token, marker, { MCP_EXTENSION_API: "none" });
    try {
      assert.equal(
        (await absent.client.listTools()).tools.some((tool) =>
          tool.name.startsWith("hitchhiker_extension"),
        ),
        false,
      );
    } finally {
      await absent.transport.close();
    }
    const reader = await connect(directory, none.token, marker);
    try {
      const tools = await reader.client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "hitchhiker_extensions_list"));
      assert.ok(tools.tools.some((tool) => tool.name === "hitchhiker_extension_remove"));
      const listed = await reader.client.callTool({
        name: "hitchhiker_extensions_list",
        arguments: {},
      });
      assert.equal(listed.isError, false);
      const denied = await reader.client.callTool({
        name: "hitchhiker_extension_remove",
        arguments: { installationId },
      });
      assert.equal(denied.isError, true);
      assert.deepEqual(
        (await records(marker)).map((entry: any) => entry.operation),
        ["extensions.list"],
      );
    } finally {
      await reader.transport.close();
    }
    const manager = await provision(directory, ["extensions.manage"]);
    const remover = await connect(directory, manager.token, marker);
    try {
      const removed = await remover.client.callTool({
        name: "hitchhiker_extension_remove",
        arguments: { installationId },
      });
      assert.equal(removed.isError, false);
      for (const arguments_ of [{ installationId: "bad" }, { installationId, path: "/tmp/x" }]) {
        await assert.rejects(
          remover.client.callTool({
            name: "hitchhiker_extension_remove",
            arguments: arguments_,
          }),
        );
      }
    } finally {
      await remover.transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP extension tools reread grants and reject cross-profile or unsafe manager responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-extensions-strict-"));
  try {
    const directory = join(root, "grants");
    const marker = join(root, "marker");
    const issued = await provision(directory, ["extensions.read", "extensions.manage"]);
    const connection = await connect(directory, issued.token, marker);
    try {
      assert.equal(
        (await connection.client.callTool({ name: "hitchhiker_extensions_list", arguments: {} }))
          .isError,
        false,
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const grants = yield* create({ directory });
          yield* grants.revoke(issued.grant.id);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      for (const request of [
        { name: "hitchhiker_extensions_list", arguments: {} },
        { name: "hitchhiker_extension_remove", arguments: { installationId } },
      ] as const) {
        const result = await connection.client.callTool(request);
        assert.equal(result.isError, true);
      }
      assert.deepEqual(
        (await records(marker)).map((entry: any) => entry.operation),
        ["extensions.list"],
      );
    } finally {
      await connection.transport.close();
    }
    const crossProfile = await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory });
        return yield* grants.issue({
          principal: "mcp-client",
          profileId: "other-profile",
          capabilities: ["extensions.read"],
          origins: [],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    const wrong = await connect(directory, crossProfile.token, marker);
    try {
      assert.equal(
        (await wrong.client.callTool({ name: "hitchhiker_extensions_list", arguments: {} }))
          .isError,
        true,
      );
    } finally {
      await wrong.transport.close();
    }
    const invalid = await provision(directory, ["extensions.read"]);
    const invalidConnection = await connect(directory, invalid.token, marker, {
      MCP_EXTENSION_OUTPUT: "invalid",
    });
    try {
      const result = await invalidConnection.client.callTool({
        name: "hitchhiker_extensions_list",
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.equal(JSON.stringify(result).includes("raw engine detail"), false);
    } finally {
      await invalidConnection.transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
