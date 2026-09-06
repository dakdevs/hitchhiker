#!/usr/bin/env node
import { createInterface } from "node:readline";
import { closeSync, writeSync } from "node:fs";
import { Socket } from "node:net";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
send({
  event: "host.ready",
  params: { version: 1, windowClientBounds: { x: 0, y: 0, width: 1000, height: 700 } },
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "error")
    return send({ id, error: { code: -32602, message: "Fixture rejection" } });
  if (method === "never") return;
  if (method === "burst") {
    for (let index = 0; index < 40; index++) send({ event: "fixture.event", params: { index } });
    return send({ id, result: {} });
  }
  if (method === "malformed") return process.stdout.write("{broken}\n");
  if (method === "close-cdp") {
    send({ id, result: {} });
    closeSync(4);
    return;
  }
  if (method === "exit") return process.exit(0);
  if (method === "window.close") {
    send({ id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }
  send({ id, result: params });
});
let raw = "";
new Socket({ fd: 3, readable: true, writable: false }).on("data", (chunk) => {
  raw += chunk.toString();
  for (;;) {
    const end = raw.indexOf("\0");
    if (end < 0) break;
    const message = JSON.parse(raw.slice(0, end));
    raw = raw.slice(end + 1);
    writeSync(4, `${JSON.stringify({ id: message.id, result: { product: "Fixture/1.0" } })}\0`);
  }
});
