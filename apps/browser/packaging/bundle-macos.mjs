import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const nodeVersion = "24.19.0";
const pnpmVersion = "11.24.0";
const nodeArchiveName = `node-v${nodeVersion}-darwin-arm64.tar.xz`;
const nodeArchiveSha256 = "3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94";
const nodeArchiveUrl = `https://nodejs.org/download/release/v${nodeVersion}/${nodeArchiveName}`;
const nativeCommit = "5665a355cae768dff734d79dd4c0bd9d099f83fb";
const cefVersion = "144.0.6+g5f7e671+chromium-144.0.7559.59";

const packaging = dirname(fileURLToPath(import.meta.url));
const root = resolve(packaging, "../../..");
const work = join(root, "work");
const argument = (name) => {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
};
const output = resolve(
  argument("--output") ?? join(work, "package/Hitchhiker Developer/Hitchhiker.app"),
);
const showHelp = process.argv.includes("--help");
const verifyOnly = process.argv.includes("--verify-only");
const skipBuild = process.argv.includes("--skip-build");
const nativeSource = resolve(
  argument("--native-source") ?? process.env.NATIVE_SDK_SOURCE ?? join(work, "native-sdk"),
);
const cefRoot = resolve(argument("--cef-root") ?? process.env.CEF_ROOT ?? join(work, "cef"));
const hostApp = join(work, "host-probe/build/Release/hitchhiker-probe.app");
const pluginApp = join(work, "plugin-host/build/PluginHost.app");
const downloads = join(work, "downloads");
const nodeArchive = join(downloads, nodeArchiveName);
const nodeRoot = join(work, "toolchains", `node-v${nodeVersion}-darwin-arm64`);
const nodeBinary = join(nodeRoot, "bin/node");
const corepack = join(nodeRoot, "lib/node_modules/corepack/dist/corepack.js");
const isolatedWorkspace = join(work, "package-staging/workspace");
const controllerStage = join(work, "package-staging/controller");
const defaultPluginBundle = join(root, "apps/default-plugins/dist");
const defaultArtifactIds = [
  "default-tab-model",
  "default-tab-pins",
  "default-browser-layout",
  "default-sidebar-tabs",
  "default-top-tabs",
];
const defaultPlacements = ["sidebar", "top"];

const fail = (message) => {
  throw new Error(message);
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    fail(`${command} failed with status ${result.status}${detail}`);
  }
  return result.stdout?.trim() ?? "";
};

const sha256File = (path) => {
  const hash = createHash("sha256");
  const descriptor = readFileSync(path);
  hash.update(descriptor);
  return hash.digest("hex");
};

const sha256FileContents = (contents) => createHash("sha256").update(contents).digest("hex");

const requireDirectory = (path, description) => {
  if (!existsSync(path) || !statSync(path).isDirectory())
    fail(`${description} is missing at ${path}`);
};

const requireFile = (path, description) => {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`${description} is missing at ${path}`);
};

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

const isSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const isDefaultPlan = (placement, composition, services) => {
  const presenter = `default-${placement}-tabs`;
  const expectedBindings = [
    ["model", "default-tab-model", "model"],
    ["pins", "default-tab-pins", "pins"],
    ["layout", "default-browser-layout", "layout"],
  ];
  return (
    exactKeys(composition, ["layout", "slots"]) &&
    composition.layout === "default-browser-layout" &&
    Array.isArray(composition.slots) &&
    composition.slots.length === 3 &&
    composition.slots.every(
      (slot, index) =>
        exactKeys(slot, ["key", "contributions"]) &&
        slot.key === ["tabs", "toolbar", "content"][index] &&
        Array.isArray(slot.contributions) &&
        slot.contributions.length === 1 &&
        exactKeys(slot.contributions[0], ["pluginId", "id"]) &&
        slot.contributions[0].pluginId === presenter &&
        slot.contributions[0].id === slot.key,
    ) &&
    exactKeys(services, ["bindings"]) &&
    Array.isArray(services.bindings) &&
    services.bindings.length === expectedBindings.length &&
    services.bindings.every(
      (binding, index) =>
        exactKeys(binding, ["consumer", "dependency", "provider", "service"]) &&
        binding.consumer === presenter &&
        binding.dependency === expectedBindings[index][0] &&
        binding.provider === expectedBindings[index][1] &&
        binding.service === expectedBindings[index][2],
    )
  );
};

