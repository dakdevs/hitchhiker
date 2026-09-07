import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";

test("the bundled SDK preserves full-size binary chunks and rejects oversized chunks before calling the host", async () => {
  const bundled = await build({
    stdin: {
      contents: `import { definePlugin } from "./packages/plugin-sdk/src/index.ts";
        definePlugin({ async activate(api) {
          for (const length of [1, 2, 3, 65536]) {
            const bytes = Uint8Array.from({length}, (_, i) => i % 256);
            await api.extensions.installation.append("a".repeat(32), 0, bytes);
          }
          try { await api.extensions.installation.append("a".repeat(32), 65536, new Uint8Array(65537)); }
          catch { globalThis.oversizedRejected = true; }
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
    Uint8Array,
    oversizedRejected: false,
    calls: [] as { method: string; params: { dataBase64: string; offset: number } }[],
  };
  const context = createContext(sandbox);
  runInContext(bundled.outputFiles[0]!.text, context);
  await runInContext(
    `HitchhikerPlugin.activate({call(method, params) {
    calls.push({method, params});
    return Promise.resolve({operationId:"a".repeat(32),state:"receiving"});
  }})`,
    context,
  );
  assert.equal(sandbox.calls.length, 4);
  assert.equal(sandbox.calls[0]?.method, "extensions.installation.append");
  assert.equal(sandbox.calls[0]?.params.offset, 0);
  for (const [index, length] of [1, 2, 3, 65536].entries()) {
    const encoded = sandbox.calls[index]!.params.dataBase64;
    const expected = Buffer.from(Uint8Array.from({ length }, (_, i) => i % 256));
    assert.equal(encoded, expected.toString("base64"));
    assert.deepEqual(Buffer.from(encoded, "base64"), expected);
  }
  assert.equal(sandbox.oversizedRejected, true);
});
