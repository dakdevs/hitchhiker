import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = resolve(
  root,
  "work/host-probe/build/Release/hitchhiker-probe.app/Contents/MacOS/hitchhiker-probe",
);
if (!existsSync(binary))
  throw new Error("Run pnpm --filter @hitchhiker/host-probe build:native first.");
const child = spawn(binary, ["--url=about:blank"], { stdio: "inherit" });
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
