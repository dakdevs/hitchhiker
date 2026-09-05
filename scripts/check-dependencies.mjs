import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const problems = [];
const exact = /^(?:workspace:)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const manifests = [new URL("package.json", root)];
for (const directory of ["apps", "packages"]) {
  const entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true }).catch(
    (error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (entry.isDirectory())
      manifests.push(new URL(join(directory, entry.name, "package.json"), root));
  }
}
for (const file of manifests) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const section of sections) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (typeof version !== "string" || !exact.test(version))
        problems.push(`${manifest.name}: ${name} must use an exact version`);
      if (/biome/i.test(name)) problems.push(`${manifest.name}: use oxlint and oxfmt`);
    }
  }
}
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
if (!/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager))
  problems.push("Pin packageManager to exact pnpm version");
if (!(await readFile(new URL(".npmrc", root), "utf8")).split(/\r?\n/).includes("save-exact=true"))
  problems.push("Missing save-exact=true");
await readFile(new URL("pnpm-lock.yaml", root), "utf8");
if (problems.length) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Exact dependencies verified in ${manifests.length} manifests.\n`);
}
