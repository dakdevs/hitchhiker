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
const fixtureReady = "HITCHHIKER_MCP_FIXTURE_READY";
const fixtureStartupDeadlineMs = 10_000;

const waitForFixtureReady = (child: ReturnType<typeof spawn>) =>
  new Promise<void>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP stdio fixture did not become ready"));
    }, fixtureStartupDeadlineMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk;
      if (!stderr.includes(`${fixtureReady}\n`)) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", fail);
    child.once("exit", (code) =>
      fail(new Error(`MCP stdio fixture exited before readiness (${code}): ${stderr}`)),
    );
  });

const closeWith = async (input?: string | Uint8Array, env: NodeJS.ProcessEnv = {}) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", fixture], {
    env: { ...process.env, ...env, MCP_READY: "yes" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  const exited = once(child, "exit") as Promise<[number | null]>;
  await waitForFixtureReady(child);
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP stdio child did not stop after input closed"));
    }, 2_000);
    void exited.then(([exitCode]) => {
      clearTimeout(timer);
      resolve(exitCode);
    }, reject);
  });
  return { code, stdout, stderr };
};

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
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP stdio fixture did not initialize"));
    }, fixtureStartupDeadlineMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    lines.once("line", (received: string) => {
      clearTimeout(timer);
      resolve(received);
    });
    child.once("error", fail);
    child.once("exit", (code) =>
      fail(new Error(`MCP stdio fixture exited before initialization (${code})`)),
    );
  });
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

test("history tools are optional, require pages.manage, and reread revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-history-"));
  try {
    const marker = join(directory, "history");
    const absentTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", fixture],
      env: { ...process.env, MCP_CAPABILITIES: "manage" },
      stderr: "pipe",
    });
    const absent = new Client({ name: "history-absent", version: "1.0.0" });
    await absent.connect(absentTransport);
    try {
      assert.equal(
        (await absent.listTools()).tools.some((tool) => tool.name === "hitchhiker_page_back"),
        false,
      );
    } finally {
      await absentTransport.close();
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", fixture],
      env: {
        ...process.env,
        MCP_CAPABILITIES: "manage",
        MCP_HISTORY: "yes",
        MCP_HISTORY_MARKER: marker,
        MCP_REVOKE_AFTER: "one",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "history-present", version: "1.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      for (const action of ["back", "forward", "reload", "stop"])
        assert.ok(tools.tools.some((tool) => tool.name === `hitchhiker_page_${action}`));
      const first = await client.callTool({
        name: "hitchhiker_page_back",
        arguments: { pageId: "page" },
      });
      assert.equal(first.isError, false);
      const revoked = await client.callTool({
        name: "hitchhiker_page_forward",
        arguments: { pageId: "page" },
      });
      assert.equal(revoked.isError, true);
      assert.equal(await readFile(marker, "utf8"), "page:back\n");
    } finally {
      await transport.close();
    }

    const deniedTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", fixture],
      env: {
        ...process.env,
        MCP_CAPABILITIES: "none",
        MCP_HISTORY: "yes",
        MCP_HISTORY_MARKER: marker,
      },
      stderr: "pipe",
    });
    const denied = new Client({ name: "history-denied", version: "1.0.0" });
    await denied.connect(deniedTransport);
    try {
      const response = await denied.callTool({
        name: "hitchhiker_page_reload",
        arguments: { pageId: "page" },
      });
      assert.equal(response.isError, true);
      assert.equal(await readFile(marker, "utf8"), "page:back\n");
    } finally {
      await deniedTransport.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
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
        MCP_READY: "yes",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await waitForFixtureReady(duplicate);
    const duplicateLines = await initializeRaw(duplicate);
    duplicate.stdin?.write(`${toolCall(1)}\n${toolCall(1)}\n`);
    const duplicateExit = waitForExit(duplicate);
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
        MCP_READY: "yes",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await waitForFixtureReady(capacity);
    const capacityLines = await initializeRaw(capacity);
    capacity.stdin?.write(
      `${Array.from({ length: 33 }, (_, index) => toolCall(index + 1)).join("\n")}\n`,
    );
    const capacityExit = waitForExit(capacity);
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

test("oversized and unsafe JSON-RPC request IDs close before dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-mcp-id-"));
  try {
    for (const [name, id] of [
      ["string", "\u0000".repeat(65)],
      ["number", Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      const dispatchMarker = join(directory, `${name}-dispatch`);
      const cleanupMarker = join(directory, `${name}-cleanup`);
      const child = spawn(process.execPath, ["--experimental-strip-types", fixture], {
        env: {
          ...process.env,
          MCP_DISPATCH_MARKER: dispatchMarker,
          MCP_FINALIZER_MARKER: cleanupMarker,
          MCP_READY: "yes",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      await waitForFixtureReady(child);
      const lines = await initializeRaw(child);
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "hitchhiker_pages_list", arguments: {} },
        })}\n`,
      );
      const exited = waitForExit(child);
      const result = await exited;
      lines.close();
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /request id is invalid/);
      assert.equal(await readFile(dispatchMarker, "utf8").catch(() => ""), "");
      assert.equal(await readFile(cleanupMarker, "utf8"), "cleaned\n");
    }
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

test("DevTools MCP tools are optional, profile-wide, strict, and grant-checked", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", fixture],
    env: { ...process.env, MCP_CAPABILITIES: "devtools", MCP_DEVTOOLS: "yes" },
    stderr: "pipe",
  });
  const client = new Client({ name: "devtools", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "hitchhiker_devtools_show"));
    const shown = await client.callTool({
      name: "hitchhiker_devtools_show",
      arguments: { pageId: "page", inspectAt: { x: 4, y: 5 } },
    });
    assert.equal(shown.isError, false);
    await assert.rejects(
      client.callTool({
        name: "hitchhiker_devtools_show",
        arguments: { pageId: "page", inspectAt: { x: -1, y: 0 } },
      }),
      /Invalid parameters/,
    );
  } finally {
    await transport.close();
  }
});
