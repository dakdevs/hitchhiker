import { NodeServices } from "@effect/platform-node";
import { isAbsolute } from "node:path";
import { Context, Deferred, Effect, Layer, PubSub, Queue, Schema, Stream } from "effect";
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
export type EngineEvent = typeof Event.Type;
export type JsonObject = typeof JsonObject.Type;

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
    readonly cdpEvents: Stream.Stream<JsonObject>;
    readonly request: (
      method: string,
      params?: JsonObject,
    ) => Effect.Effect<Schema.Json, EngineError>;
    readonly sendCdp: (message: JsonObject) => Effect.Effect<void, EngineError>;
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
        const events = yield* PubSub.bounded<EngineEvent>({ capacity: 16 });
        const eventDelivery = yield* Queue.bounded<{ event: EngineEvent; bytes: number }>(64);
        let eventDeliveryBytes = 0;
        const cdpEvents = yield* PubSub.bounded<JsonObject>({ capacity: 4 });
        const ready = yield* Deferred.make<EngineEvent, EngineError>();
        const pending = new Map<number, Deferred.Deferred<Schema.Json, EngineError>>();
        let sequence = 0;
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
              ["--host-ipc", "--remote-debugging-pipe", `--profile-root=${options.profileRoot}`],
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
          yield* Queue.shutdown(eventDelivery);
          yield* Deferred.fail(ready, error);
          for (const deferred of pending.values()) yield* Deferred.fail(deferred, error);
          pending.clear();
          yield* PubSub.shutdown(events);
          yield* PubSub.shutdown(cdpEvents);
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
          Stream.runForEach((message) => PubSub.publish(cdpEvents, message)),
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
        const sendCdp = Effect.fn("EngineConnection.sendCdp")(function* (
          message: JsonObject,
        ): Effect.fn.Return<void, EngineError> {
          const beforeEncode = stoppedError();
          if (beforeEncode) return yield* beforeEncode;
          const bytes = yield* Effect.try({
            try: () => Buffer.from(`${JSON.stringify(message)}\0`),
            catch: (cause) => failure("encode", cause),
          });
          if (bytes.length > 32 * 1024 * 1024)
            return yield* failure("size", "CDP request exceeds 32 MiB");
          const beforeOffer = stoppedError();
          if (beforeOffer) return yield* beforeOffer;
          if (!(yield* Queue.offer(rawOutgoing, bytes)))
            return yield* failure("closed", "CDP pipe closed");
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
          cdpEvents: Stream.fromPubSub(cdpEvents),
          request,
          sendCdp,
        });
      }),
    ).pipe(Layer.provide(NodeServices.layer));
  }
}
