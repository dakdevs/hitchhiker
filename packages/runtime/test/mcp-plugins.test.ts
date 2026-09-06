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
const manifest = (capabilities: readonly Capability[] = ["pages.list"]) => ({
  id: "managed-plugin",
  version: "1.0.0",
  name: "Managed plugin",
  capabilities,
});

const readRecords = async (path: string) =>
  readFile(path, "utf8").then(
    (value) =>
      value
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    () => [] as Record<string, unknown>[],
  );

const expectToolError = async (call: Promise<unknown>) => {
  let result: unknown;
  try {
    result = await call;
  } catch (error) {
    assert(error instanceof Error);
    return;
  }
  assert.equal((result as { readonly isError?: boolean }).isError, true);
};

const provision = async (directory: string, capabilities: readonly Capability[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const grants = yield* create({ directory });
      return yield* grants.issue({
        principal: "mcp-client",
        profileId: "profile",
        capabilities,
        origins: ["https://allowed.test"],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

const connect = async (
  directory: string,
  token: string,
  marker: string,
  environment: NodeJS.ProcessEnv = {},
) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", fixture],
    env: {
      ...process.env,
      MCP_PLUGIN_GRANTS: directory,
      MCP_PLUGIN_TOKEN: token,
      MCP_PLUGIN_MARKER: marker,
      ...environment,
    },
    stderr: "pipe",
    maxBufferSize: 256 * 1024,
  });
  const client = new Client({ name: "plugin-tools-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
};

test("plugin tools are optional and every action requires plugins.install", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-plugins-"));
  try {
    const grantsDirectory = join(root, "grants");
    const marker = join(root, "marker");
    const issued = await provision(grantsDirectory, ["pages.list"]);
    const absent = await connect(grantsDirectory, issued.token, marker, {
      MCP_PLUGIN_API: "none",
    });
    try {
      const tools = await absent.client.listTools();
      assert.equal(
        tools.tools.some((tool) => tool.name.startsWith("hitchhiker_plugin")),
        false,
      );
    } finally {
      await absent.transport.close();
    }

    const present = await connect(grantsDirectory, issued.token, marker);
    try {
      const tools = await present.client.listTools();
      for (const name of [
        "hitchhiker_plugins_list",
        "hitchhiker_plugin_install",
        "hitchhiker_plugin_enable",
        "hitchhiker_plugin_disable",
        "hitchhiker_plugin_rollback",
      ])
        assert.ok(
          tools.tools.some((tool) => tool.name === name),
          name,
        );
      for (const [name, arguments_] of [
        ["hitchhiker_plugins_list", {}],
        ["hitchhiker_plugin_enable", { id: "managed-plugin" }],
        ["hitchhiker_plugin_disable", { id: "managed-plugin" }],
        ["hitchhiker_plugin_rollback", { id: "managed-plugin" }],
        [
          "hitchhiker_plugin_install",
          { manifest: manifest(), code: "globalThis.HitchhikerPlugin={activate(){}}" },
        ],
      ] as const) {
        const result = await present.client.callTool({ name, arguments: arguments_ });
        assert.equal(result.isError, true, name);
      }
      assert.deepEqual(await readRecords(marker), []);
    } finally {
      await present.transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install accepts bounded uploaded data, delegates a subset, and returns no credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-install-"));
  try {
    const grantsDirectory = join(root, "grants");
    const marker = join(root, "marker");
    const issued = await provision(grantsDirectory, ["plugins.install", "pages.list"]);
    const connection = await connect(grantsDirectory, issued.token, marker);
    try {
      const installed = await connection.client.callTool({
        name: "hitchhiker_plugin_install",
        arguments: {
          manifest: manifest(),
          code: "globalThis.HitchhikerPlugin={activate(){}}",
        },
      });
      assert.equal(installed.isError, false, JSON.stringify(installed));
      const encoded = JSON.stringify(installed);
      assert.equal(encoded.includes(issued.token), false);
      assert.equal(/credential|grantId|token/i.test(encoded), false);
      const records = await readRecords(marker);
      assert.deepEqual(
        records.map((record) => record.operation),
        ["stage", "install"],
      );
      const childId = records[1]!.grantId;
      assert.equal(typeof childId, "string");

      const grants = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* create({ directory: grantsDirectory });
          const child = yield* store.authorizeGrant(childId as string, {
            profileId: "profile",
            capability: "pages.list",
          });
          yield* store.revoke(issued.grant.id);
          return { store, child };
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      assert.equal(grants.child.principal, "managed-plugin");
      await assert.rejects(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* create({ directory: grantsDirectory });
            return yield* store.authenticateGrant(childId as string, { profileId: "profile" });
          }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        ),
      );
    } finally {
      await connection.transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install rejects escalation, oversized code, paths, and caller-selected grant IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-reject-"));
  try {
    const grantsDirectory = join(root, "grants");
    const marker = join(root, "marker");
    const issued = await provision(grantsDirectory, ["plugins.install", "pages.list"]);
    const connection = await connect(grantsDirectory, issued.token, marker);
    try {
      for (const arguments_ of [
        {
          manifest: manifest(["pages.manage"]),
          code: "globalThis.HitchhikerPlugin={activate(){}}",
        },
        {
          manifest: manifest(["cdp.connect"]),
          code: "globalThis.HitchhikerPlugin={activate(){}}",
        },
        {
          manifest: { ...manifest(), name: "x".repeat(101) },
          code: "globalThis.HitchhikerPlugin={activate(){}}",
        },
        { manifest: manifest(), code: "x".repeat(196_609) },
        {
          manifest: manifest(),
          code: "globalThis.HitchhikerPlugin={activate(){}}",
          path: "/tmp/plugin.js",
        },
        {
          manifest: manifest(),
          code: "globalThis.HitchhikerPlugin={activate(){}}",
          grantId: issued.grant.id,
        },
      ]) {
        await expectToolError(
          connection.client.callTool({
            name: "hitchhiker_plugin_install",
            arguments: arguments_,
          }),
        );
      }
      const store = await Effect.runPromise(
        Effect.gen(function* () {
          const grants = yield* create({ directory: grantsDirectory });
          return yield* grants.list();
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      assert.equal(store.length, 1);
      assert.deepEqual(await readRecords(marker), []);
    } finally {
      await connection.transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["fail", "never"] as const) {
  test(`failed or cancelled plugin install revokes its delegated child (${mode})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-cleanup-"));
    try {
      const grantsDirectory = join(root, "grants");
      const marker = join(root, "marker");
      const issued = await provision(grantsDirectory, ["plugins.install", "pages.list"]);
      const connection = await connect(grantsDirectory, issued.token, marker, {
        MCP_PLUGIN_INSTALL: mode,
      });
      try {
        const controller = new AbortController();
        const call = connection.client.callTool(
          {
            name: "hitchhiker_plugin_install",
            arguments: {
              manifest: manifest(),
              code: "globalThis.HitchhikerPlugin={activate(){}}",
            },
          },
          undefined,
          mode === "never" ? { signal: controller.signal } : undefined,
        );
        if (mode === "never") {
          const deadline = Date.now() + 3_000;
          while (!(await readRecords(marker)).some((record) => record.operation === "install")) {
            if (Date.now() >= deadline) assert.fail("cancelled install did not start");
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          controller.abort();
        }
        await expectToolError(call);
        const records = await readRecords(marker);
        const childId = records.find((record) => record.operation === "install")?.grantId;
        assert.equal(typeof childId, "string");
        const deadline = Date.now() + 3_000;
        for (;;) {
          const revoked = await Effect.runPromise(
            Effect.gen(function* () {
              const grants = yield* create({ directory: grantsDirectory });
              const entries = yield* grants.list();
              return entries.find((grant) => grant.id === childId)?.revokedAt !== undefined;
            }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
          );
          if (revoked) break;
          if (Date.now() >= deadline) assert.fail(`${mode} install left child grant active`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        await connection.transport.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