/**
 * The bundle index names only this fixed, trusted inventory. Never use a path supplied by a
 * plugin manifest to find a file: index paths are part of the signed application payload.
 */
const validateDefaultPluginBundle = (directory) => {
  requireDirectory(directory, "Default plugin bundle");
  if (lstatSync(directory).isSymbolicLink()) fail("Default plugin bundle must not be a symlink");
  const readRegular = (relativePath, description) => {
    const path = join(directory, relativePath);
    if (!path.startsWith(`${directory}${sep}`)) fail(`Invalid ${description} path`);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
      fail(`${description} must be a regular file`);
    }
    return readFileSync(path);
  };
  const indexBytes = readRegular("bundle.json", "Default plugin index");
  let index;
  try {
    index = JSON.parse(indexBytes);
  } catch {
    fail("Default plugin index is not valid JSON");
  }
  if (!exactKeys(index, ["format", "artifacts", "plans", "digest"]) || index.format !== 1) {
    fail("Default plugin index has an invalid schema");
  }
  const unsigned = { format: index.format, artifacts: index.artifacts, plans: index.plans };
  if (
    !isSha256(index.digest) ||
    sha256FileContents(Buffer.from(JSON.stringify(unsigned))) !== index.digest
  ) {
    fail("Default plugin index digest does not match its contents");
  }
  if (!Array.isArray(index.artifacts) || index.artifacts.length !== defaultArtifactIds.length) {
    fail("Default plugin index does not contain the five required artifacts");
  }
  for (const [position, id] of defaultArtifactIds.entries()) {
    const artifact = index.artifacts[position];
    const manifest = `${id}/hitchhiker.plugin.json`;
    const code = `${id}/plugin.js`;
    if (
      !exactKeys(artifact, ["id", "manifest", "code", "manifestSha256", "codeSha256"]) ||
      artifact.id !== id ||
      artifact.manifest !== manifest ||
      artifact.code !== code ||
      !isSha256(artifact.manifestSha256) ||
      !isSha256(artifact.codeSha256)
    ) {
      fail(`Default plugin index has an invalid ${id} artifact`);
    }
    const manifestBytes = readRegular(manifest, `${id} manifest`);
    const codeBytes = readRegular(code, `${id} code`);
    if (
      sha256FileContents(manifestBytes) !== artifact.manifestSha256 ||
      sha256FileContents(codeBytes) !== artifact.codeSha256
    ) {
      fail(`Default plugin index hash mismatch for ${id}`);
    }
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(manifestBytes);
    } catch {
      fail(`Default plugin ${id} manifest is not valid JSON`);
    }
    if (parsedManifest.id !== id) fail(`Default plugin manifest identity mismatch for ${id}`);
  }
  if (!exactKeys(index.plans, defaultPlacements))
    fail("Default plugin plans have an invalid schema");
  for (const placement of defaultPlacements) {
    const plan = index.plans[placement];
    const composition = `${placement}/composition.json`;
    const services = `${placement}/services.json`;
    if (
      !exactKeys(plan, ["composition", "compositionSha256", "services", "servicesSha256"]) ||
      plan.composition !== composition ||
      plan.services !== services ||
      !isSha256(plan.compositionSha256) ||
      !isSha256(plan.servicesSha256)
    ) {
      fail(`Default plugin ${placement} plan is invalid`);
    }
    const compositionBytes = readRegular(composition, `${placement} composition`);
    const servicesBytes = readRegular(services, `${placement} services`);
    if (
      sha256FileContents(compositionBytes) !== plan.compositionSha256 ||
      sha256FileContents(servicesBytes) !== plan.servicesSha256
    ) {
      fail(`Default plugin index hash mismatch for ${placement} plan`);
    }
    try {
      if (!isDefaultPlan(placement, JSON.parse(compositionBytes), JSON.parse(servicesBytes))) {
        fail(`Default plugin ${placement} recipe does not match the fixed plan`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Default plugin")) throw error;
      fail(`Default plugin ${placement} recipe is not valid JSON`);
    }
  }
};

const safeRemove = (path) => {
  const resolved = resolve(path);
  const allowedRoots = [resolve(work), resolve("/tmp")];
  if (!allowedRoots.some((allowed) => resolved.startsWith(`${allowed}${sep}`))) {
    fail(`Refusing to remove a path outside work or /tmp: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
};

const downloadNode = async () => {
  mkdirSync(downloads, { recursive: true });
  if (!existsSync(nodeArchive) || sha256File(nodeArchive) !== nodeArchiveSha256) {
    const partial = `${nodeArchive}.partial`;
    safeRemove(partial);
    const response = await fetch(nodeArchiveUrl);
    if (!response.ok || !response.body) fail(`Node download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }));
    if (sha256File(partial) !== nodeArchiveSha256)
      fail("Downloaded Node archive checksum mismatch");
    renameSync(partial, nodeArchive);
  }
  if (sha256File(nodeArchive) !== nodeArchiveSha256) fail("Cached Node archive checksum mismatch");
  if (
    !existsSync(nodeBinary) ||
    run(nodeBinary, ["--version"], { capture: true }) !== `v${nodeVersion}`
  ) {
    safeRemove(nodeRoot);
    mkdirSync(dirname(nodeRoot), { recursive: true });
    run("/usr/bin/tar", ["-xJf", nodeArchive, "-C", dirname(nodeRoot)]);
  }
  if (run(nodeBinary, ["--version"], { capture: true }) !== `v${nodeVersion}`) {
    fail(`Extracted Node is not ${nodeVersion}`);
  }
  if (run(nodeBinary, [corepack, "pnpm", "--version"], { capture: true }) !== pnpmVersion) {
    fail(`Corepack did not resolve pnpm ${pnpmVersion}`);
  }
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", nodeBinary]);
};

