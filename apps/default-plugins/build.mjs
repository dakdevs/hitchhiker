import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { isDeepStrictEqual } from "node:util";
import { compileSchemas } from "./compile-schemas.mjs";
import { pathToFileURL } from "node:url";
import { contractDocuments } from "./src/contract-documents.ts";

const directory = new URL("./", import.meta.url);
const out = new URL("dist/", directory);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifactIds = [
  "default-tab-model",
  "default-tab-pins",
  "default-browser-layout",
  "default-sidebar-tabs",
  "default-top-tabs",
  "default-devtools",
  "default-extension-management",
];
const placements = ["sidebar", "top"];
const compositionFor = (presenter) => ({
  layout: "default-browser-layout",
  slots: [
    { key: "tabs", contributions: [{ pluginId: presenter, id: "tabs" }] },
    {
      key: "toolbar",
      contributions: [
        { pluginId: presenter, id: "toolbar" },
        { pluginId: "default-devtools", id: "toolbar" },
        { pluginId: "default-extension-management", id: "launcher", optional: true },
      ],
    },
    {
      key: "content",
      route: { fallback: { pluginId: presenter, id: "content" } },
      contributions: [
        { pluginId: presenter, id: "content" },
        { pluginId: presenter, id: "settings", optional: true },
        { pluginId: presenter, id: "plugins", optional: true },
        { pluginId: "default-extension-management", id: "main", optional: true },
      ],
    },
  ],
});

// The index digest deliberately excludes itself. Its canonical representation has no whitespace
// and is generated from fixed-key objects below, so it remains stable across platforms.
const indexDigest = (index) => sha256(JSON.stringify(index));

await rm(out, { recursive: true, force: true });
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
    id: "default-extension-management",
    entry: "extensions-entry",
    name: "Extensions",
    capabilities: [
      "ui.compose",
      "extensions.read",
      "extensions.manage",
      "extensions.install",
      "configuration.read",
    ],
  },
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
    capabilities: ["ui.compose", "configuration.read"],
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
      "configuration.read",
      "configuration.write",
      "plugins.read",
      "plugins.manage",
    ],
    requires: [
      { id: "model", contract: contracts.model },
      { id: "layout", contract: contracts.layout },
      { id: "pins", contract: contracts.pins, optional: true },
    ],
  })),
  {
    id: "default-devtools",
    entry: "devtools-entry",
    name: "Developer tools",
    capabilities: [
      "ui.compose",
      "devtools.manage",
      "pages.list",
      "pages.manage",
      "storage.local",
      "configuration.read",
    ],
    requires: [
      { id: "model", contract: contracts.model },
      { id: "layout", contract: contracts.layout },
    ],
  },
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
  const composition = compositionFor(presenter);
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
      {
        consumer: "default-devtools",
        dependency: "model",
        provider: "default-tab-model",
        service: "model",
      },
      {
        consumer: "default-devtools",
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

const bundleArtifacts = [];
for (const id of artifactIds) {
  const manifest = `${id}/hitchhiker.plugin.json`;
  const code = `${id}/plugin.js`;
  const [manifestBytes, codeBytes] = await Promise.all([
    readFile(new URL(manifest, out)),
    readFile(new URL(code, out)),
  ]);
  const parsedManifest = JSON.parse(manifestBytes);
  if (parsedManifest.id !== id) throw new Error(`Unexpected manifest identity for ${id}`);
  bundleArtifacts.push({
    id,
    manifest,
    code,
    manifestSha256: sha256(manifestBytes),
    codeSha256: sha256(codeBytes),
  });
}
const plans = {};
for (const placement of placements) {
  const composition = `${placement}/composition.json`;
  const services = `${placement}/services.json`;
  const [compositionBytes, servicesBytes] = await Promise.all([
    readFile(new URL(composition, out)),
    readFile(new URL(services, out)),
  ]);
  const presenter = `default-${placement}-tabs`;
  const recipe = JSON.parse(compositionBytes);
  const bindings = JSON.parse(servicesBytes);
  const expectedBindings = [
    [presenter, "model", "default-tab-model", "model"],
    [presenter, "pins", "default-tab-pins", "pins"],
    [presenter, "layout", "default-browser-layout", "layout"],
    ["default-devtools", "model", "default-tab-model", "model"],
    ["default-devtools", "layout", "default-browser-layout", "layout"],
  ];
  if (
    !isDeepStrictEqual(recipe, compositionFor(presenter)) ||
    !Array.isArray(bindings.bindings) ||
    bindings.bindings.length !== expectedBindings.length ||
    !bindings.bindings.every(
      (binding, index) =>
        binding.consumer === expectedBindings[index][0] &&
        binding.dependency === expectedBindings[index][1] &&
        binding.provider === expectedBindings[index][2] &&
        binding.service === expectedBindings[index][3],
    )
  ) {
    throw new Error(`Unexpected ${placement} default plan`);
  }
  plans[placement] = {
    composition,
    compositionSha256: sha256(compositionBytes),
    services,
    servicesSha256: sha256(servicesBytes),
  };
}
const index = { format: 3, artifacts: bundleArtifacts, plans };
await writeFile(
  new URL("bundle.json", out),
  JSON.stringify({ ...index, digest: indexDigest(index) }, null, 2) + "\n",
);
