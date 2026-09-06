import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, "../../..");
const binary = resolve(
  root,
  "work/host-probe/build/Release/hitchhiker-probe.app/Contents/MacOS/hitchhiker-probe",
);
const args = process.argv.slice(2);
if (!existsSync(binary))
  throw new Error("Run pnpm --filter @hitchhiker/host-probe build:native first.");
const fixtures = spawn(process.execPath, [resolve(scripts, "serve-fixtures.mjs")], {
  stdio: ["ignore", "pipe", "inherit"],
});
let child;
let timeout;
let timedOut = false;
const stop = (signal) => {
  child?.kill(signal);
  fixtures.kill(signal);
};
const onInterrupt = () => stop("SIGINT");
const onTerminate = () => stop("SIGTERM");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
try {
  await new Promise((resolveReady, reject) => {
    let output = "";
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const exited = () => failed(new Error("Fixture server exited before browser launch"));
    const data = (chunk) => {
      output += chunk.toString();
      if (output.includes("Host fixtures listening")) {
        cleanup();
        process.stdout.write(output);
        resolveReady();
      }
    };
    const readyTimeout = setTimeout(
      () => failed(new Error("Fixture server did not become ready")),
      5000,
    );
    const cleanup = () => {
      clearTimeout(readyTimeout);
      fixtures.off("error", failed);
      fixtures.off("exit", exited);
      fixtures.stdout.off("data", data);
    };
    fixtures.once("error", failed);
    fixtures.once("exit", exited);
    fixtures.stdout.on("data", data);
  });
  const extension = resolve(root, "apps/host-probe/fixtures/extension");
  child = spawn(binary, [`--load-extension=${extension}`, ...args], { stdio: "inherit" });
  fixtures.once("exit", () => child.kill("SIGTERM"));
  if (args.includes("--self-test")) {
    timeout = setTimeout(() => {
      timedOut = true;
      process.stderr.write("Hitchhiker native smoke test exceeded 30 seconds\n");
      child.kill("SIGTERM");
    }, 30000);
  }
  await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      process.exitCode = timedOut ? 1 : (code ?? 1);
      resolveExit();
    });
  });
} finally {
  clearTimeout(timeout);
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  fixtures.kill("SIGTERM");
}
