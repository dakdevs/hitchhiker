import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import {
  createPluginServiceBroker,
  type PluginServiceBroker,
  type ServiceBrokerAuthority,
  type ServiceOwner,
} from "../src/plugin-service-broker.ts";
import type { ServiceParty } from "../src/service-authority.ts";
import { validateServiceGraph } from "../src/service-contracts.ts";

const contract = Object.freeze({
  name: "test.echo",
  version: "1.0.0",
  digest: "a".repeat(64),
});
const provider = (generation = 1): ServiceParty => ({
  id: "provider",
  generation,
  profileId: "profile",
  grantId: `provider-grant-${generation}`,
  declaredCapabilities: [],
});
const consumer = (generation = 1, id = "consumer"): ServiceParty => ({
  id,
  generation,
  profileId: "profile",
  grantId: `${id}-grant-${generation}`,
  declaredCapabilities: [],
});
const owner = (party: ServiceParty): ServiceOwner => ({
  id: party.id,
  generation: party.generation,
});
const plugin = (
  id: string,
  provides: readonly string[] = [],
  requires: readonly { readonly id: string; readonly optional?: boolean }[] = [],
) => ({
  id,
  provides: provides.map((service) => ({ id: service, contract })),
  requires: requires.map((dependency) => ({ ...dependency, contract })),
});

const allow: ServiceBrokerAuthority = {
  authenticateProvider: () => Effect.void,
  authorizeService: () => Effect.void,
};

const withBroker = <A>(
  installed: unknown,
  bindings: unknown,
  use: (broker: PluginServiceBroker) => Effect.Effect<A, unknown, Scope.Scope>,
  authority: ServiceBrokerAuthority = allow,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const graph = yield* validateServiceGraph(installed, bindings);
        const broker = yield* createPluginServiceBroker({ graph, profileId: "profile", authority });
        return yield* use(broker);
      }),
    ),
  );

const standardPlugins = [
  plugin("provider", ["echo"]),
  plugin("consumer", [], [{ id: "echo" }, { id: "missing", optional: true }]),
];
const standardBindings = [
  { consumer: "consumer", dependency: "echo", provider: "provider", service: "echo" },
];

const nextEvent = (broker: PluginServiceBroker, party: ServiceParty) =>
  Stream.runCollect(broker.events(owner(party)).pipe(Stream.take(1))).pipe(
    Effect.map((events) => events[0]!),
  );

test("required providers gate activation and unbound optional dependencies stay unavailable", async () => {
  await withBroker(standardPlugins, standardBindings, (broker) =>
    Effect.gen(function* () {
      assert(Exit.isFailure(yield* Effect.exit(broker.activate(consumer()))));
      yield* broker.activate(provider());
      yield* broker.publish(owner(provider()), "echo", { version: 1 });
      yield* broker.ready(owner(provider()));
      yield* broker.activate(consumer());

      assert.deepEqual(yield* broker.get(owner(consumer()), "echo"), {
        available: true,
        providerGeneration: 1,
        revision: 1,
        value: { version: 1 },
      });
      assert.deepEqual(yield* broker.get(owner(consumer()), "missing"), { available: false });
      assert.deepEqual(yield* broker.subscribe(owner(consumer()), "missing"), {
        available: false,
      });
      assert(
        Exit.isFailure(yield* Effect.exit(broker.call(owner(consumer()), "missing", "ping", null))),
      );
    }),
  );
});

test("interrupted activation leaves the previous generation and its state authoritative", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const never = yield* Deferred.make<void>();
        const authority: ServiceBrokerAuthority = {
          authenticateProvider: (party) =>
            party.id === "provider" && party.generation === 2
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(never)))
              : Effect.void,
          authorizeService: () => Effect.void,
        };
        const graph = yield* validateServiceGraph(standardPlugins, standardBindings);
        const broker = yield* createPluginServiceBroker({
          graph,
          profileId: "profile",
          authority,
        });
        yield* broker.activate(provider());
        yield* broker.ready(owner(provider()));
        yield* broker.publish(owner(provider()), "echo", { generation: 1 });
        yield* broker.activate(consumer());
        const replacement = yield* Effect.forkScoped(broker.activate(provider(2)));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(replacement);
        assert.deepEqual(yield* broker.get(owner(consumer()), "echo"), {
          available: true,
          providerGeneration: 1,
          revision: 1,
          value: { generation: 1 },
        });
      }),
    ),
  );
});

