import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { create } from "../src/grants.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const launcher = process.env.HITCHHIKER_BROWSER_LAUNCHER;
const main = fileURLToPath(new URL("../../../apps/browser/src/main.ts", import.meta.url));
const PluginList = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    version: Schema.String,
    enabled: Schema.Boolean,
    running: Schema.Boolean,
  }),
);

test(
  "real MCP installs, updates, rolls back and restores a native plugin without losing pages",
  {
    skip: !binary || !pluginHost,
    timeout: 60_000,
  },
  async () => {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-managed-native-")));
    const fixture = createServer((_request, response) =>
      response.end("<!doctype html><title>Plugin persistence</title>"),
    );
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    assert(address && typeof address !== "string");
    const credentials = await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory: join(profile, "hitchhiker-grants") });
        return yield* grants.issue({
          principal: "native-plugin-manager",
          profileId: "default",
          capabilities: ["plugins.install", "pages.list", "pages.manage", "ui.compose"],
          origins: [],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    const code = await readFile(
      fileURLToPath(new URL("../../../apps/canvas-plugin/dist/plugin.js", import.meta.url)),
      "utf8",
    );
    const manifest = {
      id: "canvas-example",
      name: "Canvas",
      version: "1.0.0",
      capabilities: ["pages.list", "pages.manage", "ui.compose"],
    };
    const registryDiagnostic = async () => {
      try {
        const registry = JSON.parse(
          await readFile(join(profile, "hitchhiker-plugins", "plugins.json"), "utf8"),
        ) as { readonly plugins?: readonly Record<string, unknown>[] };
        return JSON.stringify(
          (registry.plugins ?? []).map((plugin) => {
            const revision = plugin.revision as Record<string, unknown> | undefined;
            return {
              id: plugin.id,
              enabled: plugin.enabled,
              starting: plugin.starting,
              lastFailure: plugin.lastFailure,
              revision:
                revision === undefined
                  ? undefined
                  : { hash: revision.hash, name: revision.name, version: revision.version },
            };
          }),
        );
      } catch {
        return "unavailable";
      }
    };
    const connect = async () => {
      const transport = new StdioClientTransport({
        command: launcher ?? process.execPath,
        args: [
          ...(launcher ? [] : ["--experimental-strip-types", main]),
          "--mcp",
          `--profile-root=${profile}`,
        ],
        env: {
          ...process.env,
          HITCHHIKER_NATIVE_BINARY: binary!,
          HITCHHIKER_PLUGIN_HOST: pluginHost!,
          HITCHHIKER_MCP_TOKEN: credentials.token,
        },
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk).slice(-8192);
      });
      const client = new Client({ name: "native-installed-plugin-test", version: "1.0.0" });
      await client.connect(transport);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(
          result.isError,
          false,
          `${JSON.stringify(result)}\nregistry=${await registryDiagnostic()}\n${stderr}`,
        );
        return Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }))(
          result.structuredContent,
        ).result;
      };
      const list = async () =>
        Schema.decodeUnknownSync(PluginList)(await call("hitchhiker_plugins_list"));
      return { transport, call, list, client };
    };
    let session: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      session = await connect();
      const opened = await session.call("hitchhiker_page_open", {
        url: `http://127.0.0.1:${address.port}/`,
      });
      assert(opened && typeof opened === "object" && "pageId" in opened);
      const pageId = opened.pageId;
      await session.call("hitchhiker_plugin_install", { manifest, code });
      assert.deepEqual(await session.list(), [
        { id: "canvas-example", version: "1.0.0", enabled: true, running: true },
      ]);
      await session.call("hitchhiker_plugin_install", {
        manifest: { ...manifest, version: "2.0.0" },
        code,
      });
      assert.equal((await session.list())[0]?.version, "2.0.0");
      await session.call("hitchhiker_plugin_rollback", { id: manifest.id });
      assert.equal((await session.list())[0]?.version, "1.0.0");
      await session.call("hitchhiker_plugin_disable", { id: manifest.id });
      assert.equal((await session.list())[0]?.running, false);
      await session.call("hitchhiker_plugin_enable", { id: manifest.id });
      assert.equal((await session.list())[0]?.running, true);
      await session.transport.close();
      session = undefined;
      session = await connect();
      assert.deepEqual(await session.list(), [
        { id: "canvas-example", version: "1.0.0", enabled: true, running: true },
      ]);
      assert(JSON.stringify(await session.call("hitchhiker_pages_list")).includes(String(pageId)));
      await Effect.runPromise(
        Effect.gen(function* () {
          const grants = yield* create({ directory: join(profile, "hitchhiker-grants") });
          yield* grants.revoke(credentials.grant.id);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(
        (await session.client.callTool({ name: "hitchhiker_plugins_list", arguments: {} })).isError,
        true,
      );
      const registry = JSON.parse(
        await readFile(join(profile, "hitchhiker-plugins", "plugins.json"), "utf8"),
      );
      assert.equal(
        registry.plugins[0].enabled,
        false,
        "revoked installation must remain disabled after restart",
      );
    } finally {
      await session?.transport.close();
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);

test(
  "safe-mode starts the real browser without opening an invalid plugin store",
  { skip: !binary || !pluginHost, timeout: 30_000 },
  async () => {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-safe-native-")));
    const issued = await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory: join(profile, "hitchhiker-grants") });
        return yield* grants.issue({
          principal: "recovery-test",
          profileId: "default",
          capabilities: ["pages.list"],
          origins: [],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    // A regular file where a plugin directory belongs would fail manager construction.
    await writeFile(join(profile, "hitchhiker-plugins"), "invalid plugin store", { mode: 0o600 });
    const transport = new StdioClientTransport({
      command: launcher ?? process.execPath,
      args: [
        ...(launcher ? [] : ["--experimental-strip-types", main]),
        "--mcp",
        "--safe-mode",
        `--profile-root=${profile}`,
      ],
      env: {
        ...process.env,
        HITCHHIKER_NATIVE_BINARY: binary!,
        HITCHHIKER_PLUGIN_HOST: pluginHost!,
        HITCHHIKER_MCP_TOKEN: issued.token,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "native-safe-mode-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      assert.equal(
        (await client.callTool({ name: "hitchhiker_pages_list", arguments: {} })).isError,
        false,
      );
      assert.equal(
        (await client.listTools()).tools.some((tool) => tool.name.startsWith("hitchhiker_plugin")),
        false,
      );
    } finally {
      await transport.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
);