const buildEnvironment = () => ({
  ...process.env,
  PATH: `${join(nodeRoot, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  NATIVE_SDK_SOURCE: nativeSource,
  CEF_ROOT: cefRoot,
  HITCHHIKER_CODESIGN_IDENTITY: "-",
});

const validateInputs = () => {
  requireDirectory(nativeSource, "Pinned Native source");
  requireDirectory(cefRoot, "Pinned CEF source");
  if (
    run("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: nativeSource, capture: true }) !==
    nativeCommit
  ) {
    fail(`Native source must be pinned to ${nativeCommit}`);
  }
  if (run("/usr/bin/git", ["status", "--porcelain"], { cwd: nativeSource, capture: true }) !== "") {
    fail("Native source must be clean");
  }
  const cefHeader = readFileSync(join(cefRoot, "include/cef_version.h"), "utf8");
  if (!cefHeader.includes(`#define CEF_VERSION "${cefVersion}"`)) {
    fail(`CEF source must be ${cefVersion}`);
  }
};

const buildInputs = () => {
  const environment = buildEnvironment();
  run(nodeBinary, [join(root, "apps/plugin-host/scripts/build.mjs")], { env: environment });
  run(nodeBinary, [join(root, "apps/host-probe/scripts/build.mjs")], { env: environment });
};

const buildDefaultPluginBundle = () => {
  run(nodeBinary, [join(root, "apps/default-plugins/build.mjs")], { env: buildEnvironment() });
  validateDefaultPluginBundle(defaultPluginBundle);
};

const prepareIsolatedWorkspace = () => {
  safeRemove(isolatedWorkspace);
  mkdirSync(isolatedWorkspace, { recursive: true });
  for (const file of [".npmrc", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    copyFileSync(join(root, file), join(isolatedWorkspace, file));
  }

  const selectedPackages = [
    "apps/browser",
    "packages/core",
    "packages/default-interface",
    "packages/runtime",
    "packages/ui",
  ];
  for (const packagePath of selectedPackages) {
    const source = join(root, packagePath);
    cpSync(source, join(isolatedWorkspace, packagePath), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => {
        const segments = relative(source, path).split(sep);
        return !segments.includes("node_modules") && !segments.includes(".turbo");
      },
    });
  }

  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const manifest = join(root, group, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const destination = join(isolatedWorkspace, group, entry.name, "package.json");
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(manifest, destination);
    }
  }
};

