import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import type { Capability } from "@hitchhiker/core";
import { create } from "../src/grants.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-dom-server.ts", import.meta.url));
const provision = (
  directory: string,
  origins: readonly string[],
  capabilities: readonly Capability[] = ["pages.read", "pages.write"],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const grants = yield* create({ directory });
      return yield* grants.issue({
        principal: "mcp-dom",
        profileId: "profile",
        capabilities,
        origins,
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
      MCP_DOM_GRANTS: directory,
      MCP_DOM_TOKEN: token,
      MCP_DOM_MARKER: marker,
      ...environment,
    },
    stderr: "pipe",
    maxBufferSize: 256 * 1024,
  });
  const client = new Client({ name: "scoped-dom-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
};
const resultJson = (result: unknown) => {
  const response = result as {
    readonly isError?: boolean;
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  };
  assert.equal(response.isError, false, JSON.stringify(result));
  const item = response.content?.[0];
  assert(item && item.type === "text");
  if (typeof item.text !== "string") throw new Error("expected text MCP response");
  return JSON.parse(item.text) as { readonly result: unknown };
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

test("scoped DOM tools are optional and expose no raw browser identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-dom-"));
  try {
    const grant = await provision(join(root, "grants"), ["https://allowed.test"]);
    const marker = join(root, "marker");
    const absent = await connect(join(root, "grants"), grant.token, marker, {
      MCP_DOM_API: "none",
    });
    try {
      assert.equal(
        (await absent.client.listTools()).tools.some(
          (tool) => tool.name === "hitchhiker_page_snapshot",
        ),
        false,
      );
    } finally {
      await absent.transport.close();
    }

    const present = await connect(join(root, "grants"), grant.token, marker);
    try {
      const listed = await present.client.listTools();
      for (const name of [
        "hitchhiker_page_snapshot",
        "hitchhiker_page_click",
        "hitchhiker_page_fill",
      ])
        assert.ok(
          listed.tools.some((tool) => tool.name === name),
          name,
        );
      for (const arguments_ of [
        { pageId: "page", selector: "#save" },
        { pageId: "page", backendNodeId: 1 },
        { pageId: "page", ref: "r", expression: "document.body.remove()" },
      ]) {
        await assert.rejects(() =>
          present.client.callTool({
            name: arguments_.ref ? "hitchhiker_page_click" : "hitchhiker_page_snapshot",
            arguments: arguments_,
          }),
        );
      }
      assert.deepEqual(await records(marker), []);
    } finally {
      await present.transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("official MCP client can snapshot, click, and fill opaque top-frame references", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-dom-"));
  try {
    const grant = await provision(join(root, "grants"), ["https://allowed.test"]);
    const marker = join(root, "marker");
    const connection = await connect(join(root, "grants"), grant.token, marker);
    try {
      const response = resultJson(
        await connection.client.callTool({
          name: "hitchhiker_page_snapshot",
          arguments: { pageId: "page", interactiveOnly: false, maxDepth: 8 },
        }),
      );
      const snapshot = response.result as {
        readonly nodes: readonly {
          readonly name?: string;
          readonly value?: string;
          readonly ref?: string;
        }[];
      };
      assert.equal(snapshot.nodes.find((node) => node.name === "Password")?.value, undefined);
      const button = snapshot.nodes.find((node) => node.name === "Save draft")?.ref;
      const title = snapshot.nodes.find((node) => node.name === "Title")?.ref;
      const password = snapshot.nodes.find((node) => node.name === "Password")?.ref;
      assert.ok(button && title && password);
      resultJson(
        await connection.client.callTool({
          name: "hitchhiker_page_click",
          arguments: { pageId: "page", ref: button },
        }),
      );
      resultJson(
        await connection.client.callTool({
          name: "hitchhiker_page_fill",
          arguments: { pageId: "page", ref: title, value: "Published" },
        }),
      );
      assert.equal(
        (
          await connection.client.callTool({
            name: "hitchhiker_page_fill",
            arguments: { pageId: "page", ref: password, value: "secret" },
          })
        ).isError,
        true,
      );
      assert.deepEqual(await records(marker), [
        { operation: "snapshot" },
        { operation: "click", axId: "save" },
        { operation: "fill", axId: "title", value: "Published" },
      ]);
    } finally {
      await connection.transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("origin denial occurs before snapshot content and references do not cross connections", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-dom-"));
  try {
    const directory = join(root, "grants");
    const marker = join(root, "marker");
    const deniedGrant = await provision(directory, ["https://other.test"]);
    const denied = await connect(directory, deniedGrant.token, marker);
    try {
      const response = await denied.client.callTool({
        name: "hitchhiker_page_snapshot",
        arguments: { pageId: "page" },
      });
      assert.equal(response.isError, true);
      assert.deepEqual(await records(marker), []);
    } finally {
      await denied.transport.close();
    }

    const allowedGrant = await provision(directory, ["https://allowed.test"]);
    const first = await connect(directory, allowedGrant.token, marker);
    let ref: string;
    try {
      const snapshot = resultJson(
        await first.client.callTool({
          name: "hitchhiker_page_snapshot",
          arguments: { pageId: "page" },
        }),
      ).result as { readonly nodes: readonly { readonly ref?: string }[] };
      ref = snapshot.nodes.find((node) => node.ref !== undefined)!.ref!;
    } finally {
      await first.transport.close();
    }
    const second = await connect(directory, allowedGrant.token, marker);
    try {
      const response = await second.client.callTool({
        name: "hitchhiker_page_click",
        arguments: { pageId: "page", ref },
      });
      assert.equal(response.isError, true);
      assert.deepEqual(
        (await records(marker)).map((record: any) => record.operation),
        ["snapshot"],
      );
    } finally {
      await second.transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the actual official-MCP response stays below 256 KiB near the snapshot limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-dom-"));
  try {
    const directory = join(root, "grants");
    const grant = await provision(directory, ["https://allowed.test"]);
    const connection = await connect(directory, grant.token, join(root, "marker"), {
      MCP_DOM_LARGE: "one",
    });
    try {
      const response = await connection.client.callTool({
        name: "hitchhiker_page_snapshot",
        arguments: { pageId: "page", interactiveOnly: false },
      });
      assert.equal(response.isError, false, JSON.stringify(response));
      assert.ok(Buffer.byteLength(JSON.stringify(response)) < 256 * 1024);
      assert.equal(
        (resultJson(response).result as { readonly truncated: boolean }).truncated,
        true,
      );
    } finally {
      await connection.transport.close();
    }

    const child = spawn(process.execPath, ["--experimental-strip-types", fixture], {
      env: {
        ...process.env,
        MCP_DOM_GRANTS: directory,
        MCP_DOM_TOKEN: grant.token,
        MCP_DOM_MARKER: join(root, "raw-marker"),
        MCP_DOM_LARGE: "one",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert(child.stdin && child.stdout);
    const lines = createInterface({ input: child.stdout });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "escaped-id-test", version: "1.0.0" },
        },
      })}\n`,
    );
    await once(lines, "line");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const escapedId = "\u0000".repeat(64);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: escapedId,
        method: "tools/call",
        params: {
          name: "hitchhiker_page_snapshot",
          arguments: { pageId: "page", interactiveOnly: false },
        },
      })}\n`,
    );
    const [line] = (await once(lines, "line")) as [string];
    const rawResponse = JSON.parse(line) as { readonly id: string };
    assert.equal(rawResponse.id, escapedId);
    assert.ok(Buffer.byteLength(`${line}\n`) <= 256 * 1024);
    child.stdin.end();
    await once(child, "exit");
    lines.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read, write, full-control, and durable revocation are checked at the operation boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-dom-auth-"));
  try {
    const directory = join(root, "grants");
    const marker = join(root, "marker");
    const read = await provision(directory, ["https://allowed.test"], ["pages.read"]);
    const readConnection = await connect(directory, read.token, marker);
    let readRef: string;
    try {
      const snapshot = resultJson(
        await readConnection.client.callTool({
          name: "hitchhiker_page_snapshot",
          arguments: { pageId: "page" },
        }),
      ).result as { readonly nodes: readonly { readonly ref?: string }[] };
      readRef = snapshot.nodes.find((node) => node.ref !== undefined)!.ref!;
      assert.equal(
        (
          await readConnection.client.callTool({
            name: "hitchhiker_page_click",
            arguments: { pageId: "page", ref: readRef },
          })
        ).isError,
        true,
      );
    } finally {
      await readConnection.transport.close();
    }

    const write = await provision(directory, ["https://allowed.test"], ["pages.write"]);
    const writeConnection = await connect(directory, write.token, marker);
    try {
      assert.equal(
        (
          await writeConnection.client.callTool({
            name: "hitchhiker_page_snapshot",
            arguments: { pageId: "page" },
          })
        ).isError,
        true,
      );
    } finally {
      await writeConnection.transport.close();
    }

    const full = await provision(directory, [], ["browser.full-control"]);
    const fullConnection = await connect(directory, full.token, marker);
    try {
      const snapshot = resultJson(
        await fullConnection.client.callTool({
          name: "hitchhiker_page_snapshot",
          arguments: { pageId: "page" },
        }),
      ).result as { readonly nodes: readonly { readonly ref?: string }[] };
      const ref = snapshot.nodes.find((node) => node.ref !== undefined)!.ref!;
      assert.equal(
        (
          await fullConnection.client.callTool({
            name: "hitchhiker_page_click",
            arguments: { pageId: "page", ref },
          })
        ).isError,
        false,
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const grants = yield* create({ directory });
          yield* grants.revoke(full.grant.id);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      assert.equal(
        (
          await fullConnection.client.callTool({
            name: "hitchhiker_page_click",
            arguments: { pageId: "page", ref },
          })
        ).isError,
        true,
      );
    } finally {
      await fullConnection.transport.close();
    }
    const operations = (await records(marker)) as { readonly operation: string }[];
    assert.equal(operations.filter((record) => record.operation === "click").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
