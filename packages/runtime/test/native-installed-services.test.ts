import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  "installed SDK service dependencies survive provider replacement and fresh-process restore",
  { skip: !binary || !pluginHost, timeout: 45000 },
  async () => {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-services-mcp-")));
    const credentials = await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* create({ directory: join(profile, "hitchhiker-grants") });
        return yield* grants.issue({
          principal: "services-test",
          profileId: "default",
          capabilities: ["plugins.install", "pages.list", "configuration.write"],
          origins: [],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    await mkdir(join(profile, "hitchhiker-plugins"));
    const recipePath = join(profile, "hitchhiker-plugins", "services.json");
    await writeFile(recipePath, await readFile(new URL("services.json", example)));
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
      const install = async (name: string, version = "1.0.0") => {
        const manifest = JSON.parse(
          await readFile(new URL(`${name}.hitchhiker.plugin.json`, example), "utf8"),
        );
        await session!.call("hitchhiker_plugin_install", {
          manifest: { ...manifest, version },
          code: await readFile(new URL(`dist/${name}.js`, example), "utf8"),
        });
      };
      const list = async () =>
        Schema.decodeUnknownSync(Plugins)(await session!.call("hitchhiker_plugins_list"));
      await install("service-provider");
      await install("service-consumer");
      assert.equal((await list()).filter((entry) => entry.running).length, 2);
      const exported = Schema.decodeUnknownSync(Schema.Struct({ recipe: Schema.String }))(
        await session.call("hitchhiker_customization_export", { includePlugins: true }),
      );
      const portable = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            plugins: Schema.Array(
              Schema.Struct({
                manifest: Schema.Struct({
                  id: Schema.String,
                  requires: Schema.optional(Schema.Array(Schema.Unknown)),
                }),
              }),
            ),
          }),
        ),
      )(exported.recipe);
      assert.equal(
        portable.plugins.find((entry) => entry.manifest.id === "service-consumer")?.manifest
          .requires?.length,
        1,
      );
      await session.call("hitchhiker_plugin_disable", { id: "service-provider" });
      assert.deepEqual(
        (await list()).find((entry) => entry.id === "service-consumer"),
        { id: "service-consumer", enabled: true, running: false },
      );
      await session.call("hitchhiker_plugin_enable", { id: "service-provider" });
      assert.equal((await list()).filter((entry) => entry.running).length, 2);
      await install("service-provider", "2.0.0");
      assert.equal((await list()).filter((entry) => entry.running).length, 2);
      await session.transport.close();
      session = undefined;
      session = await connect();
      assert.equal((await list()).filter((entry) => entry.running).length, 2);
      await session.call("hitchhiker_plugin_uninstall", { id: "service-provider" });
      assert.deepEqual(await list(), [{ id: "service-consumer", enabled: true, running: false }]);
      await install("service-provider");
      assert.equal((await list()).filter((entry) => entry.running).length, 2);
      await session.transport.close();
      session = undefined;
      await writeFile(recipePath, "{invalid");
      session = await connect(true);
      assert(Array.isArray(await session.call("hitchhiker_pages_list")));
    } finally {
      await session?.transport.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
);
