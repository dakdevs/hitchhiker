import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(app, "../..");
const work = join(root, "work/host-probe");
const cef = resolve(process.env.CEF_ROOT ?? join(root, "work/cef"));
const native = resolve(process.env.NATIVE_SDK_SOURCE ?? join(root, "work/native-sdk"));
const zig = process.env.ZIG ?? join(homedir(), ".native/toolchains/zig-0.16.0/zig");
const localCmake = join(root, "work/build-tools/bin/cmake");
const cmake = process.env.CMAKE ?? (existsSync(localCmake) ? localCmake : "cmake");
const run = (command, args, cwd = work, capture = false) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout?.trim();
};

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The current host probe requires Apple Silicon macOS.");
}
mkdirSync(work, { recursive: true });
if (
  !readFileSync(join(cef, "include/cef_version.h"), "utf8").includes(
    'CEF_VERSION "144.0.6+g5f7e671+chromium-144.0.7559.59"',
  )
) {
  throw new Error("CEF_ROOT must contain the pinned CEF 144.0.6 distribution.");
}
if (
  run("git", ["rev-parse", "HEAD"], native, true) !== "5665a355cae768dff734d79dd4c0bd9d099f83fb"
) {
  throw new Error("NATIVE_SDK_SOURCE must be at the documented Native commit.");
}
if (run("git", ["status", "--porcelain"], native, true) !== "") {
  throw new Error("NATIVE_SDK_SOURCE must be clean, with no local source changes.");
}
if (run(zig, ["version"], work, true) !== "0.16.0") throw new Error("Zig 0.16.0 is required.");
const surface = join(work, "native");
rmSync(surface, { recursive: true, force: true });
mkdirSync(surface, { recursive: true });
cpSync(join(app, "native"), surface, { recursive: true });
writeFileSync(
  join(surface, "build.zig.zon"),
  `.{
  .name = .mobile_canvas,
  .fingerprint = 0xdabb871273e3dcbe,
  .version = "0.1.0",
  .minimum_zig_version = "0.16.0",
  .dependencies = .{ .native_sdk = .{ .path = ${JSON.stringify(relative(surface, native))} } },
  .paths = .{ "build.zig", "build.zig.zon", "src" },
}
`,
);
run(zig, ["build", "lib", "-Doptimize=ReleaseFast"], surface);

// Apple ld requires aligned archive members. Repackage Zig's object with Apple's libtool.
const objects = join(surface, "objects");
mkdirSync(objects, { recursive: true });
run("ar", ["-x", join(surface, "zig-out/lib/libhitchhiker-surface.a")], objects);
const objectPaths = readdirSync(objects)
  .filter((name) => name.endsWith(".o"))
  .map((name) => join(objects, name));
if (objectPaths.length !== 1) throw new Error("Unexpected Native archive object count.");
for (const path of objectPaths) chmodSync(path, 0o600);
const library = join(surface, "zig-out/lib/libhitchhiker-surface-darwin.a");
run("xcrun", ["libtool", "-static", "-o", library, ...objectPaths]);
const build = join(work, "build");
run(cmake, [
  "-S",
  app,
  "-B",
  build,
  "-DCMAKE_BUILD_TYPE=Release",
  `-DCEF_ROOT=${cef}`,
  `-DNATIVE_SURFACE_LIBRARY=${library}`,
]);
run(cmake, ["--build", build, "--target", "libcef_dll_wrapper", "--parallel", "8"]);
// Serializing the resource step avoids the post-link wait observed with Make's parallel jobserver.
run(cmake, ["--build", build, "--target", "hitchhiker-probe", "--parallel", "1"]);
console.log(`Built ${join(build, "Release/hitchhiker-probe.app")}`);
