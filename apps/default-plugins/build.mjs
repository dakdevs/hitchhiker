import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { isDeepStrictEqual } from "node:util";
import { compileSchemas } from "./compile-schemas.mjs";
import { pathToFileURL } from "node:url";
import { contractDocuments } from "./src/contract-documents.ts";

const directory = new URL("./", import.meta.url);
const out = new URL("dist/", directory);
await mkdir(out, { recursive: true });
const schemaSafeLicense = await readFile(new URL("SCHEMASAFE-LICENSE", directory));
const contracts = {};
for (const name of ["model", "pins", "layout"]) {
  const bytes = await readFile(new URL(`contracts/${name}.json`, directory));
  const document = JSON.parse(bytes);
  if (!isDeepStrictEqual(document, contractDocuments[name]))
    throw new Error(`${name} contract differs from its executable decoders`);
  contracts[name] = {
    name: document.name,
    version: document.version,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}
const artifacts = [
  {
    id: "default-tab-model",
    entry: "model-entry",
    name: "Tabs",
    capabilities: ["pages.list", "pages.manage", "storage.local"],
    provides: [{ id: "model", contract: contracts.model }],
  },
  {
    id: "default-tab-pins",
    entry: "pins-entry",
    name: "Pinned tabs",
    capabilities: ["pages.list", "storage.local"],
    provides: [{ id: "pins", contract: contracts.pins }],
  },
  {
    id: "default-browser-layout",
    entry: "layout-entry",
    name: "Browser layout",
    capabilities: ["ui.compose", "configuration.write"],
    provides: [{ id: "layout", contract: contracts.layout }],
  },
  ...["sidebar", "top"].map((placement) => ({
    id: `default-${placement}-tabs`,
    entry: `${placement}-entry`,
    name: placement === "sidebar" ? "Sidebar tabs" : "Top tabs",
    capabilities: [
      "ui.compose",
      "pages.list",
      "pages.manage",
      "storage.local",
      "configuration.write",
    ],
    requires: [
      { id: "model", contract: contracts.model },
      { id: "layout", contract: contracts.layout },
      { id: "pins", contract: contracts.pins, optional: true },
    ],
  })),
];
for (const { entry, ...manifest } of artifacts) {
  const destination = new URL(`${manifest.id}/`, out);
  await mkdir(destination, { recursive: true });
  const result = await build({
    entryPoints: [new URL(`src/${entry}.ts`, directory).pathname],
    plugins: [
      {
        name: "standalone-contracts",
        setup(builder) {
          builder.onLoad(
            { filter: /(?:^|\/)(?:contracts|input-contracts)\.ts$/ },
            async ({ path }) => ({
              contents: compileSchemas(await import(pathToFileURL(path).href)),
              loader: "js",
            }),
          );
        },
      },
    ],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "safari17",
    minify: true,
    banner: { js: "/*! @exodus/schemasafe MIT; see SCHEMASAFE-LICENSE */" },
    write: false,
  });
  const code = result.outputFiles[0].contents;
  if (code.length > 512 * 1024)
    throw new Error(`${manifest.id} exceeds the isolated host code limit`);
  await writeFile(new URL("plugin.js", destination), code);
  await writeFile(new URL("SCHEMASAFE-LICENSE", destination), schemaSafeLicense);
  await writeFile(
    new URL("hitchhiker.plugin.json", destination),
    JSON.stringify({ ...manifest, version: "1.0.0" }, null, 2) + "\n",
  );
  process.stdout.write(`${manifest.id}: ${code.length} bytes\n`);
}
for (const placement of ["sidebar", "top"]) {
  const presenter = `default-${placement}-tabs`;
  const destination = new URL(`${placement}/`, out);
  await mkdir(destination, { recursive: true });
  const composition = {
    layout: "default-browser-layout",
    slots: ["tabs", "toolbar", "content"].map((key) => ({
      key,
      contributions: [{ pluginId: presenter, id: key }],
    })),
  };
  const services = {
    bindings: [
      { consumer: presenter, dependency: "model", provider: "default-tab-model", service: "model" },
      { consumer: presenter, dependency: "pins", provider: "default-tab-pins", service: "pins" },
      {
        consumer: presenter,
        dependency: "layout",
        provider: "default-browser-layout",
        service: "layout",
      },
    ],
  };
  await writeFile(
    new URL("composition.json", destination),
    JSON.stringify(composition, null, 2) + "\n",
  );
  await writeFile(new URL("services.json", destination), JSON.stringify(services, null, 2) + "\n");
}
