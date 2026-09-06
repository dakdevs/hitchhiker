import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { Effect, Deferred, Option, Schema, Scope, Stream } from "effect";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { EngineConnection, type JsonObject } from "./engine.ts";

const MaxCdpMessageBytes = 32 * 1024 * 1024;
const DefaultQueuedOutputBytes = 8 * 1024 * 1024;
const DefaultPendingInputBytes = 32 * 1024 * 1024;
const DefaultPendingInputMessages = 64;
const InternalVersionRequestId = 2_147_483_647;

const JsonObjectFromString = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const decodeJsonObject = Schema.decodeUnknownEffect(JsonObjectFromString);
const CdpMessageId = Schema.Struct({ id: Schema.Int });
const decodeCdpMessageId = Schema.decodeUnknownOption(CdpMessageId);
const BrowserVersionResponse = Schema.Struct({
  id: Schema.Literal(InternalVersionRequestId),
  result: Schema.Struct({
    protocolVersion: Schema.String,
    product: Schema.String,
    revision: Schema.String,
    userAgent: Schema.String,
    jsVersion: Schema.String,
  }),
});
const decodeBrowserVersionResponse = Schema.decodeUnknownEffect(BrowserVersionResponse);

export class CdpRelayError extends Schema.TaggedError<CdpRelayError>()("CdpRelayError", {
  code: Schema.String,
  message: Schema.String,
}) {}

const relayError = (code: string, message: string) => new CdpRelayError({ code, message });

export interface CdpRelayOptions {
  /** The connection must be exclusively owned by this relay while the relay is open. */
  readonly engine: EngineConnection["Service"];
  /** Stable audit identity for the grant holder. It is deliberately not exposed over HTTP. */
  readonly principal: string;
  /** Re-evaluated for discovery, upgrade, every CDP message, and periodically while connected. */
  readonly authorize: () => Effect.Effect<boolean, unknown>;
  /** Browser clients normally omit Origin. Any supplied Origin is rejected unless listed here. */
  readonly allowedOrigins?: readonly string[];
  readonly authorizationTimeoutMs?: number;
  readonly authorizationRecheckMs?: number;
  readonly queuedOutputLimitBytes?: number;
  readonly pendingInputLimitBytes?: number;
  readonly pendingInputLimitMessages?: number;
}

export interface CdpRelay {
  /** Direct browser WebSocket endpoint, suitable for clients that accept a CDP WebSocket URL. */
  readonly url: string;
  /** Token-bearing HTTP endpoint for Chromium's /json/version discovery document. */
  readonly discoveryUrl: string;
  /** Closes the listener and all clients and prevents pending authorization from reopening access. */
  readonly revoke: Effect.Effect<void>;
}

interface BrowserVersion {
  readonly protocolVersion: string;
  readonly product: string;
  readonly userAgent: string;
  readonly jsVersion: string;
}

const rejectUpgrade = (
  socket: NodeJS.WritableStream & { destroy(): void },
  status: number,
  reason: string,
) => {
  if (!socket.writable) return;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
};

const sendHttp = (response: ServerResponse, status: number, body?: JsonObject) => {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    ...(encoded === undefined
      ? { "content-length": "0" }
      : {
          "content-length": String(encoded.length),
          "content-type": "application/json; charset=utf-8",
        }),
  });
  response.end(encoded);
};

const constantTimeEqual = (left: string, right: string) => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const bearerToken = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
};

const rawDataToBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};

/**
 * Opens a loopback-only, capability-URL relay for one exclusive browser-level CDP connection.
 * The capability remains valid only while the supplied authorization check keeps succeeding.
 */
