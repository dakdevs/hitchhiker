import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, PubSub, Stream } from "effect";
import { WebSocket, type ClientOptions } from "ws";
import { openCdpRelay, type CdpRelay, type CdpRelayOptions } from "../src/cdp-relay.ts";
import { EngineConnection, EngineError, type JsonObject } from "../src/engine.ts";

const TestTimeoutMs = 3_000;

const timeout = <A>(promise: Promise<A>, message: string): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), TestTimeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const connect = (url: string, options?: ClientOptions): Promise<WebSocket> =>
  timeout(
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, options);
      socket.once("open", () => resolve(socket));
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        reject(new Error(`Upgrade rejected with ${response.statusCode}`));
      });
      socket.once("error", reject);
    }),
    "WebSocket connection timed out",
  );

const rejectedConnection = async (url: string, options?: ClientOptions): Promise<void> => {
  await assert.rejects(connect(url, options));
};

const nextMessage = (socket: WebSocket): Promise<JsonObject> =>
  timeout(
    new Promise<JsonObject>((resolve, reject) => {
      socket.once("message", (data, isBinary) => {
        if (isBinary) return reject(new Error("Expected a text CDP message"));
        try {
          resolve(JSON.parse(data.toString()) as JsonObject);
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
    }),
    "WebSocket message timed out",
  );

const closed = (socket: WebSocket): Promise<void> =>
  timeout(
    new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once("close", () => resolve());
    }),
    "WebSocket did not close",
  );

interface FakeEngine {
  readonly service: EngineConnection["Service"];
  readonly sent: JsonObject[];
  readonly fail: Effect.Effect<void>;
  readonly publish: (message: JsonObject) => Effect.Effect<boolean>;
}

const makeFakeEngine = Effect.fn("makeFakeEngine")(function* (): Effect.fn.Return<FakeEngine> {
  const events = yield* PubSub.unbounded<JsonObject>();
  const exit = yield* Deferred.make<number, EngineError>();
  const sent: JsonObject[] = [];
  let claimed = false;

  const sendCdp = Effect.fn("FakeEngine.sendCdp")(function* (message: JsonObject) {
    sent.push(message);
    if (message.method === "Browser.getVersion") {
      yield* PubSub.publish(events, {
        id: message.id,
        result: {
          protocolVersion: "1.3",
          product: "Chrome/144.0.7559.59",
          revision: "@test",
          userAgent: "Test Chromium",
          jsVersion: "14.4.0",
        },
      });
      return;
    }
    if (typeof message.id === "number") {
      yield* PubSub.publish(events, { id: message.id, result: { targetInfos: [] } });
    }
  });

  return {
    service: EngineConnection.of({
      pid: 42,
      ready: Effect.never,
      exit: Deferred.await(exit),
      events: Stream.empty,
      request: () =>
        Effect.fail(new EngineError({ code: "unsupported", message: "unused in relay tests" })),
      loadUnpacked: () =>
        Effect.fail(new EngineError({ code: "unsupported", message: "unused in relay tests" })),
      uninstall: () =>
        Effect.fail(new EngineError({ code: "unsupported", message: "unused in relay tests" })),
      claimRawCdp: Effect.suspend(() => {
        if (claimed)
          return Effect.fail(new EngineError({ code: "cdp-owned", message: "already claimed" }));
        claimed = true;
        return Effect.succeed({ events: Stream.fromPubSub(events), send: sendCdp });
      }),
    }),
    sent,
    fail: PubSub.shutdown(events),
    publish: (message) => PubSub.publish(events, message),
  };
});

const withRelay = <A>(
  run: (relay: CdpRelay, fake: FakeEngine) => Promise<A>,
  overrides: Partial<Omit<CdpRelayOptions, "engine" | "principal">> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* makeFakeEngine();
      const relay = yield* openCdpRelay({
        engine: fake.service,
        principal: "test-principal",
        authorize: () => Effect.succeed(true),
        authorizationRecheckMs: 25,
        ...overrides,
      });
      return yield* Effect.promise(() => run(relay, fake));
    }),
  );