const deployController = (build) => {
  safeRemove(controllerStage);
  mkdirSync(dirname(controllerStage), { recursive: true });
  prepareIsolatedWorkspace();
  run(
    nodeBinary,
    [
      corepack,
      "pnpm",
      "install",
      "--filter",
      "@hitchhiker/browser...",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    { cwd: isolatedWorkspace, env: buildEnvironment() },
  );
  if (build) {
    run(nodeBinary, [corepack, "pnpm", "--filter", "@hitchhiker/browser...", "build"], {
      cwd: isolatedWorkspace,
      env: buildEnvironment(),
    });
  }
  run(
    nodeBinary,
    [
      corepack,
      "pnpm",
      "--filter",
      "@hitchhiker/browser",
      "deploy",
      "--prod",
      "--legacy",
      controllerStage,
    ],
    { cwd: isolatedWorkspace, env: buildEnvironment() },
  );
  requireFile(join(controllerStage, "dist/main.js"), "Deployed browser controller");
  assertContainedSymlinks(controllerStage);
};

const within = (parent, child) => {
  const path = relative(realpathSync(parent), realpathSync(child));
  return path === "" || (!path.startsWith("..") && !path.startsWith(sep));
};

const assertContainedSymlinks = (directory) => {
  const sourcePackages = [join(root, "apps/browser"), join(isolatedWorkspace, "apps/browser")]
    .filter(existsSync)
    .map((path) => realpathSync(path));
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        let target = resolve(dirname(child), readlinkSync(child));
        if (existsSync(target) && sourcePackages.includes(realpathSync(target))) {
          rmSync(child);
          symlinkSync(relative(dirname(child), directory), child);
          target = directory;
        }
        if (!existsSync(target) || !within(directory, target)) {
          fail(`Deployed controller symlink escapes its package: ${relative(directory, child)}`);
        }
      } else if (entry.isDirectory()) visit(child);
    }
  };
  visit(directory);
};

const rewriteBundleIdentity = (bundle, identifier) => {
  const plist = join(bundle, "Contents/Info.plist");
  run("/usr/bin/plutil", ["-replace", "CFBundleIdentifier", "-string", identifier, plist]);
  run("/usr/bin/plutil", ["-replace", "CFBundleShortVersionString", "-string", "0.1.0", plist]);
  run("/usr/bin/plutil", ["-replace", "CFBundleVersion", "-string", "1", plist]);
};

const isMachO = (path) => {
  if (!lstatSync(path).isFile()) return false;
  const bytes = readFileSync(path).subarray(0, 4);
  if (bytes.length !== 4) return false;
  const magic = bytes.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
};

const collect = (directory, predicate) => {
  const result = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(child);
        if (predicate(child, true)) result.push(child);
      } else if (predicate(child, false)) result.push(child);
    }
  };
  visit(directory);
  return result;
};

const signCode = (path) => run("/usr/bin/codesign", ["--force", "--sign", "-", path]);

const signCefPayload = (bundle, engine) => {
  const frameworks = join(bundle, "Contents/Frameworks");
  const binaries = collect(frameworks, (path, directory) => !directory && isMachO(path));
  binaries.sort((left, right) => right.length - left.length);
  for (const binary of binaries) signCode(binary);
  const bundles = collect(
    frameworks,
    (path, directory) => directory && (path.endsWith(".framework") || path.endsWith(".app")),
  );
  bundles.sort((left, right) => right.length - left.length);
  for (const nestedBundle of bundles) signCode(nestedBundle);
  signCode(engine);
};

const stageCleanCefFramework = (engine) => {
  const source = join(cefRoot, "Release/Chromium Embedded Framework.framework");
  requireDirectory(source, "CEF release framework");
  const framework = join(engine, "Contents/Frameworks/Chromium Embedded Framework.framework");
  safeRemove(framework);
  const version = join(framework, "Versions/A");
  mkdirSync(dirname(version), { recursive: true });
  cpSync(source, version, { recursive: true, verbatimSymlinks: true });
  symlinkSync("A", join(framework, "Versions/Current"));
  symlinkSync(
    "Versions/A/Chromium Embedded Framework",
    join(framework, "Chromium Embedded Framework"),
  );
  symlinkSync("Versions/A/Libraries", join(framework, "Libraries"));
  symlinkSync("Versions/A/Resources", join(framework, "Resources"));
};