test("replacement retires old queues, pending calls, state, and required consumers atomically", async () => {
  await withBroker(standardPlugins, standardBindings, (broker) =>
    Effect.gen(function* () {
      yield* broker.activate(provider());
      yield* broker.ready(owner(provider()));
      yield* broker.publish(owner(provider()), "echo", { generation: 1 });
      yield* broker.activate(consumer());

      const call = yield* Effect.forkScoped(
        Effect.exit(broker.call(owner(consumer()), "echo", "wait", null)),
      );
      const request = yield* nextEvent(broker, provider());
      assert.equal(request.event, "service.request");
      const oldEvents = yield* Effect.forkScoped(
        Effect.exit(Stream.runHead(broker.events(owner(provider())))),
      );
      const consumerFailure = yield* Effect.forkScoped(
        Effect.exit(broker.failure(owner(consumer()))),
      );

      yield* broker.activate(provider(2));
      assert(Exit.isFailure(yield* Fiber.join(call)));
      assert(Exit.isFailure(yield* Fiber.join(oldEvents)));
      assert(Exit.isFailure(yield* Fiber.join(consumerFailure)));
      assert(Exit.isFailure(yield* Effect.exit(broker.get(owner(consumer()), "echo"))));

      yield* broker.deactivate(owner(provider()));
      yield* broker.ready(owner(provider(2)));
      yield* broker.activate(consumer(2));
      assert.deepEqual(yield* broker.get(owner(consumer(2)), "echo"), { available: false });
    }),
  );
});

test("state notifications coalesce and recheck current authority at delivery", async () => {
  let denyPairs = false;
  const authority: ServiceBrokerAuthority = {
    authenticateProvider: () => Effect.void,
    authorizeService: () => (denyPairs ? Effect.fail("revoked") : Effect.void),
  };
  const installed = [
    plugin("provider", ["echo"]),
    plugin("consumer", [], [{ id: "echo", optional: true }]),
  ];
  const bindings = [
    { consumer: "consumer", dependency: "echo", provider: "provider", service: "echo" },
  ];
  await withBroker(
    installed,
    bindings,
    (broker) =>
      Effect.gen(function* () {
        yield* broker.activate(consumer());
        assert.deepEqual(yield* broker.subscribe(owner(consumer()), "echo"), {
          available: false,
        });
        yield* broker.activate(provider());
        yield* broker.ready(owner(provider()));
        yield* broker.publish(owner(provider()), "echo", { revision: 1 });
        yield* broker.publish(owner(provider()), "echo", { revision: 2 });
        yield* broker.publish(owner(provider()), "echo", { revision: 3 });
        const event = yield* nextEvent(broker, consumer());
        assert.equal(event.event, "service.state");
        assert.deepEqual(event.payload, {
          dependency: "echo",
          providerGeneration: 1,
          revision: 3,
          available: true,
        });

        yield* broker.publish(owner(provider()), "echo", { revision: 4 });
        denyPairs = true;
        assert(
          Exit.isFailure(yield* Effect.exit(Stream.runHead(broker.events(owner(consumer()))))),
        );
      }),
    authority,
  );
});

test("deactivation is idempotent and does not require a still-valid grant", async () => {
  let revoked = false;
  const authority: ServiceBrokerAuthority = {
    authenticateProvider: () => (revoked ? Effect.fail("revoked") : Effect.void),
    authorizeService: () => Effect.void,
  };
  await withBroker(
    [plugin("provider", ["echo"])],
    [],
    (broker) =>
      Effect.gen(function* () {
        yield* broker.activate(provider());
        const failed = yield* Effect.forkScoped(Effect.exit(broker.failure(owner(provider()))));
        revoked = true;
        yield* broker.deactivate(owner(provider()));
        yield* broker.deactivate(owner(provider()));
        assert(Exit.isFailure(yield* Fiber.join(failed)));
      }),
    authority,
  );
});

test("JSON boundaries reject accessors, exotic objects, cycles, and preserve global replacement accounting", async () => {
  const providers = Array.from({ length: 16 }, (_, index) =>
    plugin(`provider-${index}`, ["state"]),
  );
  await withBroker(providers, [], (broker) =>
    Effect.gen(function* () {
      const parties = providers.map((descriptor) => consumer(1, descriptor.id));
      for (const party of parties) yield* broker.activate(party);

      let getterCalls = 0;
      const accessor = {};
      Object.defineProperty(accessor, "value", {
        enumerable: true,
        get: () => {
          getterCalls++;
          return 1;
        },
      });
      assert(
        Exit.isFailure(yield* Effect.exit(broker.publish(owner(parties[0]!), "state", accessor))),
      );
      assert.equal(getterCalls, 0);
      assert(
        Exit.isFailure(yield* Effect.exit(broker.publish(owner(parties[0]!), "state", new Date()))),
      );
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      assert(
        Exit.isFailure(yield* Effect.exit(broker.publish(owner(parties[0]!), "state", cyclic))),
      );

      const full = "x".repeat(64 * 1024);
      for (let index = 0; index < 15; index++)
        yield* broker.publish(owner(parties[index]!), "state", full);
      assert.deepEqual(yield* broker.publish(owner(parties[0]!), "state", full), {
        revision: 2,
      });
      assert(
        Exit.isFailure(yield* Effect.exit(broker.publish(owner(parties[15]!), "state", full))),
      );
    }),
  );
});

