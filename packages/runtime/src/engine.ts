import { NodeServices } from "@effect/platform-node";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  Context,
  Cause,
  Channel,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Schema,
  Scope,
  Stream,
  Take,
} from "effect";
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
const CdpSessionResult = Schema.Struct({
  id: Schema.Int,
  result: Schema.Json,
  sessionId: Schema.String,
});
const decodeCdpSessionResult = Schema.decodeUnknownOption(CdpSessionResult, {
  onExcessProperty: "error",
});
const CdpSessionFailure = Schema.Struct({
  id: Schema.Int,
  sessionId: Schema.String,
  error: Schema.Struct({
    code: Schema.Union([Schema.String, Schema.Int]),
    message: Schema.String,
    data: Schema.optional(Schema.Json),
  }),
});
const decodeCdpSessionFailure = Schema.decodeUnknownOption(CdpSessionFailure, {
  onExcessProperty: "error",
});
const CdpAttachedSession = Schema.Struct({
  sessionId: Schema.NonEmptyString,
});
const decodeCdpAttachedSession = Schema.decodeUnknownOption(CdpAttachedSession, {
  onExcessProperty: "error",
});
const CdpDetachedSession = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  targetId: Schema.optional(Schema.String),
});
const decodeCdpDetachedSession = Schema.decodeUnknownOption(CdpDetachedSession, {
  onExcessProperty: "error",
});
const CdpSessionEvent = Schema.Struct({
  method: Schema.NonEmptyString,
  params: Schema.optional(JsonObject),
  sessionId: Schema.NonEmptyString,
});
const decodeCdpSessionEvent = Schema.decodeUnknownOption(CdpSessionEvent, {
  onExcessProperty: "preserve",
});
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
const MaxPendingSessionRequests = 32;
const MaxSessionEvents = 32;
const MaxManagedSessions = 8;
const MaxSessionEventBytes = 256 * 1024;
export type EngineEvent = typeof Event.Type;
export type JsonObject = typeof JsonObject.Type;

export interface ManagedCdpEvent {
  readonly method: string;
  readonly params: JsonObject;
}

/** A trusted, engine-owned flattened CDP page session. This is not a public relay. */
export interface ManagedCdpSession {
  readonly events: Stream.Stream<ManagedCdpEvent, EngineError>;
  readonly request: (
    method: string,
    params?: JsonObject,
  ) => Effect.Effect<Schema.Json, EngineError>;
  readonly close: Effect.Effect<void, EngineError>;
}

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
  /** Bounds delivery of already parsed host events when the engine exits. */
  readonly eventDrainTimeoutMs?: number;
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
    /** Opens a scoped, trusted page session. Callers must never pass untrusted target IDs here. */
    readonly openCdpSession: (
      targetId: string,
    ) => Effect.Effect<ManagedCdpSession, EngineError, Scope.Scope>;
    readonly claimRawCdp: Effect.Effect<RawCdpConnection, EngineError>;
  }
