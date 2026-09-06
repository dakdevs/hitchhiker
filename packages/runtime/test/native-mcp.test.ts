import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
const launcher = process.env.HITCHHIKER_BROWSER_LAUNCHER;
const toolJson = (response: unknown) => {
  const result = response as {
    readonly isError?: boolean;
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  };
  assert.equal(result.isError, false, JSON.stringify(response));
  const content = result.content?.[0];
  if (content?.type !== "text" || typeof content.text !== "string")
    throw new Error("expected a text MCP result");
  return (JSON.parse(content.text) as { readonly result: unknown }).result;
};
test(
  "official MCP client uses scoped DOM refs in the real browser and loses access after revocation",
  { skip: !binary, timeout: 30000 },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "hitchhiker-native-mcp-")));
    const grantDirectory = join(directory, "hitchhiker-grants");
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.url === "/new") {
        response.end("<!doctype html><title>Replacement</title><h1>New document</h1>");
        return;
      }
      if (request.url === "/many") {
        response.end(
          `<!doctype html><title>Many controls</title>${Array.from(
            { length: 513 },
            (_, index) =>
              `<input aria-label="Password ${index}" role="button" type="password" value="many-secret-${index}">`,
          ).join("")}`,
        );
        return;
      }
      response.end(`<!doctype html><title>MCP browser fixture</title>
        <h1 id="status">Native Chromium</h1>
        <button id="save" onclick="document.querySelector('#status').textContent='Saved'">Save draft</button>
        <label>Title <input id="title" value="Draft"></label>
        <label>Password <input id="password" type="password" value="private-value"></label>
        <input aria-label="Alternate password" role="button" type="password" value="alternate-secret">
        <fieldset disabled><input aria-label="Disabled title" value="Blocked"></fieldset>
        <div style="height:1800px"></div>
        <button aria-label="Offscreen action" onclick="document.querySelector('#status').textContent='Scrolled and saved'">Offscreen</button>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    const urlOrigin = `http://127.0.0.1:${address.port}`;
    const crossSiteOrigin = `http://localhost:${address.port}`;
    const issued = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* create({ directory: grantDirectory });
        return yield* store.issue({
          principal: "mcp-test",
          profileId: "default",
          capabilities: [
            "pages.list",
            "pages.manage",
            "pages.read",
            "pages.write",
            "configuration.write",
          ],
          origins: [urlOrigin, crossSiteOrigin],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    const main = fileURLToPath(new URL("../../../apps/browser/src/main.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: launcher ?? process.execPath,
      args: [
        ...(launcher ? [] : ["--experimental-strip-types", main]),
        "--mcp",
        `--profile-root=${directory}`,
      ],
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
      const pageId = (toolJson(opened) as { readonly pageId: string }).pageId;
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
      const waitForTitle = async (title: string) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const pages = await client.callTool({ name: "hitchhiker_pages_list", arguments: {} });
          if (JSON.stringify(pages).includes(title)) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.fail(`timed out waiting for ${title}: ${stderr}`);
      };
      const firstSnapshot = toolJson(
        await client.callTool({
          name: "hitchhiker_page_snapshot",
          arguments: { pageId, interactiveOnly: false, maxDepth: 8 },
        }),
      ) as {
        readonly nodes: readonly {
          readonly name?: string;
          readonly value?: string;
          readonly ref?: string;
        }[];
      };
      assert.equal(JSON.stringify(firstSnapshot).includes("private-value"), false);
      assert.equal(JSON.stringify(firstSnapshot).includes("alternate-secret"), false);
      const clickRef = firstSnapshot.nodes.find(
        (node) => node.name?.trim() === "Save draft" && node.ref !== undefined,
      )?.ref;
      const fillRef = firstSnapshot.nodes.find(
        (node) => node.name?.trim() === "Title" && node.ref !== undefined,
      )?.ref;
      const passwordRef = firstSnapshot.nodes.find(
        (node) => node.name?.trim() === "Password" && node.ref !== undefined,
      )?.ref;
      const alternatePasswordRef = firstSnapshot.nodes.find(
        (node) => node.name?.trim() === "Alternate password" && node.ref !== undefined,
      )?.ref;
      const disabledRef = firstSnapshot.nodes.find(
        (node) => node.name?.trim() === "Disabled title" && node.ref !== undefined,
      )?.ref;
      const offscreenRef = firstSnapshot.nodes.find(
        (node) => node.name?.trim() === "Offscreen action" && node.ref !== undefined,
      )?.ref;
      assert.equal(JSON.stringify(firstSnapshot).includes("••"), false);
      assert.ok(
        clickRef && fillRef && passwordRef && alternatePasswordRef && disabledRef && offscreenRef,
        JSON.stringify(firstSnapshot),
      );
      toolJson(
        await client.callTool({
          name: "hitchhiker_page_click",
          arguments: { pageId, ref: clickRef },
        }),
      );
      toolJson(
        await client.callTool({
          name: "hitchhiker_page_fill",
          arguments: { pageId, ref: fillRef, value: "Published" },
        }),
      );
      assert.equal(
        (
          await client.callTool({
            name: "hitchhiker_page_fill",
            arguments: { pageId, ref: passwordRef, value: "secret" },
          })
        ).isError,
        true,
      );
      assert.equal(
        (
          await client.callTool({
            name: "hitchhiker_page_fill",
            arguments: { pageId, ref: disabledRef, value: "must not change" },
          })
        ).isError,
        true,
      );
      toolJson(
        await client.callTool({
          name: "hitchhiker_page_click",
          arguments: { pageId, ref: offscreenRef },
        }),
      );
      assert.equal(
        (
          await client.callTool({
            name: "hitchhiker_page_fill",
            arguments: { pageId, ref: alternatePasswordRef, value: "secret" },
          })
        ).isError,
        true,
      );
      const afterWrite = toolJson(
        await client.callTool({
          name: "hitchhiker_page_snapshot",
          arguments: { pageId, interactiveOnly: false },
        }),
      ) as { readonly nodes: readonly { readonly name?: string; readonly value?: string }[] };
      assert.ok(afterWrite.nodes.some((node) => node.name === "Scrolled and saved"));
      assert.equal(
        afterWrite.nodes.find((node) => node.name?.trim() === "Title" && node.value !== undefined)
          ?.value,
        "Published",
      );
      assert.equal(
        (
          await client.callTool({
            name: "hitchhiker_page_navigate",
            arguments: { pageId, url: `${crossSiteOrigin}/new` },
          })
        ).isError,
        false,
      );
      await waitForTitle("Replacement");
      assert.equal(
        (
          await client.callTool({
            name: "hitchhiker_page_click",
            arguments: { pageId, ref: clickRef },
          })
        ).isError,
        true,
      );
      assert.equal(
        (
          await client.callTool({
            name: "hitchhiker_page_navigate",
            arguments: { pageId, url: `${crossSiteOrigin}/many` },
          })
        ).isError,
        false,
      );
      await waitForTitle("Many controls");
      const many = await client.callTool({
        name: "hitchhiker_page_snapshot",
        arguments: { pageId, interactiveOnly: false },
      });
      assert.equal(many.isError, true);
      assert.equal(JSON.stringify(many).includes("many-secret"), false);
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
      const exported = toolJson(
        await client.callTool({ name: "hitchhiker_customization_export", arguments: {} }),
      ) as { recipe: string };
      assert.deepEqual(JSON.parse(exported.recipe), {
        version: 1,
        configuration: { colorScheme: "dark", sleepAfterMs: 60_000, alwaysAwakeOrigins: [] },
        interface: { tabPlacement: "top" },
        plugins: [],
      });
      const importedRecipe = {
        version: 1,
        configuration: {
          colorScheme: "light",
          sleepAfterMs: 120_000,
          alwaysAwakeOrigins: [urlOrigin],
        },
        interface: { tabPlacement: "sidebar" },
        plugins: [],
      };
      assert.deepEqual(
        toolJson(
          await client.callTool({
            name: "hitchhiker_customization_import",
            arguments: { recipe: JSON.stringify(importedRecipe) },
          }),
        ),
        { applied: true, pluginRequirements: [], pluginsChanged: false },
      );
      const persisted = JSON.parse(await readFile(join(directory, "browser-state.json"), "utf8"));
      assert.deepEqual(persisted.configuration, importedRecipe.configuration);
      assert.equal(persisted.interface.tabPlacement, "sidebar");
      assert(persisted.pages.some((page: { id: string }) => page.id === pageId));
      const exportedAgain = toolJson(
        await client.callTool({ name: "hitchhiker_customization_export", arguments: {} }),
      ) as { recipe: string };
      assert.deepEqual(JSON.parse(exportedAgain.recipe), importedRecipe);
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
      assert.equal(
        (
          await client.callTool({
            name: "hitchhiker_customization_import",
            arguments: { recipe: exported.recipe },
          })
        ).isError,
        true,
      );
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