test("method validation, interrupted event waits, and call concurrency limits clean up deterministically", async () => {
  const installed = [
    plugin("provider", ["echo"]),
    plugin("consumer-a", [], [{ id: "echo" }]),
    plugin("consumer-b", [], [{ id: "echo" }]),
    plugin("consumer-c", [], [{ id: "echo" }]),
  ];
  const bindings = ["consumer-a", "consumer-b", "consumer-c"].map((id) => ({
    consumer: id,
    dependency: "echo",
    provider: "provider",
    service: "echo",
  }));
  await withBroker(installed, bindings, (broker) =>
    Effect.gen(function* () {
      const a = consumer(1, "consumer-a");
      const b = consumer(1, "consumer-b");
      const c = consumer(1, "consumer-c");
      yield* broker.activate(provider());
      yield* broker.ready(owner(provider()));
      for (const party of [a, b, c]) yield* broker.activate(party);

      assert(Exit.isFailure(yield* Effect.exit(broker.call(owner(a), "echo", "bad method", null))));
      const waiting = yield* Effect.forkScoped(Stream.runHead(broker.events(owner(provider()))));
      yield* Fiber.interrupt(waiting);

      const calls = [];
      for (let index = 0; index < 16; index++)
        calls.push(yield* Effect.forkScoped(broker.call(owner(a), "echo", "hold", index)));
      yield* Stream.runCollect(broker.events(owner(provider())).pipe(Stream.take(16)));
      assert(Exit.isFailure(yield* Effect.exit(broker.call(owner(a), "echo", "overflow", null))));
      for (let index = 0; index < 16; index++)
        calls.push(yield* Effect.forkScoped(broker.call(owner(b), "echo", "hold", index)));
      yield* Stream.runCollect(broker.events(owner(provider())).pipe(Stream.take(16)));
      assert(Exit.isFailure(yield* Effect.exit(broker.call(owner(c), "echo", "overflow", null))));

      for (const fiber of calls) yield* Fiber.interrupt(fiber);
      const finalCall = yield* Effect.forkScoped(broker.call(owner(c), "echo", "ping", null));
      const event = yield* nextEvent(broker, provider());
      const payload = Schema.decodeUnknownSync(Schema.Struct({ callId: Schema.String }))(
        event.payload,
      );
      yield* broker.respond(owner(provider()), { callId: payload.callId, result: { ok: true } });
      assert.deepEqual(yield* Fiber.join(finalCall), { ok: true });
    }),
  );
});

test("a timed-out call rejects its late response and releases routing capacity", async () => {
  await withBroker(standardPlugins, standardBindings, (broker) =>
    Effect.gen(function* () {
      yield* broker.activate(provider());
      yield* broker.ready(owner(provider()));
      yield* broker.activate(consumer());

      const timedOut = yield* Effect.forkScoped(
        Effect.exit(broker.call(owner(consumer()), "echo", "slow", null)),
      );
      const first = yield* nextEvent(broker, provider());
      const firstPayload = Schema.decodeUnknownSync(Schema.Struct({ callId: Schema.String }))(
        first.payload,
      );
      assert(Exit.isFailure(yield* Fiber.join(timedOut)));
      assert(
        Exit.isFailure(
          yield* Effect.exit(
            broker.respond(owner(provider()), {
              callId: firstPayload.callId,
              result: { tooLate: true },
            }),
          ),
        ),
      );

      const fresh = yield* Effect.forkScoped(broker.call(owner(consumer()), "echo", "fresh", null));
      const second = yield* nextEvent(broker, provider());
      const secondPayload = Schema.decodeUnknownSync(Schema.Struct({ callId: Schema.String }))(
        second.payload,
      );
      yield* broker.respond(owner(provider()), {
        callId: secondPayload.callId,
        result: { ok: true },
      });
      assert.deepEqual(yield* Fiber.join(fresh), { ok: true });
    }),
  );
});
