import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const stage = option("stage") ?? "before";
if (!option("cef") || !option("chromium") || !["before", "after"].includes(stage)) {
  throw new Error(
    "Usage: node verify.mjs --cef=/path/to/cef --chromium=/path/to/src [--stage=before|after]",
  );
}
const roots = { cef: await realpath(option("cef")), chromium: await realpath(option("chromium")) };
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [file, expected] of Object.entries(manifest.patches)) {
  if (hash(await readFile(join(directory, file))) !== expected)
    throw new Error(`Patch checksum mismatch: ${file}`);
}
for (const [file, expected] of Object.entries(manifest.files)) {
  const [kind, ...parts] = file.split("/");
  if (hash(await readFile(join(roots[kind], ...parts))) !== expected[stage])
    throw new Error(`Source checksum mismatch (${stage}): ${file}`);
}
for (const kind of ["cef", "chromium"]) {
  execFileSync(
    "git",
    [
      "apply",
      "--check",
      ...(stage === "after" ? ["--reverse"] : []),
      join(directory, `${kind}-guarded-discard.patch`),
    ],
    { cwd: roots[kind], stdio: "pipe" },
  );
}
console.log(
  `Verified ${stage} source checksums and patch application for ${Object.keys(manifest.files).length} files. This does not verify compilation or runtime behavior.`,
);