const assertCefSandboxBuild = () => {
  const cachePath = join(work, "host-probe/build/CMakeCache.txt");
  requireFile(cachePath, "CEF host CMake cache");
  if (!readFileSync(cachePath, "utf8").includes("USE_SANDBOX:BOOL=ON")) {
    fail("CEF host was not configured with sandbox support");
  }
};

const writeInputManifest = (resources) => {
  const status = run("/usr/bin/git", ["status", "--porcelain"], { capture: true });
  const manifest = {
    format: 1,
    product: "Hitchhiker developer bundle",
    version: "0.1.0",
    architecture: "arm64",
    minimumMacOS: "14.0",
    signing: "ad-hoc developer",
    notarized: false,
    source: {
      revision: run("/usr/bin/git", ["rev-parse", "HEAD"], { capture: true }),
      dirty: status.length > 0,
      lockfileSha256: sha256File(join(root, "pnpm-lock.yaml")),
    },
    node: { version: nodeVersion, archive: nodeArchiveName, sha256: nodeArchiveSha256 },
    pnpm: pnpmVersion,
    native: { revision: nativeCommit },
    cef: { version: cefVersion, sandbox: true },
  };
  writeFileSync(join(resources, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
};

const stageBundle = () => {
  requireDirectory(hostApp, "Built CEF host app");
  requireDirectory(pluginApp, "Built PluginHost app");
  assertCefSandboxBuild();
  safeRemove(output);
  cpSync(hostApp, output, { recursive: true, verbatimSymlinks: true });
  const contents = join(output, "Contents");
  const macOS = join(contents, "MacOS");
  const helpers = join(contents, "Helpers");
  const resources = join(contents, "Resources");
  mkdirSync(helpers, { recursive: true });

  const engine = join(macOS, "hitchhiker-probe");
  const plugin = join(helpers, "PluginHost.app");
  stageCleanCefFramework(output);
  copyFileSync(join(packaging, "Info.plist"), join(contents, "Info.plist"));
  cpSync(pluginApp, plugin, { recursive: true, verbatimSymlinks: true });
  copyFileSync(nodeBinary, join(helpers, "node"));
  chmodSync(join(helpers, "node"), 0o755);
  cpSync(controllerStage, join(resources, "controller"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  assertContainedSymlinks(join(resources, "controller"));
  validateDefaultPluginBundle(defaultPluginBundle);
  cpSync(defaultPluginBundle, join(resources, "default-plugins"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  validateDefaultPluginBundle(join(resources, "default-plugins"));

  const licenses = join(resources, "licenses");
  mkdirSync(licenses, { recursive: true });
  copyFileSync(join(root, "LICENSE"), join(licenses, "Hitchhiker-LICENSE"));
  copyFileSync(join(nodeRoot, "LICENSE"), join(licenses, "Node-LICENSE"));
  copyFileSync(join(root, "apps/host-probe/LICENSE-CEF.txt"), join(licenses, "CEF-LICENSE"));
  copyFileSync(join(nativeSource, "LICENSE"), join(licenses, "Native-LICENSE"));
  copyFileSync(join(resources, "cefsimple.icns"), join(resources, "Hitchhiker.icns"));

  const helperApps = readdirSync(join(contents, "Frameworks"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(contents, "Frameworks", entry.name));
  for (const [index, helper] of helperApps.sort().entries()) {
    const suffix = helper.match(/\(([^)]+)\)/)?.[1]?.replaceAll(/[^A-Za-z0-9]/g, "") ?? "Main";
    rewriteBundleIdentity(helper, `dev.hitchhiker.Engine.Helper.${suffix}.${index + 1}`);
  }

  const launcher = join(macOS, "Hitchhiker");
  run("/usr/bin/xcrun", [
    "clang",
    "-arch",
    "arm64",
    "-mmacosx-version-min=14.0",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(packaging, "launcher.c"),
    "-o",
    launcher,
  ]);
  assertContainedSymlinks(output);
  writeInputManifest(resources);

  signCefPayload(output, engine);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", plugin]);
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", join(helpers, "node")]);
  signCode(launcher);
  signCode(output);
};

const finalFileManifest = (bundle) => {
  const files = collect(bundle, (_path, directory) => !directory)
    .map((path) => ({
      path: relative(bundle, path),
      bytes: statSync(path).size,
      sha256: sha256File(path),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const symlinks = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push({ path: relative(bundle, child), target: readlinkSync(child) });
      } else if (entry.isDirectory()) visit(child);
    }
  };
  visit(bundle);
  symlinks.sort((left, right) => left.path.localeCompare(right.path));
  const destination = join(dirname(bundle), "Hitchhiker.app.manifest.json");
  writeFileSync(destination, `${JSON.stringify({ format: 1, files, symlinks }, null, 2)}\n`);
  return destination;
};

const verifyBundle = (bundle) => {
  requireDirectory(bundle, "Hitchhiker app bundle");
  const contents = join(bundle, "Contents");
  const launcher = join(contents, "MacOS/Hitchhiker");
  const engine = join(contents, "MacOS/hitchhiker-probe");
  const plugin = join(contents, "Helpers/PluginHost.app");
  const bundledNode = join(contents, "Helpers/node");
  const controller = join(contents, "Resources/controller/dist/controller.js");
  const defaultPlugins = join(contents, "Resources/default-plugins");
  const manifestPath = join(contents, "Resources/build-manifest.json");
  for (const code of [plugin, bundle]) {
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", code]);
  }
  for (const code of [engine, bundledNode, launcher]) {
    run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", code]);
  }
  if (run(bundledNode, ["--version"], { capture: true }) !== `v${nodeVersion}`) {
    fail("Bundled Node version mismatch");
  }
  requireFile(manifestPath, "Bundle input manifest");
  validateDefaultPluginBundle(defaultPlugins);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.node?.version !== nodeVersion ||
    manifest.pnpm !== pnpmVersion ||
    manifest.native?.revision !== nativeCommit ||
    manifest.cef?.version !== cefVersion ||
    manifest.cef?.sandbox !== true
  ) {
    fail("Bundle input manifest does not match the pinned toolchain or sandbox policy");
  }
  run(
    bundledNode,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(controller).href)})`,
    ],
    { capture: true },
  );
  const help = run(launcher, ["--help"], { capture: true });
  if (!help.includes("Hitchhiker developer bundle")) fail("Relocated launcher help failed");
};

const unknownArguments = process.argv
  .slice(2)
  .filter(
    (value) =>
      !["--", "--help", "--skip-build", "--verify-only"].includes(value) &&
      !["--output=", "--native-source=", "--cef-root="].some((prefix) => value.startsWith(prefix)),
  );
if (unknownArguments.length > 0) fail(`Unknown argument: ${unknownArguments[0]}`);
if (showHelp) {
  console.log(`Build an Apple Silicon Hitchhiker developer app.
Usage: pnpm bundle:macos [-- --skip-build] [--output=/path/Hitchhiker.app]
       node apps/browser/packaging/bundle-macos.mjs --verify-only --output=/path/Hitchhiker.app

Options:
  --native-source=/path  Native checkout pinned to ${nativeCommit}
  --cef-root=/path       CEF ${cefVersion} binary distribution
  --skip-build           Reuse native outputs and TypeScript dist files
  --verify-only          Verify an existing bundle without build inputs
`);
  process.exit(0);
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("Hitchhiker developer bundling currently requires Apple Silicon macOS");
}
if (!output.endsWith(".app")) fail("--output must name an .app bundle");

if (verifyOnly) {
  verifyBundle(output);
  console.log(`Verified ${output}`);
} else {
  await downloadNode();
  validateInputs();
  if (!skipBuild) buildInputs();
  buildDefaultPluginBundle();
  deployController(!skipBuild);
  stageBundle();
  verifyBundle(output);
  const manifest = finalFileManifest(output);
  console.log(`Built and verified ${output}`);
  console.log(`File manifest: ${manifest}`);
}
