import { isAbsolute } from "node:path";
import { Deferred, Effect, Fiber, PubSub, Queue, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { FrameDecoder } from "./framing.ts";
import { PluginCallError } from "./plugin-dispatch.ts";

const ObjectValue = Schema.Record(Schema.String, Schema.Json);
const Identifier = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Event = Schema.Struct({ event: Schema.String, params: ObjectValue });
const Positive = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const StartAbstime = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]*$/),
  Schema.makeFilter(
    (value) => value.length < 20 || (value.length === 20 && value <= "18446744073709551615"),
  ),
);
const ByteCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const WorkerIdentitySchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2_147_483_647)),
  generation: Positive,
  startAbstime: StartAbstime,
});
export type WorkerIdentity = typeof WorkerIdentitySchema.Type;
export const WorkerUsageSchema = Schema.Struct({
  identity: WorkerIdentitySchema,
  physicalFootprintBytes: ByteCount,
  residentBytes: ByteCount,
});
export type WorkerUsage = typeof WorkerUsageSchema.Type;
const HostControl = Schema.Struct({
  hostControl: Schema.Union([
    Schema.Struct({ event: Schema.Literal("worker.started"), identity: WorkerIdentitySchema }),
    Schema.Struct({ event: Schema.Literal("worker.stopped"), identity: WorkerIdentitySchema }),
    Schema.Struct({
      id: Positive,
      result: WorkerUsageSchema,
    }),
    Schema.Struct({
      id: Positive,
      error: Schema.Struct({ code: Schema.Literals(["stale_worker", "unavailable"]) }),
    }),
  ]),
});
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
const Incoming = Schema.Union([HostControl, Message]);
const decodeIncoming = Schema.decodeUnknownEffect(Schema.fromJsonString(Incoming), {
  onExcessProperty: "error",
});
const decodeCall = Schema.decodeUnknownEffect(Call, { onExcessProperty: "error" });
export class PluginHostError extends Schema.TaggedError<PluginHostError>()("PluginHostError", {
  code: Schema.String,
  message: Schema.String,
}) {}
const fail = (code: string, message: string) => new PluginHostError({ code, message });
const publicPluginCallFailures: Readonly<
  Record<PluginCallError["code"], { readonly code: string; readonly message: string }>
