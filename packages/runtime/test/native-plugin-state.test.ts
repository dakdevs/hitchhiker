import assert from "node:assert/strict";
import test from "node:test";
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
const main = fileURLToPath(new URL("../../../apps/browser/src/main.ts", import.meta.url));
const example = new URL("../../../apps/composition-example/", import.meta.url);
const Plugins = Schema.Array(
  Schema.Struct({ id: Schema.String, enabled: Schema.Boolean, running: Schema.Boolean }),
);

test(
  "installed SDK page watches and storage survive restart and clear on uninstall",
  { skip: !binary || !pluginHost, timeout: 45000 },
  async () => {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-state-mcp-")));
    const credentials = await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory: join(profile, "hitchhiker-grants") });
        return yield* grants.issue({
          principal: "services-test",
          profileId: "default",
          capabilities: ["plugins.install", "pages.list", "pages.manage", "storage.local"],
          origins: [],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    const connect = async (safeMode = false) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--experimental-strip-types",
          main,
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
      const client = new Client({ name: "services-test", version: "1.0.0" });
      try {
        await client.connect(transport);
      } catch (error) {
        await transport.close();
        throw new Error(`${String(error)}\n${stderr}`);
      }
      return {
        transport,
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
      const install = async (version = "1.0.0") => {
        await session!.call("hitchhiker_plugin_install", {
          manifest: {
            id: "page-state",
            name: "Page state",
            version,
            capabilities: ["pages.list", "pages.manage", "storage.local"],
          },
          code: await readFile(new URL("dist/page-state.js", example), "utf8"),
        });
      };
      const stored = async () =>
        Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              revision: Schema.Number,
              value: Schema.Struct({
                activations: Schema.Number,
                pageId: Schema.String,
                observedRevision: Schema.Number,
                observedUrl: Schema.optional(Schema.NullOr(Schema.String)),
              }),
            }),
          ),
        )(
          await readFile(join(profile, "hitchhiker-plugins", "storage", "page-state.json"), "utf8"),
        );
      await install();
      assert.equal((await stored()).value.activations, 1);
      const pageId = (await stored()).value.pageId;
      await session.call("hitchhiker_page_navigate", { pageId, url: "https://example.org/" });
      for (
        let attempt = 0;
        (await stored()).value.observedUrl !== "https://example.org/";
        attempt++
      ) {
        assert(attempt < 100, "SDK did not receive reduced page changes");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await session.call("hitchhiker_plugin_disable", { id: "page-state" });
      await session.call("hitchhiker_plugin_enable", { id: "page-state" });
      assert.equal((await stored()).value.activations, 2);
      await install("2.0.0");
      assert.equal((await stored()).value.activations, 3);
      await session.transport.close();
      session = undefined;
      session = await connect();
      assert.equal((await stored()).value.activations, 4);
      await session.call("hitchhiker_plugin_uninstall", { id: "page-state" });
      await assert.rejects(stored(), { code: "ENOENT" });
      await install();
      assert.equal((await stored()).value.activations, 1);
      const plugins = Schema.decodeUnknownSync(Plugins)(
        await session.call("hitchhiker_plugins_list"),
      );
      assert.equal(plugins[0]?.running, true);
    } finally {
      await session?.transport.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
);
