import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Deferred, Effect } from "effect";
import { createGrantStore } from "@hitchhiker/runtime";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { createPluginManager } from "../src/plugin-manager.ts";

const contract = { name: "test.source", version: "1.0.0", digest: "a".repeat(64) };
const provider = (version = "1.0.0", digest = contract.digest) => ({
  id: "provider",
  name: "Provider",
  version,
  capabilities: [],
  provides: [{ id: "source", contract: { ...contract, digest } }],
  requires: [],
});
const consumer = (optional = false) => ({
  id: "consumer",
  name: "Consumer",
  version: "1.0.0",
  capabilities: [],
  provides: [],
  requires: [{ id: "source", optional, contract }],
});

test("manager service reconciliation stops required consumers with providers and restores provider-first", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-manager-services-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* createGrantStore({ directory: join(root, "grants") });
        const providerGrant = yield* grants.issue({
          principal: "provider",
          profileId: "default",
          capabilities: [],
          origins: [],
        });
        const consumerGrant = yield* grants.issue({
          principal: "consumer",
          profileId: "default",
          capabilities: [],
          origins: [],
        });
        const artifacts = yield* createPluginArtifactStore(root);
        const p = yield* artifacts.stage({ manifest: provider(), code: "provider" });
        const c = yield* artifacts.stage({ manifest: consumer(), code: "consumer" });
        const starts: Array<readonly [string, number]> = [];
        const grantBindings: string[] = [];
        const manager = yield* createPluginManager({
          profileRoot: root,
          grants,
          serviceBindings: [
            { consumer: "consumer", dependency: "source", provider: "provider", service: "source" },
          ],
          launch: (artifact, grantId, ready, activation) => {
            const party = {
              id: artifact.manifest.id,
              generation: activation.generation,
              profileId: activation.profileId,
              grantId,
              declaredCapabilities: artifact.manifest.capabilities,
            };
            const acquire = Effect.gen(function* () {
              if (activation.services) yield* activation.services.activate(party);
              yield* ready;
              if (activation.services) yield* activation.services.ready(party);
              starts.push([party.id, party.generation]);
              grantBindings.push(`${party.id}:${grantId}`);
            });
            return Effect.scoped(
              Effect.acquireRelease(acquire, () =>
                activation.onStopping.pipe(
                  Effect.andThen(
                    activation.services ? activation.services.deactivate(party) : Effect.void,
                  ),
                ),
              ).pipe(Effect.andThen(Effect.never)),
            );
          },
        });
        yield* manager.install(p.hash, providerGrant.grant.id);
        yield* manager.install(c.hash, consumerGrant.grant.id);
        assert.deepEqual(
          new Map((yield* manager.list()).map(({ id, running }) => [id, running])),
          new Map([
            ["provider", true],
            ["consumer", true],
          ]),
        );
        const firstProviderGeneration = starts.find(([id]) => id === "provider")![1];
        yield* manager.disable("provider");
        assert.deepEqual(
          new Map(
            (yield* manager.list()).map(({ id, enabled, running }) => [id, [enabled, running]]),
          ),
          new Map([
            ["provider", [false, false]],
            ["consumer", [true, false]],
          ]),
        );
        const startsBeforeRestore = starts.length;
        yield* manager.enable("provider");
        assert.deepEqual(
          new Map(
            (yield* manager.list()).map(({ id, enabled, running }) => [id, [enabled, running]]),
          ),
          new Map([
            ["provider", [true, true]],
            ["consumer", [true, true]],
          ]),
        );
        assert(
          starts
            .filter(([id]) => id === "provider")
            .some(([, generation]) => generation > firstProviderGeneration),
        );
        assert.deepEqual(
          starts.slice(startsBeforeRestore).map(([id]) => id),
          ["provider", "consumer"],
        );
        const replacementGrant = yield* grants.issue({
          principal: "provider",
          profileId: "default",
          capabilities: [],
          origins: [],
        });
        const consumerStarts = starts.filter(([id]) => id === "consumer").length;
        yield* manager.install(p.hash, replacementGrant.grant.id);
        assert(grantBindings.includes(`provider:${replacementGrant.grant.id}`));
        assert(starts.filter(([id]) => id === "consumer").length > consumerStarts);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional consumers stay running and incompatible provider replacements fail before stopping", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-manager-optional-services-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* createGrantStore({ directory: join(root, "grants") });
        const pg = yield* grants.issue({
          principal: "provider",
          profileId: "default",
          capabilities: [],
          origins: [],
        });
        const cg = yield* grants.issue({
          principal: "consumer",
          profileId: "default",
          capabilities: [],
          origins: [],
        });
        const artifacts = yield* createPluginArtifactStore(root);
        const p = yield* artifacts.stage({ manifest: provider(), code: "provider" });
        const bad = yield* artifacts.stage({
          manifest: provider("2.0.0", "b".repeat(64)),
          code: "bad",
        });
        const c = yield* artifacts.stage({ manifest: consumer(true), code: "consumer" });
        const started: string[] = [];
        const manager = yield* createPluginManager({
          profileRoot: root,
          grants,
          serviceBindings: [
            { consumer: "consumer", dependency: "source", provider: "provider", service: "source" },
          ],
          launch: (artifact, grantId, ready, activation) => {
            const party = {
              id: artifact.manifest.id,
              generation: activation.generation,
              profileId: activation.profileId,
              grantId,
              declaredCapabilities: artifact.manifest.capabilities,
            };
            return Effect.scoped(
              Effect.acquireRelease(
                Effect.gen(function* () {
                  if (activation.services) yield* activation.services.activate(party);
                  yield* ready;
                  if (activation.services) yield* activation.services.ready(party);
                  started.push(party.id);
                }),
                () =>
                  activation.onStopping.pipe(
                    Effect.andThen(
                      activation.services ? activation.services.deactivate(party) : Effect.void,
                    ),
                  ),
              ).pipe(Effect.andThen(Effect.never)),
            );
          },
        });
        yield* manager.install(p.hash, pg.grant.id);
        yield* manager.install(c.hash, cg.grant.id);
        const before = (yield* manager.list()).find((item) => item.id === "provider")!;
        yield* manager.install(bad.hash, pg.grant.id).pipe(Effect.flip);
        const after = (yield* manager.list()).find((item) => item.id === "provider")!;
        assert.equal(after.hash, before.hash);
        assert.equal(started.filter((id) => id === "consumer").length, 1);
        yield* manager.disable("provider");
        assert.equal((yield* manager.list()).find((item) => item.id === "consumer")?.running, true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider crash waits for required consumer cleanup before fallback and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-manager-service-crash-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* createGrantStore({ directory: join(root, "grants") });
        const pg = yield* grants.issue({
          principal: "provider",
          profileId: "default",
          capabilities: [],
          origins: [],
        });
        const cg = yield* grants.issue({
          principal: "consumer",
          profileId: "default",
          capabilities: [],
          origins: [],
        });
        const artifacts = yield* createPluginArtifactStore(root);
        const stable = yield* artifacts.stage({ manifest: provider(), code: "stable" });
        const crashing = yield* artifacts.stage({ manifest: provider("2.0.0"), code: "crash" });
        const c = yield* artifacts.stage({ manifest: consumer(), code: "consumer" });
        const crash = yield* Deferred.make<void, string>();
        const consumerStopped = yield* Deferred.make<void>();
        const releaseConsumer = yield* Deferred.make<void>();
        const providerRestarted = yield* Deferred.make<void>();
        const consumerRestarted = yield* Deferred.make<void>();
        let armed = false;
        const starts: string[] = [];
        const manager = yield* createPluginManager({
          profileRoot: root,
          grants,
          serviceBindings: [
            { consumer: "consumer", dependency: "source", provider: "provider", service: "source" },
          ],
          launch: (artifact, grantId, ready, activation) => {
            const party = {
              id: artifact.manifest.id,
              generation: activation.generation,
              profileId: activation.profileId,
              grantId,
              declaredCapabilities: artifact.manifest.capabilities,
            };
            const finalizer = () =>
              Effect.gen(function* () {
                yield* activation.onStopping;
                if (party.id === "consumer" && armed) {
                  yield* Deferred.succeed(consumerStopped, undefined);
                  yield* Deferred.await(releaseConsumer);
                }
                if (activation.services) yield* activation.services.deactivate(party);
              });
            return Effect.scoped(
              Effect.acquireRelease(
                activation.services ? activation.services.activate(party) : Effect.void,
                finalizer,
              ).pipe(
                Effect.andThen(ready),
                Effect.andThen(
                  activation.services ? activation.services.ready(party) : Effect.void,
                ),
                Effect.andThen(
                  Effect.sync(() => {
                    starts.push(`${party.id}:${artifact.code}`);
                  }),
                ),
                Effect.tap(() =>
                  armed && party.id === "provider" && artifact.code === "stable"
                    ? Deferred.succeed(providerRestarted, undefined)
                    : armed && party.id === "consumer"
                      ? Deferred.succeed(consumerRestarted, undefined)
                      : Effect.void,
                ),
                Effect.andThen(artifact.code === "crash" ? Deferred.await(crash) : Effect.never),
              ),
            );
          },
        });
        yield* manager.install(stable.hash, pg.grant.id);
        yield* manager.install(c.hash, cg.grant.id);
        yield* manager.install(crashing.hash, pg.grant.id);
        armed = true;
        yield* Effect.sleep(300);
        yield* Deferred.fail(crash, "provider crash");
        yield* Deferred.await(consumerStopped).pipe(
          Effect.timeoutOrElse({
            duration: 2_000,
            orElse: () => Effect.fail(new Error("consumer was not stopped")),
          }),
        );
        assert.equal(starts.filter((item) => item === "provider:stable").length, 1);
        yield* Deferred.succeed(releaseConsumer, undefined);
        yield* Deferred.await(providerRestarted).pipe(
          Effect.timeoutOrElse({
            duration: 2_000,
            orElse: () => Effect.fail(new Error("provider did not restart")),
          }),
        );
        yield* Deferred.await(consumerRestarted).pipe(
          Effect.timeoutOrElse({
            duration: 2_000,
            orElse: () => Effect.fail(new Error("consumer did not restart")),
          }),
        );
        assert(starts.filter((item) => item === "provider:stable").length >= 2);
        assert(starts.filter((item) => item === "consumer:consumer").length >= 3);
        const entries = yield* manager.list();
        assert.equal(entries.find((entry) => entry.id === "provider")?.version, "1.0.0");
        assert.equal(entries.find((entry) => entry.id === "consumer")?.version, "1.0.0");
        assert(entries.every((entry) => entry.running));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
