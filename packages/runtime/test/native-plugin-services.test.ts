import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import { create } from "../src/grants.ts";
import { createServiceAuthority } from "../src/service-authority.ts";
import { validateServiceGraph } from "../src/service-contracts.ts";
import { createPluginServiceBroker } from "../src/plugin-service-broker.ts";
import { runLivePlugin } from "../src/plugin-session.ts";

const executable = process.env.HITCHHIKER_PLUGIN_HOST;
const contract = { name: "example.counter", version: "1.0.0", digest: "a".repeat(64) };
const provider = {
  id: "service-provider",
  version: "1.0.0",
  name: "Counter",
  capabilities: [],
  provides: [{ id: "counter", contract }],
};
const consumer = {
  id: "service-consumer",
  version: "1.0.0",
  name: "Counter consumer",
  capabilities: [],
  provides: [{ id: "report", contract }],
  requires: [{ id: "counter", contract, optional: false }],
};

test(
  "isolated SDK plugins exchange service state and commands without page authority",
  { skip: !executable, timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-service-sdk-"));
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const grants = yield* create({ directory });
          const graph = yield* validateServiceGraph(
            [
              { id: provider.id, provides: provider.provides },
              { id: consumer.id, provides: consumer.provides, requires: consumer.requires },
            ],
            [
              {
                consumer: consumer.id,
                dependency: "counter",
                provider: provider.id,
                service: "counter",
              },
            ],
          );
          const broker = yield* createPluginServiceBroker({
            graph,
            profileId: "default",
            authority: createServiceAuthority(grants),
          });
          const report = yield* Deferred.make<Schema.Json>();
          const launch = Effect.fn(function* (
            manifest: typeof provider | typeof consumer,
            ready: Deferred.Deferred<void>,
          ) {
            const issued = yield* grants.issue({
              principal: manifest.id,
              profileId: "default",
              capabilities: [],
              origins: [],
            });
            const party = {
              id: manifest.id,
              generation: 1,
              profileId: "default",
              grantId: issued.grant.id,
              declaredCapabilities: [],
            };
            const code = yield* Effect.promise(() =>
              readFile(
                new URL(
                  `../../../apps/composition-example/dist/${manifest.id}.js`,
                  import.meta.url,
                ),
                "utf8",
              ),
            );
            const running = yield* Effect.acquireRelease(broker.activate(party), () =>
              broker.deactivate(party),
            ).pipe(
              Effect.andThen(
                runLivePlugin({
                  manifest,
                  code,
                  executable: executable!,
                  token: issued.token,
                  profileId: "default",
                  grants,
                  browser: {
                    pages: Effect.die("Unexpected pages API"),
                    open: () => Effect.die("Unexpected pages API"),
                    close: () => Effect.die("Unexpected pages API"),
                    navigate: () => Effect.die("Unexpected pages API"),
                    configuration: Effect.die("Unexpected configuration API"),
                    configure: () => Effect.die("Unexpected configuration API"),
                    setTabPlacement: () => Effect.die("Unexpected tab API"),
                  },
                  publish: () => Effect.die("Unexpected UI API"),
                  release: Effect.void,
                  onStop: Effect.void,
                  events: Stream.never,
                  serviceEvents: broker.events(party),
                  stopWhen: broker.failure(party),
                  onReady: broker
                    .ready(party)
                    .pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.asVoid),
                  services: {
                    publish: (service, value) =>
                      broker
                        .publish(party, service, value)
                        .pipe(
                          Effect.tap(() =>
                            service === "report" ? Deferred.succeed(report, value) : Effect.void,
                          ),
                        ),
                    get: (dependency) => broker.get(party, dependency),
                    subscribe: (dependency) => broker.subscribe(party, dependency),
                    call: (dependency, method, params) =>
                      broker.call(party, dependency, method, params),
                    respond: (response) => broker.respond(party, response),
                  },
                }),
              ),
              Effect.scoped,
              Effect.forkScoped,
            );
            yield* Deferred.await(ready).pipe(Effect.timeout(5_000));
            return { party, running, grantId: issued.grant.id };
          });
          const first = yield* launch(provider, yield* Deferred.make<void>());
          const second = yield* launch(consumer, yield* Deferred.make<void>());
          assert.deepEqual(yield* Deferred.await(report), {
            initial: { available: true, providerGeneration: 1, revision: 1, value: { value: 0 } },
            result: { value: 1 },
          });
          yield* grants.revoke(first.grantId);
          assert(Exit.isFailure(yield* Effect.exit(broker.get(second.party, "counter"))));
          assert(Exit.isFailure(yield* Fiber.await(second.running).pipe(Effect.timeout(2_000))));
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