test("serves authenticated discovery and forwards browser-level CDP messages", async () => {
  await Effect.runPromise(
    withRelay(async (relay, fake) => {
      const discovery = await fetch(relay.discoveryUrl);
      assert.equal(discovery.status, 200);
      assert.equal(discovery.headers.get("cache-control"), "no-store");
      const document = (await discovery.json()) as Record<string, unknown>;
      assert.equal(document.Browser, "Chrome/144.0.7559.59");
      assert.equal(document["Protocol-Version"], "1.3");
      assert.equal(document.webSocketDebuggerUrl, relay.url);

      const socket = await connect(relay.url);
      const response = nextMessage(socket);
      socket.send(JSON.stringify({ id: 7, method: "Target.getTargets" }));
      assert.deepEqual(await response, { id: 7, result: { targetInfos: [] } });
      assert.deepEqual(fake.sent.at(-1), { id: 7, method: "Target.getTargets" });
    }),
  );
});

test("permits flattened sessions while rejecting extension mutation, legacy nesting, and reserved IDs", async () => {
  await Effect.runPromise(
    withRelay(async (relay, fake) => {
      const socket = await connect(relay.url);
      const response = nextMessage(socket);
      socket.send(
        JSON.stringify({ id: 12, sessionId: "flattened", method: "Runtime.enable", params: {} }),
      );
      assert.deepEqual(await response, { id: 12, result: { targetInfos: [] } });
      assert.deepEqual(fake.sent.at(-1), {
        id: 12,
        sessionId: "flattened",
        method: "Runtime.enable",
        params: {},
      });
    }),
  );

  for (const message of [
    { id: 20, method: "Extensions.loadUnpacked", params: { path: "/tmp/extension" } },
    { id: 21, sessionId: "flattened", method: "Extensions.uninstall", params: { id: "a" } },
    {
      id: 22,
      method: "Target.sendMessageToTarget",
      params: {
        sessionId: "legacy",
        message: JSON.stringify({
          id: 1,
          method: "Extensions.loadUnpacked",
          params: { path: "/tmp/extension" },
        }),
      },
    },
    { id: 2_147_483_647, method: "Browser.getVersion" },
    { id: -2_147_483_648, method: "Browser.getVersion" },
  ] satisfies JsonObject[]) {
    await Effect.runPromise(
      withRelay(async (relay, fake) => {
        const socket = await connect(relay.url);
        const sentBeforeClientMessage = fake.sent.length;
        const response = nextMessage(socket);
        socket.send(JSON.stringify(message));
        assert.deepEqual(await response, {
          id: message.id,
          ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}),
          error: { code: -32601, message: "Method is not available through this relay" },
        });
        assert.equal(socket.readyState, WebSocket.OPEN);
        assert.equal(fake.sent.length, sentBeforeClientMessage);
      }),
    );
  }
});

test("supports standard discovery and WebSocket paths with a Bearer capability", async () => {
  await Effect.runPromise(
    withRelay(async (relay) => {
      const discoveryUrl = new URL(relay.discoveryUrl);
      const token = discoveryUrl.pathname.split("/")[1];
      assert.ok(token);
      const authorization = { Authorization: `Bearer ${token}` };
      const discovery = await fetch(`http://${discoveryUrl.host}/json/version`, {
        headers: authorization,
      });
      assert.equal(discovery.status, 200);

      const endpoint = new URL(relay.url);
      const browserId = endpoint.pathname.split("/").at(-1);
      assert.ok(browserId);
      const socket = await connect(`ws://${endpoint.host}/devtools/browser/${browserId}`, {
        headers: authorization,
      });
      assert.equal(socket.readyState, WebSocket.OPEN);
    }),
  );
});

test("denies discovery and upgrades when the grant is absent", async () => {
  await Effect.runPromise(
    withRelay(
      async (relay) => {
        const discovery = await fetch(relay.discoveryUrl);
        assert.equal(discovery.status, 403);
        await rejectedConnection(relay.url);
      },
      // Exercise the request-level denial before periodic revocation closes the listener.
      // Listener shutdown without a client is covered separately below.
      { authorize: () => Effect.succeed(false), authorizationRecheckMs: 60_000 },
    ),
  );
});

