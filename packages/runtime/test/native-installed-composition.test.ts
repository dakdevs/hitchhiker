import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { create } from "../src/grants.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const pluginHost = process.env.HITCHHIKER_PLUGIN_HOST;
const launcher = process.env.HITCHHIKER_BROWSER_LAUNCHER;
const main = fileURLToPath(new URL("../../../apps/browser/src/main.ts", import.meta.url));
const example = new URL("../../../apps/composition-example/", import.meta.url);
const Plugins = Schema.Array(
  Schema.Struct({ id: Schema.String, enabled: Schema.Boolean, running: Schema.Boolean }),
);
const Plan = Schema.Struct({ revision: Schema.Number });
const composition = {
  layout: "split-layout",
  slots: [
    {
      key: "content",
      contributions: [
        { pluginId: "split-left", id: "page" },
        { pluginId: "split-right", id: "page" },
      ],
    },
  ],
};
const withoutLeft = {
  layout: "split-layout",
  slots: [{ key: "content", contributions: [{ pluginId: "split-right", id: "page" }] }],
};

test(
  "MCP stages a profile composition plan and a fresh app restores it without re-enabling removed features",
  { skip: !binary || !pluginHost, timeout: 45000 },
  async () => {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-composition-mcp-")));
    const server = createServer((_request, response) =>
      response.end("<!doctype html><title>Composition restart</title>"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const credentials = await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory: join(profile, "hitchhiker-grants") });
        return yield* grants.issue({
          principal: "composition-test",
          profileId: "default",
          capabilities: ["plugins.install", "pages.list", "pages.manage", "ui.compose"],
          origins: [],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    const connect = async (safeMode = false) => {
      const transport = new StdioClientTransport({
        command: launcher ?? process.execPath,
        args: [
          ...(launcher ? [] : ["--experimental-strip-types", main]),
          "--mcp",
          `--profile-root=${profile}`,
          ...(safeMode ? ["--safe-mode"] : []),
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
      const client = new Client({ name: "composition-test", version: "1.0.0" });
      try {
        await client.connect(transport);
      } catch (error) {
        await transport.close();
        throw new Error(`${String(error)}\n${stderr}`);
      }
      return {
        transport,
        diagnostics: () => stderr,
        call: async (name: string, args: Record<string, unknown> = {}) => {
          const result = await client.callTool({ name, arguments: args });
          assert.equal(result.isError, false, `${JSON.stringify(result)}\n${stderr}`);
          return Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }))(
            result.structuredContent,
          ).result;
        },
      };
    };
    let session: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      session = await connect();
      for (const page of ["one", "two"])
        await session.call("hitchhiker_page_open", {
          url: `http://127.0.0.1:${address.port}/${page}`,
        });
      const stage = async (name: string) =>
        session!.call("hitchhiker_plugin_stage", {
          manifest: JSON.parse(
            await readFile(new URL(`${name}.hitchhiker.plugin.json`, example), "utf8"),
          ),
          code: await readFile(new URL(`dist/${name}.js`, example), "utf8"),
        });
      const list = async () =>
        Schema.decodeUnknownSync(Plugins)(await session!.call("hitchhiker_plugins_list"));
      const plan = async () =>
        Schema.decodeUnknownSync(Plan)(await session!.call("hitchhiker_plugin_plan"));
      const apply = async (candidate: Record<string, unknown>) =>
        session!.call("hitchhiker_plugin_apply_plan", {
          expectedRevision: (await plan()).revision,
          candidate,
        });
      for (const name of ["right", "left", "layout"]) await stage(name);
      assert((await list()).every((plugin) => !plugin.enabled && !plugin.running));
      await apply({
        enabled: ["split-layout", "split-left", "split-right"],
        composition,
        serviceBindings: [],
      });
      assert.equal((await list()).filter((plugin) => plugin.running).length, 3);
      await apply({
        enabled: ["split-layout", "split-right"],
        composition: withoutLeft,
        serviceBindings: [],
      });
      assert.deepEqual(
        (await list()).find((plugin) => plugin.id === "split-left"),
        {
          id: "split-left",
          enabled: false,
          running: false,
        },
      );
      await session.call("hitchhiker_plugin_uninstall", { id: "split-left" });
      await session.transport.close();
      const firstLog = session.diagnostics();
      const afterClose = JSON.parse(
        await readFile(join(profile, "hitchhiker-plugins", "plugins.json"), "utf8"),
      ).plugins.map((entry: { id: string; enabled: boolean; lastFailure?: string }) => ({
        id: entry.id,
        enabled: entry.enabled,
        lastFailure: entry.lastFailure,
      }));
      session = undefined;
      session = await connect();
      const restoredData = await session.call("hitchhiker_plugins_list");
      const restored = Schema.decodeUnknownSync(Plugins)(restoredData);
      assert.equal(
        restored.filter((plugin) => plugin.running).length,
        2,
        `${JSON.stringify(restoredData)}\nafter-close=${JSON.stringify(afterClose)}\nfirst=${firstLog}\nsecond=${session.diagnostics()}`,
      );
      assert.equal(
        restored.find((plugin) => plugin.id === "split-left"),
        undefined,
      );
      await stage("left");
      await apply({
        enabled: ["split-layout", "split-left", "split-right"],
        composition,
        serviceBindings: [],
      });
      assert.equal(
        Schema.decodeUnknownSync(Plugins)(await session.call("hitchhiker_plugins_list")).filter(
          (plugin) => plugin.running,
        ).length,
        3,
      );
      assert.equal(
        Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
          await session.call("hitchhiker_pages_list"),
        ).length,
        2,
      );
      await session.transport.close();
      session = undefined;
      session = await connect(true);
      assert.equal(
        Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
          await session.call("hitchhiker_pages_list"),
        ).length,
        2,
      );
    } finally {
      await session?.transport.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);
