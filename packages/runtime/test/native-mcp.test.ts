import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { create } from "../src/grants.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
test(
  "official MCP client controls the real native browser and loses access after durable revocation",
  { skip: !binary, timeout: 30000 },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-native-mcp-")));
    const grantDirectory = join(directory, "hitchhiker-grants");
    const issued = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* create({ directory: grantDirectory });
        return yield* store.issue({
          principal: "mcp-test",
          profileId: "default",
          capabilities: ["pages.list", "pages.manage", "configuration.write"],
          origins: [],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    const server = createServer((_request, response) =>
      response.end("<!doctype html><title>MCP browser fixture</title><h1>Native Chromium</h1>"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    const main = fileURLToPath(new URL("../../../apps/browser/src/main.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", main, "--mcp", `--profile-root=${directory}`],
      env: {
        ...process.env,
        HITCHHIKER_NATIVE_BINARY: binary!,
        HITCHHIKER_MCP_TOKEN: issued.token,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "native-mcp-test", version: "1.0.0" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk).slice(-16384);
    });
    try {
      await client.connect(transport);
      const opened = await client.callTool({ name: "hitchhiker_page_open", arguments: { url } });
      assert.equal(opened.isError, false, JSON.stringify(opened));
      let found = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const pages = await client.callTool({ name: "hitchhiker_pages_list", arguments: {} });
        assert.equal(pages.isError, false);
        if (JSON.stringify(pages).includes("MCP browser fixture")) {
          found = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(found, stderr);
      assert.equal(
        (await client.callTool({ name: "hitchhiker_tabs_set", arguments: { placement: "top" } }))
          .isError,
        false,
      );
      assert.equal(
        (
          await client.callTool({
            name: "hitchhiker_configuration_set",
            arguments: { colorScheme: "dark", sleepAfterMs: 60000, alwaysAwakeOrigins: [] },
          })
        ).isError,
        false,
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* create({ directory: grantDirectory });
          yield* store.revoke(issued.grant.id);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      assert.equal(
        (await client.callTool({ name: "hitchhiker_pages_list", arguments: {} })).isError,
        true,
      );
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
