import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(app, "../..");
const executable = resolve(
  root,
  "work/plugin-host/build/PluginHost.app/Contents/MacOS/plugin-host",
);
const fixture = "/tmp/hitchhiker-plugin-host-deny-fixture";
const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const buildNative = ({ testing = false, startupTest } = {}) => {
  const env = { ...process.env };
  delete env.HITCHHIKER_PLUGIN_HOST_TESTING;
  delete env.HITCHHIKER_PLUGIN_HOST_STARTUP_TEST;
  if (testing) env.HITCHHIKER_PLUGIN_HOST_TESTING = "1";
  if (startupTest !== undefined) env.HITCHHIKER_PLUGIN_HOST_STARTUP_TEST = startupTest;
  return spawnSync(process.execPath, [resolve(app, "scripts/build.mjs")], {
    cwd: root,
    env,
    encoding: "utf8",
  });
};

const signedEntitlements = (path) => {
  const signature = spawnSync("codesign", ["-d", "--entitlements", ":-", path], {
    encoding: "utf8",
  });
  assert.equal(signature.status, 0, signature.stderr);
  const combined = `${signature.stdout}${signature.stderr}`;
  const plist = combined.slice(combined.indexOf("<?xml"));
  const converted = spawnSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    input: plist,
    encoding: "utf8",
  });
  assert.equal(converted.status, 0, converted.stderr);
  return JSON.parse(converted.stdout);
};

