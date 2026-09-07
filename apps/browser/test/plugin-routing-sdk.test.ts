import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";

test("compiled route SDK calls carry only the contribution ID and sanitize host failures", async () => {
  const bundled = await build({
    stdin: {
      contents: `import { definePlugin } from "./packages/plugin-sdk/src/index.ts";
        definePlugin({ async activate(api) {
          globalThis.shown = await api.ui.showRoute("main");
          globalThis.hidden = await api.ui.hideRoute("main");
          try { await api.ui.showRoute("absent"); }
          catch (error) { globalThis.failure = error.message; }
        }});`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  const sandbox = {
    shown: undefined,
    hidden: undefined,
    failure: undefined,
    calls: [] as unknown[],
  };
  const context = createContext(sandbox);
  runInContext(bundled.outputFiles[0]!.text, context);
  await runInContext(
    `HitchhikerPlugin.activate({ call(method, params) {
    calls.push({method, params});
    if (params.id === "absent") return Promise.reject(new Error("not_authorized"));
    return Promise.resolve({revision: method === "ui.showRoute" ? 7 : 8});
  }})`,
    context,
  );
  assert.equal(
    JSON.stringify(sandbox.calls),
    JSON.stringify([
      { method: "ui.showRoute", params: { id: "main" } },
      { method: "ui.hideRoute", params: { id: "main" } },
      { method: "ui.showRoute", params: { id: "absent" } },
    ]),
  );
  assert.equal(JSON.stringify(sandbox.shown), '{"revision":7}');
  assert.equal(JSON.stringify(sandbox.hidden), '{"revision":8}');
  assert.equal(sandbox.failure, "Plugin operation was denied or could not complete");
});