> = {
  conflict: { code: "conflict", message: "Plugin storage revision changed" },
  denied: { code: "denied", message: "Operation was denied or could not complete" },
  "stale-snapshot": {
    code: "stale-snapshot",
    message: "Page snapshot changed; restart from offset zero",
  },
  not_authorized: {
    code: "not_authorized",
    message: "DOM access is not authorized for this page.",
  },
  page_gone: { code: "page_gone", message: "The target page is no longer available." },
  stale_ref: { code: "stale_ref", message: "The DOM reference is stale; take a new snapshot." },
  covered: { code: "covered", message: "The target element cannot be safely activated." },
  unsupported: {
    code: "unsupported",
    message: "The target element does not support this operation.",
  },
  limit: { code: "limit", message: "The DOM operation exceeds a supported limit." },
  browser_error: {
    code: "browser_error",
    message: "The browser could not complete the DOM operation.",
  },
};
const publicCallFailure = (error: unknown) => {
  if (error instanceof PluginCallError) {
    const failure = publicPluginCallFailures[error.code];
    if (failure) return failure;
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
export interface TrustedPluginWorkerDiagnostics {
  readonly started: Effect.Effect<WorkerIdentity, PluginHostError>;
  readonly stopped: (identity: WorkerIdentity) => Effect.Effect<void, PluginHostError>;
  readonly sample: (identity: WorkerIdentity) => Effect.Effect<WorkerUsage, PluginHostError>;
}

/** Private transport for one isolated plugin. No executable path or identity comes from plugin code. */
export const spawnPluginHost = Effect.fn("spawnPluginHost")(function* (options: PluginHostOptions) {
  if (!isAbsolute(options.executable))
    return yield* fail("configuration", "Plugin host executable must be absolute");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outgoing = yield* Queue.bounded<Uint8Array>(32);
  const calls = yield* Queue.bounded<{ call: typeof Call.Type; bytes: number }>(32);
  const events = yield* PubSub.sliding<typeof Event.Type>({ capacity: 16 });
  const diagnosticStarted = yield* Deferred.make<WorkerIdentity, PluginHostError>();
  const diagnosticStopped = new Map<string, Deferred.Deferred<void, PluginHostError>>();
  const observedStops = new Set<string>();
  const pending = new Map<number, Deferred.Deferred<Schema.Json, PluginHostError>>();
  const pendingDiagnostics = new Map<number, Deferred.Deferred<WorkerUsage, PluginHostError>>();
  let sequence = 0;
  let diagnosticSequence = 0;
  let workerIdentity: WorkerIdentity | undefined;
  let diagnosticWorkerStarted = false;
  let activated = false;
  let workerStarted = false;
  let callsReceived = 0;
  let callsCompleted = 0;
  let callPhase: "idle" | "dispatch" | "resolve" = "idle";
  let outgoingBytes = 0;
  let callBytes = 0;
  let stopped: PluginHostError | undefined;
  let stopping = false;
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
    for (const deferred of pendingDiagnostics.values()) yield* Deferred.fail(deferred, error);
    pendingDiagnostics.clear();
    yield* Queue.shutdown(outgoing);
    yield* Queue.shutdown(calls);
    yield* PubSub.shutdown(events);
    yield* Deferred.fail(diagnosticStarted, error).pipe(Effect.catch(() => Effect.void));
    for (const deferred of diagnosticStopped.values()) yield* Deferred.fail(deferred, error);
    diagnosticStopped.clear();
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
  const sameIdentity = (left: WorkerIdentity | undefined, right: WorkerIdentity) =>
    left?.pid === right.pid &&
    left.generation === right.generation &&
    left.startAbstime === right.startAbstime;
  const sample = Effect.fn("PluginHost.sampleWorker")(function* (identity: WorkerIdentity) {
    if (stopped) return yield* stopped;
    if (!sameIdentity(workerIdentity, identity))
      return yield* fail("stale_worker", "Worker identity is no longer current");
    if (pendingDiagnostics.size >= 8 || diagnosticSequence >= Number.MAX_SAFE_INTEGER)
      return yield* fail("capacity", "Worker diagnostic request limit reached");
    const id = ++diagnosticSequence;
    const bytes = Buffer.from(
      `${JSON.stringify({ hostControl: { id, method: "worker.sample", identity } })}\n`,
    );
    if (bytes.length > 1024 * 1024 || outgoingBytes + bytes.length > 8 * 1024 * 1024)
      return yield* fail("capacity", "Worker diagnostic input buffer limit reached");
    const deferred = yield* Deferred.make<WorkerUsage, PluginHostError>();
    pendingDiagnostics.set(id, deferred);
    outgoingBytes += bytes.length;
    if (!Queue.offerUnsafe(outgoing, bytes)) {
      outgoingBytes -= bytes.length;
      pendingDiagnostics.delete(id);
      return yield* fail("capacity", "Worker diagnostic input queue is full");
    }
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({
        duration: 2_000,
        orElse: () => Effect.fail(fail("timeout", "Worker diagnostic sample timed out")),
      }),
      Effect.flatMap((result) =>
        sameIdentity(workerIdentity, identity) && sameIdentity(result.identity, identity)
          ? Effect.succeed(result)
          : Effect.fail(fail("stale_worker", "Worker identity changed while sampling")),
      ),
      Effect.ensuring(Effect.sync(() => pendingDiagnostics.delete(id))),
    );
  });
  const identityKey = (identity: WorkerIdentity) =>
    `${identity.pid}\u0000${identity.generation}\u0000${identity.startAbstime}`;
  const observeStopped = (identity: WorkerIdentity) =>
    Effect.suspend(() => {
      const key = identityKey(identity);
      if (observedStops.has(key)) return Effect.void;
      if (stopped) return Effect.fail(stopped);
      if (!sameIdentity(workerIdentity, identity))
        return Effect.fail(fail("stale_worker", "Worker identity is no longer current"));
      const existing = diagnosticStopped.get(key);
      if (existing) return Deferred.await(existing);
      return Effect.gen(function* () {
        const deferred = yield* Deferred.make<void, PluginHostError>();
        diagnosticStopped.set(key, deferred);
        return yield* Deferred.await(deferred);
      });
    });
  const handleControl = Effect.fn("PluginHost.handleControl")(function* (
    control: typeof HostControl.Type,
  ) {
    const value = control.hostControl;
    if ("event" in value) {
      if (value.event === "worker.started") {
        if (diagnosticWorkerStarted)
          return yield* stop(fail("protocol", "Duplicate worker diagnostic start"));
        diagnosticWorkerStarted = true;
        workerIdentity = value.identity;
        yield* Deferred.succeed(diagnosticStarted, value.identity).pipe(
          Effect.catch(() => Effect.void),
        );
        return;
      }
      if (!sameIdentity(workerIdentity, value.identity))
        return yield* stop(fail("protocol", "Mismatched worker diagnostic stop"));
      workerIdentity = undefined;
      const key = identityKey(value.identity);
      observedStops.add(key);
      const deferred = diagnosticStopped.get(key);
      if (deferred) yield* Deferred.succeed(deferred, undefined);
      diagnosticStopped.delete(key);
      return;
    }
    const deferred = pendingDiagnostics.get(value.id);
    if (!deferred) return;
    if ("error" in value)
      return yield* Deferred.fail(
        deferred,
        fail(
          value.error.code,
          value.error.code === "stale_worker"
            ? "Worker identity is stale"
            : "Worker diagnostics are unavailable",
        ),
      );
    if (!sameIdentity(workerIdentity, value.result.identity))
      return yield* Deferred.fail(
        deferred,
        fail("stale_worker", "Worker identity changed while sampling"),
      );
    yield* Deferred.succeed(deferred, value.result);
  });
  // Never await a plugin call while reading its replies: resolving a Promise can itself issue calls.
  const dispatchFiber = yield* Stream.fromQueue(calls).pipe(
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
        const incoming = yield* decodeIncoming(line).pipe(
          Effect.mapError(() => fail("protocol", "Invalid plugin output")),
        );
        if ("hostControl" in incoming) return yield* handleControl(incoming);
        const message = incoming;
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
          if (stopping) return;
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
    Effect.catch((error) =>
      stop(fail("read", error instanceof PluginHostError ? error.message : "Plugin output failed")),
    ),
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
  const gracefulStop = yield* Effect.cached(
    Effect.gen(function* () {
      stopping = true;
      // Cancel host-call work before the worker exits; no late resolve may poison its stop event.
      yield* Fiber.interrupt(dispatchFiber);
      const identity = workerIdentity;
      yield* request("stop");
      // The reply acknowledges the command; the broker separately confirms process exit.
      if (identity !== undefined) yield* observeStopped(identity);
    }),
  );
  return {
    events: Stream.fromPubSub(events),
    failure: Deferred.await(termination),
    diagnostics: {
      started: Deferred.await(diagnosticStarted).pipe(
        Effect.timeoutOrElse({
          duration: 5_000,
          orElse: () =>
            Effect.fail(fail("unavailable", "Worker diagnostic identity is unavailable")),
        }),
      ),
      stopped: observeStopped,
      sample,
    },
    activate,
    sendEvent: (event: string, payload: Schema.Json) => request("event", { event, payload }),
    stop: gracefulStop,
  };
});
