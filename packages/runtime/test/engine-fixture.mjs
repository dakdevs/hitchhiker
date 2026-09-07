#!/usr/bin/env node
import { createInterface } from "node:readline";
import { closeSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { basename } from "node:path";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
send({
  event: "host.ready",
  params: {
    version: 1,
    args: process.argv.slice(2),
    windowClientBounds: { x: 0, y: 0, width: 1000, height: 700 },
  },
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "error")
    return send({ id, error: { code: -32602, message: "Fixture rejection" } });
  if (method === "never") return;
  if (method === "ui.commit") return send({ event: "ui.received", params: {} });
  if (method === "burst") {
    for (let index = 0; index < 40; index++) send({ event: "fixture.event", params: { index } });
    return send({ id, result: {} });
  }
  if (method === "burst-exit") {
    for (let index = 0; index < 40; index++) send({ event: "fixture.event", params: { index } });
    return process.stdout.write("", () => process.exit(0));
  }
  if (method === "close-cdp-burst-exit") {
    closeSync(4);
    for (let index = 0; index < 4; index++) send({ event: "fixture.event", params: { index } });
    return process.stdout.write("", () => process.exit(0));
  }
  if (method === "exit-one") return process.exit(1);
  if (method === "partial-exit")
    return process.stdout.write('{"event":"fixture.partial"', () => process.exit(0));
  if (method === "close-stdout-hang") {
    process.on("SIGTERM", () => {});
    closeSync(1);
    return setInterval(() => {}, 1_000);
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
let heldRequests = 0;
const concurrentDetaches = new Set();
const extensionId = "a".repeat(32);
const replyCdp = (message) => writeSync(4, `${JSON.stringify(message)}\0`);
new Socket({ fd: 3, readable: true, writable: false }).on("data", (chunk) => {
  raw += chunk.toString();
  for (;;) {
    const end = raw.indexOf("\0");
    if (end < 0) break;
    const message = JSON.parse(raw.slice(0, end));
    raw = raw.slice(end + 1);
    if (message.method === "Target.attachToTarget") {
      if (message.params.targetId === "attach-never") continue;
      const sessionId = `session-${message.params.targetId}`;
      const reply = { id: message.id, result: { sessionId } };
      let event = {
        method: "Runtime.executionContextCreated",
        params: { targetId: message.params.targetId },
        sessionId,
      };
      if (message.params.targetId === "attach-malformed") replyCdp({ id: message.id, result: {} });
      else if (["overflow-attach33", "pre-reply-overflow"].includes(message.params.targetId)) {
        const events = Array.from({ length: 33 }, (_, index) => ({
          method: "Runtime.fixture",
          params: { index },
          sessionId,
        }));
        const eventBytes = events.map((item) => `${JSON.stringify(item)}\0`).join("");
        const replyBytes = `${JSON.stringify(reply)}\0`;
        writeSync(
          4,
          message.params.targetId === "pre-reply-overflow"
            ? eventBytes + replyBytes
            : replyBytes + eventBytes,
        );
      } else if (message.params.targetId === "oversized-attach") {
        event.params = { body: "x".repeat(256 * 1024) };
        writeSync(4, `${JSON.stringify(reply)}\0${JSON.stringify(event)}\0`);
      } else if (message.params.targetId === "detach-before-adoption") {
        const detached = { method: "Target.detachedFromTarget", params: { sessionId } };
        writeSync(4, `${JSON.stringify(reply)}\0${JSON.stringify(detached)}\0`);
      } else if (message.params.targetId === "pre-reply")
        writeSync(4, `${JSON.stringify(event)}\0${JSON.stringify(reply)}\0`);
      else if (message.params.targetId === "same-write")
        writeSync(4, `${JSON.stringify(reply)}\0${JSON.stringify(event)}\0`);
      else {
        replyCdp(reply);
        replyCdp(event);
        if (message.params.targetId === "overflow-attach")
          for (let index = 0; index < 33; index++)
            replyCdp({ method: "Runtime.fixture", params: { index }, sessionId });
      }
      continue;
    }
    if (message.method === "Target.detachFromTarget") {
      if (
        message.params.sessionId === "session-concurrent-a" ||
        message.params.sessionId === "session-concurrent-b"
      ) {
        concurrentDetaches.add(message.params.sessionId);
        if (concurrentDetaches.size === 2) send({ event: "detach.both-received", params: {} });
        if (message.params.sessionId === "session-concurrent-a")
          replyCdp({
            method: "Target.detachedFromTarget",
            params: { sessionId: message.params.sessionId },
          });
        continue;
      }
      if (message.params.sessionId === "session-detach-event") {
        replyCdp({
          method: "Target.detachedFromTarget",
          params: { sessionId: message.params.sessionId },
        });
        continue;
      }
      if (message.params.sessionId === "session-detach-never") continue;
      replyCdp({ id: message.id, result: {} });
      continue;
    }
    if (message.method === "Extensions.loadUnpacked") {
      const artifactName = basename(message.params.path);
      const behavior = artifactName.startsWith("ab") ? "g" : artifactName[0];
      if (behavior === "b")
        replyCdp({
          id: message.id,
          error: { code: -32602, message: `Rejected ${message.params.path}`, data: "fixture" },
        });
      else if (behavior === "c") replyCdp({ id: message.id, result: { id: "invalid" } });
      else if (behavior === "d") {
        send({ event: "extension.received", params: {} });
        continue;
      } else if (behavior === "e")
        setTimeout(() => replyCdp({ id: message.id, result: { id: extensionId } }), 250);
      else if (behavior === "f")
        setTimeout(() => replyCdp({ id: message.id, result: { id: extensionId } }), 50);
      else if (behavior === "g")
        replyCdp({ id: message.id, result: { id: extensionId }, unexpected: true });
      else replyCdp({ id: message.id, result: { id: extensionId } });
      continue;
    }
    if (message.method === "Extensions.uninstall") {
      if (message.params.id.startsWith("b"))
        replyCdp({ id: message.id, error: { code: -32602, message: "Rejected uninstall" } });
      else if (message.params.id.startsWith("c"))
        replyCdp({ id: message.id, result: { extra: true } });
      else if (message.params.id.startsWith("d")) continue;
      else replyCdp({ id: message.id, result: {} });
      continue;
    }
    if (message.sessionId) {
      if (message.method === "Runtime.triggerDetach") {
        replyCdp({
          method: "Target.detachedFromTarget",
          params: { sessionId: message.sessionId },
        });
        continue;
      }
      if (message.method === "Runtime.never") continue;
      if (message.method === "Runtime.hold") {
        heldRequests += 1;
        if (heldRequests === 32) send({ event: "session.holds", params: {} });
        continue;
      }
      if (message.method === "Runtime.overflow") {
        replyCdp({ id: message.id, result: {}, sessionId: message.sessionId });
        setImmediate(() => {
          for (let index = 0; index < 33; index++)
            replyCdp({
              method: "Runtime.fixture",
              params: { index },
              sessionId: message.sessionId,
            });
          send({ event: "session.overflow-sent", params: {} });
        });
        continue;
      }
      if (message.method === "Runtime.enable") {
        replyCdp({ id: message.id, result: {}, sessionId: message.sessionId });
        replyCdp({
          method: "Runtime.consoleAPICalled",
          params: { session: message.sessionId },
          sessionId: message.sessionId,
        });
      } else
        replyCdp({
          id: message.id,
          result: { value: message.params?.expression ?? "ok" },
          sessionId: message.sessionId,
        });
      continue;
    }
    replyCdp({ id: message.id, result: { product: "Fixture/1.0" } });
  }
});
