import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Deferred, Effect, Exit, Fiber, Stream } from "effect";
import type { BrowserPage } from "@hitchhiker/core";
import { create } from "../src/grants.ts";
import type { LivePluginOptions } from "../src/plugin-session.ts";
import { runLivePlugin } from "../src/plugin-session.ts";

const executable = process.env.HITCHHIKER_PLUGIN_HOST;

const hostPids = (path: string): Set<number> => {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return new Set(
    rows
      .split("\n")
      .map((row) => row.trim().match(/^(\d+)\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => match?.[2] === path)
      .map((match) => Number(match[1])),
  );
};

const waitForNoNewHosts = async (path: string, baseline: ReadonlySet<number>) => {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const remaining = [...hostPids(path)].filter((pid) => !baseline.has(pid));
    if (remaining.length === 0) return;
    if (Date.now() >= deadline)
      assert.fail(`plugin-host processes leaked: ${remaining.join(", ")}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
};

const page = (id: string): BrowserPage => ({
  id,
  profileId: "default",
  url: `https://${id}.example.test/`,
  title: id,
  lifecycle: "loaded",
  lastUsedAt: 1,
  protections: { audio: false, call: false, download: false, unsavedInput: false },
});

const plugin = `
(() => {
  globalThis.HitchhikerPlugin = {
    async activate(hitchhiker) {
      const pages = await hitchhiker.call("pages.list", {});
      await hitchhiker.call("ui.publish", {
        surface: { sourcePageId: pages[0].id, apiKeys: Object.keys(hitchhiker) }
      });
    }
  };
})();
`;

test(
  "real plugin host binds durable identities, releases UI leases, and contains resource crashes",
  { skip: process.platform !== "darwin" || executable === undefined },
  async () => {
    assert(executable !== undefined);
    const baseline = hostPids(executable);
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-native-plugin-"));
    const releases = new Map<string, number>();
    const publications: Array<{ owner: string; surface: unknown }> = [];
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const grants = yield* create({ directory: join(directory, "grants") });
          const alphaGrant = yield* grants.issue({
            principal: "alpha-plugin",
            profileId: "default",
            capabilities: ["pages.list", "ui.compose"],
            origins: [],
          });
          const betaGrant = yield* grants.issue({
            principal: "beta-plugin",
            profileId: "default",
            capabilities: ["pages.list", "ui.compose"],
            origins: [],
          });
          const alphaPublished = yield* Deferred.make<void>();
          const betaPublished = yield* Deferred.make<void>();

          const options = (
            owner: string,
            token: string,
            signal: Deferred.Deferred<void>,
          ): LivePluginOptions => ({
            manifest: {
              id: owner,
              version: "1.0.0",
              name: owner,
              capabilities: ["pages.list", "ui.compose"],
            },
            executable,
            code: plugin,
            profileId: "default",
            token,
            grants,
            browser: {
              pages: Effect.succeed([page(owner)]),
              open: () => Effect.die("not used"),
              navigate: () => Effect.die("not used"),
              close: () => Effect.die("not used"),
              configuration: Effect.die("not used"),
              configure: () => Effect.die("not used"),
              setTabPlacement: () => Effect.die("not used"),
            },
            publish: (surface) =>
              Effect.gen(function* () {
                publications.push({ owner, surface });
                yield* Deferred.succeed(signal, undefined);
                return publications.length;
              }),
            release: Effect.sync(() => releases.set(owner, (releases.get(owner) ?? 0) + 1)),
            events: Stream.never,
          });

          const alpha = yield* runLivePlugin(
            options("alpha-plugin", alphaGrant.token, alphaPublished),
          ).pipe(Effect.forkScoped);
          yield* Effect.raceFirst(Deferred.await(alphaPublished), Fiber.join(alpha)).pipe(
            Effect.timeout(10_000),
          );
          const beta = yield* runLivePlugin(
            options("beta-plugin", betaGrant.token, betaPublished),
          ).pipe(Effect.forkScoped);
          yield* Effect.raceFirst(Deferred.await(betaPublished), Fiber.join(beta)).pipe(
            Effect.timeout(10_000),
          );
          assert.deepEqual(
            publications.toSorted((left, right) => left.owner.localeCompare(right.owner)),
            [
              {
                owner: "alpha-plugin",
                surface: { sourcePageId: "alpha-plugin", apiKeys: ["call"] },
              },
              {
                owner: "beta-plugin",
                surface: { sourcePageId: "beta-plugin", apiKeys: ["call"] },
              },
            ],
          );

          yield* grants.revoke(alphaGrant.grant.id);
          assert(Exit.isFailure(yield* Fiber.await(alpha).pipe(Effect.timeout(3_000))));
          assert.equal(releases.get("alpha-plugin"), 1);
          assert.equal(releases.get("beta-plugin"), undefined);
          yield* Fiber.interrupt(beta);
          assert.equal(releases.get("beta-plugin"), 1);

          const crashGrant = yield* grants.issue({
            principal: "crash-plugin",
            profileId: "default",
            capabilities: ["ui.compose"],
            origins: [],
          });
          const crashSignal = yield* Deferred.make<void>();
          const crashOptions = options("crash-plugin", crashGrant.token, crashSignal);
          const crash = yield* Effect.exit(
            runLivePlugin({
              ...crashOptions,
              code: "globalThis.HitchhikerPlugin={activate(){while(true){}}}",
            }),
          );
          assert(Exit.isFailure(crash));
          assert.equal(releases.get("crash-plugin"), 1);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await waitForNoNewHosts(executable, baseline);
    }
  },
);
