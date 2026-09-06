import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(app, "../..");
const output = resolve(root, "work/plugin-host/build/PluginHost.app");
const contents = resolve(output, "Contents");
const service = resolve(contents, "XPCServices/PluginBroker.xpc");
const serviceMacOS = resolve(service, "Contents/MacOS");
const identity = process.env.HITCHHIKER_CODESIGN_IDENTITY ?? "-";
const testing = process.env.HITCHHIKER_PLUGIN_HOST_TESTING === "1";

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
};

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("plugin-host build:native requires Apple Silicon macOS");
}

rmSync(output, { recursive: true, force: true });
mkdirSync(resolve(contents, "MacOS"), { recursive: true });
mkdirSync(serviceMacOS, { recursive: true });
cpSync(resolve(app, "mac/App-Info.plist"), resolve(contents, "Info.plist"));
cpSync(resolve(app, "mac/Service-Info.plist"), resolve(service, "Contents/Info.plist"));

const compile = (source, destination, frameworks = [], extra = []) =>
  run("xcrun", [
    "clang",
    "-arch",
    "arm64",
    "-mmacosx-version-min=14.0",
    "-fobjc-arc",
    "-fblocks",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...extra,
    ...frameworks.flatMap((framework) => ["-framework", framework]),
    resolve(app, source),
    "-o",
    destination,
  ]);

compile("src/client.m", resolve(contents, "MacOS/plugin-host"), ["Foundation"]);
compile("src/broker.m", resolve(serviceMacOS, "plugin-broker"), ["Foundation"]);
compile(
  "src/worker.m",
  resolve(serviceMacOS, "plugin-worker"),
  ["Foundation", "JavaScriptCore"],
  testing ? ["-DPLUGIN_HOST_TESTING=1"] : [],
);
if (
  !testing &&
  readFileSync(resolve(serviceMacOS, "plugin-worker")).includes(
    Buffer.from("hitchhiker-plugin-host-deny-fixture"),
  )
) {
  throw new Error("Production worker contains the integration-test isolation probe");
}

const sign = (target, identifier, entitlements) => {
  const args = ["--force", "--sign", identity, "--identifier", identifier, "--options", "runtime"];
  if (identity !== "-") args.push("--timestamp");
  if (entitlements) args.push("--entitlements", resolve(app, entitlements));
  args.push(target);
  run("codesign", args);
};

sign(
  resolve(serviceMacOS, "plugin-worker"),
  "dev.hitchhiker.PluginHost.Broker.Worker",
  "mac/worker.entitlements",
);
sign(service, "dev.hitchhiker.PluginHost.Broker", "mac/service.entitlements");
sign(output, "dev.hitchhiker.PluginHost");
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", output]);
console.log(`Built ${output}`);
