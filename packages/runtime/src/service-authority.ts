import type { Capability, CapabilityGrant } from "@hitchhiker/core";
import { Effect } from "effect";
import { GrantStoreError, type GrantStoreApi } from "./grants.ts";

type CapabilityScope = "originless" | "scoped" | "wildcard" | "cdp";
const capabilityScopes = {
  "pages.list": "originless",
  "pages.manage": "originless",
  "pages.read": "scoped",
  "pages.write": "scoped",
  "ui.compose": "originless",
  "configuration.read": "originless",
  "configuration.write": "originless",
  "plugins.install": "originless",
  "plugins.read": "originless",
  "plugins.manage": "originless",
  "extensions.read": "originless",
  "extensions.manage": "originless",
  "extensions.install": "originless",
  "devtools.manage": "originless",
  "storage.local": "originless",
  "browser.full-control": "wildcard",
  "cdp.connect": "cdp",
} as const satisfies Record<Capability, CapabilityScope>;
const capabilities = Object.keys(capabilityScopes) as Capability[];

export interface ServiceParty {
  readonly id: string;
  readonly generation: number;
  readonly profileId: string;
  /** Trusted broker identity. Service protocol peers must never supply grant IDs. */
  readonly grantId: string;
  readonly declaredCapabilities: readonly Capability[];
}

export interface EffectiveAuthority {
  readonly id: string;
  readonly generation: number;
  readonly profileId: string;
  readonly grantId: string;
  readonly capabilities: readonly Capability[];
  /** `all` is possible only when the durable grant has browser.full-control. */
  readonly origins: "all" | readonly string[];
  readonly expiresAt?: number;
}

const denied = () =>
  new GrantStoreError({ code: "denied", message: "Service authority is not authorized" });

const includes = (values: readonly Capability[], capability: Capability) =>
  values.includes(capability);

const effectiveAuthority = (party: ServiceParty, grant: CapabilityGrant): EffectiveAuthority => {
  const manifestFullControl = includes(party.declaredCapabilities, "browser.full-control");
  const grantFullControl = includes(grant.capabilities, "browser.full-control");
  const allowsManifest = (capability: Capability) =>
    includes(party.declaredCapabilities, capability) ||
    (capability !== "cdp.connect" && manifestFullControl);
  const allowsGrant = (capability: Capability) =>
    includes(grant.capabilities, capability) || (capability !== "cdp.connect" && grantFullControl);
  const effectiveCapabilities = Object.freeze(
    capabilities.filter((capability) => {
      switch (capabilityScopes[capability]) {
        case "wildcard":
          return manifestFullControl && grantFullControl;
        case "cdp":
          return allowsManifest(capability) && allowsGrant(capability);
        case "scoped":
          if (!grantFullControl && grant.origins.length === 0) return false;
          return allowsManifest(capability) && allowsGrant(capability);
        case "originless":
          return allowsManifest(capability) && allowsGrant(capability);
      }
    }),
  );
  const hasScopedAuthority = effectiveCapabilities.some(
    (capability) => capabilityScopes[capability] === "scoped",
  );
  const origins = !hasScopedAuthority
    ? Object.freeze([] as string[])
    : grantFullControl
      ? "all"
      : Object.freeze([...grant.origins]);
  return Object.freeze({
    id: party.id,
    generation: party.generation,
    profileId: party.profileId,
    grantId: party.grantId,
    capabilities: effectiveCapabilities,
    origins,
    ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
  });
};

const containsOrigins = (
  consumer: EffectiveAuthority["origins"],
  provider: EffectiveAuthority["origins"],
) =>
  provider === "all"
    ? consumer === "all"
    : consumer === "all" || provider.every((origin) => consumer.includes(origin));

const containsAuthority = (consumer: EffectiveAuthority, provider: EffectiveAuthority) => {
  if (consumer.profileId !== provider.profileId) return false;
  const consumerFullControl = includes(consumer.capabilities, "browser.full-control");
  if (includes(provider.capabilities, "browser.full-control") && !consumerFullControl) return false;
  for (const capability of provider.capabilities) {
    if (capability === "browser.full-control") continue;
    if (capability === "cdp.connect") {
      if (!includes(consumer.capabilities, capability)) return false;
    } else if (!consumerFullControl && !includes(consumer.capabilities, capability)) return false;
  }
  if (!containsOrigins(consumer.origins, provider.origins)) return false;
  if (
    provider.expiresAt === undefined
      ? consumer.expiresAt !== undefined
      : consumer.expiresAt !== undefined && consumer.expiresAt < provider.expiresAt
  )
    return false;
  return true;
};

export const createServiceAuthority = (grants: GrantStoreApi) => {
  const authenticateParty = Effect.fn("ServiceAuthority.authenticateParty")(function* (
    party: ServiceParty,
  ) {
    // authenticateGrant validates the leaf and its complete durable ancestor
    // chain. Delegated leaves preserve ancestor origins and expiry exactly and
    // can only narrow capabilities, so the authenticated leaf defines the
    // effective scope used here.
    const authenticated = yield* grants.authenticateGrant(party.grantId, {
      profileId: party.profileId,
    });
    if (
      authenticated.principal !== party.id ||
      authenticated.grant.id !== party.grantId ||
      authenticated.grant.profileId !== party.profileId
    )
      return yield* denied();
    return effectiveAuthority(party, authenticated.grant);
  });

  const authenticateProvider = Effect.fn("ServiceAuthority.authenticateProvider")(function* (
    provider: ServiceParty,
  ) {
    return yield* authenticateParty(provider);
  });

  const authorizeService = Effect.fn("ServiceAuthority.authorizeService")(function* (
    consumer: ServiceParty,
    provider: ServiceParty,
  ) {
    // These are two current durable-boundary checks. They intentionally do not
    // claim to form an atomic revocation transaction across both identities.
    const consumerAuthority = yield* authenticateParty(consumer);
    const providerAuthority = yield* authenticateParty(provider);
    if (!containsAuthority(consumerAuthority, providerAuthority)) return yield* denied();
  });

  return Object.freeze({ authenticateProvider, authorizeService });
};
