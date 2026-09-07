import { Deferred, Effect, Queue, Schema, Scope, Semaphore, Stream } from "effect";
import type { ServiceParty } from "./service-authority.ts";
import type { ResolvedServiceBinding, ValidatedServiceGraph } from "./service-contracts.ts";

const MaxJsonDepth = 32;
const MaxJsonNodes = 4_096;
const MaxJsonStringBytes = 64 * 1024;
const MaxJsonBytes = 128 * 1024;
const MaxStateBytes = 1024 * 1024;
const MaxSubscriptions = 8;
const MaxPendingByConsumer = 16;
const MaxPendingByProvider = 32;
const MaxPendingCalls = 128;
const CallTimeoutMs = 3_000;

const ServiceMethod = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]*$/),
);

export interface ServiceOwner {
  readonly id: string;
  readonly generation: number;
}

export interface ServiceBrokerAuthority {
  readonly authenticateProvider: (party: ServiceParty) => Effect.Effect<unknown, unknown>;
  readonly authorizeService: (
    consumer: ServiceParty,
    provider: ServiceParty,
  ) => Effect.Effect<void, unknown>;
}

export interface ServiceBrokerOptions {
  readonly graph: ValidatedServiceGraph;
  readonly profileId: string;
  readonly authority: ServiceBrokerAuthority;
}

export type ServiceState =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly providerGeneration: number;
      readonly revision: number;
      readonly value: Schema.Json;
    };

export type ServiceEvent =
  | {
      readonly type: "service.request";
      readonly callId: string;
      readonly service: string;
      readonly method: string;
      readonly params: Schema.Json;
      readonly caller: ServiceOwner;
    }
  | {
      readonly type: "service.state";
      readonly dependency: string;
      readonly providerGeneration: number;
      readonly revision: number;
      readonly available: boolean;
    };

export interface PluginServiceBroker {
  /** Host-only graph replacement. Active required contracts and bindings must remain unchanged. */
  readonly reconfigure: (graph: ValidatedServiceGraph) => Effect.Effect<void, ServiceBrokerError>;
  readonly activate: (party: ServiceParty) => Effect.Effect<void, ServiceBrokerError>;
  readonly ready: (owner: ServiceOwner) => Effect.Effect<void, ServiceBrokerError>;
  readonly deactivate: (owner: ServiceOwner) => Effect.Effect<void>;
  readonly publish: (
    owner: ServiceOwner,
    service: string,
    value: unknown,
  ) => Effect.Effect<{ readonly revision: number }, ServiceBrokerError>;
  readonly get: (
    owner: ServiceOwner,
    dependency: string,
  ) => Effect.Effect<ServiceState, ServiceBrokerError>;
  readonly subscribe: (
    owner: ServiceOwner,
    dependency: string,
  ) => Effect.Effect<ServiceState, ServiceBrokerError>;
  readonly call: (
    owner: ServiceOwner,
    dependency: string,
    method: string,
    params: unknown,
  ) => Effect.Effect<Schema.Json, ServiceBrokerError>;
  readonly respond: (
    owner: ServiceOwner,
    response:
      | { readonly callId: string; readonly result: unknown }
      | { readonly callId: string; readonly error: string },
  ) => Effect.Effect<void, ServiceBrokerError>;
  readonly events: (
    owner: ServiceOwner,
  ) => Stream.Stream<{ readonly event: string; readonly payload: Schema.Json }, ServiceBrokerError>;
  readonly failure: (owner: ServiceOwner) => Effect.Effect<never, ServiceBrokerError>;
}

export class ServiceBrokerError extends Schema.TaggedError<ServiceBrokerError>()(
  "ServiceBrokerError",
  { message: Schema.String },
) {}

const failed = (message: string) => new ServiceBrokerError({ message });
const bindingKey = (consumer: string, dependency: string) => `${consumer}\u0000${dependency}`;
const serviceKey = (provider: string, service: string) => `${provider}\u0000${service}`;
const ownerKey = (owner: ServiceOwner) => `${owner.id}\u0000${owner.generation}`;

const sameContract = (
  left: ResolvedServiceBinding["service"]["contract"],
  right: ResolvedServiceBinding["service"]["contract"],
) => left.name === right.name && left.version === right.version && left.digest === right.digest;
const sameBinding = (
  left: ResolvedServiceBinding | undefined,
  right: ResolvedServiceBinding | undefined,
) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.consumer === right.consumer &&
    left.dependency.id === right.dependency.id &&
    left.dependency.optional === right.dependency.optional &&
    sameContract(left.dependency.contract, right.dependency.contract) &&
    left.provider === right.provider &&
    left.service.id === right.service.id &&
    sameContract(left.service.contract, right.service.contract));
