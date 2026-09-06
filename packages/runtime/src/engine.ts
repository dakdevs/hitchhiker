import { NodeServices } from "@effect/platform-node";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Context, Deferred, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { FrameDecoder } from "./framing.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const Reply = Schema.Struct({ id: Schema.Int, result: Schema.Json });
const Failure = Schema.Struct({
  id: Schema.Int,
  error: Schema.Struct({ code: Schema.Union([Schema.String, Schema.Int]), message: Schema.String }),
});
const Event = Schema.Struct({ event: Schema.String, params: JsonObject });
const Message = Schema.Union([Reply, Failure, Event]);
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(Message));
const decodeCdp = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject));
const CdpMessageId = Schema.Struct({ id: Schema.Int });
const decodeCdpMessageId = Schema.decodeUnknownOption(CdpMessageId);
const CdpResult = Schema.Struct({ id: Schema.Int, result: Schema.Json });
const decodeCdpResult = Schema.decodeUnknownOption(CdpResult, { onExcessProperty: "error" });
const CdpFailure = Schema.Struct({
  id: Schema.Int,
  error: Schema.Struct({
    code: Schema.Union([Schema.String, Schema.Int]),
    message: Schema.String,
    data: Schema.optional(Schema.Json),
  }),
});
const decodeCdpFailure = Schema.decodeUnknownOption(CdpFailure, { onExcessProperty: "error" });
const LoadUnpackedResult = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-p]{32}$/)),
});
const decodeLoadUnpackedResult = Schema.decodeUnknownOption(LoadUnpackedResult, {
  onExcessProperty: "error",
});
const EmptyResult = Schema.Struct({});
const decodeEmptyResult = Schema.decodeUnknownOption(EmptyResult, { onExcessProperty: "error" });
const ExtensionInstallationId = /^[a-f0-9]{32}$/;
const ChromiumExtensionId = /^[a-p]{32}$/;
const InternalCdpRequestIdFloor = 2_147_000_000;
const InternalCdpRequestIdCeiling = 2_147_483_647;
const MaxPendingExtensionRequests = 8;
export type EngineEvent = typeof Event.Type;
export type JsonObject = typeof JsonObject.Type;

export interface RawCdpConnection {
  readonly events: Stream.Stream<JsonObject>;
  readonly send: (message: JsonObject) => Effect.Effect<void, EngineError>;
}

