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

const fixture = fileURLToPath(new URL("./fixtures/mcp-customization-server.ts", import.meta.url));
const issue = (directory: string, capabilities: readonly Capability[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const grants = yield* create({ directory });
      return yield* grants.issue({
        principal: "client",
        profileId: "profile",
        capabilities,
        origins: [],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
const records = (path: string) =>
  readFile(path, "utf8").then(
    (v) =>
      v
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x) as { operation: string; value?: unknown }),
    () => [],
  );
const connect = async (directory: string, token: string, marker: string, requirements = "yes") => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", fixture],
    env: {
      ...process.env,
      MCP_CUSTOMIZATION_GRANTS: directory,
      MCP_CUSTOMIZATION_TOKEN: token,
      MCP_CUSTOMIZATION_MARKER: marker,
      MCP_CUSTOMIZATION_REQUIREMENTS: requirements,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "customization-test", version: "1" });
  await client.connect(transport);
  return { client, transport };
};
const payload = (result: unknown): unknown => {
  assert.equal(typeof result, "object");
  assert(result !== null);
  const response = result as {
    readonly isError?: boolean;
    readonly content?: readonly { readonly text?: string }[];
  };
  assert.equal(response.isError, false);
  const text = response.content?.[0]?.text;
  if (typeof text !== "string")
    assert.fail("successful MCP tool response did not contain JSON text");
  return JSON.parse(text).result;
};
const recipe = (plugins: readonly unknown[] = []) =>
  JSON.stringify({
    version: 1,
    configuration: { colorScheme: "light", sleepAfterMs: 10_000, alwaysAwakeOrigins: [] },
    interface: { tabPlacement: "sidebar" },
    plugins,
  });

test("customization MCP gates plugin requirements and never mutates plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-customization-"));
  try {
    const directory = join(root, "grants"),
      marker = join(root, "marker");
    const none = await issue(directory, []);
    const denied = await connect(directory, none.token, marker);
    try {
      assert.equal(
        (await denied.client.callTool({ name: "hitchhiker_customization_export", arguments: {} }))
          .isError,
        true,
      );
      assert.equal(
        (
          await denied.client.callTool({
            name: "hitchhiker_customization_import",
            arguments: { recipe: recipe() },
          })
        ).isError,
        true,
      );
      assert.deepEqual(await records(marker), []);
    } finally {
      await denied.transport.close();
    }
    const settings = await issue(directory, ["configuration.write"]);
    const connection = await connect(directory, settings.token, marker);
    try {
      const exported = await connection.client.callTool({
        name: "hitchhiker_customization_export",
        arguments: {},
      });
      assert.equal(exported.isError, false);
      const parsed = JSON.parse((payload(exported) as { readonly recipe: string }).recipe);
      assert.equal(parsed.plugins.length, 0);
      assert.equal(JSON.stringify(parsed).includes("secret"), false);
      assert.equal(
        (
          await connection.client.callTool({
            name: "hitchhiker_customization_export",
            arguments: { includePlugins: true },
          })
        ).isError,
        true,
      );
      const settingsImport = await connection.client.callTool({
        name: "hitchhiker_customization_import",
        arguments: { recipe: recipe() },
      });
      assert.equal(settingsImport.isError, false);
      const beforeInvalid = (await records(marker)).filter(
        (entry) => entry.operation === "apply",
      ).length;
      assert.equal(
        (
          await connection.client.callTool({
            name: "hitchhiker_customization_import",
            arguments: {
              recipe: recipe([
                {
                  manifest: {
                    id: "portable-plugin",
                    version: "1.0.0",
                    name: "Portable",
                    capabilities: ["pages.list"],
                  },
                  hash: "a".repeat(64),
                  enabled: true,
                },
              ]),
            },
          })
        ).isError,
        true,
      );
      assert.equal(
        (
          await connection.client.callTool({
            name: "hitchhiker_customization_import",
            arguments: { recipe: "{}" },
          })
        ).isError,
        true,
      );
      assert.equal(
        (await records(marker)).filter((entry) => entry.operation === "apply").length,
        beforeInvalid,
      );
    } finally {
      await connection.transport.close();
    }
    const full = await issue(directory, ["configuration.write", "plugins.install"]);
    const second = await connect(directory, full.token, marker);
    try {
      const exported = await second.client.callTool({
        name: "hitchhiker_customization_export",
        arguments: { includePlugins: true },
      });
      const exportedPayload = payload(exported) as { readonly recipe: string };
      assert.equal(exportedPayload.recipe.includes("secret"), false);
      const plugin = JSON.parse(exportedPayload.recipe).plugins[0];
      const expectedPlugin = {
        manifest: {
          id: "portable-plugin",
          version: "1.0.0",
          name: "Portable",
          capabilities: ["pages.list"],
        },
        hash: "a".repeat(64),
        enabled: true,
      };
      assert.deepEqual(plugin, expectedPlugin);
      const imported = await second.client.callTool({
        name: "hitchhiker_customization_import",
        arguments: { recipe: exportedPayload.recipe },
      });
      assert.equal(imported.isError, false);
      assert.deepEqual(payload(imported), {
        applied: true,
        pluginRequirements: [expectedPlugin],
        pluginsChanged: false,
      });
      const ops = (await records(marker)).map((entry) => entry.operation);
      assert(ops.includes("apply"));
      assert.equal(
        ops.some((op) => ["stage", "install", "enable", "disable", "rollback"].includes(op)),
        false,
      );
    } finally {
      await second.transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("customization MCP rejects unavailable requirements and revoked settings grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-customization-"));
  try {
    const directory = join(root, "grants"),
      marker = join(root, "marker");
    const full = await issue(directory, ["configuration.write", "plugins.install"]);
    const unavailable = await connect(directory, full.token, marker, "none");
    try {
      assert.equal(
        (
          await unavailable.client.callTool({
            name: "hitchhiker_customization_export",
            arguments: {},
          })
        ).isError,
        false,
      );
      const result = await unavailable.client.callTool({
        name: "hitchhiker_customization_export",
        arguments: { includePlugins: true },
      });
      assert.equal(result.isError, true);
      assert.equal(
        (await records(marker)).some((entry) => entry.operation === "requirements"),
        false,
      );
    } finally {
      await unavailable.transport.close();
    }
    const settings = await issue(directory, ["configuration.write"]);
    const revoked = await connect(directory, settings.token, marker);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const grants = yield* create({ directory });
          yield* grants.revoke(settings.grant.id);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      const before = (await records(marker)).length;
      const result = await revoked.client.callTool({
        name: "hitchhiker_customization_import",
        arguments: { recipe: recipe() },
      });
      assert.equal(result.isError, true);
      assert.equal(
        (await records(marker)).slice(before).some((entry) => entry.operation === "apply"),
        false,
      );
    } finally {
      await revoked.transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
