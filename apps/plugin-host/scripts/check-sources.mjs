import { accessSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const path of [
  "src/client.m",
  "src/broker.m",
  "src/worker.m",
  "mac/App-Info.plist",
  "mac/Service-Info.plist",
  "mac/service.entitlements",
  "mac/worker.entitlements",
]) {
  accessSync(resolve(app, path));
}