const sameDescriptor = (
  left: ValidatedServiceGraph["plugins"][number] | undefined,
  right: ValidatedServiceGraph["plugins"][number] | undefined,
) => {
  if (left === right) return true;
  if (!left || !right || left.id !== right.id) return false;
  if (
    left.provides.length !== right.provides.length ||
    left.requires.length !== right.requires.length
  )
    return false;
  const rightProvided = new Map(right.provides.map((service) => [service.id, service]));
  for (const service of left.provides) {
    const candidate = rightProvided.get(service.id);
    if (!candidate || !sameContract(service.contract, candidate.contract)) return false;
  }
  const rightRequired = new Map(right.requires.map((dependency) => [dependency.id, dependency]));
  for (const dependency of left.requires) {
    const candidate = rightRequired.get(dependency.id);
    if (
      !candidate ||
      dependency.optional !== candidate.optional ||
      !sameContract(dependency.contract, candidate.contract)
    )
      return false;
  }
  return true;
};

interface JsonBudget {
  nodes: number;
  stringBytes: number;
  readonly seen: WeakSet<object>;
}

/** Reads only own data descriptors before Schema sees the detached tree. */
const structuralJson = (input: unknown, depth: number, budget: JsonBudget): Schema.Json => {
  if (depth > MaxJsonDepth || ++budget.nodes > MaxJsonNodes)
    throw failed("Service JSON exceeds structural limits");
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw failed("Service input must be JSON");
    return input;
  }
  if (typeof input === "string") {
    budget.stringBytes += Buffer.byteLength(input, "utf8");
    if (budget.stringBytes > MaxJsonStringBytes)
      throw failed("Service JSON exceeds structural limits");
    return input;
  }
  if (typeof input !== "object") throw failed("Service input must be JSON");
  if (budget.seen.has(input)) throw failed("Service input must be JSON");
  budget.seen.add(input);

  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype)
      throw failed("Service input must be JSON");
    const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0) throw failed("Service input must be JSON");
    const keys = Reflect.ownKeys(input);
    if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string"))
      throw failed("Service input must be JSON");
    const output: Schema.Json[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw failed("Service input must be JSON");
      output.push(structuralJson(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(output);
  }

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw failed("Service input must be JSON");
  const output: Record<string, Schema.Json> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") throw failed("Service input must be JSON");
    budget.stringBytes += Buffer.byteLength(key, "utf8");
    if (budget.stringBytes > MaxJsonStringBytes)
      throw failed("Service JSON exceeds structural limits");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw failed("Service input must be JSON");
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: structuralJson(descriptor.value, depth + 1, budget),
    });
  }
  return Object.freeze(output);
};

interface PortableJson {
  readonly value: Schema.Json;
  readonly bytes: number;
}

const decodePortableJson = Effect.fn("ServiceBroker.decodePortableJson")(function* (
  input: unknown,
): Effect.fn.Return<PortableJson, ServiceBrokerError> {
  const value = yield* Effect.try({
    try: () => structuralJson(input, 0, { nodes: 0, stringBytes: 0, seen: new WeakSet() }),
    catch: () => failed("Service input must be bounded JSON"),
  });
  yield* Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    Effect.mapError(() => failed("Service input must be JSON")),
  );
  const encoded = yield* Effect.try({
    try: () => JSON.stringify(value),
    catch: () => failed("Service input must be JSON"),
  });
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MaxJsonBytes) return yield* failed("Service JSON exceeds size limits");
  return Object.freeze({ value, bytes });
});

interface PublishedState {
  readonly generation: number;
  readonly revision: number;
  readonly value: Schema.Json;
  readonly bytes: number;
}

interface StateNotification {
  readonly dependency: string;
  readonly provider: string;
  readonly service: string;
  readonly providerGeneration: number;
  readonly revision: number;
  readonly available: boolean;
}

interface PartyRecord {
  readonly party: ServiceParty;
  ready: boolean;
  readonly wake: Queue.Queue<null, ServiceBrokerError>;
  readonly failed: Deferred.Deferred<never, ServiceBrokerError>;
  readonly subscriptions: Set<string>;
  readonly requests: string[];
  readonly notifications: Map<string, StateNotification>;
}