>()("@hitchhiker/runtime/EngineConnection") {
  static layer(options: EngineOptions) {
    return Layer.effect(
      EngineConnection,
      Effect.gen(function* () {
        const engineScope = yield* Effect.scope;
        const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
        const eventDrainTimeoutMs = options.eventDrainTimeoutMs ?? 5_000;
        if (
          !isAbsolute(options.executable) ||
          !isAbsolute(options.profileRoot) ||
          typeof options.extensionManagement !== "boolean" ||
          !Number.isSafeInteger(requestTimeoutMs) ||
          requestTimeoutMs <= 0 ||
          !Number.isSafeInteger(eventDrainTimeoutMs) ||
          eventDrainTimeoutMs < 50 ||
          eventDrainTimeoutMs > 60_000
        ) {
          return yield* failure(
            "configuration",
            "Engine paths must be absolute and timeouts must be valid",
          );
        }
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const outgoing = yield* Queue.bounded<Uint8Array>(64);
        const rawOutgoing = yield* Queue.bounded<Uint8Array>(4);
        const rawIncoming = yield* Queue.bounded<JsonObject>(4);
        type QueuedEvent = { readonly event: EngineEvent; readonly bytes: number };
        const eventTakes = yield* PubSub.bounded<Take.Take<EngineEvent>>({
          capacity: 16,
        });
        // Queue.end closes this queue at EOF without discarding its FIFO contents.
        const eventDelivery = yield* Queue.bounded<QueuedEvent, Cause.Done>(64);
        let eventDeliveryBytes = 0;
        const ready = yield* Deferred.make<EngineEvent, EngineError>();
        const pending = new Map<number, Deferred.Deferred<Schema.Json, EngineError>>();
        const pendingExtension = new Map<number, Deferred.Deferred<JsonObject, EngineError>>();
        type PendingSession = {
          readonly sessionId?: string;
          readonly ownerSessionId?: string;
          readonly method: string;
          readonly deferred: Deferred.Deferred<JsonObject, EngineError>;
        };
        type ManagedSessionState = {
          readonly sessionId: string;
          readonly events: Queue.Queue<ManagedCdpEvent, Cause.Done>;
          readonly pending: Set<number>;
          readonly terminal: Deferred.Deferred<void, EngineError>;
          readonly closeDone: Deferred.Deferred<void, EngineError>;
          closed: boolean;
          closing: boolean;
          subscribed: boolean;
        };
        const pendingSession = new Map<number, PendingSession>();
        const externallyDetachedPending = new Set<number>();
        const attachingSessionIds = new Set<string>();
        const pendingAttachEvents = new Map<string, ManagedCdpEvent[]>();
        const pendingAttachErrors = new Map<string, EngineError>();
        const detachedAttachments = new Set<string>();
        const managedSessions = new Map<string, ManagedSessionState>();
        let sequence = 0;
        let extensionSequence = InternalCdpRequestIdCeiling;
        let sessionSequence = 0;
        let managedOperations = 0;
        let cdpOwner: "management" | "uncertain" | "raw" = "management";
        let unknownAttachment = false;
        const uncertainSessionIds = new Set<string>();
        const retainAttachingSession = (sessionId: string) => {
          if (attachingSessionIds.has(sessionId)) return true;
          if (managedOperations === 0) return false;
          if (attachingSessionIds.size >= MaxManagedSessions) {
            unknownAttachment = true;
            return false;
          }
          attachingSessionIds.add(sessionId);
          return true;
        };
        let extensionOperations = 0;
        let stopped: EngineError | undefined;
        let childExitCode: number | undefined;
        let hostFinished = false;
        let acceptingEventSubscribers = true;
        let eventTerminalError: EngineError | undefined;
        let eventConsumerError: EngineError | undefined;
        let drainCoordinatorStarted = false;
        let nextEventSubscriber = 0;
        const preterminalSubscribers = new Set<number>();
        const eventDeliveryDone = yield* Deferred.make<void, EngineError>();
        const subscribersDrained = yield* Deferred.make<void, never>();
        const childExitObserved = yield* Deferred.make<void, never>();
        const hostEofObserved = yield* Deferred.make<void, never>();
        const logicalExit = yield* Deferred.make<number, EngineError>();
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
                // The process spawner otherwise waits indefinitely for SIGTERM during
                // scoped release. A host that never reaches `host.ready` must still
                // release its process group when startup is interrupted.
                forceKillAfter: 100,
                stdin: Stream.fromQueue(outgoing),
                stdout: "pipe",
                stderr: "inherit",
                additionalFds: { fd3: { type: "input" }, fd4: { type: "output" } },
              },
            ),
          )
          .pipe(Effect.mapError((cause) => failure("spawn", cause)));

        const stopOperations = Effect.fn("EngineConnection.stopOperations")(function* (
          error: EngineError,
        ) {
          if (stopped) return;
          stopped = error;
          yield* Queue.shutdown(outgoing);
          yield* Queue.shutdown(rawOutgoing);
          yield* Queue.shutdown(rawIncoming);
          yield* Deferred.fail(ready, error);
          for (const deferred of pending.values()) yield* Deferred.fail(deferred, error);
          pending.clear();
          for (const deferred of pendingExtension.values()) yield* Deferred.fail(deferred, error);
          pendingExtension.clear();
          for (const pending of pendingSession.values())
            yield* Deferred.fail(pending.deferred, error);
          pendingSession.clear();
          for (const session of managedSessions.values()) {
            session.closed = true;
            yield* Deferred.fail(session.terminal, error);
            yield* Queue.shutdown(session.events);
          }
        });
        const completeSubscribersIfDrained = () => {
          if (!acceptingEventSubscribers && preterminalSubscribers.size === 0)
            return Deferred.succeed(subscribersDrained, undefined);
          return Effect.void;
        };
        const onEventSubscriberExit = (subscriber: number, exit: Exit.Exit<unknown, unknown>) =>
          Effect.sync(() => {
            const participated = preterminalSubscribers.delete(subscriber);
            if (
              participated &&
              !acceptingEventSubscribers &&
              eventTerminalError === undefined &&
              !Exit.isSuccess(exit) &&
              eventConsumerError === undefined
            )
              eventConsumerError = failure(
                "event-consumer-failed",
                "An engine event consumer did not finish after the event stream ended",
              );
          }).pipe(Effect.andThen(() => completeSubscribersIfDrained()));
        const trackedEvents = Stream.unwrap(
          Effect.gen(function* () {
            // Register a stream-scope finalizer before subscribing. The finalizer
            // observes the consumer's outer completion (including mapEffect work),
            // rather than merely an upstream PubSub pull completing.
            if (!acceptingEventSubscribers) return Stream.empty;
            const subscriber = ++nextEventSubscriber;
            // Register before PubSub.subscribe. PubSub's own unsubscribe finalizer
            // is registered afterwards, so scope finalization runs it first (LIFO)
            // and only then releases this drain participant.
            yield* Effect.addFinalizer((exit) => onEventSubscriberExit(subscriber, exit));
            if (!acceptingEventSubscribers) return Stream.empty;
            const subscription = yield* PubSub.subscribe(eventTakes);
            if (!acceptingEventSubscribers) return Stream.empty;
            // There is no effect boundary between this cutoff check and the
            // registration, so a participant cannot miss its terminal Take.
            preterminalSubscribers.add(subscriber);
            return Stream.fromChannel(Channel.fromEffectTake(PubSub.take(subscription)));
          }),
        );
        const startDrainCoordinator = Effect.fn("EngineConnection.startDrainCoordinator")(
          function* () {
            if (drainCoordinatorStarted) return;
            drainCoordinatorStarted = true;
            yield* Effect.gen(function* () {
              yield* Effect.all([
                Deferred.await(childExitObserved),
                Deferred.await(hostEofObserved),
              ]).pipe(
                Effect.andThen(Deferred.await(eventDeliveryDone)),
                Effect.andThen(Deferred.await(subscribersDrained)),
                Effect.timeoutOrElse({
                  duration: eventDrainTimeoutMs,
                  orElse: () =>
                    Effect.fail(
                      failure(
                        "event-drain-timeout",
                        "Engine event delivery did not finish before the drain deadline",
                      ),
                    ),
                }),
              );
              const code = childExitCode ?? -1;
              if (eventTerminalError) return yield* Deferred.fail(logicalExit, eventTerminalError);
              if (eventConsumerError) return yield* Deferred.fail(logicalExit, eventConsumerError);
              if (code !== 0)
                return yield* Deferred.fail(
                  logicalExit,
                  failure("exit", `Engine exited with code ${code}`),
                );
              return yield* Deferred.succeed(logicalExit, code);
            }).pipe(
              Effect.catch((error) =>
                Effect.all([
                  stopOperations(error as EngineError),
                  Queue.shutdown(eventDelivery),
                  PubSub.shutdown(eventTakes),
                  child
                    .kill({ killSignal: "SIGTERM", forceKillAfter: 100 })
                    .pipe(Effect.catch(() => Effect.void)),
                ]).pipe(
                  Effect.asVoid,
                  Effect.andThen(Deferred.fail(logicalExit, error as EngineError)),
                ),
              ),
              // The scoped finalizer only stops queues. It never waits for a drain
              // coordinator which may itself be waiting on an interrupted consumer.
              Effect.forkScoped,
            );
          },
        );
        const finishHost = Effect.fn("EngineConnection.finishHost")(function* (
          terminalError?: EngineError,
        ) {
          if (hostFinished) return;
          hostFinished = true;
          acceptingEventSubscribers = false;
          if (terminalError) eventTerminalError ??= terminalError;
          yield* completeSubscribersIfDrained();
          if (terminalError) yield* stopOperations(terminalError);
          else yield* stopOperations(failure("host-read-closed", "Engine host output closed"));
          // Queue.end is FIFO and never waits for capacity. The drain deadline
          // starts at the first child/EOF terminal observation and includes this
          // graceful publication path.
          yield* startDrainCoordinator();
          yield* Deferred.succeed(hostEofObserved, undefined);
          yield* Queue.end(eventDelivery);
        });
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const closed = failure("closed", "Engine connection closed");
            acceptingEventSubscribers = false;
            yield* stopOperations(closed);
            yield* Queue.shutdown(eventDelivery);
            yield* PubSub.shutdown(eventTakes);
            yield* Deferred.fail(logicalExit, closed);
          }).pipe(Effect.uninterruptible),
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
        // Queue.end drains every parsed event before this worker publishes the
        // terminal Take to current subscribers.
        yield* Stream.fromQueue(eventDelivery).pipe(
          Stream.runForEach(({ event, bytes }) =>
            PubSub.publish(eventTakes, [event]).pipe(
              Effect.flatMap((accepted) =>
                accepted
                  ? Effect.void
                  : Effect.fail(failure("event-delivery", "Engine event stream was closed")),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  eventDeliveryBytes -= bytes;
                }),
              ),
            ),
          ),
          Effect.andThen(PubSub.publish(eventTakes, Exit.succeed(undefined))),
          Effect.andThen(
            Effect.void.pipe(
              Effect.andThen(completeSubscribersIfDrained()),
              Effect.andThen(Deferred.succeed(eventDeliveryDone, undefined)),
            ),
          ),
          Effect.catch((error) => Deferred.fail(eventDeliveryDone, error)),
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
                  return yield* failure(
                    "event-capacity",
                    "Engine event consumer exceeded its bounded delivery queue",
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
          Effect.tap(() => finishHost()),
          Effect.catch((error) => finishHost(error)),
          Effect.forkScoped,
        );
        yield* Stream.fromQueue(rawOutgoing).pipe(
          Stream.run(child.getInputFd(3)),
          Effect.mapError((cause) => failure("cdp-write", cause)),
          Effect.catch(stopOperations),
          Effect.ensuring(stopOperations(failure("cdp-write-closed", "CDP input pipe closed"))),
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
              if (cdpOwner === "raw") {
                yield* Queue.offer(rawIncoming, message);
                return;
              }
              if (message.method === "Target.detachedFromTarget") {
                const detached = decodeCdpDetachedSession(message.params);
                const detachedSessionId = Option.isSome(detached)
                  ? detached.value.sessionId
                  : undefined;
                if (detachedSessionId) {
                  const session = managedSessions.get(detachedSessionId);
                  if (!session && retainAttachingSession(detachedSessionId))
                    detachedAttachments.add(detachedSessionId);
                  if (session) {
                    const error = failure(
                      "cdp-session-closed",
                      "Chromium detached the CDP session",
                    );
                    session.closed = true;
                    managedSessions.delete(detachedSessionId);
                    uncertainSessionIds.delete(detachedSessionId);
                    for (const id of session.pending) {
                      const pending = pendingSession.get(id);
                      if (pending) {
                        externallyDetachedPending.add(id);
                        yield* Deferred.fail(pending.deferred, error);
                      }
                    }
                    for (const [id, pending] of pendingSession) {
                      if (
                        pending.method === "Target.detachFromTarget" &&
                        pending.ownerSessionId === detachedSessionId
                      ) {
                        externallyDetachedPending.add(id);
                        yield* Deferred.succeed(pending.deferred, { id, result: {} });
                      }
                    }
                    yield* Deferred.fail(session.terminal, error);
                    yield* Deferred.succeed(session.closeDone, undefined);
                    yield* Queue.end(session.events);
                  }
                  return;
                }
              }
              if (Option.isSome(decodedId)) {
                const pending = pendingSession.get(decodedId.value.id);
                if (pending) {
                  const receivedSessionId = message.sessionId;
                  if (
                    pending.sessionId === undefined ||
                    (typeof receivedSessionId === "string" &&
                      receivedSessionId === pending.sessionId)
                  ) {
                    if (pending.method === "Target.attachToTarget") {
                      const attach = decodeCdpResult(message);
                      const value = Option.isSome(attach) ? attach.value.result : undefined;
                      const attached = decodeCdpAttachedSession(value);
                      if (Option.isSome(attached)) retainAttachingSession(attached.value.sessionId);
                    }
                    yield* Deferred.succeed(pending.deferred, message);
                  }
                  // A mismatched session reply is deliberately not handed to another lane.
                  return;
                }
              }
              const event = decodeCdpSessionEvent(message);
              if (Option.isSome(event)) {
                const { sessionId: eventSessionId, method: eventMethod } = event.value;
                const params = event.value.params ?? {};
                const session = managedSessions.get(eventSessionId);
                if (!session) {
                  if (!retainAttachingSession(eventSessionId)) return;
                  if (pendingAttachErrors.has(eventSessionId)) return;
                  const buffered = pendingAttachEvents.get(eventSessionId) ?? [];
                  if (
                    buffered.length >= MaxSessionEvents ||
                    Buffer.byteLength(JSON.stringify(message)) > MaxSessionEventBytes
                  ) {
                    pendingAttachErrors.set(
                      eventSessionId,
                      failure(
                        "cdp-event-capacity",
                        "CDP attachment event buffer exceeded its limit",
                      ),
                    );
                    return;
                  }
                  buffered.push({ method: eventMethod, params });
                  pendingAttachEvents.set(eventSessionId, buffered);
                  return;
                }
                if (session.closed) return;
                if (Buffer.byteLength(JSON.stringify(message)) > MaxSessionEventBytes) {
                  session.closed = true;
                  yield* Deferred.fail(
                    session.terminal,
                    failure("cdp-event-size", "CDP session event exceeds 256 KiB"),
                  );
                  yield* Queue.end(session.events);
                  yield* closeManagedSession(session).pipe(Effect.forkScoped);
                  return;
                }
                if (
                  !Queue.offerUnsafe(session.events, {
                    method: eventMethod,
                    params,
                  })
                ) {
                  // Dropping queues never stall the shared pipe. A full lane is terminal so
                  // consumers never mistake a silently dropped protocol event for completeness.
                  session.closed = true;
                  for (const id of session.pending) {
                    const pending = pendingSession.get(id);
                    if (pending)
                      yield* Deferred.fail(
                        pending.deferred,
                        failure(
                          "cdp-event-capacity",
                          "CDP session event delivery exceeded its bounded queue",
                        ),
                      );
                  }
                  yield* Deferred.fail(
                    session.terminal,
                    failure(
                      "cdp-event-capacity",
                      "CDP session event delivery exceeded its bounded queue",
                    ),
                  );
                  yield* Queue.end(session.events);
                  yield* closeManagedSession(session).pipe(Effect.forkScoped);
                }
                return;
              }
              if (typeof message.sessionId === "string" && !("id" in message)) {
                const error = failure(
                  "cdp-session-protocol",
                  "Chromium returned an invalid session event",
                );
                if (
                  !managedSessions.has(message.sessionId) &&
                  retainAttachingSession(message.sessionId)
                )
                  pendingAttachErrors.set(message.sessionId, error);
                const session = managedSessions.get(message.sessionId);
                if (session && !session.closed) {
                  session.closed = true;
                  yield* Deferred.fail(session.terminal, error);
                  yield* Queue.end(session.events);
                  yield* closeManagedSession(session).pipe(Effect.forkScoped);
                }
              }
            }),
          ),
          Effect.catch(stopOperations),
          // CDP can close before stdout. Keep parsing the host pipe so its
          // already-buffered events can still reach existing subscribers.
          Effect.ensuring(stopOperations(failure("cdp-read-closed", "CDP output pipe closed"))),
          Effect.forkScoped,
        );
        const childExit = child.exitCode.pipe(Effect.mapError((cause) => failure("exit", cause)));
        yield* childExit.pipe(
          Effect.tap((code) =>
            Effect.gen(function* () {
              childExitCode = code;
              acceptingEventSubscribers = false;
              yield* completeSubscribersIfDrained();
              yield* Deferred.succeed(childExitObserved, undefined);
              yield* stopOperations(failure("exit", `Engine exited with code ${code}`));
              yield* startDrainCoordinator();
            }),
          ),
          Effect.catch((error) =>
            Effect.gen(function* () {
              childExitCode = -1;
              acceptingEventSubscribers = false;
              eventTerminalError ??= error;
              yield* completeSubscribersIfDrained();
              yield* Deferred.succeed(childExitObserved, undefined);
              yield* stopOperations(error);
              yield* startDrainCoordinator();
            }),
          ),
          Effect.forkScoped,
        );

        const terminateAmbiguousCommit = Effect.fn("EngineConnection.terminateAmbiguousCommit")(
          function* (error: EngineError) {
            yield* finishHost(error).pipe(Effect.provideService(Scope.Scope, engineScope));
            yield* child
              .kill({ killSignal: "SIGTERM", forceKillAfter: 100 })
              .pipe(Effect.catch(() => Effect.void));
          },
          Effect.uninterruptible,
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
              orElse: () =>
                Effect.gen(function* () {
                  const error = failure("timeout", `Engine request timed out: ${method}`);
                  if (method === "ui.commit") {
                    // Adoption may have happened without an acknowledgement. Never
                    // allow a caller to retry against unknown Native state.
                    yield* terminateAmbiguousCommit(error);
                  }
                  return yield* error;
                }),
            }),
            Effect.onInterrupt(() =>
              method === "ui.commit"
                ? terminateAmbiguousCommit(
                    failure("commit-interrupted", "Native commit acknowledgement was interrupted"),
                  )
                : Effect.void,
            ),
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
        const sendManaged = Effect.fn("EngineConnection.sendManaged")(function* (
          method: string,
          params: JsonObject,
          session?: ManagedSessionState,
          ownerSessionId = session?.sessionId,
        ): Effect.fn.Return<JsonObject, EngineError> {
          if (
            pendingSession.size >=
              MaxPendingSessionRequests +
                (method === "Target.detachFromTarget" ? MaxManagedSessions : 0) ||
            sessionSequence >= InternalCdpRequestIdFloor - 1
          )
            return yield* failure("capacity", "CDP session request capacity reached");
          if (session?.closed) return yield* failure("cdp-session-closed", "CDP session is closed");
          const id = ++sessionSequence;
          const deferred = yield* Deferred.make<JsonObject, EngineError>();
          pendingSession.set(id, {
            sessionId: session?.sessionId,
            ownerSessionId,
            method,
            deferred,
          });
          session?.pending.add(id);
          let sent = false;
          let certain = false;
          return yield* Effect.gen(function* () {
            sent = true;
            yield* offerCdp({
              id,
              method,
              params,
              ...(session ? { sessionId: session.sessionId } : {}),
            });
            const reply = yield* Deferred.await(deferred);
            const rejected = session ? decodeCdpSessionFailure(reply) : decodeCdpFailure(reply);
            if (
              Option.isSome(rejected) &&
              rejected.value.id === id &&
              (!session ||
                ("sessionId" in rejected.value && rejected.value.sessionId === session.sessionId))
            ) {
              certain = true;
              return yield* failure("cdp-session-rejected", rejected.value.error.message);
            }
            const result = session ? decodeCdpSessionResult(reply) : decodeCdpResult(reply);
            if (
              Option.isNone(result) ||
              result.value.id !== id ||
              (session &&
                (!("sessionId" in result.value) || result.value.sessionId !== session.sessionId))
            )
              return yield* failure(
                "cdp-session-protocol",
                "Chromium returned an invalid CDP session response",
              );
            certain = true;
            return reply;
          }).pipe(
            Effect.timeoutOrElse({
              duration: requestTimeoutMs,
              orElse: () =>
                Effect.fail(
                  failure("cdp-session-timeout", `CDP session request timed out: ${method}`),
                ),
            }),
            Effect.ensuring(
              Effect.sync(() => {
                pendingSession.delete(id);
                session?.pending.delete(id);
                // A command may have reached Chromium without a reliable response. Keep the
                // lane out of raw ownership until the process is restarted or it is detached.
                const detached = externallyDetachedPending.delete(id);
                if (sent && !certain && !detached) {
                  if (ownerSessionId) {
                    if (managedSessions.has(ownerSessionId))
                      uncertainSessionIds.add(ownerSessionId);
                  } else unknownAttachment = true;
                }
              }),
            ),
          );
        });
        const closeManagedSession = (session: ManagedSessionState) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* (): Effect.fn.Return<void, EngineError> {
              if (session.closed && !managedSessions.has(session.sessionId)) return;
              if (session.closing) return yield* Deferred.await(session.closeDone);
              session.closed = true;
              session.closing = true;
              for (const id of session.pending) {
                const pending = pendingSession.get(id);
                if (pending)
                  yield* Deferred.fail(
                    pending.deferred,
                    failure(
                      "cdp-session-closed",
                      "CDP session closed while its request was pending",
                    ),
                  );
                pendingSession.delete(id);
              }
              session.pending.clear();
              yield* Queue.end(session.events);
              const reply = yield* restore(
                sendManaged(
                  "Target.detachFromTarget",
                  { sessionId: session.sessionId },
                  undefined,
                  session.sessionId,
                ),
              );
              const result = decodeCdpResult(reply);
              if (Option.isNone(result))
                return yield* failure(
                  "cdp-session-protocol",
                  "Chromium returned an invalid detach response",
                );
              managedSessions.delete(session.sessionId);
              uncertainSessionIds.delete(session.sessionId);
              yield* Deferred.succeed(session.terminal, undefined);
              yield* Deferred.succeed(session.closeDone, undefined);
            }),
          ).pipe(
            Effect.tapError((error) =>
              Effect.all([
                Deferred.fail(session.terminal, error),
                Deferred.fail(session.closeDone, error),
              ]),
            ),
            Effect.onInterrupt(() =>
              Effect.all([
                Deferred.fail(
                  session.terminal,
                  failure("cdp-session-interrupted", "CDP detach was interrupted"),
                ),
                Deferred.fail(
                  session.closeDone,
                  failure("cdp-session-interrupted", "CDP detach was interrupted"),
                ),
              ]),
            ),
          );
        const openCdpSession = Effect.fn("EngineConnection.openCdpSession")(function* (
          targetId: string,
        ): Effect.fn.Return<ManagedCdpSession, EngineError, Scope.Scope> {
          if (typeof targetId !== "string" || targetId.length === 0)
            return yield* failure("cdp-target", "CDP target ID is invalid");
          const stoppedNow = stoppedError();
          if (stoppedNow) return yield* stoppedNow;
          if (cdpOwner === "raw")
            return yield* failure("cdp-owned", "Raw CDP already owns the browser pipe");
          if (cdpOwner === "uncertain" || unknownAttachment || uncertainSessionIds.size > 0)
            return yield* failure(
              "extension-uncertain",
              "CDP ownership is uncertain; restart the engine",
            );
          if (managedOperations + managedSessions.size >= MaxManagedSessions)
            return yield* failure("capacity", "CDP session capacity reached");
          managedOperations += 1;
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* (): Effect.fn.Return<ManagedCdpSession, EngineError, Scope.Scope> {
              const reply = yield* restore(
                sendManaged("Target.attachToTarget", { targetId, flatten: true }),
              );
              const result = decodeCdpResult(reply);
              const value = Option.isSome(result) ? result.value.result : undefined;
              const attached = decodeCdpAttachedSession(value);
              const sessionId = Option.isSome(attached) ? attached.value.sessionId : undefined;
              if (!sessionId) unknownAttachment = true;
              if (!sessionId)
                return yield* failure(
                  "cdp-session-protocol",
                  "Chromium returned an invalid attach response",
                );
              if (detachedAttachments.delete(sessionId)) {
                attachingSessionIds.delete(sessionId);
                pendingAttachEvents.delete(sessionId);
                pendingAttachErrors.delete(sessionId);
                return yield* failure(
                  "cdp-session-closed",
                  "Chromium detached the session during attachment",
                );
              }
              const events = yield* Queue.dropping<ManagedCdpEvent, Cause.Done>(MaxSessionEvents);
              const terminal = yield* Deferred.make<void, EngineError>();
              const closeDone = yield* Deferred.make<void, EngineError>();
              const session: ManagedSessionState = {
                sessionId,
                events,
                pending: new Set(),
                terminal,
                closeDone,
                closed: false,
                closing: false,
                subscribed: false,
              };
              if (managedSessions.has(sessionId)) {
                unknownAttachment = true;
                return yield* failure(
                  "cdp-session-protocol",
                  "Chromium reused an active CDP session ID",
                );
              }
              managedSessions.set(sessionId, session);
              attachingSessionIds.delete(sessionId);
              for (const event of pendingAttachEvents.get(sessionId) ?? [])
                Queue.offerUnsafe(events, event);
              pendingAttachEvents.delete(sessionId);
              const request = Effect.fn("EngineConnection.managedCdpRequest")(function* (
                method: string,
                params: JsonObject = {},
              ): Effect.fn.Return<Schema.Json, EngineError> {
                if (session.closed)
                  return yield* failure("cdp-session-closed", "CDP session is closed");
                if (method.startsWith("Extensions.") || method.startsWith("Target."))
                  return yield* failure("cdp-session-method", "CDP session method is reserved");
                const reply = yield* sendManaged(method, params, session);
                const result = decodeCdpSessionResult(reply);
                if (Option.isNone(result))
                  return yield* failure(
                    "cdp-session-protocol",
                    "Chromium returned an invalid CDP session response",
                  );
                return result.value.result;
              });
              const eventsStream = Stream.unwrap(
                Effect.sync(() => {
                  if (session.subscribed)
                    return Stream.fail(
                      failure("cdp-session-events", "CDP session events allow one consumer"),
                    );
                  session.subscribed = true;
                  return Stream.fromQueue(session.events).pipe(
                    Stream.concat(
                      Stream.fromEffect(Deferred.await(session.terminal)).pipe(Stream.drain),
                    ),
                  );
                }),
              );
              const close = closeManagedSession(session);
              yield* Effect.addFinalizer(() => close.pipe(Effect.catch(() => Effect.void)));
              const attachError = pendingAttachErrors.get(sessionId);
              pendingAttachErrors.delete(sessionId);
              if (attachError) {
                yield* close.pipe(Effect.catch(() => Effect.void));
                return yield* attachError;
              }
              return { events: eventsStream, request, close } satisfies ManagedCdpSession;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  managedOperations -= 1;
                  if (managedOperations === 0) {
                    attachingSessionIds.clear();
                    pendingAttachEvents.clear();
                    pendingAttachErrors.clear();
                    detachedAttachments.clear();
                  }
                }),
              ),
            ),
          );
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
          if (unknownAttachment || uncertainSessionIds.size > 0)
            return failure("cdp-owned", "A managed CDP operation has an uncertain result");
          if (
            extensionOperations !== 0 ||
            pendingExtension.size !== 0 ||
            managedOperations !== 0 ||
            pendingSession.size !== 0 ||
            managedSessions.size !== 0
          )
            return failure("cdp-owned", "Managed CDP operations are still pending");
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
          exit: Deferred.await(logicalExit),
          events: trackedEvents,
          request,
          loadUnpacked,
          uninstall,
          openCdpSession,
          claimRawCdp,
        });
      }),
    ).pipe(Layer.provide(NodeServices.layer));
  }
}
