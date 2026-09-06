import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const root = new URL("../", import.meta.url);
if (process.platform !== "darwin") {
  throw new Error("Native integration tests require macOS.");
}
for (const name of ["HITCHHIKER_NATIVE_BINARY", "HITCHHIKER_PLUGIN_HOST"]) {
  const executable = process.env[name];
  if (!executable || !isAbsolute(executable)) {
    throw new Error(`${name} must point to an absolute native executable path.`);
  }
  await access(executable, constants.X_OK);
}

// These suites exercise real wall-clock and memory watchdogs. Run one file at a
// time so unrelated browser startups do not consume a fixture's resource budget.
for (const workspace of ["packages/runtime/", "apps/browser/"]) {
  const cwd = new URL(workspace, root);
  const files = (await readdir(new URL("test/", cwd)))
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => `test/${file}`);
  if (files.length === 0) throw new Error(`No integration tests found in ${workspace}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--test", "--test-concurrency=1", "--experimental-strip-types", ...files],
      { cwd, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