export class EngineError extends Schema.TaggedError<EngineError>()("EngineError", {
  code: Schema.String,
  message: Schema.String,
}) {}
const failure = (code: string, cause: unknown): EngineError =>
  new EngineError({
    code,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export interface EngineOptions {
  readonly executable: string;
  readonly profileRoot: string;
  readonly extensionManagement: boolean;
  readonly requestTimeoutMs?: number;
}

/** Trusted runtime service. Never hand this unrestricted connection to plugins. */
export class EngineConnection extends Context.Service<
  EngineConnection,
  {
    readonly pid: number;
    readonly ready: Effect.Effect<EngineEvent, EngineError>;
    readonly exit: Effect.Effect<number, EngineError>;
    readonly events: Stream.Stream<EngineEvent>;
    readonly request: (
      method: string,
      params?: JsonObject,
    ) => Effect.Effect<Schema.Json, EngineError>;
    readonly loadUnpacked: (
      canonicalArtifactDirectory: string,
    ) => Effect.Effect<string, EngineError>;
    readonly uninstall: (extensionId: string) => Effect.Effect<void, EngineError>;
    readonly claimRawCdp: Effect.Effect<RawCdpConnection, EngineError>;
  }
>()("@hitchhiker/runtime/EngineConnection") {
  static layer(options: EngineOptions) {
    return Layer.effect(
      EngineConnection,
      Effect.gen(function* () {
        const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
        if (
          !isAbsolute(options.executable) ||
          !isAbsolute(options.profileRoot) ||
          typeof options.extensionManagement !== "boolean" ||
          !Number.isSafeInteger(requestTimeoutMs) ||
          requestTimeoutMs <= 0
        ) {
          return yield* failure(
            "configuration",
            "Engine paths must be absolute and timeout must be positive",
          );
        }
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const outgoing = yield* Queue.bounded<Uint8Array>(64);
        const rawOutgoing = yield* Queue.bounded<Uint8Array>(4);
        const rawIncoming = yield* Queue.bounded<JsonObject>(4);
        const events = yield* PubSub.bounded<EngineEvent>({ capacity: 16 });
        const eventDelivery = yield* Queue.bounded<{ event: EngineEvent; bytes: number }>(64);
        let eventDeliveryBytes = 0;
        const ready = yield* Deferred.make<EngineEvent, EngineError>();
        const pending = new Map<number, Deferred.Deferred<Schema.Json, EngineError>>();
        const pendingExtension = new Map<number, Deferred.Deferred<JsonObject, EngineError>>();
        let sequence = 0;
        let extensionSequence = InternalCdpRequestIdCeiling;
        let cdpOwner: "management" | "uncertain" | "raw" = "management";
        let extensionOperations = 0;
        let stopped: EngineError | undefined;
        const stoppedError = () => stopped;
        const environment = Object.fromEntries(
          ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"].flatMap((name) =>
            process.env[name] === undefined ? [] : [[name, process.env[name]]],
          ),
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(
              options.executable,
              [
                "--host-ipc",
                "--remote-debugging-pipe",
                `--profile-root=${options.profileRoot}`,
                ...(options.extensionManagement ? ["--enable-unsafe-extension-debugging"] : []),
              ],
              {
                env: environment,
                extendEnv: false,
                stdin: Stream.fromQueue(outgoing),
                stdout: "pipe",
                stderr: "inherit",
                additionalFds: { fd3: { type: "input" }, fd4: { type: "output" } },
              },
            ),
          )
          .pipe(Effect.mapError((cause) => failure("spawn", cause)));

        const stop = Effect.fn("EngineConnection.stop")(function* (error: EngineError) {
          if (stopped) return;
          stopped = error;
          yield* Queue.shutdown(outgoing);
          yield* Queue.shutdown(rawOutgoing);
          yield* Queue.shutdown(rawIncoming);
          yield* Queue.shutdown(eventDelivery);
          yield* Deferred.fail(ready, error);
          for (const deferred of pending.values()) yield* Deferred.fail(deferred, error);
          pending.clear();
          for (const deferred of pendingExtension.values()) yield* Deferred.fail(deferred, error);
          pendingExtension.clear();
          yield* PubSub.shutdown(events);
        });
        yield* Effect.addFinalizer(() =>
          Effect.uninterruptible(stop(failure("closed", "Engine connection closed"))),
        );

        const readFrames = <E>(
          stream: Stream.Stream<Uint8Array, E>,
          delimiter: number,
          limit: number,
        ) => {
          const decoder = new FrameDecoder(delimiter, limit);
          return stream.pipe(
            Stream.mapError((cause) => failure("read", cause)),
            Stream.mapEffect((chunk) =>
              Effect.try({
                try: () => decoder.push(chunk),
                catch: (cause) => failure("framing", cause),
              }),
            ),
            Stream.flatMap((frames) => Stream.fromIterable(frames)),
            Stream.concat(
              Stream.fromEffect(
                Effect.try({
                  try: () => decoder.finish(),
                  catch: (cause) => failure("framing", cause),
                }),
              ).pipe(Stream.drain),
            ),
          );
        };
        // A subscriber may await a host command while consuming an event. Keep
        // delivery separate so that subscriber cannot block the command's reply.
        yield* Stream.fromQueue(eventDelivery).pipe(
          Stream.runForEach(({ event, bytes }) =>
            PubSub.publish(events, event).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  eventDeliveryBytes -= bytes;
                }),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        yield* readFrames(child.stdout, 10, 8 * 1024 * 1024).pipe(
          Stream.mapEffect((line) =>
            decodeMessage(line).pipe(
              Effect.map((message) => ({ message, bytes: Buffer.byteLength(line) })),
              Effect.mapError((cause) => failure("protocol", cause)),
            ),
          ),
          Stream.runForEach(({ message, bytes }) =>
            Effect.gen(function* () {
              if ("event" in message) {
                if (message.event === "host.ready") yield* Deferred.succeed(ready, message);
                if (
                  eventDeliveryBytes + bytes > 8 * 1024 * 1024 ||
                  !Queue.offerUnsafe(eventDelivery, { event: message, bytes })
                ) {
                  return yield* stop(
                    failure(
                      "event-capacity",
                      "Engine event consumer exceeded its bounded delivery queue",
                    ),
                  );
                }
                eventDeliveryBytes += bytes;
                return;
              }
              const deferred = pending.get(message.id);
              if (!deferred) return;
              if ("error" in message)
                yield* Deferred.fail(
                  deferred,
                  new EngineError({
                    code: String(message.error.code),
                    message: message.error.message,
                  }),
                );
              else yield* Deferred.succeed(deferred, message.result);
            }),
          ),
          Effect.catch(stop),
          Effect.ensuring(stop(failure("host-read-closed", "Engine host output closed"))),
          Effect.forkScoped,
        );
        yield* Stream.fromQueue(rawOutgoing).pipe(
          Stream.run(child.getInputFd(3)),
          Effect.mapError((cause) => failure("cdp-write", cause)),
          Effect.catch(stop),
          Effect.ensuring(stop(failure("cdp-write-closed", "CDP input pipe closed"))),
          Effect.forkScoped,
        );
        yield* readFrames(child.getOutputFd(4), 0, 32 * 1024 * 1024).pipe(
          Stream.mapEffect((line) =>
            decodeCdp(line).pipe(Effect.mapError((cause) => failure("cdp-protocol", cause))),
          ),
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              const decodedId = decodeCdpMessageId(message);
              if (
                Option.isSome(decodedId) &&
                decodedId.value.id >= InternalCdpRequestIdFloor &&
                decodedId.value.id <= InternalCdpRequestIdCeiling
              ) {
                const deferred = pendingExtension.get(decodedId.value.id);
                if (deferred) yield* Deferred.succeed(deferred, message);
                // Reserved replies without a pending trusted request are late or unsolicited.
                return;
              }
              if (cdpOwner === "raw") yield* Queue.offer(rawIncoming, message);
            }),
          ),
          Effect.catch(stop),
          Effect.ensuring(stop(failure("cdp-read-closed", "CDP output pipe closed"))),
          Effect.forkScoped,
        );
        const exit = child.exitCode.pipe(Effect.mapError((cause) => failure("exit", cause)));
        yield* exit.pipe(
          Effect.flatMap((code) => stop(failure("exit", `Engine exited with code ${code}`))),
          Effect.catch(stop),
          Effect.forkScoped,
        );

        const request = Effect.fn("EngineConnection.request")(function* (
          method: string,
          params: JsonObject = {},
        ): Effect.fn.Return<Schema.Json, EngineError> {
          const beforeEncode = stoppedError();
          if (beforeEncode) return yield* beforeEncode;
          if (pending.size >= 64 || sequence >= 2_147_483_647)
            return yield* failure("capacity", "Engine request capacity reached");
          const id = ++sequence;
          const bytes = yield* Effect.try({
            try: () => Buffer.from(`${JSON.stringify({ id, method, params })}\n`),
            catch: (cause) => failure("encode", cause),
          });
          if (bytes.length > 256 * 1024)
            return yield* failure("size", "Engine request exceeds 256 KiB");
          const deferred = yield* Deferred.make<Schema.Json, EngineError>();
          pending.set(id, deferred);
          const afterInsert = stoppedError();
          if (afterInsert) {
            pending.delete(id);
            return yield* afterInsert;
          }
          return yield* Effect.gen(function* () {
            if (!(yield* Queue.offer(outgoing, bytes)))
              return yield* failure("closed", "Engine input closed");
            return yield* Deferred.await(deferred);
          }).pipe(
            Effect.timeoutOrElse({
              duration: requestTimeoutMs,
              orElse: () => Effect.fail(failure("timeout", `Engine request timed out: ${method}`)),
            }),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id);
              }),
            ),
          );
        });
        const encodeCdp = (message: JsonObject) =>
          Effect.try({
            try: () => Buffer.from(`${JSON.stringify(message)}\0`),
            catch: (cause) => failure("encode", cause),
          });
        const offerCdp = Effect.fn("EngineConnection.offerCdp")(function* (
          message: JsonObject,
        ): Effect.fn.Return<void, EngineError> {
          const beforeEncode = stoppedError();
          if (beforeEncode) return yield* beforeEncode;
          const bytes = yield* encodeCdp(message);
          if (bytes.length > 32 * 1024 * 1024)
            return yield* failure("size", "CDP request exceeds 32 MiB");
          const beforeOffer = stoppedError();
          if (beforeOffer) return yield* beforeOffer;
          if (!(yield* Queue.offer(rawOutgoing, bytes)))
            return yield* failure("closed", "CDP pipe closed");
        });
        const validateArtifactDirectory = Effect.fn("EngineConnection.validateArtifactDirectory")(
          function* (directory: string): Effect.fn.Return<string, EngineError> {
            if (!options.extensionManagement)
              return yield* failure("extension-disabled", "Extension management is disabled");
            if (!isAbsolute(directory))
              return yield* failure("extension-path", "Extension artifact path is invalid");
            return yield* Effect.tryPromise({
              try: async () => {
                const profile = await realpath(options.profileRoot);
                const artifacts = await realpath(
                  join(profile, "hitchhiker-extensions", "artifacts"),
                );
                const resolved = await realpath(directory);
                const info = await lstat(directory);
                const child = relative(artifacts, resolved);
                if (
                  resolved !== directory ||
                  artifacts !== join(profile, "hitchhiker-extensions", "artifacts") ||
                  !info.isDirectory() ||
                  info.isSymbolicLink() ||
                  child.includes(sep) ||
                  !ExtensionInstallationId.test(child)
                ) {
                  throw new Error("invalid artifact path");
                }
                const descriptor = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                  const opened = await descriptor.stat();
                  if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino)
                    throw new Error("artifact was replaced");
                } finally {
                  await descriptor.close();
                }
                return resolved;
              },
              catch: () =>
                failure("extension-path", "Extension artifact path is invalid or unavailable"),
            });
          },
        );
        const extensionRequest = Effect.fn("EngineConnection.extensionRequest")(function* <A>(
          method: "Extensions.loadUnpacked" | "Extensions.uninstall",
          params: JsonObject,
          decodeResult: (value: unknown) => A | undefined,
        ): Effect.fn.Return<A, EngineError> {
          if (!options.extensionManagement)
            return yield* failure("extension-disabled", "Extension management is disabled");
          if (cdpOwner === "raw")
            return yield* failure("cdp-owned", "Raw CDP already owns the browser pipe");
          if (cdpOwner === "uncertain")
            return yield* failure(
              "extension-uncertain",
              "An extension operation has an uncertain result; restart the engine",
            );
          if (
            pendingExtension.size >= MaxPendingExtensionRequests ||
            extensionSequence < InternalCdpRequestIdFloor
          )
            return yield* failure("capacity", "Extension request capacity reached");
          const id = extensionSequence--;
          const deferred = yield* Deferred.make<JsonObject, EngineError>();
          pendingExtension.set(id, deferred);
          let sent = false;
          let certain = false;
          return yield* Effect.gen(function* () {
            // Queue.offer is interruptible. Mark the outcome uncertain before crossing that
            // boundary so cancellation cannot hand the browser pipe to a raw client after a
            // mutation may have been enqueued.
            sent = true;
            yield* offerCdp({ id, method, params });
            const message = yield* Deferred.await(deferred).pipe(
              Effect.timeoutOrElse({
                duration: requestTimeoutMs,
                orElse: () =>
                  Effect.fail(
                    failure(
                      "extension-uncertain",
                      "Extension operation timed out; restart the engine",
                    ),
                  ),
              }),
            );
            const rejected = decodeCdpFailure(message);
            if (Option.isSome(rejected) && rejected.value.id === id) {
              certain = true;
              return yield* failure(
                "extension-rejected",
                "Chromium rejected the extension operation",
              );
            }
            const reply = decodeCdpResult(message);
            if (Option.isNone(reply) || reply.value.id !== id)
              return yield* failure(
                "extension-uncertain",
                "Chromium returned an invalid extension response; restart the engine",
              );
            const result = decodeResult(reply.value.result);
            if (result === undefined)
              return yield* failure(
                "extension-uncertain",
                "Chromium returned an invalid extension result; restart the engine",
              );
            certain = true;
            return result;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                pendingExtension.delete(id);
                if (sent && !certain && cdpOwner === "management") cdpOwner = "uncertain";
              }),
            ),
          );
        });
        const runExtensionOperation = <A>(effect: Effect.Effect<A, EngineError>) =>
          Effect.suspend(() => {
            extensionOperations += 1;
            return effect.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  extensionOperations -= 1;
                }),
              ),
            );
          });
        const loadUnpacked = Effect.fn("EngineConnection.loadUnpacked")(function* (
          directory: string,
        ) {
          return yield* runExtensionOperation(
            Effect.gen(function* () {
              const path = yield* validateArtifactDirectory(directory);
              return yield* extensionRequest("Extensions.loadUnpacked", { path }, (value) => {
                const decoded = decodeLoadUnpackedResult(value);
                return Option.isSome(decoded) ? decoded.value.id : undefined;
              });
            }),
          );
        });
        const uninstall = Effect.fn("EngineConnection.uninstall")(function* (extensionId: string) {
          if (!ChromiumExtensionId.test(extensionId))
            return yield* failure("extension-id", "Chromium extension ID is invalid");
          return yield* runExtensionOperation(
            extensionRequest("Extensions.uninstall", { id: extensionId }, (value) =>
              Option.isSome(decodeEmptyResult(value)) ? true : undefined,
            ).pipe(Effect.asVoid),
          );
        });
        const rawSend = Effect.fn("EngineConnection.rawCdpSend")(function* (message: JsonObject) {
          if (cdpOwner !== "raw") return yield* failure("cdp-owned", "Raw CDP is not active");
          if (
            message.method === "Extensions.loadUnpacked" ||
            message.method === "Extensions.uninstall" ||
            message.method === "Target.sendMessageToTarget"
          )
            return yield* failure("cdp-reserved-method", "CDP method is reserved");
          const decodedId = decodeCdpMessageId(message);
          if (
            Option.isSome(decodedId) &&
            decodedId.value.id >= InternalCdpRequestIdFloor &&
            decodedId.value.id <= InternalCdpRequestIdCeiling
          )
            return yield* failure("cdp-reserved-id", "CDP request ID is reserved");
          yield* offerCdp(message);
        });
        const claimRawCdp = Effect.suspend(() => {
          const stoppedNow = stoppedError();
          if (stoppedNow) return stoppedNow;
          if (cdpOwner === "uncertain")
            return failure(
              "extension-uncertain",
              "An extension operation has an uncertain result; restart the engine",
            );
          if (cdpOwner === "raw") return failure("cdp-owned", "Raw CDP is already claimed");
          if (extensionOperations !== 0 || pendingExtension.size !== 0)
            return failure("cdp-owned", "Extension operations are still pending");
          cdpOwner = "raw";
          return Effect.succeed({
            events: Stream.fromQueue(rawIncoming).pipe(Stream.catchCause(() => Stream.empty)),
            send: rawSend,
          } satisfies RawCdpConnection);
        });
        return EngineConnection.of({
          pid: child.pid,
          ready: Deferred.await(ready).pipe(
            Effect.timeoutOrElse({
              duration: 30_000,
              orElse: () => Effect.fail(failure("startup", "Engine did not become ready")),
            }),
          ),
          exit,
          events: Stream.fromPubSub(events),
          request,
          loadUnpacked,
          uninstall,
          claimRawCdp,
        });
      }),
    ).pipe(Layer.provide(NodeServices.layer));
  }
}
