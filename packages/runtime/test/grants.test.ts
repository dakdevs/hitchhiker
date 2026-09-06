import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { create, type GrantStoreApi } from "../src/grants.ts";

const withStore = async <A>(run: (store: GrantStoreApi) => Effect.Effect<A, unknown>) => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-grants-"));
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

const grantsModule = new URL("../src/grants.ts", import.meta.url).href;
const runtimeDirectory = fileURLToPath(new URL("..", import.meta.url));
const runWriter = (directory: string, action: "issue" | "revoke", id?: string) =>
  new Promise<string>((resolve, reject) => {
    const source = `
      import { NodeServices } from "@effect/platform-node";
      import { Effect } from "effect";
      const { create } = await import(${JSON.stringify(grantsModule)});
      const output = await Effect.runPromise(Effect.gen(function* () {
        const store = yield* create({ directory: process.env.HH_GRANT_DIRECTORY });
        return ${JSON.stringify(action)} === "issue"
          ? yield* store.issue({ principal: process.env.HH_GRANT_PRINCIPAL, profileId: "profile", capabilities: ["pages.list"], origins: [] })
          : yield* store.revoke(${JSON.stringify(id)});
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped));
      process.stdout.write(JSON.stringify(output));
    `;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", source],
      {
        cwd: runtimeDirectory,
        env: {
          ...process.env,
          HH_GRANT_DIRECTORY: directory,
          HH_GRANT_PRINCIPAL: `writer${Math.floor(Math.random() * 1_000_000)}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`writer exited ${code}: ${stderr}`)),
    );
  });

test("persists only token hashes and authorizes after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-grants-"));
  try {
    const issued = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* create({ directory });
        return yield* store.issue({
          principal: "cli",
          profileId: "profile",
          capabilities: ["pages.write"],
          origins: ["https://example.test"],
        });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    const disk = await readFile(join(directory, "grants.json"), "utf8");
    assert.equal(disk.includes(issued.token), false);
    assert.match(disk, /"tokenHash":"[a-f0-9]{64}"/);
    const authorized = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* create({ directory });
        return yield* store.authorize(issued.token, {
          profileId: "profile",
          capability: "pages.write",
          origin: "https://example.test",
        });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    assert.equal(authorized.principal, "cli");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enforces revocation, profile, origin, expiry, and CDP's separate permission", async () => {
  await withStore((store) =>
    Effect.gen(function* () {
      const issued = yield* store.issue({
        principal: "agent",
        profileId: "one",
        capabilities: ["pages.write"],
        origins: ["https://one.test"],
      });
      assert.equal(
        (yield* store.authenticate(issued.token, { profileId: "one" })).principal,
        "agent",
      );
      yield* assertDenied(store.authenticate(issued.token, { profileId: "two" }));
      yield* assertDenied(
        store.authorize(issued.token, {
          profileId: "two",
          capability: "pages.write",
          origin: "https://one.test",
        }),
      );
      yield* assertDenied(
        store.authorize(issued.token, {
          profileId: "one",
          capability: "pages.write",
          origin: "https://other.test",
        }),
      );
      yield* store.revoke(issued.grant.id);
      yield* assertDenied(store.authenticate(issued.token, { profileId: "one" }));
      yield* assertDenied(
        store.authorize(issued.token, {
          profileId: "one",
          capability: "pages.write",
          origin: "https://one.test",
        }),
      );
      const fullControl = yield* store.issue({
        principal: "agent",
        profileId: "one",
        capabilities: ["browser.full-control"],
        origins: [],
      });
      yield* assertDenied(
        store.authorize(fullControl.token, { profileId: "one", capability: "cdp.connect" }),
      );
      const expired = yield* store.issue({
        principal: "agent",
        profileId: "one",
        capabilities: ["pages.list"],
        origins: [],
        expiresAt: 0,
      });
      yield* assertDenied(
        store.authorize(expired.token, { profileId: "one", capability: "pages.list" }),
      );
      yield* assertDenied(store.authenticate(expired.token, { profileId: "one" }));
    }),
  );
});

test("rejects malformed persisted state without replacing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-grants-"));
  const path = join(directory, "grants.json");
  try {
    await writeFile(path, "{not-json", { mode: 0o600 });
    await assert.rejects(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* create({ directory });
          return yield* store.list();
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      ),
    );
    assert.equal(await readFile(path, "utf8"), "{not-json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects oversized stores before parsing and preserves their contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-grants-"));
  const path = join(directory, "grants.json");
  const oversized = " ".repeat(1024 * 1024 + 1);
  try {
    await writeFile(path, oversized, { mode: 0o600 });
    await assert.rejects(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* create({ directory });
          return yield* store.list();
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      ),
    );
    assert.equal((await stat(path)).size, oversized.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a 1025th grant without writing an invalid store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-grants-"));
  const path = join(directory, "grants.json");
  const grants = Array.from({ length: 1024 }, (_, index) => ({
    grant: {
      id: `g${index}`,
      principal: "agent",
      profileId: "profile",
      capabilities: ["pages.list"],
      origins: [],
    },
    issuedAt: index,
    tokenHash: index.toString(16).padStart(64, "0"),
  }));
  try {
    await writeFile(path, JSON.stringify({ version: 1, grants }), { mode: 0o600 });
    await assert.rejects(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* create({ directory });
          return yield* store.issue({
            principal: "agent",
            profileId: "profile",
            capabilities: ["pages.list"],
            origins: [],
          });
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      ),
    );
    const persisted = JSON.parse(await readFile(path, "utf8")) as { grants: unknown[] };
    assert.equal(persisted.grants.length, 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed bearer tokens and keeps an existing revocation timestamp", async () => {
  await withStore((store) =>
    Effect.gen(function* () {
      const issued = yield* store.issue({
        principal: "agent",
        profileId: "profile",
        capabilities: ["pages.list"],
        origins: [],
      });
      yield* assertDenied(
        store.authorize("x".repeat(1024 * 1024), {
          profileId: "profile",
          capability: "pages.list",
        }),
      );
      const first = yield* store.revoke(issued.grant.id);
      yield* Effect.sleep(2);
      const second = yield* store.revoke(issued.grant.id);
      assert.equal(second.revokedAt, first.revokedAt);
    }),
  );
});

test("serializes concurrent issues and keeps private filesystem modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-grants-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* create({ directory });
        yield* Effect.all(
          Array.from({ length: 32 }, (_, index) =>
            store.issue({
              principal: `agent${index}`,
              profileId: "profile",
              capabilities: ["pages.list"],
              origins: [],
            }),
          ),
          { concurrency: 32 },
        );
        const grants = yield* store.list();
        assert.equal(grants.length, 32);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "grants.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent stores preserve concurrent issues and revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-grants-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* create({ directory });
        const second = yield* create({ directory });
        const [one, two] = yield* Effect.all(
          [
            first.issue({
              principal: "first",
              profileId: "profile",
              capabilities: ["pages.list"],
              origins: [],
            }),
            second.issue({
              principal: "second",
              profileId: "profile",
              capabilities: ["pages.list"],
              origins: [],
            }),
          ],
          { concurrency: 2 },
        );
        yield* second.revoke(one.grant.id);
        const grants = yield* first.list();
        assert.equal(grants.length, 2);
        assert.equal(
          grants.find((grant) => grant.id === one.grant.id)?.revokedAt !== undefined,
          true,
        );
        assert.equal(grants.find((grant) => grant.id === two.grant.id)?.revokedAt, undefined);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate writer processes preserve issues and a revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-grants-"));
  try {
    const [one, two] = (
      await Promise.all([runWriter(directory, "issue"), runWriter(directory, "issue")])
    ).map((output) => JSON.parse(output) as { grant: { id: string } });
    await runWriter(directory, "revoke", one.grant.id);
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* create({ directory });
        const grants = yield* store.list();
        assert.equal(grants.length, 2);
        assert.equal(
          grants.find((grant) => grant.id === one.grant.id)?.revokedAt !== undefined,
          true,
        );
        assert.equal(grants.find((grant) => grant.id === two.grant.id)?.revokedAt, undefined);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale mutation lock fails closed without auto-reclaiming it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-grants-"));
  const lock = join(directory, ".write-lock");
  try {
    await (await import("node:fs/promises")).mkdir(lock, { mode: 0o700 });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* create({ directory });
        return yield* store
          .issue({
            principal: "writer",
            profileId: "profile",
            capabilities: ["pages.list"],
            origins: [],
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    assert.equal(error.code, "locked");
    assert.equal((await stat(lock)).isDirectory(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const assertDenied = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.flip,
    Effect.map(() => undefined),
  );
