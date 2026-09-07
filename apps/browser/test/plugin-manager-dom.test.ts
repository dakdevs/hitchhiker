import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import type { Capability } from "@hitchhiker/core";
import { createGrantStore } from "@hitchhiker/runtime";
import { Effect, Exit } from "effect";
import { createPluginArtifactStore } from "../src/plugin-artifacts.ts";
import { createPluginManager } from "../src/plugin-manager.ts";

const profileId = "default";
const origin = "https://allowed.test";

const withProfile = async (run: (profileRoot: string) => Promise<void>) => {
  const profileRoot = await mkdtemp(join(tmpdir(), "hitchhiker-manager-dom-"));
  try {
    await run(profileRoot);
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
};

const stage = (id: string, capabilities: readonly Capability[]) => ({
  id,
  name: id,
  version: "1.0.0",
  capabilities,
});

test("installed plugin admission preserves scoped DOM grants without authorizing an originless page", async () => {
  await withProfile(async (profileRoot) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* createGrantStore({ directory: join(profileRoot, "grants") });
        const artifacts = yield* createPluginArtifactStore(profileRoot);
        const manager = yield* createPluginManager({
          profileRoot,
          grants,
          launch: (_artifact, _grant, ready) => ready.pipe(Effect.andThen(Effect.never)),
        });
        const dom = yield* artifacts.stage({
          manifest: stage("dom-plugin", ["pages.read", "pages.write"]),
          code: "compiled",
        });
        const scoped = yield* grants.issue({
          principal: "dom-plugin",
          profileId,
          capabilities: ["pages.read", "pages.write"],
          origins: [origin],
        });
        yield* manager.install(dom.hash, scoped.grant.id, { staged: true });

        const fullDom = yield* artifacts.stage({
          manifest: stage("full-dom-plugin", ["pages.read", "pages.write"]),
          code: "compiled",
        });
        const full = yield* grants.issue({
          principal: "full-dom-plugin",
          profileId,
          capabilities: ["browser.full-control"],
          origins: [],
        });
        yield* manager.install(fullDom.hash, full.grant.id, { staged: true });

        const missing = yield* artifacts.stage({
          manifest: stage("missing-dom-cap", ["pages.read", "pages.write"]),
          code: "compiled",
        });
        const readOnly = yield* grants.issue({
          principal: "missing-dom-cap",
          profileId,
          capabilities: ["pages.read"],
          origins: [origin],
        });
        assert(
          Exit.isFailure(yield* Effect.exit(manager.install(missing.hash, readOnly.grant.id))),
        );

        const cdp = yield* artifacts.stage({
          manifest: stage("cdp-plugin", ["cdp.connect"]),
          code: "compiled",
        });
        const fullWithoutCdp = yield* grants.issue({
          principal: "cdp-plugin",
          profileId,
          capabilities: ["browser.full-control"],
          origins: [],
        });
        assert(
          Exit.isFailure(yield* Effect.exit(manager.install(cdp.hash, fullWithoutCdp.grant.id))),
        );

        const revoked = yield* grants.issue({
          principal: "revoked-dom",
          profileId,
          capabilities: ["pages.read"],
          origins: [origin],
        });
        yield* grants.revoke(revoked.grant.id);
        const revokedArtifact = yield* artifacts.stage({
          manifest: stage("revoked-dom", ["pages.read"]),
          code: "compiled",
        });
        assert(
          Exit.isFailure(
            yield* Effect.exit(manager.install(revokedArtifact.hash, revoked.grant.id)),
          ),
        );

        const wrongProfile = yield* grants.issue({
          principal: "wrong-profile-dom",
          profileId: "other-profile",
          capabilities: ["pages.read"],
          origins: [origin],
        });
        const wrongProfileArtifact = yield* artifacts.stage({
          manifest: stage("wrong-profile-dom", ["pages.read"]),
          code: "compiled",
        });
        assert(
          Exit.isFailure(
            yield* Effect.exit(manager.install(wrongProfileArtifact.hash, wrongProfile.grant.id)),
          ),
        );

        const wrongPrincipal = yield* grants.issue({
          principal: "other-principal",
          profileId,
          capabilities: ["pages.read"],
          origins: [origin],
        });
        const wrongPrincipalArtifact = yield* artifacts.stage({
          manifest: stage("wrong-principal-dom", ["pages.read"]),
          code: "compiled",
        });
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              manager.install(wrongPrincipalArtifact.hash, wrongPrincipal.grant.id),
            ),
          ),
        );

        assert.deepEqual(
          (yield* manager.list()).map((plugin) => plugin.id),
          ["dom-plugin", "full-dom-plugin"],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});
