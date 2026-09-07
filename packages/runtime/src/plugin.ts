import { isAbsolute } from "node:path";
import { Deferred, Effect, PubSub, Queue, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { FrameDecoder } from "./framing.ts";
import { PluginCallError } from "./plugin-dispatch.ts";

const ObjectValue = Schema.Record(Schema.String, Schema.Json);
const Identifier = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Event = Schema.Struct({ event: Schema.String, params: ObjectValue });
const Message = Schema.Union([
  Event,
  Schema.Struct({ id: Identifier, result: Schema.Json }),
  Schema.Struct({
    id: Identifier,
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
]);
const Call = Schema.Struct({
  callId: Identifier,
  method: Schema.String.check(Schema.isMaxLength(128)),
  params: ObjectValue,
});
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(Message));
const decodeCall = Schema.decodeUnknownEffect(Call, { onExcessProperty: "error" });
export class PluginHostError extends Schema.TaggedError<PluginHostError>()("PluginHostError", {
  code: Schema.String,
  message: Schema.String,
}) {}
const fail = (code: string, message: string) => new PluginHostError({ code, message });
const publicCallFailure = (error: unknown) => {
  if (error instanceof PluginCallError) {
    if (error.code === "conflict")
      return { code: "conflict", message: "Plugin storage revision changed" };
    if (error.code === "stale-snapshot")
      return {
        code: "stale-snapshot",
        message: "Page snapshot changed; restart from offset zero",
      };
  }
  return {
    code: "denied",
    message: "Operation was denied or could not complete",
  };
};

export interface PluginHostOptions {
  readonly executable: string;
  /** This closure captures the installed identity and enforces grants for every operation. */
  readonly call: (
    method: string,
    params: typeof ObjectValue.Type,
  ) => Effect.Effect<Schema.Json, unknown>;
}

/** Private transport for one isolated plugin. No executable path or identity comes from plugin code. */
export const spawnPluginHost = Effect.fn("spawnPluginHost")(function* (options: PluginHostOptions) {
  if (!isAbsolute(options.executable))
    return yield* fail("configuration", "Plugin host executable must be absolute");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outgoing = yield* Queue.bounded<Uint8Array>(32);
  const calls = yield* Queue.bounded<{ call: typeof Call.Type; bytes: number }>(32);
  const events = yield* PubSub.sliding<typeof Event.Type>({ capacity: 16 });
  const pending = new Map<number, Deferred.Deferred<Schema.Json, PluginHostError>>();
  let sequence = 0;
  let activated = false;
  let workerStarted = false;
  let callsReceived = 0;
  let callsCompleted = 0;
  let callPhase: "idle" | "dispatch" | "resolve" = "idle";
  let outgoingBytes = 0;
  let callBytes = 0;
  let stopped: PluginHostError | undefined;
  const termination = yield* Deferred.make<never, PluginHostError>();
  const child = yield* spawner
    .spawn(
      ChildProcess.make(options.executable, [], {
        env: Object.fromEntries(
          ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"].flatMap((key) =>
            process.env[key] === undefined ? [] : [[key, process.env[key]]],
          ),
        ),
        extendEnv: false,
        stdin: Stream.fromQueue(outgoing).pipe(
          Stream.tap((bytes) =>
            Effect.sync(() => {
              outgoingBytes -= bytes.length;
            }),
          ),
        ),
        stdout: "pipe",
        stderr: "inherit",
      }),
    )
    .pipe(Effect.mapError(() => fail("spawn", "Could not start isolated plugin host")));
  const stop = Effect.fn("PluginHost.stop")(function* (error: PluginHostError) {
    if (stopped) return;
    stopped = error;
    yield* Deferred.fail(termination, error);
    for (const deferred of pending.values()) yield* Deferred.fail(deferred, error);
    pending.clear();
    yield* Queue.shutdown(outgoing);
    yield* Queue.shutdown(calls);
    yield* PubSub.shutdown(events);
  }, Effect.uninterruptible);
  yield* Effect.addFinalizer(() => stop(fail("closed", "Plugin host scope closed")));
  const request = Effect.fn("PluginHost.request")(function* (
    method: "activate" | "event" | "resolve" | "stop",
    params: typeof ObjectValue.Type = {},
  ): Effect.fn.Return<Schema.Json, PluginHostError> {
    if (stopped) return yield* stopped;
    if (pending.size >= 32 || sequence >= Number.MAX_SAFE_INTEGER)
      return yield* fail("capacity", "Plugin request limit reached");
    const id = ++sequence;
    const bytes = yield* Effect.try({
      try: () => Buffer.from(`${JSON.stringify({ id, method, params })}\n`),
      catch: () => fail("encode", "Plugin message is not JSON"),
    });
    if (bytes.length > 1024 * 1024 || outgoingBytes + bytes.length > 8 * 1024 * 1024)
      return yield* fail("capacity", "Plugin input buffer limit reached");
    const deferred = yield* Deferred.make<Schema.Json, PluginHostError>();
    pending.set(id, deferred);
    outgoingBytes += bytes.length;
    if (!Queue.offerUnsafe(outgoing, bytes)) {
      outgoingBytes -= bytes.length;
      pending.delete(id);
      return yield* fail("capacity", "Plugin input queue is full");
    }
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({
        duration: 5000,
        orElse: () =>
          Effect.fail(
            fail(
              "timeout",
              `Plugin host did not reply to ${method} (worker=${workerStarted ? "started" : "unconfirmed"}, calls=${callsReceived}/${callsCompleted}, phase=${callPhase})`,
            ),
          ),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          pending.delete(id);
        }),
      ),
    );
  });
  // Never await a plugin call while reading its replies: resolving a Promise can itself issue calls.
  yield* Stream.fromQueue(calls).pipe(
    Stream.runForEach(({ call, bytes }) =>
      Effect.sync(() => {
        callPhase = "dispatch";
      }).pipe(
        Effect.andThen(Effect.suspend(() => options.call(call.method, call.params))),
        Effect.timeoutOrElse({ duration: 4000, orElse: () => Effect.fail("timeout") }),
        Effect.onExit(() =>
          Effect.sync(() => {
            callPhase = "resolve";
          }),
        ),
        Effect.matchEffect({
          onFailure: (error) =>
            request("resolve", {
              callId: call.callId,
              error: publicCallFailure(error),
            }),
          onSuccess: (result) => request("resolve", { callId: call.callId, result }),
        }),
        Effect.tap(() =>
          Effect.sync(() => {
            callsCompleted = Math.min(callsCompleted + 1, Number.MAX_SAFE_INTEGER);
          }),
        ),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            callPhase = "idle";
            callBytes -= bytes;
          }),
        ),
      ),
    ),
    Effect.catch(stop),
    Effect.forkScoped,
  );
  const decoder = new FrameDecoder(10, 1024 * 1024);
  yield* child.stdout.pipe(
    Stream.mapError(() => fail("read", "Plugin output failed")),
    Stream.mapEffect((chunk) =>
      Effect.try({
        try: () => decoder.push(chunk),
        catch: () => fail("framing", "Invalid plugin output framing"),
      }),
    ),
    Stream.flatMap(Stream.fromIterable),
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        const message = yield* decodeMessage(line).pipe(
          Effect.mapError(() => fail("protocol", "Invalid plugin output")),
        );
        if ("id" in message) {
          const deferred = pending.get(message.id);
          if (deferred) {
            if ("error" in message)
              yield* Deferred.fail(deferred, fail(message.error.code, message.error.message));
            else yield* Deferred.succeed(deferred, message.result);
          }
        } else if (message.event === "plugin.resource" || message.event === "plugin.crash") {
          // The broker may stay alive after its worker dies. Remember the terminal state before
          // any subscriber attaches, including while activation or onReady is still pending.
          yield* stop(
            message.event === "plugin.resource"
              ? fail("resource", "Plugin worker was stopped by its resource watchdog")
              : fail("crash", "Plugin worker exited unexpectedly"),
          );
        } else if (message.event === "plugin.call") {
          const call = yield* decodeCall(message.params).pipe(
            Effect.mapError(() => fail("protocol", "Invalid plugin call")),
          );
          const bytes = Buffer.byteLength(line);
          if (callBytes + bytes > 8 * 1024 * 1024 || !Queue.offerUnsafe(calls, { call, bytes }))
            return yield* fail("capacity", "Plugin call queue limit reached");
          callBytes += bytes;
          callsReceived = Math.min(callsReceived + 1, Number.MAX_SAFE_INTEGER);
        } else {
          if (message.event === "plugin.started") workerStarted = true;
          yield* PubSub.publish(events, message);
        }
      }),
    ),
    Effect.catch(stop),
    Effect.ensuring(stop(fail("closed", "Plugin output closed"))),
    Effect.forkScoped,
  );
  yield* child.exitCode.pipe(
    Effect.flatMap(() => stop(fail("exit", "Plugin host exited"))),
    Effect.catch(() => stop(fail("exit", "Plugin host exit failed"))),
    Effect.forkScoped,
  );
  const activate = Effect.fn("PluginHost.activate")(function* (code: string) {
    if (activated)
      return yield* fail("lifecycle", "Create a new isolated host for each plugin revision");
    if (Buffer.byteLength(code) > 512 * 1024)
      return yield* fail("size", "Compiled plugin exceeds 512 KiB");
    activated = true;
    return yield* request("activate", { code });
  });
  return {
    events: Stream.fromPubSub(events),
    failure: Deferred.await(termination),
    activate,
    sendEvent: (event: string, payload: Schema.Json) => request("event", { event, payload }),
    stop: request("stop"),
  };
});
