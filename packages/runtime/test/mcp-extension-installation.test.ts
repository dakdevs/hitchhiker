import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { create } from "../src/grants.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-plugins-server.ts", import.meta.url));
const provision = async (
  directory: string,
  capabilities: readonly ["extensions.install"] | readonly [],
) =>
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
  env: NodeJS.ProcessEnv = {},
) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", fixture],
    env: {
      ...process.env,
      MCP_PLUGIN_GRANTS: directory,
      MCP_PLUGIN_TOKEN: token,
      MCP_PLUGIN_MARKER: marker,
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "install-tools", version: "1.0" });
  await client.connect(transport);
  return { client, transport };
};

test("MCP extension installation tools are optional, strict, and grant bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-extension-installation-"));
  try {
    const directory = join(root, "grants"),
      marker = join(root, "marker");
    const granted = await provision(directory, ["extensions.install"]);
    const absent = await connect(directory, granted.token, marker, {
      MCP_EXTENSION_INSTALLATION: "none",
    });
    try {
      assert.equal(
        (await absent.client.listTools()).tools.some((tool) =>
          tool.name.startsWith("hitchhiker_extension_install_"),
        ),
        false,
      );
    } finally {
      await absent.transport.close();
    }
    const connection = await connect(directory, granted.token, marker);
    try {
      const tools = await connection.client.listTools();
      assert.equal(
        tools.tools.filter((tool) => tool.name.startsWith("hitchhiker_extension_install_")).length,
        8,
      );
      const begin = await connection.client.callTool({
        name: "hitchhiker_extension_install_begin",
        arguments: {},
      });
      assert.equal(begin.isError, false);
      const id = "d".repeat(32);
      const file = await connection.client.callTool({
        name: "hitchhiker_extension_install_begin_file",
        arguments: { operationId: id, path: "manifest.json", size: 2 },
      });
      assert.equal(file.isError, false);
      const append = await connection.client.callTool({
        name: "hitchhiker_extension_install_append",
        arguments: { operationId: id, offset: 0, dataBase64: "/w==" },
      });
      assert.equal(append.isError, false);
      await assert.rejects(
        connection.client.callTool({
          name: "hitchhiker_extension_install_append",
          arguments: { operationId: id, offset: 0, dataBase64: "a".repeat(87_385) },
        }),
      );
    } finally {
      await connection.transport.close();
    }
    const denied = await provision(directory, []);
    const blocked = await connect(directory, denied.token, marker);
    try {
      assert.equal(
        (
          await blocked.client.callTool({
            name: "hitchhiker_extension_install_begin",
            arguments: {},
          })
        ).isError,
        true,
      );
    } finally {
      await blocked.transport.close();
    }
    const records = await readFile(marker, "utf8");
    assert.match(records, /installation\.begin/);
    assert.match(records, /installation\.append/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
