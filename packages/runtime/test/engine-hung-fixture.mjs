#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const profileRoot = process.argv
  .find((argument) => argument.startsWith("--profile-root="))
  ?.slice("--profile-root=".length);

if (!profileRoot) throw new Error("missing profile root");

process.on("SIGTERM", () => {});
writeFileSync(join(profileRoot, "hung-engine-started"), "ready");
setInterval(() => {}, 1_000);