class Host {
  constructor() {
    this.child = spawn(executable, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    this.messages = [];
    this.waiters = [];
    this.stderr = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      const index = this.waiters.findIndex(({ predicate }) => predicate(message));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message);
      else this.messages.push(message);
    });
  }

  async send(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (!this.child.stdin.write(line)) await once(this.child.stdin, "drain");
  }

  async sendRaw(line) {
    if (!this.child.stdin.write(line)) await once(this.child.stdin, "drain");
  }

  next(predicate, timeoutMs = 5000) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolveNext, reject) => {
      const waiter = {
        predicate,
        resolve: (message) => {
          clearTimeout(timeout);
          resolveNext(message);
        },
      };
      const timeout = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error(`Timed out waiting for plugin-host message; stderr: ${this.stderr}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  reply(identifier) {
    return this.next((message) => message.id === identifier);
  }

  event(name, timeoutMs) {
    return this.next((message) => message.event === name, timeoutMs);
  }

  call(method, timeoutMs) {
    return this.next(
      (message) => message.event === "plugin.call" && message.params.method === method,
      timeoutMs,
    );
  }

  async stop(identifier = 2_000_000_000) {
    if (this.child.exitCode !== null) return;
    await this.send({ id: identifier, method: "stop", params: {} });
    await this.reply(identifier);
    this.child.stdin.end();
    const [code] = await once(this.child, "exit");
    assert.equal(code, 0, this.stderr);
  }

  kill() {
    this.child.kill("SIGKILL");
  }
}

const pluginCode = `
(() => {
  let host;
  let count = 0;
  globalThis.HitchhikerPlugin = {
    activate(hitchhiker) {
      host = hitchhiker;
      return hitchhiker.call("inspect", {
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        timers: typeof setTimeout,
        nativeBridge: typeof __hitchhikerNativeCall,
        frozen: Object.isFrozen(hitchhiker),
        keys: Object.keys(hitchhiker)
      }).then((result) => hitchhiker.call("resolved", result));
    },
    onEvent(event, payload) {
      count += 1;
      host.call("event.seen", { count, event, payload });
    }
  };
})();
`;

test("native plugin host isolates workers and recovers from resource violations", async (t) => {
  t.after(() => {
    const production = buildNative();
    assert.equal(production.status, 0, `${production.stdout}\n${production.stderr}`);
  });

  await t.test("cold startup has a separate trusted readiness budget", async (startup) => {
    const delayedBuild = buildNative({ testing: true, startupTest: "delay" });
    assert.equal(delayedBuild.status, 0, `${delayedBuild.stdout}\n${delayedBuild.stderr}`);
    const delayed = new Host();
    startup.after(() => delayed.kill());
    const began = Date.now();
    await delayed.send({
      id: 1,
      method: "activate",
      params: { code: "globalThis.HitchhikerPlugin={activate(){}}" },
    });
    await delayed.event("plugin.started");
    assert.ok(Date.now() - began >= 600, "test worker did not exercise a >500 ms cold start");
    await delayed.event("plugin.ready");
    assert.equal((await delayed.reply(1)).result, null);
    await delayed.stop();

    const hangingBuild = buildNative({ testing: true, startupTest: "hang" });
    assert.equal(hangingBuild.status, 0, `${hangingBuild.stdout}\n${hangingBuild.stderr}`);
    const hanging = new Host();
    startup.after(() => hanging.kill());
    await hanging.send({
      id: 1,
      method: "activate",
      params: { code: "globalThis.HitchhikerPlugin={activate(){}}" },
    });
    const resource = await hanging.event("plugin.resource", 6000);
    assert.equal(resource.params.reason, "startup-wall");
    assert.equal(resource.params.startupLimitMs, 4000);
    assert.equal(resource.params.cpuLimitMs, 500);
    assert.equal((await hanging.event("plugin.crash")).params.reason, "startup-wall");
    assert.equal(
      hanging.messages.some((message) => message.event === "plugin.started"),
      false,
    );

    const recoveryBuild = buildNative({ testing: true });
    assert.equal(recoveryBuild.status, 0, `${recoveryBuild.stdout}\n${recoveryBuild.stderr}`);
    await hanging.send({
      id: 2,
      method: "activate",
      params: { code: "globalThis.HitchhikerPlugin={activate(){}}" },
    });
    await hanging.event("plugin.started");
    await hanging.event("plugin.ready");
    assert.equal((await hanging.reply(2)).result, null);
    await hanging.stop();
  });

  const build = buildNative({ testing: true });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  await t.test(
    "private diagnostics bind samples and stop to the exact native worker",
    async (diagnostics) => {
      const host = new Host();
      diagnostics.after(() => host.kill());
      await host.send({
        id: 1,
        method: "activate",
        params: { code: "globalThis.HitchhikerPlugin={activate(){}}" },
      });
      const started = await host.next((message) => message.hostControl?.event === "worker.started");
      const identity = started.hostControl.identity;
      assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
      assert.ok(Number.isSafeInteger(identity.generation) && identity.generation > 0);
      assert.match(identity.startAbstime, /^[1-9][0-9]*$/);
      await host.reply(1);
      await host.send({ hostControl: { id: 1, method: "worker.sample", identity } });
      const sample = await host.next((message) => message.hostControl?.id === 1);
      assert.deepEqual(sample.hostControl.result.identity, identity);
      assert.ok(sample.hostControl.result.physicalFootprintBytes > 0);
      assert.ok(sample.hostControl.result.residentBytes > 0);
      await host.send({
        hostControl: {
          id: 2,
          method: "worker.sample",
          identity: { ...identity, startAbstime: String(BigInt(identity.startAbstime) + 1n) },
        },
      });
      assert.deepEqual(
        (await host.next((message) => message.hostControl?.id === 2)).hostControl.error,
        { code: "stale_worker" },
      );
      await host.stop();
      const stopped = await host.next((message) => message.hostControl?.event === "worker.stopped");
      assert.deepEqual(stopped.hostControl.identity, identity);
    },
  );

  const serviceRoot = resolve(
    root,
    "work/plugin-host/build/PluginHost.app/Contents/XPCServices/PluginBroker.xpc",
  );
  assert.deepEqual(signedEntitlements(serviceRoot), {
    "com.apple.security.app-sandbox": true,
  });
  assert.deepEqual(signedEntitlements(resolve(serviceRoot, "Contents/MacOS/plugin-worker")), {
    "com.apple.security.app-sandbox": true,
    "com.apple.security.inherit": true,
  });

  writeFileSync(fixture, "task-created isolation fixture\n", { mode: 0o600 });
  let acceptedConnections = 0;
  const server = createServer((socket) => {
    acceptedConnections += 1;
    socket.destroy();
  });
  server.listen(38991, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    unlinkSync(fixture);
  });

  await t.test("two workers have isolated state and bounded host calls", async () => {
    const first = new Host();
    const second = new Host();
    t.after(() => {
      first.kill();
      second.kill();
    });
    await Promise.all([
      first.send({ id: 1, method: "activate", params: { code: pluginCode } }),
      second.send({ id: 1, method: "activate", params: { code: pluginCode } }),
    ]);
    await Promise.all([first.event("plugin.started"), second.event("plugin.started")]);
    const [firstProbe, secondProbe] = await Promise.all([
      first.event("plugin.testIsolation"),
      second.event("plugin.testIsolation"),
    ]);
    assert.deepEqual(firstProbe.params, { openErrno: 1, connectErrno: 1 });
    assert.deepEqual(secondProbe.params, { openErrno: 1, connectErrno: 1 });
    assert.equal(acceptedConnections, 0);

    const [firstInspect, secondInspect] = await Promise.all([
      first.call("inspect"),
      second.call("inspect"),
    ]);
    for (const inspect of [firstInspect, secondInspect]) {
      assert.deepEqual(inspect.params.params, {
        process: "undefined",
        require: "undefined",
        fetch: "undefined",
        timers: "undefined",
        nativeBridge: "undefined",
        frozen: true,
        keys: ["call"],
      });
    }
    await Promise.all([
      first.send({
        id: 2,
        method: "resolve",
        params: { callId: firstInspect.params.callId, result: { worker: "first" } },
      }),
      second.send({
        id: 2,
        method: "resolve",
        params: { callId: secondInspect.params.callId, result: { worker: "second" } },
      }),
    ]);
    const [firstResolved, secondResolved] = await Promise.all([
      first.call("resolved"),
      second.call("resolved"),
    ]);
    assert.deepEqual(firstResolved.params.params, { worker: "first" });
    assert.deepEqual(secondResolved.params.params, { worker: "second" });
    await Promise.all([first.reply(2), second.reply(2)]);
    await Promise.all([
      first.send({
        id: 5,
        method: "resolve",
        params: { callId: firstResolved.params.callId, result: null },
      }),
      second.send({
        id: 5,
        method: "resolve",
        params: { callId: secondResolved.params.callId, result: null },
      }),
    ]);
    await Promise.all([first.reply(5), second.reply(5)]);
    await Promise.all([first.event("plugin.ready"), second.event("plugin.ready")]);
    await Promise.all([first.reply(1), second.reply(1)]);

    await Promise.all([
      first.send({ id: 3, method: "event", params: { event: "tick", payload: { side: 1 } } }),
      second.send({ id: 3, method: "event", params: { event: "tick", payload: { side: 2 } } }),
    ]);
    const [firstEvent, secondEvent] = await Promise.all([
      first.call("event.seen"),
      second.call("event.seen"),
    ]);
    assert.equal(firstEvent.params.params.count, 1);
    assert.equal(secondEvent.params.params.count, 1);
    await Promise.all([first.reply(3), second.reply(3)]);
    await first.send({ id: 4, method: "event", params: { event: "tick", payload: null } });
    assert.equal((await first.call("event.seen")).params.params.count, 2);
    await first.reply(4);
    await Promise.all([first.stop(), second.stop()]);
  });

  await t.test(
    "CPU slices pause for host waits and rearm for nested continuations",
    async (slice) => {
      const waiting = new Host();
      slice.after(() => waiting.kill());
      await waiting.send({
        id: 1,
        method: "activate",
        params: {
          code: 'globalThis.HitchhikerPlugin={async activate(h){await h.call("slow",{})}}',
        },
      });
      await waiting.event("plugin.started");
      const slow = await waiting.call("slow");
      await delay(700);
      await waiting.send({
        id: 2,
        method: "resolve",
        params: { callId: slow.params.callId, result: null },
      });
      assert.equal((await waiting.reply(2)).result, null);
      await waiting.event("plugin.ready");
      assert.equal((await waiting.reply(1)).result, null);
      await waiting.stop();

      const continuation = new Host();
      slice.after(() => continuation.kill());
      await continuation.send({
        id: 1,
        method: "activate",
        params: {
          code:
            'globalThis.HitchhikerPlugin={async activate(h){await h.call("first",{});' +
            'await h.call("second",{});await Promise.resolve();while(true){}}}',
        },
      });
      await continuation.event("plugin.started");
      const first = await continuation.call("first");
      await continuation.send({
        id: 2,
        method: "resolve",
        params: { callId: first.params.callId, result: null },
      });
      const second = await continuation.call("second");
      assert.equal((await continuation.reply(2)).result, null);
      await continuation.send({
        id: 3,
        method: "resolve",
        params: { callId: second.params.callId, result: null },
      });
      const cpu = await continuation.event("plugin.resource");
      assert.equal(cpu.params.reason, "cpu");
      assert.equal(cpu.params.cpuLimitMs, 500);
      assert.equal((await continuation.event("plugin.crash")).params.reason, "cpu");
    },
  );

  await t.test("hostile Promise assimilation remains inside the CPU slice", async (hostile) => {
    const host = new Host();
    hostile.after(() => host.kill());
    for (const [identifier, code] of [
      [
        1,
        "globalThis.HitchhikerPlugin={activate(){return Object.defineProperty({},'then',{get(){while(true){}}})}}",
      ],
      [
        2,
        "globalThis.HitchhikerPlugin={activate(){return Promise.reject({toString(){while(true){}}})}}",
      ],
    ]) {
      await host.send({ id: identifier, method: "activate", params: { code } });
      await host.event("plugin.started");
      assert.equal((await host.event("plugin.resource")).params.reason, "cpu");
      assert.equal((await host.event("plugin.crash")).params.reason, "cpu");
    }
  });

  await t.test("cheap asynchronous yielding remains bounded by total wall time", async (wall) => {
    const host = new Host();
    wall.after(() => host.kill());
    await host.send({
      id: 1,
      method: "activate",
      params: {
        code: 'globalThis.HitchhikerPlugin={async activate(h){for(;;){await h.call("again",{})}}}',
      },
    });
    await host.event("plugin.started");
    let resolving = true;
    const drive = (async () => {
      let identifier = 2;
      while (resolving) {
        const call = await host.call("again", 1000);
        await delay(250);
        if (!resolving) return;
        await host.send({
          id: identifier,
          method: "resolve",
          params: { callId: call.params.callId, result: null },
        });
        identifier += 1;
      }
    })().catch(() => {});
    const resource = await host.event("plugin.resource", 7000);
    resolving = false;
    assert.equal(resource.params.reason, "wall");
    assert.equal(resource.params.commandWallLimitMs, 5000);
    assert.equal((await host.event("plugin.crash")).params.reason, "wall");
    await drive;
  });

  await t.test("malformed input and CPU/RSS kills restart cleanly", async () => {
    const host = new Host();
    t.after(() => host.kill());
    await host.sendRaw("{bad json}\n");
    assert.equal((await host.reply(0)).error.code, "invalid_request");
    await host.sendRaw(`${"x".repeat(1024 * 1024 + 1)}\n`);
    assert.equal((await host.reply(0)).error.code, "frame_too_large");
    await host.send({
      id: 9,
      method: "activate",
      params: { code: " ".repeat(512 * 1024 + 1) },
    });
    assert.equal((await host.reply(9)).error.code, "invalid_request");

    await host.send({
      id: 90,
      method: "activate",
      params: {
        code: 'globalThis.HitchhikerPlugin={activate(){return Promise.reject(new Error("no"))}}',
      },
    });
    await host.event("plugin.started");
    assert.equal((await host.reply(90)).error.code, "javascript");
    await host.event("plugin.crash");
    assert.equal(
      host.messages.some((message) => message.event === "plugin.ready"),
      false,
    );

    await host.send({
      id: 91,
      method: "activate",
      params: {
        code: "globalThis.HitchhikerPlugin={activate(){Promise.resolve=()=>{throw new Error('tampered')};Promise.prototype.then=()=>{throw new Error('tampered')}}}",
      },
    });
    await host.event("plugin.started");
    await host.event("plugin.ready");
    assert.equal((await host.reply(91)).result, null);
    await host.send({ id: 92, method: "stop", params: {} });
    await host.reply(92);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

    await host.send({
      id: 10,
      method: "activate",
      params: { code: "globalThis.HitchhikerPlugin={activate(){while(true){}}}" },
    });
    await host.event("plugin.started");
    assert.equal((await host.event("plugin.resource", 5000)).params.reason, "cpu");
    assert.equal((await host.event("plugin.crash")).params.reason, "cpu");

    await host.send({
      id: 11,
      method: "activate",
      params: { code: "globalThis.HitchhikerPlugin={activate(){}}" },
    });
    await host.event("plugin.started");
    await host.event("plugin.ready");
    assert.equal((await host.reply(11)).result, null);
    await host.send({ id: 12, method: "stop", params: {} });
    await host.reply(12);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

    const previousDiagnosticGeneration = Math.max(
      0,
      ...host.messages.flatMap((message) =>
        message.hostControl?.event === "worker.started"
          ? [message.hostControl.identity.generation]
          : [],
      ),
    );
    await host.send({
      id: 13,
      method: "activate",
      params: {
        code: "globalThis.HitchhikerPlugin={activate(){const held=[];for(let i=0;i<20;i++){held.push(new Uint8Array(10*1024*1024).fill(7))}return new Promise(()=>{})}}",
      },
    });
    await host.event("plugin.started");
    const memoryIdentity = (
      await host.next(
        (message) =>
          message.hostControl?.event === "worker.started" &&
          message.hostControl.identity.generation > previousDiagnosticGeneration,
      )
    ).hostControl.identity;
    const memoryResource = await host.event("plugin.resource", 5000);
    assert.equal(memoryResource.params.reason, "rss", JSON.stringify(memoryResource));
    assert.ok(memoryResource.params.rssBytes > 150 * 1024 * 1024);
    await host.event("plugin.crash");
    const memoryStopped = await host.next(
      (message) =>
        message.hostControl?.event === "worker.stopped" &&
        message.hostControl.identity.generation === memoryIdentity.generation,
    );
    assert.deepEqual(memoryStopped.hostControl.identity, memoryIdentity);
    await host.send({
      hostControl: { id: 400, method: "worker.sample", identity: memoryIdentity },
    });
    assert.deepEqual(
      (await host.next((message) => message.hostControl?.id === 400)).hostControl.error,
      { code: "stale_worker" },
    );

    await host.send({
      id: 14,
      method: "activate",
      params: { code: "globalThis.HitchhikerPlugin={activate(){}}" },
    });
    await host.event("plugin.started");
    await host.event("plugin.ready");
    assert.equal((await host.reply(14)).result, null);
    await host.stop();
  });
});