test("rejects a supplied Origin unless it is explicitly allowed", async () => {
  await Effect.runPromise(
    withRelay(async (relay) => {
      await rejectedConnection(relay.url, { origin: "https://untrusted.example" });
    }),
  );
});

test("permits only one active CDP client", async () => {
  await Effect.runPromise(
    withRelay(async (relay) => {
      const first = await connect(relay.url);
      await rejectedConnection(relay.url);
      assert.equal(first.readyState, WebSocket.OPEN);
    }),
  );
});

test("rechecks authorization for every client message and while idle", async () => {
  let checks = 0;
  await Effect.runPromise(
    withRelay(
      async (relay, fake) => {
        const socket = await connect(relay.url);
        const didClose = closed(socket);
        socket.send(JSON.stringify({ id: 9, method: "Target.getTargets" }));
        await didClose;
        assert.equal(
          fake.sent.some((message) => message.id === 9),
          false,
        );
      },
      {
        authorize: () => Effect.succeed(++checks === 1),
        authorizationRecheckMs: 1_000,
      },
    ),
  );

  let allowed = true;
  await Effect.runPromise(
    withRelay(
      async (relay) => {
        const socket = await connect(relay.url);
        const didClose = closed(socket);
        allowed = false;
        await didClose;
      },
      { authorize: () => Effect.succeed(allowed), authorizationRecheckMs: 10 },
    ),
  );
});

test("disconnects when backend output would exceed the bounded client queue", async () => {
  await Effect.runPromise(
    withRelay(
      async (relay, fake) => {
        const socket = await connect(relay.url);
        const didClose = closed(socket);
        await Effect.runPromise(
          fake.publish({ method: "Runtime.consoleAPICalled", params: { value: "x".repeat(256) } }),
        );
        await didClose;
      },
      { queuedOutputLimitBytes: 128 },
    ),
  );
});

test("revocation wins a pending authorization race and closes an active client", async () => {
  let releaseAuthorization: ((allowed: boolean) => void) | undefined;
  let gateAuthorization = true;
  const authorize = () =>
    gateAuthorization
      ? Effect.promise(
          () =>
            new Promise<boolean>((resolve) => {
              releaseAuthorization = resolve;
            }),
        )
      : Effect.succeed(true);

  await Effect.runPromise(
    withRelay(
      async (relay) => {
        const pendingConnection = connect(relay.url);
        await timeout(
          new Promise<void>((resolve) => {
            const poll = () =>
              releaseAuthorization === undefined ? setImmediate(poll) : resolve();
            poll();
          }),
          "Authorization was not evaluated",
        );
        const revoke = Effect.runPromise(relay.revoke);
        await timeout(revoke, "Revocation waited for a pending authorization decision");
        releaseAuthorization?.(true);
        await assert.rejects(pendingConnection);

        gateAuthorization = false;
        await assert.rejects(fetch(relay.discoveryUrl));
      },
      { authorize, authorizationTimeoutMs: 1_000 },
    ),
  );

  await Effect.runPromise(
    withRelay(async (relay) => {
      const socket = await connect(relay.url);
      const didClose = closed(socket);
      await Effect.runPromise(relay.revoke);
      await didClose;
    }),
  );
});

test("backend termination shuts down the relay and connected client", async () => {
  await Effect.runPromise(
    withRelay(async (relay, fake) => {
      const socket = await connect(relay.url);
      const didClose = closed(socket);
      await Effect.runPromise(fake.fail);
      await didClose;
      await assert.rejects(fetch(relay.discoveryUrl));
    }),
  );
});

test("revocation closes discovery even before any CDP client connects", async () => {
  let authorized = true;
  await Effect.runPromise(
    withRelay(
      async (relay) => {
        assert.equal((await fetch(relay.discoveryUrl)).status, 200);
        authorized = false;
        await new Promise((resolve) => setTimeout(resolve, 100));
        await assert.rejects(fetch(relay.discoveryUrl));
      },
      { authorize: () => Effect.succeed(authorized) },
    ),
  );
});
