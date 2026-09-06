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

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));

const closeWith = (input?: string | Uint8Array, env: NodeJS.ProcessEnv = {}) =>
  new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", fixture], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("MCP stdio child did not stop after input closed"));
      }, 2_000);
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(input);
    },
  );

const waitForExit = (
  child: ReturnType<typeof spawn>,
  timeoutMs = 3_000,
): Promise<{ readonly code: number | null; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP stdio child did not terminate boundedly"));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.on("error", reject);
  });

const initializeRaw = async (child: ReturnType<typeof spawn>) => {
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
        clientInfo: { name: "bounds-test", version: "1.0.0" },
      },
    })}\n`,
  );
  const [line] = (await once(lines, "line")) as [string];
  assert.equal(JSON.parse(line).id, 0);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return lines;
};

const toolCall = (id: number) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "hitchhiker_pages_list", arguments: {} },
  });

test("official MCP client negotiates 2025-06-18 and enforces the pre-issued grant", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", fixture],
    env: { ...process.env, MCP_CAPABILITIES: "pages", MCP_REVOKE_AFTER: "one" },
    stderr: "pipe",
    maxBufferSize: 256 * 1024,
  });
  const client = new Client({ name: "runtime-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "hitchhiker_pages_list"));
    assert.ok(!tools.tools.some((tool) => tool.name.includes("cdp")));
    const listed = await client.callTool({ name: "hitchhiker_pages_list", arguments: {} });
    assert.equal(listed.isError, false);
    const revoked = await client.callTool({ name: "hitchhiker_pages_list", arguments: {} });
    assert.equal(revoked.isError, true);
    const denied = await client.callTool({
      name: "hitchhiker_page_open",
      arguments: { url: "https://example.test" },
    });
    assert.equal(denied.isError, true);
  } finally {
    await transport.close();
  }
});

test("EOF and rejected stdio frames terminate boundedly without contaminating protocol stdout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-cleanup-"));
  try {
    const eofMarker = join(directory, "eof");
    const eof = await closeWith(undefined, { MCP_FINALIZER_MARKER: eofMarker });
    assert.equal(eof.code, 0);
    assert.equal(eof.stdout, "");
    assert.equal(await readFile(eofMarker, "utf8"), "cleaned\n");

    for (const [name, input, error] of [
      ["malformed", "not json\n", /Malformed MCP input/],
      ["oversized", "x".repeat(256 * 1024 + 1), /256 KiB/],
      ["unterminated", '{"jsonrpc":"2.0"}', /unterminated frame/],
      ["utf8", new Uint8Array([0xff, 0x0a]), /valid UTF-8/],
    ] as const) {
      const marker = join(directory, name);
      const result = await closeWith(input, { MCP_FINALIZER_MARKER: marker });
      assert.notEqual(result.code, 0, name);
      assert.equal(result.stdout, "", name);
      assert.match(result.stderr, error, name);
      assert.equal(await readFile(marker, "utf8"), "cleaned\n");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate and thirty-third active request close before excess dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-capacity-"));
  try {
    const duplicateMarker = join(directory, "duplicate-dispatch");
    const duplicateCleanup = join(directory, "duplicate-cleanup");
    const duplicate = spawn(process.execPath, ["--experimental-strip-types", fixture], {
      env: {
        ...process.env,
        MCP_SLOW_MS: "1000",
        MCP_DISPATCH_MARKER: duplicateMarker,
        MCP_FINALIZER_MARKER: duplicateCleanup,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const duplicateExit = waitForExit(duplicate);
    const duplicateLines = await initializeRaw(duplicate);
    duplicate.stdin?.write(`${toolCall(1)}\n${toolCall(1)}\n`);
    const duplicateResult = await duplicateExit;
    duplicateLines.close();
    assert.notEqual(duplicateResult.code, 0);
    assert.match(duplicateResult.stderr, /already active/);
    const duplicateDispatches = await readFile(duplicateMarker, "utf8").catch(() => "");
    assert.ok(duplicateDispatches.split("\n").filter(Boolean).length <= 1);
    assert.equal(await readFile(duplicateCleanup, "utf8"), "cleaned\n");

    const capacityMarker = join(directory, "capacity-dispatch");
    const capacityCleanup = join(directory, "capacity-cleanup");
    const capacity = spawn(process.execPath, ["--experimental-strip-types", fixture], {
      env: {
        ...process.env,
        MCP_SLOW_MS: "1000",
        MCP_DISPATCH_MARKER: capacityMarker,
        MCP_FINALIZER_MARKER: capacityCleanup,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const capacityExit = waitForExit(capacity);
    const capacityLines = await initializeRaw(capacity);
    capacity.stdin?.write(
      `${Array.from({ length: 33 }, (_, index) => toolCall(index + 1)).join("\n")}\n`,
    );
    const capacityResult = await capacityExit;
    capacityLines.close();
    assert.notEqual(capacityResult.code, 0);
    assert.match(capacityResult.stderr, /too many in-flight requests/);
    const dispatched = await readFile(capacityMarker, "utf8").catch(() => "");
    assert.ok(dispatched.split("\n").filter(Boolean).length < 33);
    assert.equal(await readFile(capacityCleanup, "utf8"), "cleaned\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("thirty-two concurrent official SDK calls all progress", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", fixture],
    env: { ...process.env, MCP_SLOW_MS: "25" },
    stderr: "pipe",
    maxBufferSize: 256 * 1024,
  });
  const client = new Client({ name: "runtime-concurrency-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const responses = await Promise.all(
      Array.from({ length: 32 }, () =>
        client.callTool({ name: "hitchhiker_pages_list", arguments: {} }),
      ),
    );
    assert.equal(responses.length, 32);
    assert.ok(responses.every((response) => response.isError === false));
  } finally {
    await transport.close();
  }
});
