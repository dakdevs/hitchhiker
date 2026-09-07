import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import type { Capability } from "@hitchhiker/core";
import { Effect } from "effect";
import { create, type GrantStoreApi } from "../src/grants.ts";
import {
  createServiceAuthority,
  type EffectiveAuthority,
  type ServiceParty,
} from "../src/service-authority.ts";

const withStore = async <A>(run: (store: GrantStoreApi) => Effect.Effect<A, unknown>) => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-service-authority-"));
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* create({ directory });
        return yield* run(store);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const party = (
  id: string,
  grantId: string,
  declaredCapabilities: readonly Capability[],
  profileId = "profile",
  generation = 1,
): ServiceParty => ({ id, generation, profileId, grantId, declaredCapabilities });

const issueParty = Effect.fn("ServiceAuthorityTest.issueParty")(function* (
  store: GrantStoreApi,
  input: {
    readonly id: string;
    readonly grantCapabilities: readonly Capability[];
    readonly declaredCapabilities: readonly Capability[];
    readonly origins?: readonly string[];
    readonly profileId?: string;
    readonly expiresAt?: number;
  },
) {
  const issued = yield* store.issue({
    principal: input.id,
    profileId: input.profileId ?? "profile",
    capabilities: input.grantCapabilities,
    origins: input.origins ?? [],
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });
  return party(input.id, issued.grant.id, input.declaredCapabilities, input.profileId);
});

const assertDenied = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.flip,
    Effect.map(() => undefined),
  );

test("authenticates the full durable chain and intersects manifest and grant authority", async () => {
  await withStore((store) =>
    Effect.gen(function* () {
      const authority = createServiceAuthority(store);
      const broadGrant = yield* issueParty(store, {
        id: "broad-grant",
        grantCapabilities: ["browser.full-control", "cdp.connect"],
        declaredCapabilities: ["pages.read"],
      });
      assert.deepEqual(yield* authority.authenticateProvider(broadGrant), {
        id: broadGrant.id,
        generation: broadGrant.generation,
        profileId: broadGrant.profileId,
        grantId: broadGrant.grantId,
        capabilities: ["pages.read"],
        origins: "all",
      } satisfies EffectiveAuthority);

      const broadManifest = yield* issueParty(store, {
        id: "broad-manifest",
        grantCapabilities: ["pages.read", "cdp.connect"],
        declaredCapabilities: ["browser.full-control"],
        origins: [],
      });
      assert.deepEqual(yield* authority.authenticateProvider(broadManifest), {
        id: broadManifest.id,
        generation: broadManifest.generation,
        profileId: broadManifest.profileId,
        grantId: broadManifest.grantId,
        capabilities: ["cdp.connect"],
        origins: [],
      } satisfies EffectiveAuthority);

      const expiresAt = Date.now() + 60_000;
      const emptyOriginsProvider = yield* issueParty(store, {
        id: "empty-origins-provider",
        grantCapabilities: ["pages.read", "pages.write"],
        declaredCapabilities: ["pages.read", "pages.write"],
        origins: [],
        expiresAt,
      });
      const emptyConsumer = yield* issueParty(store, {
        id: "empty-consumer",
        grantCapabilities: [],
        declaredCapabilities: [],
        origins: [],
        expiresAt,
      });
      assert.deepEqual(
        (yield* authority.authenticateProvider(emptyOriginsProvider)).capabilities,
        [],
      );
      yield* authority.authorizeService(emptyConsumer, emptyOriginsProvider);

      yield* assertDenied(
        authority.authenticateProvider({ ...broadManifest, id: "different-principal" }),
      );
      yield* assertDenied(
        authority.authenticateProvider({ ...broadManifest, profileId: "different-profile" }),
      );
    }),
  );
});