export const openCdpRelay = Effect.fn("openCdpRelay")(function* (
  options: CdpRelayOptions,
): Effect.fn.Return<CdpRelay, CdpRelayError, Scope.Scope> {
  const token = randomBytes(32).toString("base64url");
  const browserId = randomUUID();
  const tokenPrefix = `/${token}`;
  const tokenWebSocketPath = `${tokenPrefix}/devtools/browser/${browserId}`;
  const standardWebSocketPath = `/devtools/browser/${browserId}`;
  const tokenVersionPath = `${tokenPrefix}/json/version`;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const authorizationTimeoutMs = options.authorizationTimeoutMs ?? 2_000;
  const authorizationRecheckMs = options.authorizationRecheckMs ?? 1_000;
  const queuedOutputLimitBytes = options.queuedOutputLimitBytes ?? DefaultQueuedOutputBytes;
  const pendingInputLimitBytes = options.pendingInputLimitBytes ?? DefaultPendingInputBytes;
  const pendingInputLimitMessages =
    options.pendingInputLimitMessages ?? DefaultPendingInputMessages;

  if (
    options.principal.length === 0 ||
    options.principal.length > 256 ||
    !Number.isSafeInteger(authorizationTimeoutMs) ||
    authorizationTimeoutMs <= 0 ||
    !Number.isSafeInteger(authorizationRecheckMs) ||
    authorizationRecheckMs <= 0 ||
    !Number.isSafeInteger(queuedOutputLimitBytes) ||
    queuedOutputLimitBytes <= 0 ||
    queuedOutputLimitBytes > MaxCdpMessageBytes ||
    !Number.isSafeInteger(pendingInputLimitBytes) ||
    pendingInputLimitBytes <= 0 ||
    pendingInputLimitBytes > MaxCdpMessageBytes ||
    !Number.isSafeInteger(pendingInputLimitMessages) ||
    pendingInputLimitMessages <= 0
  ) {
    return yield* relayError("configuration", "Invalid CDP relay limits");
  }

  let revoked = false;
  let upgradePending = false;
  let pendingUpgradeSocket: Duplex | undefined;
  let activeClient: WebSocket | undefined;
  let webSocketServer: WebSocketServer | undefined;
  let server: Server | undefined;
  let recheckTimer: NodeJS.Timeout | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let awaitingVersionReply = true;
  const versionReply = yield* Deferred.make<JsonObject, CdpRelayError>();

  const shutdown = (): Promise<void> => {
    revoked = true;
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = new Promise<void>((resolve) => {
      if (recheckTimer !== undefined) clearInterval(recheckTimer);
      recheckTimer = undefined;
      upgradePending = false;
      const upgradeSocket = pendingUpgradeSocket;
      pendingUpgradeSocket = undefined;
      if (upgradeSocket !== undefined) upgradeSocket.destroy();
      const client = activeClient;
      activeClient = undefined;
      if (client !== undefined) client.terminate();
      const socketServer = webSocketServer;
      webSocketServer = undefined;
      if (socketServer !== undefined) socketServer.close();
      const listeningServer = server;
      if (listeningServer === undefined || !listeningServer.listening) {
        resolve();
        return;
      }
      listeningServer.close(() => resolve());
      listeningServer.closeAllConnections();
    });
    return shutdownPromise;
  };

  const revoke = Effect.uninterruptible(Effect.promise(shutdown));

  const isAuthorized = async (): Promise<boolean> => {
    if (revoked) return false;
    try {
      const allowed = await Effect.runPromise(
        options.authorize().pipe(
          Effect.timeoutOrElse({
            duration: authorizationTimeoutMs,
            orElse: () => Effect.succeed(false),
          }),
          Effect.catch(() => Effect.succeed(false)),
        ),
      );
      return !revoked && allowed;
    } catch {
      return false;
    }
  };

  const originAllowed = (request: IncomingMessage): boolean => {
    const origin = request.headers.origin;
    return origin === undefined || (typeof origin === "string" && allowedOrigins.has(origin));
  };

  const hasToken = (
    request: IncomingMessage,
    tokenizedPath: string,
    standardPath: string,
  ): boolean => {
    if (request.url === tokenizedPath) return true;
    if (request.url !== standardPath) return false;
    const bearer = bearerToken(request);
    return bearer !== undefined && constantTimeEqual(bearer, token);
  };

  const backendFiber = yield* options.engine.cdpEvents.pipe(
    Stream.runForEach((message) => {
      const id = decodeCdpMessageId(message);
      if (awaitingVersionReply && Option.isSome(id) && id.value.id === InternalVersionRequestId) {
        return Deferred.succeed(versionReply, message);
      }
      return Effect.sync(() => {
        const client = activeClient;
        if (revoked || client === undefined || client.readyState !== WebSocket.OPEN) return;
        let encoded: string;
        try {
          encoded = JSON.stringify(message);
        } catch {
          void shutdown();
          return;
        }
        const bytes = Buffer.byteLength(encoded);
        if (bytes > MaxCdpMessageBytes || client.bufferedAmount + bytes > queuedOutputLimitBytes) {
          void shutdown();
          return;
        }
        client.send(encoded, { binary: false }, (error) => {
          if (error != null) void shutdown();
        });
      });
    }),
    Effect.ensuring(Effect.promise(shutdown)),
    Effect.forkScoped,
  );
  void backendFiber;
  // Give the stream fiber a turn to acquire its PubSub subscription before the
  // one-shot Browser.getVersion request can publish its response.
  yield* Effect.yieldNow;

  yield* options.engine
    .sendCdp({ id: InternalVersionRequestId, method: "Browser.getVersion" })
    .pipe(Effect.mapError(() => relayError("backend", "CDP backend rejected discovery request")));
  const versionMessage = yield* Deferred.await(versionReply).pipe(
    Effect.timeoutOrElse({
      duration: 3_000,
      orElse: () =>
        Effect.fail(relayError("backend-timeout", "CDP backend did not answer discovery request")),
    }),
  );
  const version = yield* decodeBrowserVersionResponse(versionMessage).pipe(
    Effect.map((message): BrowserVersion => message.result),
    Effect.mapError(() =>
      relayError("backend-protocol", "CDP backend returned an invalid discovery response"),
    ),
  );
  awaitingVersionReply = false;
  if (revoked) return yield* relayError("backend", "CDP backend closed during relay startup");

  const webSockets = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: MaxCdpMessageBytes,
    perMessageDeflate: false,
  });
  webSocketServer = webSockets;
  webSockets.on("error", () => {
    void shutdown();
  });

  let expectedHost = "";
  let webSocketUrl = "";

  const requestHandler = (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (revoked) return sendHttp(response, 410);
      if (request.method !== "GET" || request.headers.host !== expectedHost)
        return sendHttp(response, 403);
      if (!originAllowed(request)) return sendHttp(response, 403);
      if (!hasToken(request, tokenVersionPath, "/json/version")) return sendHttp(response, 404);
      if (!(await isAuthorized())) return sendHttp(response, 403);
      if (revoked || response.destroyed) return response.destroy();
      sendHttp(response, 200, {
        Browser: version.product,
        "Protocol-Version": version.protocolVersion,
        "User-Agent": version.userAgent,
        "V8-Version": version.jsVersion,
        webSocketDebuggerUrl: webSocketUrl,
      });
    })().catch(() => {
      if (!response.headersSent) sendHttp(response, 500);
      else response.destroy();
    });
  };

  const listeningServer = createServer(requestHandler);
  listeningServer.maxHeadersCount = 32;
  listeningServer.headersTimeout = 5_000;
  listeningServer.requestTimeout = 5_000;
  listeningServer.keepAliveTimeout = 1_000;
  listeningServer.on("clientError", (_error, socket) => socket.destroy());
  server = listeningServer;
  if (revoked) return yield* relayError("backend", "CDP backend closed during relay startup");

  const port = yield* Effect.acquireRelease(
    Effect.callback<number, CdpRelayError>((resume) => {
      let cancelled = false;
      const onError = () =>
        resume(Effect.fail(relayError("listen", "Could not open CDP loopback relay")));
      if (revoked) {
        resume(Effect.fail(relayError("backend", "CDP backend closed during relay startup")));
        return;
      }
      listeningServer.once("error", onError);
      listeningServer.listen(0, "127.0.0.1", () => {
        listeningServer.off("error", onError);
        if (cancelled || revoked) {
          listeningServer.close();
          resume(Effect.fail(relayError("backend", "CDP backend closed during relay startup")));
          return;
        }
        const address = listeningServer.address();
        if (address === null || typeof address === "string") {
          resume(Effect.fail(relayError("listen", "CDP relay returned an invalid address")));
          return;
        }
        resume(Effect.succeed(address.port));
      });
      return Effect.sync(() => {
        cancelled = true;
        listeningServer.off("error", onError);
        if (listeningServer.listening) listeningServer.close();
      });
    }),
    () => revoke,
  );
  expectedHost = `127.0.0.1:${port}`;
  webSocketUrl = `ws://${expectedHost}${tokenWebSocketPath}`;
  listeningServer.on("error", () => {
    void shutdown();
  });

  listeningServer.on("upgrade", (request, socket, head) => {
    if (revoked) return rejectUpgrade(socket, 410, "Gone");
    if (request.method !== "GET" || request.headers.host !== expectedHost) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }
    if (!originAllowed(request)) return rejectUpgrade(socket, 403, "Forbidden");
    if (!hasToken(request, tokenWebSocketPath, standardWebSocketPath)) {
      return rejectUpgrade(socket, 404, "Not Found");
    }
    if (activeClient !== undefined || upgradePending) return rejectUpgrade(socket, 409, "Conflict");
    upgradePending = true;
    pendingUpgradeSocket = socket;
    void isAuthorized()
      .then((authorized) => {
        if (!authorized || revoked || activeClient !== undefined) {
          upgradePending = false;
          pendingUpgradeSocket = undefined;
          rejectUpgrade(socket, authorized ? 409 : 403, authorized ? "Conflict" : "Forbidden");
          return;
        }
        webSockets.handleUpgrade(request, socket, head, (client) => {
          if (revoked || activeClient !== undefined) {
            upgradePending = false;
            pendingUpgradeSocket = undefined;
            client.terminate();
            return;
          }
          activeClient = client;
          upgradePending = false;
          pendingUpgradeSocket = undefined;
          webSockets.emit("connection", client, request);
        });
      })
      .catch(() => {
        upgradePending = false;
        pendingUpgradeSocket = undefined;
        rejectUpgrade(socket, 403, "Forbidden");
      });
  });

  webSockets.on("connection", (client) => {
    let pendingInputBytes = 0;
    let pendingInputMessages = 0;
    let incomingTail = Promise.resolve();

    client.on("message", (raw, isBinary) => {
      const bytes = rawDataToBuffer(raw);
      if (
        isBinary ||
        bytes.length > MaxCdpMessageBytes ||
        pendingInputBytes + bytes.length > pendingInputLimitBytes ||
        pendingInputMessages + 1 > pendingInputLimitMessages
      ) {
        void shutdown();
        return;
      }
      pendingInputBytes += bytes.length;
      pendingInputMessages += 1;
      incomingTail = incomingTail
        .then(async () => {
          if (revoked || activeClient !== client || !(await isAuthorized())) {
            await shutdown();
            return;
          }
          const decoded = await Effect.runPromise(
            decodeJsonObject(bytes.toString("utf8")).pipe(
              Effect.mapError(() =>
                relayError("client-protocol", "Client sent an invalid CDP message"),
              ),
            ),
          );
          if (revoked || activeClient !== client) return;
          await Effect.runPromise(options.engine.sendCdp(decoded));
        })
        .catch(() => shutdown())
        .then(() => {
          pendingInputBytes -= bytes.length;
          pendingInputMessages -= 1;
        });
    });
    client.on("error", () => {
      void shutdown();
    });
    client.on("close", () => {
      if (activeClient === client) void shutdown();
    });
  });

  recheckTimer = setInterval(() => {
    if (revoked) return;
    void isAuthorized().then((authorized) => {
      if (!authorized) void shutdown();
    });
  }, authorizationRecheckMs);
  recheckTimer.unref();

  yield* options.engine.exit.pipe(Effect.ensuring(Effect.promise(shutdown)), Effect.forkScoped);

  return {
    url: webSocketUrl,
    discoveryUrl: `http://${expectedHost}${tokenVersionPath}`,
    revoke,
  };
});
