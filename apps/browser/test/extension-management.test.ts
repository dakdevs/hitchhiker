import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { createExtensionManagement } from "../src/extension-management.ts";
import { ExtensionManagerError, type ManagedExtension } from "../src/extension-manager.ts";

const entry: ManagedExtension = {
  installationId: "a".repeat(32),
  digest: "b".repeat(64),
  expectedChromiumId: "c".repeat(32),
  name: "Fixture",
  version: "1.0",
  permissions: ["storage"],
  hostPermissions: ["https://example.test/*"],
  optionalPermissions: [],
  optionalHostPermissions: [],
  state: "enabled",
  status: "private failure containing /local/profile/path",
};

type Backend = Parameters<typeof createExtensionManagement>[0];
const backend = (overrides: Partial<Backend> = {}): Backend => ({
  list: () => Effect.succeed([entry]),
  isReadOnly: () => Effect.succeed(false),
  remove: () => Effect.void,
  ...overrides,
});

test("extension inventory exposes metadata without host diagnostics and copies permission arrays", async () => {
  const api = createExtensionManagement(backend(), () => Effect.void).forOwner(() => Effect.void);
  const result = await Effect.runPromise(api.list());
  assert.equal(result.readOnly, false);
  assert.equal(result.extensions[0]?.name, "Fixture");
  assert.equal("status" in result.extensions[0]!, false);
  assert.equal(JSON.stringify(result).includes("/local/profile/path"), false);
  assert.notEqual(result.extensions[0]?.permissions, entry.permissions);
  assert.equal("previewLocal" in api, false);
  assert.equal("confirmInstall" in api, false);
});

test("revocation while reading prevents inventory from reaching its caller", async () => {
  let allowed = true;
  const api = createExtensionManagement(
    backend({
      list: () =>
        Effect.sync(() => {
          allowed = false;
          return [entry];
        }),
    }),
    () => Effect.void,
  ).forOwner(() => (allowed ? Effect.void : Effect.fail("revoked")));
  await assert.rejects(Effect.runPromise(api.list()), /revoked/);
});

test("removal carries its owner check into the manager and requires manage authority for its reply", async () => {
  const checks: string[] = [];
  let removed = false;
  const api = createExtensionManagement(
    backend({
      remove: (id, authorize) =>
        Effect.gen(function* () {
          assert.equal(id, entry.installationId);
          assert.ok(authorize);
          yield* authorize.pipe(
            Effect.mapError(() => new ExtensionManagerError({ message: "denied" })),
          );
          removed = true;
        }),
      list: () =>
        Effect.sync(() => [{ ...entry, state: removed ? ("removed" as const) : entry.state }]),
    }),
    () => Effect.void,
  ).forOwner((capability) =>
    Effect.sync(() => {
      checks.push(capability);
    }),
  );
  const result = await Effect.runPromise(api.remove(entry.installationId));
  assert.equal(result.extensions[0]?.state, "removed");
  assert.deepEqual(checks, ["extensions.manage", "extensions.manage", "extensions.manage"]);
});

test("uncertain removal invokes application recovery and a denied caller never reaches the backend", async () => {
  let calls = 0;
  let recovery = false;
  const management = createExtensionManagement(
    backend({
      remove: () =>
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(
            new ExtensionManagerError({ message: "private engine error", restartRequired: true }),
          );
        }),
    }),
    (error) =>
      Effect.sync(() => {
        recovery = error.restartRequired === true;
      }),
  );
  await assert.rejects(
    Effect.runPromise(
      management.forOwner(() => Effect.fail("denied")).remove(entry.installationId),
    ),
  );
  assert.equal(calls, 0);
  await assert.rejects(
    Effect.runPromise(management.forOwner(() => Effect.void).remove(entry.installationId)),
  );
  assert.equal(calls, 1);
  assert.equal(recovery, true);
});