test("requires consumer authority to contain finite origins, all origins, and expiry", async () => {
  await withStore((store) =>
    Effect.gen(function* () {
      const authority = createServiceAuthority(store);
      const now = Date.now();
      const provider = yield* issueParty(store, {
        id: "provider",
        grantCapabilities: ["pages.read"],
        declaredCapabilities: ["pages.read"],
        origins: ["https://one.test"],
        expiresAt: now + 60_000,
      });
      const containing = yield* issueParty(store, {
        id: "containing-consumer",
        grantCapabilities: ["pages.read"],
        declaredCapabilities: ["pages.read"],
        origins: ["https://one.test", "https://two.test"],
        expiresAt: now + 120_000,
      });
      yield* authority.authorizeService(containing, provider);

      const wrongOrigin = yield* issueParty(store, {
        id: "wrong-origin-consumer",
        grantCapabilities: ["pages.read"],
        declaredCapabilities: ["pages.read"],
        origins: ["https://two.test"],
        expiresAt: now + 120_000,
      });
      yield* assertDenied(authority.authorizeService(wrongOrigin, provider));

      const shorter = yield* issueParty(store, {
        id: "shorter-consumer",
        grantCapabilities: ["pages.read"],
        declaredCapabilities: ["pages.read"],
        origins: ["https://one.test"],
        expiresAt: now + 30_000,
      });
      yield* assertDenied(authority.authorizeService(shorter, provider));

      const allOriginsProvider = yield* issueParty(store, {
        id: "all-origins-provider",
        grantCapabilities: ["browser.full-control"],
        declaredCapabilities: ["pages.read"],
      });
      yield* assertDenied(authority.authorizeService(containing, allOriginsProvider));
      const allOriginsConsumer = yield* issueParty(store, {
        id: "all-origins-consumer",
        grantCapabilities: ["browser.full-control"],
        declaredCapabilities: ["pages.read"],
      });
      yield* authority.authorizeService(allOriginsConsumer, allOriginsProvider);

      const otherProfile = yield* issueParty(store, {
        id: "other-profile-consumer",
        profileId: "other-profile",
        grantCapabilities: ["browser.full-control"],
        declaredCapabilities: ["pages.read"],
      });
      yield* assertDenied(authority.authorizeService(otherProfile, allOriginsProvider));
    }),
  );
});

test("preserves future full-control and CDP as separate containment requirements", async () => {
  await withStore((store) =>
    Effect.gen(function* () {
      const authority = createServiceAuthority(store);
      const wildcardProvider = yield* issueParty(store, {
        id: "wildcard-provider",
        grantCapabilities: ["browser.full-control"],
        declaredCapabilities: ["browser.full-control"],
      });
      const currentCapabilities = yield* issueParty(store, {
        id: "finite-consumer",
        grantCapabilities: [
          "pages.list",
          "pages.manage",
          "pages.read",
          "pages.write",
          "ui.compose",
          "configuration.write",
          "plugins.install",
        ],
        declaredCapabilities: ["browser.full-control"],
        origins: ["https://one.test"],
      });
      yield* assertDenied(authority.authorizeService(currentCapabilities, wildcardProvider));

      const wildcardConsumer = yield* issueParty(store, {
        id: "wildcard-consumer",
        grantCapabilities: ["browser.full-control"],
        declaredCapabilities: ["browser.full-control"],
      });
      yield* authority.authorizeService(wildcardConsumer, wildcardProvider);

      const cdpProvider = yield* issueParty(store, {
        id: "cdp-provider",
        grantCapabilities: ["cdp.connect"],
        declaredCapabilities: ["browser.full-control"],
      });
      yield* assertDenied(authority.authorizeService(wildcardConsumer, cdpProvider));
      const cdpConsumer = yield* issueParty(store, {
        id: "cdp-consumer",
        grantCapabilities: ["cdp.connect"],
        declaredCapabilities: ["cdp.connect"],
      });
      yield* authority.authorizeService(cdpConsumer, cdpProvider);
    }),
  );
});

test("rereads ancestor revocation and expiry at every service boundary", async () => {
  await withStore((store) =>
    Effect.gen(function* () {
      const authority = createServiceAuthority(store);
      const parent = yield* store.issue({
        principal: "manager",
        profileId: "profile",
        capabilities: ["plugins.install", "pages.list"],
        origins: [],
        expiresAt: Date.now() + 60_000,
      });
      const child = yield* store.delegateGrant(parent.grant.id, {
        principal: "provider",
        capabilities: ["pages.list"],
      });
      const provider = party("provider", child.id, ["pages.list"]);
      const consumer = yield* issueParty(store, {
        id: "consumer",
        grantCapabilities: ["pages.list"],
        declaredCapabilities: ["pages.list"],
        expiresAt: child.expiresAt,
      });
      yield* authority.authorizeService(consumer, provider);
      yield* store.revoke(parent.grant.id);
      yield* assertDenied(authority.authenticateProvider(provider));
      yield* assertDenied(authority.authorizeService(consumer, provider));

      const expired = yield* issueParty(store, {
        id: "expired-provider",
        grantCapabilities: ["pages.list"],
        declaredCapabilities: ["pages.list"],
        expiresAt: 0,
      });
      yield* assertDenied(authority.authenticateProvider(expired));
    }),
  );
});