interface PendingCall {
  readonly id: string;
  readonly caller: ServiceParty;
  readonly provider: ServiceParty;
  readonly dependency: string;
  readonly service: string;
  readonly method: string;
  readonly params: Schema.Json;
  readonly result: Deferred.Deferred<Schema.Json, ServiceBrokerError>;
}

type CallRegistration = Pick<PendingCall, "id" | "result">;

const frozenParty = (party: ServiceParty): ServiceParty =>
  Object.freeze({ ...party, declaredCapabilities: Object.freeze([...party.declaredCapabilities]) });

export const createPluginServiceBroker = Effect.fn("ServiceBroker.create")(function* (
  options: ServiceBrokerOptions,
): Effect.fn.Return<PluginServiceBroker, never, Scope.Scope> {
  const permit = yield* Semaphore.make(1);
  const parties = new Map<string, PartyRecord>();
  const highestGeneration = new Map<string, number>();
  const states = new Map<string, PublishedState>();
  const pending = new Map<string, PendingCall>();
  const pendingByConsumer = new Map<string, number>();
  const pendingByProvider = new Map<string, number>();
  let stateBytes = 0;
  let callSequence = 0;

  let graph = options.graph;
  let bindings = new Map<string, ResolvedServiceBinding>(
    graph.bindings.map((binding) => [bindingKey(binding.consumer, binding.dependency.id), binding]),
  );
  let descriptors = new Map(graph.plugins.map((plugin) => [plugin.id, plugin]));
  let provided = new Set<string>();
  for (const plugin of graph.plugins)
    for (const service of plugin.provides) provided.add(serviceKey(plugin.id, service.id));

  const currentRecord = (party: ServiceParty) => {
    const record = parties.get(party.id);
    return record?.party.generation === party.generation &&
      highestGeneration.get(party.id) === party.generation
      ? record
      : undefined;
  };
  const exactRecord = (owner: ServiceOwner) => {
    const record = parties.get(owner.id);
    return record?.party.generation === owner.generation ? record : undefined;
  };
  const signal = (record: PartyRecord) => {
    Queue.offerUnsafe(record.wake, null);
  };
  const adjustCount = (counts: Map<string, number>, key: string, change: 1 | -1) => {
    const next = (counts.get(key) ?? 0) + change;
    if (next === 0) counts.delete(key);
    else counts.set(key, next);
  };
  const removeRequest = (record: PartyRecord | undefined, callId: string) => {
    if (!record) return;
    const index = record.requests.indexOf(callId);
    if (index >= 0) record.requests.splice(index, 1);
  };
  const removePending = (callId: string) => {
    const call = pending.get(callId);
    if (!call) return undefined;
    pending.delete(callId);
    adjustCount(pendingByConsumer, ownerKey(call.caller), -1);
    adjustCount(pendingByProvider, ownerKey(call.provider), -1);
    removeRequest(currentRecord(call.provider), callId);
    return call;
  };
  const failPending = Effect.fn("ServiceBroker.failPending")(function* (
    callId: string,
    error: ServiceBrokerError,
  ) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const call = removePending(callId);
        if (call) yield* Deferred.fail(call.result, error);
      }),
    );
  });
  const authenticateRecord = Effect.fn("ServiceBroker.authenticateRecord")(function* (
    owner: ServiceOwner,
  ) {
    const record = exactRecord(owner);
    if (!record) return yield* failed("Stale or inactive service party");
    yield* options.authority
      .authenticateProvider(record.party)
      .pipe(Effect.mapError(() => failed("Service authority denied")));
    if (currentRecord(record.party) !== record)
      return yield* failed("Service party changed during authorization");
    return record;
  });
  const authorizeParties = Effect.fn("ServiceBroker.authorizeParties")(function* (
    consumer: ServiceParty,
    provider: ServiceParty,
  ) {
    yield* options.authority
      .authorizeService(consumer, provider)
      .pipe(Effect.mapError(() => failed("Service authority denied")));
    if (!currentRecord(consumer) || !currentRecord(provider))
      return yield* failed("Service party changed during authorization");
  });

  const notificationFor = (
    binding: ResolvedServiceBinding,
    fallbackGeneration: number,
  ): StateNotification => {
    const provider = parties.get(binding.provider);
    const state = states.get(serviceKey(binding.provider, binding.service.id));
    const currentState =
      provider !== undefined && state?.generation === provider.party.generation ? state : undefined;
    return Object.freeze({
      dependency: binding.dependency.id,
      provider: binding.provider,
      service: binding.service.id,
      providerGeneration: provider?.party.generation ?? fallbackGeneration,
      revision: currentState?.revision ?? 0,
      available: provider?.ready === true && currentState !== undefined,
    });
  };
  const notifyService = (provider: string, service: string, fallbackGeneration: number) => {
    for (const binding of graph.bindings) {
      if (binding.provider !== provider || binding.service.id !== service) continue;
      const consumer = parties.get(binding.consumer);
      if (!consumer?.subscriptions.has(binding.dependency.id)) continue;
      consumer.notifications.set(
        binding.dependency.id,
        notificationFor(binding, fallbackGeneration),
      );
      signal(consumer);
    }
  };
  const removeState = (provider: string, generation: number) => {
    for (const service of descriptors.get(provider)?.provides ?? []) {
      const key = serviceKey(provider, service.id);
      const state = states.get(key);
      if (state?.generation !== generation) continue;
      states.delete(key);
      stateBytes -= state.bytes;
    }
  };
  const closeRecord = Effect.fn("ServiceBroker.closeRecord")(function* (
    record: PartyRecord,
    error: ServiceBrokerError,
  ) {
    yield* Queue.clear(record.wake).pipe(Effect.catch(() => Effect.succeed([])));
    yield* Queue.fail(record.wake, error);
    yield* Deferred.fail(record.failed, error);
    record.requests.length = 0;
    record.notifications.clear();
    record.subscriptions.clear();
  });
  const cascadeFrom = (provider: string) => {
    const removed = new Set<string>();
    const remaining = [provider];
    while (remaining.length > 0) {
      const id = remaining.pop();
      if (id === undefined || removed.has(id) || !parties.has(id)) continue;
      removed.add(id);
      for (const binding of graph.bindings)
        if (binding.provider === id && !binding.dependency.optional)
          remaining.push(binding.consumer);
    }
    return removed;
  };
  const removeRecords = Effect.fn("ServiceBroker.removeRecords")(function* (
    ids: ReadonlySet<string>,
    reason: string,
  ) {
    const removed: PartyRecord[] = [];
    for (const id of ids) {
      const record = parties.get(id);
      if (!record) continue;
      parties.delete(id);
      removeState(id, record.party.generation);
      removed.push(record);
    }
    for (const [callId, call] of pending)
      if (ids.has(call.caller.id) || ids.has(call.provider.id))
        yield* failPending(callId, failed("Service peer deactivated"));
    for (const record of removed) yield* closeRecord(record, failed(reason));
    for (const record of removed)
      for (const service of descriptors.get(record.party.id)?.provides ?? [])
        notifyService(record.party.id, service.id, record.party.generation);
  });

  const reconfigure = Effect.fn("ServiceBroker.reconfigure")(function* (
    candidate: ValidatedServiceGraph,
  ) {
    yield* permit.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const nextDescriptors = new Map(candidate.plugins.map((plugin) => [plugin.id, plugin]));
          const nextBindings = new Map<string, ResolvedServiceBinding>(
            candidate.bindings.map((binding) => [
              bindingKey(binding.consumer, binding.dependency.id),
              binding,
            ]),
          );
          const nextProvided = new Set<string>();
          for (const plugin of candidate.plugins)
            for (const service of plugin.provides)
              nextProvided.add(serviceKey(plugin.id, service.id));

          const changedOptional = new Map<
            string,
            {
              readonly record: PartyRecord;
              readonly dependency: string;
              readonly previous: ResolvedServiceBinding | undefined;
              readonly next: ResolvedServiceBinding | undefined;
            }
          >();
          for (const record of parties.values()) {
            const currentDescriptor = descriptors.get(record.party.id);
            const nextDescriptor = nextDescriptors.get(record.party.id);
            if (!sameDescriptor(currentDescriptor, nextDescriptor))
              return yield* failed("Active service descriptor changed during reconfiguration");
            for (const dependency of currentDescriptor?.requires ?? []) {
              const key = bindingKey(record.party.id, dependency.id);
              const previous = bindings.get(key);
              const next = nextBindings.get(key);
              if (sameBinding(previous, next)) continue;
              if (!dependency.optional)
                return yield* failed(
                  "Active required service binding changed during reconfiguration",
                );
              changedOptional.set(key, {
                record,
                dependency: dependency.id,
                previous,
                next,
              });
            }
          }

          const affectedCalls = new Set<string>();
          for (const [callId, call] of pending)
            if (changedOptional.has(bindingKey(call.caller.id, call.dependency)))
              affectedCalls.add(callId);

          graph = candidate;
          bindings = nextBindings;
          descriptors = nextDescriptors;
          provided = nextProvided;

          for (const [key, state] of states) {
            if (provided.has(key)) continue;
            states.delete(key);
            stateBytes -= state.bytes;
          }
          for (const callId of affectedCalls)
            yield* failPending(callId, failed("Service binding changed"));
          for (const change of changedOptional.values()) {
            if (!change.record.subscriptions.has(change.dependency)) continue;
            const notification = change.next
              ? notificationFor(change.next, highestGeneration.get(change.next.provider) ?? 0)
              : Object.freeze({
                  dependency: change.dependency,
                  provider: change.previous?.provider ?? "",
                  service: change.previous?.service.id ?? "",
                  providerGeneration: highestGeneration.get(change.previous?.provider ?? "") ?? 0,
                  revision: 0,
                  available: false,
                });
            change.record.notifications.set(change.dependency, notification);
            signal(change.record);
          }
        }),
      ),
    );
  });

  const activate = Effect.fn("ServiceBroker.activate")(function* (candidate: ServiceParty) {
    if (
      candidate.profileId !== options.profileId ||
      !descriptors.has(candidate.id) ||
      !Number.isSafeInteger(candidate.generation) ||
      candidate.generation <= 0
    )
      return yield* failed("Service party does not match this broker");
    return yield* permit.withPermit(
      Effect.gen(function* () {
        const previousGeneration = highestGeneration.get(candidate.id);
        if (previousGeneration !== undefined && candidate.generation <= previousGeneration)
          return yield* failed("Service generation is stale");
        yield* options.authority
          .authenticateProvider(candidate)
          .pipe(Effect.mapError(() => failed("Service authority denied")));
        for (const binding of graph.bindings) {
          if (binding.consumer !== candidate.id || binding.dependency.optional) continue;
          const provider = parties.get(binding.provider);
          if (!provider?.ready) return yield* failed("Required service provider is not ready");
          yield* options.authority
            .authorizeService(candidate, provider.party)
            .pipe(Effect.mapError(() => failed("Service authority denied")));
          if (currentRecord(provider.party) !== provider)
            return yield* failed("Required service provider changed during authorization");
        }
        const party = frozenParty(candidate);
        const wake = yield* Queue.sliding<null, ServiceBrokerError>(1);
        const failure = yield* Deferred.make<never, ServiceBrokerError>();
        const record: PartyRecord = {
          party,
          ready: false,
          wake,
          failed: failure,
          subscriptions: new Set(),
          requests: [],
          notifications: new Map(),
        };
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const old = parties.get(candidate.id);
            const dependents = old ? cascadeFrom(candidate.id) : new Set<string>();
            dependents.delete(candidate.id);
            if (old) {
              parties.delete(candidate.id);
              removeState(candidate.id, old.party.generation);
              for (const [callId, call] of pending)
                if (
                  (call.caller.id === candidate.id &&
                    call.caller.generation === old.party.generation) ||
                  (call.provider.id === candidate.id &&
                    call.provider.generation === old.party.generation)
                )
                  yield* failPending(callId, failed("Service peer was replaced"));
              yield* closeRecord(old, failed("Service party was replaced"));
            }
            if (dependents.size > 0)
              yield* removeRecords(dependents, "Required service provider was replaced");
            parties.set(candidate.id, record);
            highestGeneration.set(candidate.id, candidate.generation);
            for (const service of descriptors.get(candidate.id)?.provides ?? [])
              notifyService(candidate.id, service.id, candidate.generation);
          }),
        );
      }),
    );
  });

  const ready = Effect.fn("ServiceBroker.ready")(function* (owner: ServiceOwner) {
    yield* permit.withPermit(
      Effect.gen(function* () {
        const record = yield* authenticateRecord(owner);
        for (const binding of graph.bindings) {
          if (binding.consumer !== record.party.id || binding.dependency.optional) continue;
          const provider = parties.get(binding.provider);
          if (!provider?.ready) return yield* failed("Required service provider is not ready");
          yield* authorizeParties(record.party, provider.party);
        }
        yield* Effect.uninterruptible(
          Effect.sync(() => {
            record.ready = true;
            for (const service of descriptors.get(record.party.id)?.provides ?? [])
              notifyService(record.party.id, service.id, record.party.generation);
          }),
        );
      }),
    );
  });

  const deactivate = Effect.fn("ServiceBroker.deactivate")(function* (owner: ServiceOwner) {
    yield* permit.withPermit(
      Effect.suspend(() => {
        const record = exactRecord(owner);
        if (!record) return Effect.void;
        return removeRecords(cascadeFrom(record.party.id), "Service party deactivated").pipe(
          Effect.uninterruptible,
        );
      }),
    );
  });

  const publish = Effect.fn("ServiceBroker.publish")(function* (
    owner: ServiceOwner,
    service: string,
    input: unknown,
  ) {
    const decoded = yield* decodePortableJson(input);
    return yield* permit.withPermit(
      Effect.gen(function* () {
        const provider = yield* authenticateRecord(owner);
        const key = serviceKey(provider.party.id, service);
        if (!provided.has(key)) return yield* failed("Service is not declared by provider");
        const previous = states.get(key);
        const nextBytes = stateBytes - (previous?.bytes ?? 0) + decoded.bytes;
        if (nextBytes > MaxStateBytes)
          return yield* failed("Published service state exceeds aggregate limits");
        const revision =
          previous?.generation === provider.party.generation ? previous.revision + 1 : 1;
        if (!Number.isSafeInteger(revision)) return yield* failed("Service revision limit reached");
        yield* Effect.uninterruptible(
          Effect.sync(() => {
            states.set(
              key,
              Object.freeze({
                generation: provider.party.generation,
                revision,
                value: decoded.value,
                bytes: decoded.bytes,
              }),
            );
            stateBytes = nextBytes;
            notifyService(provider.party.id, service, provider.party.generation);
          }),
        );
        return { revision };
      }),
    );
  });

  const snapshot = Effect.fn("ServiceBroker.snapshot")(function* (
    consumer: PartyRecord,
    binding: ResolvedServiceBinding,
  ): Effect.fn.Return<ServiceState, ServiceBrokerError> {
    const provider = parties.get(binding.provider);
    if (!provider?.ready) return { available: false };
    const state = states.get(serviceKey(provider.party.id, binding.service.id));
    if (!state || state.generation !== provider.party.generation) return { available: false };
    yield* authorizeParties(consumer.party, provider.party);
    return Object.freeze({
      available: true as const,
      providerGeneration: provider.party.generation,
      revision: state.revision,
      value: state.value,
    });
  });

  const findBinding = (
    consumer: PartyRecord,
    dependency: string,
  ): ResolvedServiceBinding | "optional" | undefined => {
    const requirement = descriptors
      .get(consumer.party.id)
      ?.requires.find((candidate) => candidate.id === dependency);
    if (!requirement) return undefined;
    return (
      bindings.get(bindingKey(consumer.party.id, dependency)) ??
      (requirement.optional ? "optional" : undefined)
    );
  };

  const get = Effect.fn("ServiceBroker.get")(function* (owner: ServiceOwner, dependency: string) {
    return yield* permit.withPermit(
      Effect.gen(function* () {
        const consumer = yield* authenticateRecord(owner);
        const binding = findBinding(consumer, dependency);
        if (!binding) return yield* failed("Service dependency is not declared");
        if (binding === "optional") return { available: false } as const;
        return yield* snapshot(consumer, binding);
      }),
    );
  });

  const subscribe = Effect.fn("ServiceBroker.subscribe")(function* (
    owner: ServiceOwner,
    dependency: string,
  ) {
    return yield* permit.withPermit(
      Effect.gen(function* () {
        const consumer = yield* authenticateRecord(owner);
        const binding = findBinding(consumer, dependency);
        if (!binding) return yield* failed("Service dependency is not declared");
        const state =
          binding === "optional"
            ? ({ available: false } as const)
            : yield* snapshot(consumer, binding);
        if (
          !consumer.subscriptions.has(dependency) &&
          consumer.subscriptions.size >= MaxSubscriptions
        )
          return yield* failed("Too many service subscriptions");
        yield* Effect.uninterruptible(
          Effect.sync(() => {
            consumer.subscriptions.add(dependency);
          }),
        );
        return state;
      }),
    );
  });

  const registerCall = Effect.fn("ServiceBroker.registerCall")(function* (
    owner: ServiceOwner,
    dependency: string,
    method: string,
    params: Schema.Json,
  ): Effect.fn.Return<CallRegistration, ServiceBrokerError> {
    return yield* permit.withPermit(
      Effect.gen(function* () {
        const consumer = yield* authenticateRecord(owner);
        const binding = findBinding(consumer, dependency);
        if (!binding) return yield* failed("Service dependency is not declared");
        if (binding === "optional") return yield* failed("Service provider is unavailable");
        const provider = parties.get(binding.provider);
        if (!provider?.ready) return yield* failed("Service provider is unavailable");
        yield* authorizeParties(consumer.party, provider.party);
        const consumerId = ownerKey(consumer.party);
        const providerId = ownerKey(provider.party);
        if (
          (pendingByConsumer.get(consumerId) ?? 0) >= MaxPendingByConsumer ||
          (pendingByProvider.get(providerId) ?? 0) >= MaxPendingByProvider ||
          pending.size >= MaxPendingCalls
        )
          return yield* failed("Service broker is busy");
        if (callSequence >= Number.MAX_SAFE_INTEGER)
          return yield* failed("Service call identifier limit reached");
        const id = `c${(++callSequence).toString(36)}`;
        const result = yield* Deferred.make<Schema.Json, ServiceBrokerError>();
        const call: PendingCall = Object.freeze({
          id,
          caller: consumer.party,
          provider: provider.party,
          dependency,
          service: binding.service.id,
          method,
          params,
          result,
        });
        pending.set(id, call);
        adjustCount(pendingByConsumer, consumerId, 1);
        adjustCount(pendingByProvider, providerId, 1);
        provider.requests.push(id);
        signal(provider);
        return { id, result };
      }),
    );
  });

  const releaseCall = (registration: CallRegistration) =>
    permit.withPermit(
      Effect.sync(() => {
        removePending(registration.id);
      }),
    );

  const call = Effect.fn("ServiceBroker.call")(function* (
    owner: ServiceOwner,
    dependency: string,
    method: string,
    input: unknown,
  ) {
    const decodedMethod = yield* Schema.decodeUnknownEffect(ServiceMethod)(method).pipe(
      Effect.mapError(() => failed("Service method is invalid")),
    );
    const params = yield* decodePortableJson(input);
    return yield* Effect.acquireUseRelease(
      registerCall(owner, dependency, decodedMethod, params.value),
      (registration) =>
        Deferred.await(registration.result).pipe(
          Effect.timeoutOrElse({
            duration: CallTimeoutMs,
            orElse: () => Effect.fail(failed("Service call timed out")),
          }),
        ),
      (registration) => releaseCall(registration),
    );
  });

  const respond = Effect.fn("ServiceBroker.respond")(function* (
    owner: ServiceOwner,
    response:
      | { readonly callId: string; readonly result: unknown }
      | { readonly callId: string; readonly error: string },
  ) {
    const decoded = "result" in response ? yield* decodePortableJson(response.result) : undefined;
    return yield* permit.withPermit(
      Effect.gen(function* () {
        const provider = exactRecord(owner);
        const call = pending.get(response.callId);
        if (
          !provider ||
          !call ||
          call.provider.id !== provider.party.id ||
          call.provider.generation !== provider.party.generation
        )
          return yield* failed("Service response does not match a pending call");
        const authority = yield* Effect.exit(
          Effect.gen(function* () {
            yield* options.authority
              .authenticateProvider(provider.party)
              .pipe(Effect.mapError(() => failed("Service authority denied")));
            yield* authorizeParties(call.caller, provider.party);
          }),
        );
        if (authority._tag === "Failure") {
          const error = failed("Service authority denied");
          yield* failPending(call.id, error);
          return yield* error;
        }
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const settled = removePending(call.id);
            if (!settled) return yield* failed("Service response does not match a pending call");
            if (decoded) yield* Deferred.succeed(settled.result, decoded.value);
            else yield* Deferred.fail(settled.result, failed("Service provider rejected call"));
          }),
        );
      }),
    );
  });

  const takeDelivery = Effect.fn("ServiceBroker.takeDelivery")(function* (
    owner: ServiceOwner,
  ): Effect.fn.Return<
    { readonly event: string; readonly payload: Schema.Json } | undefined,
    ServiceBrokerError
  > {
    return yield* permit.withPermit(
      Effect.gen(function* () {
        const provider = yield* authenticateRecord(owner);
        while (provider.requests.length > 0) {
          const callId = provider.requests.shift();
          if (callId === undefined) break;
          const pendingCall = pending.get(callId);
          if (
            !pendingCall ||
            pendingCall.provider.id !== provider.party.id ||
            pendingCall.provider.generation !== provider.party.generation
          )
            continue;
          const authorized = yield* Effect.exit(
            authorizeParties(pendingCall.caller, provider.party),
          );
          if (authorized._tag === "Failure") {
            yield* failPending(callId, failed("Service authority denied"));
            continue;
          }
          if (provider.requests.length > 0 || provider.notifications.size > 0) signal(provider);
          const caller = Object.freeze({
            id: pendingCall.caller.id,
            generation: pendingCall.caller.generation,
          });
          const event: ServiceEvent = Object.freeze({
            type: "service.request",
            callId,
            service: pendingCall.service,
            method: pendingCall.method,
            params: pendingCall.params,
            caller,
          });
          return {
            event: event.type,
            payload: Object.freeze({
              callId: event.callId,
              service: event.service,
              method: event.method,
              params: event.params,
              caller,
            }),
          };
        }

        const entry = provider.notifications.entries().next();
        if (entry.done) return undefined;
        const [dependency, notification] = entry.value;
        provider.notifications.delete(dependency);
        if (provider.requests.length > 0 || provider.notifications.size > 0) signal(provider);
        const binding = bindings.get(bindingKey(provider.party.id, dependency));
        if (notification.available) {
          if (
            !binding ||
            binding.provider !== notification.provider ||
            binding.service.id !== notification.service
          )
            return undefined;
          const serviceProvider = parties.get(notification.provider);
          const state = states.get(serviceKey(notification.provider, notification.service));
          if (
            !serviceProvider?.ready ||
            serviceProvider.party.generation !== notification.providerGeneration ||
            state?.generation !== notification.providerGeneration ||
            state.revision !== notification.revision
          )
            return undefined;
          yield* authorizeParties(provider.party, serviceProvider.party);
        } else if (
          binding &&
          (binding.provider !== notification.provider ||
            binding.service.id !== notification.service)
        ) {
          return undefined;
        }
        const event: ServiceEvent = Object.freeze({
          type: "service.state",
          dependency,
          providerGeneration: notification.providerGeneration,
          revision: notification.revision,
          available: notification.available,
        });
        return {
          event: event.type,
          payload: Object.freeze({
            dependency: event.dependency,
            providerGeneration: event.providerGeneration,
            revision: event.revision,
            available: event.available,
          }),
        };
      }),
    );
  });

  const nextEvent = Effect.fn("ServiceBroker.nextEvent")(function* (owner: ServiceOwner) {
    for (;;) {
      const wake = yield* permit.withPermit(
        authenticateRecord(owner).pipe(Effect.map((record) => record.wake)),
      );
      yield* Queue.take(wake);
      const event = yield* takeDelivery(owner);
      if (event !== undefined) return event;
    }
  });
  const events = (
    owner: ServiceOwner,
  ): Stream.Stream<{ readonly event: string; readonly payload: Schema.Json }, ServiceBrokerError> =>
    Stream.fromEffectRepeat(nextEvent(owner));
  const failure = Effect.fn("ServiceBroker.failure")(function* (owner: ServiceOwner) {
    const deferred = yield* permit.withPermit(
      authenticateRecord(owner).pipe(Effect.map((record) => record.failed)),
    );
    return yield* Deferred.await(deferred);
  });

  yield* Effect.addFinalizer(() =>
    permit
      .withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* removeRecords(new Set(parties.keys()), "Service broker closed");
            for (const [callId] of pending)
              yield* failPending(callId, failed("Service broker closed"));
            parties.clear();
            states.clear();
            pending.clear();
            pendingByConsumer.clear();
            pendingByProvider.clear();
            stateBytes = 0;
          }),
        ),
      )
      .pipe(Effect.catchCause(() => Effect.void)),
  );

  return Object.freeze({
    reconfigure,
    activate,
    ready,
    deactivate,
    publish,
    get,
    subscribe,
    call,
    respond,
    events,
    failure,
  });
});
