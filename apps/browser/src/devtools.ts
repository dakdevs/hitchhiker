import {
  DevToolsStatusSchema,
  EngineError,
  type DevToolsApi,
  type DevToolsInspectPoint,
  type DevToolsStatus,
  type EngineConnection,
} from "@hitchhiker/runtime";
import { Effect, Schedule, Schema, Semaphore, Stream } from "effect";

const unavailable = (message: string) => new EngineError({ code: "devtools", message });
const decodeStatus = Schema.decodeUnknownEffect(DevToolsStatusSchema, {
  onExcessProperty: "error",
});

/** Owns inspector resources, not the product controls that present them. */
export const createDevToolsController = Effect.fn("DevTools.createController")(function* (options: {
  readonly engine: EngineConnection["Service"];
  readonly protect: (status: DevToolsStatus) => Effect.Effect<void, EngineError>;
  readonly onFailure?: Effect.Effect<void>;
}) {
  const lock = yield* Semaphore.make(1);
  const owners = new Map<
    string,
    {
      readonly owner: string;
      readonly generation: number;
      readonly leaseId: string;
      readonly instance?: number;
    }
  >();
  const native = Effect.fn("DevTools.native")(function* (
    method: "devtools.status" | "devtools.show" | "devtools.close",
    pageId: string,
    expected?: {
      readonly generation: number;
      readonly instance?: number;
      readonly leaseId?: string;
    },
    inspectAt?: DevToolsInspectPoint,
    leaseId?: string,
  ) {
    const ready = yield* options.engine.ready;
    if (ready.params.devTools !== true)
      return yield* unavailable("The native host does not support DevTools windows");
    const result = yield* options.engine.request(method, {
      pageId,
      ...(expected === undefined ? {} : { expectedGeneration: expected.generation }),
      ...(expected?.instance === undefined ? {} : { expectedInstance: expected.instance }),
      ...(expected?.leaseId === undefined ? {} : { expectedLeaseId: expected.leaseId }),
      ...(leaseId === undefined ? {} : { leaseId }),
      ...(inspectAt === undefined ? {} : { inspectAt }),
    });
    const status = yield* decodeStatus(result).pipe(
      Effect.mapError(() => unavailable("Invalid DevTools response")),
    );
    if (
      status.pageId !== pageId ||
      (expected !== undefined && status.generation !== expected.generation)
    )
      return yield* unavailable("DevTools target changed");
    return status;
  });

  const cleanup = Effect.fn("DevTools.cleanup")(function* (owner: string, onlyPageId?: string) {
    for (const [pageId, held] of owners) {
      if (held.owner !== owner || (onlyPageId !== undefined && pageId !== onlyPageId)) continue;
      yield* Effect.raceFirst(
        options.engine.exit.pipe(Effect.asVoid),
        native("devtools.close", pageId, held).pipe(
          Effect.andThen(
            Effect.suspend(() => native("devtools.status", pageId)).pipe(
              Effect.flatMap((status) =>
                status.generation !== held.generation ||
                (held.instance !== undefined && status.instance !== held.instance) ||
                status.state === "closed"
                  ? Effect.succeed(status)
                  : Effect.fail(unavailable("Inspector is still closing")),
              ),
              Effect.retry({ times: 80, schedule: Schedule.spaced(25) }),
              Effect.flatMap(options.protect),
            ),
          ),
          Effect.catch((error) =>
            error.code === "-32001" || error.code === "-32005" ? Effect.void : Effect.fail(error),
          ),
        ),
      ).pipe(Effect.interruptible, Effect.timeout(5_000));
      if (owners.get(pageId) === held) owners.delete(pageId);
    }
  });
  const cleanupChecked = (owner: string, onlyPageId?: string) =>
    cleanup(owner, onlyPageId).pipe(Effect.tapError(() => options.onFailure ?? Effect.void));

  yield* options.engine.events.pipe(
    Stream.filter((event) => event.event === "devtools.changed"),
    Stream.runForEach((event) =>
      decodeStatus(event.params).pipe(
        Effect.mapError(() => unavailable("Invalid DevTools lifecycle event")),
        Effect.flatMap((status) =>
          lock.withPermit(
            Effect.gen(function* () {
              yield* options.protect(status);
              const held = owners.get(status.pageId);
              if (
                status.state === "closed" &&
                held !== undefined &&
                held.generation === status.generation &&
                held.instance === status.instance
              )
                owners.delete(status.pageId);
            }),
          ),
        ),
      ),
    ),
    Effect.catch(() => options.onFailure ?? Effect.void),
    Effect.forkScoped,
  );

  const forOwner = Effect.fn("DevTools.forOwner")(function* (
    authorize: Effect.Effect<void, unknown>,
  ) {
    const owner = crypto.randomUUID();
    let closed = false;
    let revoked = false;
    const check = Effect.fn("DevTools.checkOwner")(function* () {
      if (closed || revoked) return yield* unavailable("Inspector owner is no longer active");
      yield* authorize.pipe(Effect.mapError(() => unavailable("DevTools permission was denied")));
    });
    yield* Effect.addFinalizer(() =>
      lock
        .withPermit(
          Effect.gen(function* () {
            closed = true;
            yield* cleanupChecked(owner);
          }),
        )
        .pipe(Effect.orDie),
    );
    yield* Effect.gen(function* () {
      yield* Effect.sleep(500);
      yield* lock.withPermit(
        Effect.gen(function* () {
          if (closed || revoked || ![...owners.values()].some((held) => held.owner === owner))
            return;
          const result = yield* Effect.exit(authorize);
          if (result._tag === "Failure") {
            revoked = true;
            yield* cleanupChecked(owner);
          }
        }),
      );
    }).pipe(
      Effect.forever,
      Effect.catch(() => options.onFailure ?? Effect.void),
      Effect.forkScoped,
    );

    return {
      status: (pageId: string) =>
        lock.withPermit(
          Effect.gen(function* () {
            yield* check();
            const status = yield* native("devtools.status", pageId);
            yield* options.protect(status);
            return status;
          }),
        ),
      show: (pageId: string, inspectAt?: DevToolsInspectPoint) =>
        lock.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* check();
              const current = yield* native("devtools.status", pageId);
              if (current.state === "closing") return yield* unavailable("Inspector is closing");
              yield* options.protect({ ...current, state: "opening" });
              const leaseId = crypto.randomUUID();
              owners.set(pageId, { owner, generation: current.generation, leaseId });
              const result = yield* Effect.exit(
                native("devtools.show", pageId, current, inspectAt, leaseId),
              );
              if (result._tag === "Failure") {
                yield* cleanupChecked(owner, pageId);
                return yield* Effect.failCause(result.cause);
              }
              owners.set(pageId, {
                owner,
                generation: result.value.generation,
                instance: result.value.instance,
                leaseId,
              });
              yield* options.protect(result.value);
              return result.value;
            }),
          ),
        ),
      close: (pageId: string) =>
        lock.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* check();
              const current = yield* native("devtools.status", pageId);
              const status = yield* native("devtools.close", pageId, current);
              yield* options.protect(status);
              if (status.state === "closed") owners.delete(pageId);
              return status;
            }),
          ),
        ),
    } satisfies DevToolsApi;
  });
  return { forOwner };
});
export type DevToolsController = Effect.Success<ReturnType<typeof createDevToolsController>>;
