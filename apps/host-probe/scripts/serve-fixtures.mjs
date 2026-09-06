import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(scriptDirectory, "../fixtures");
const port = 4319;
const fixtures = new Map([
  ["/one", { file: "one.html", type: "text/html; charset=utf-8" }],
  ["/two", { file: "two.html", type: "text/html; charset=utf-8" }],
  ["/fixture.js", { file: "fixture.js", type: "text/javascript; charset=utf-8" }],
]);

const server = createServer(async (request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  const fixture = fixtures.get(path);
  if (!fixture || request.method !== "GET") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Fixture not found.\n");
    return;
  }
  try {
    const body = await readFile(resolve(fixtureDirectory, fixture.file));
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": fixture.type,
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Fixture unavailable.\n");
  }
});

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Host fixtures listening at http://127.0.0.1:${port}\n`);
});
