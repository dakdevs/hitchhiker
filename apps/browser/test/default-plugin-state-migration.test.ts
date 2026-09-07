import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfiguration } from "@hitchhiker/core";
import { createDefaultInterface } from "@hitchhiker/default-interface";
import {
  createPluginStorage,
  PluginStorageError,
  type PluginStorageAdapter,
} from "@hitchhiker/runtime";
import { Deferred, Effect, Fiber, type Schema } from "effect";
import {
  DefaultTabModelPluginId,
  DefaultTabPinsPluginId,
  mapDefaultPluginState,
  seedDefaultPluginState,
  type DefaultPluginStateStorage,
} from "../src/default-plugin-state-migration.ts";
import type { BrowserPersistence } from "../src/persistence.ts";

const legacy = (options: {
  readonly selectedPageId?: string;
  readonly pageOrder: readonly string[];
  readonly pinnedPageIds: readonly string[];
}): BrowserPersistence =>
  Object.freeze({
    configuration: defaultConfiguration,
    interfaceConfiguration: { tabPlacement: "sidebar" as const },
    interfaceState: Object.freeze({
      ...createDefaultInterface("default"),
      ...(options.selectedPageId === undefined ? {} : { selectedPageId: options.selectedPageId }),
      pageOrder: options.pageOrder,
      pinnedPageIds: options.pinnedPageIds,
    }),
    pages: Object.freeze([]),
  });

const state = () =>
  mapDefaultPluginState(
    legacy({
      selectedPageId: "closed",
      pageOrder: ["second", "closed", "second", "first"],
      pinnedPageIds: ["closed", "first", "first", "third"],
    }),
    { pageIds: ["first", "second", "third"], pageOrder: ["third", "first", "second"] },
  );

test("maps legacy state onto the current complete controller order", () => {
  assert.deepEqual(state(), {
    model: {
      version: 1,
      pagesRevision: 0,
      selection: { kind: "page", pageId: "second" },
      pageOrder: ["second", "first", "third"],
    },
    pins: { version: 1, pagesRevision: 0, pinnedPageIds: ["first", "third"] },
  });
  assert.deepEqual(
    mapDefaultPluginState(
      legacy({ selectedPageId: "third", pageOrder: ["second"], pinnedPageIds: [] }),
      { pageIds: ["first", "second", "third"], pageOrder: ["first", "second", "third"] },
    ).model.selection,
    { kind: "page", pageId: "third" },
  );
  assert.deepEqual(
    mapDefaultPluginState(undefined, { pageIds: [], pageOrder: [] }).model.selection,
    { kind: "new-page" },
  );
  assert.throws(
    () => mapDefaultPluginState(undefined, { pageIds: ["one", "two"], pageOrder: ["one"] }),
    /contain each/i,
  );
});

test("maps a frozen V2 bootstrap seed without treating its legacy fields as live interface state", () => {
  const v2: BrowserPersistence = {
    configuration: defaultConfiguration,
    interfaceConfiguration: { tabPlacement: "sidebar" },
    interfaceState: createDefaultInterface("default"),
    pages: [],
    format: 2,
    legacyBootstrapSeed: {
      tabPlacement: "top",
      selectedPageId: "second",
      pageOrder: ["second", "first"],
      pinnedPageIds: ["first"],
    },
  };
  assert.deepEqual(
    mapDefaultPluginState(v2, {
      pageIds: ["first", "second", "third"],
      pageOrder: ["third", "first", "second"],
    }),
    {
      model: {
        version: 1,
        pagesRevision: 0,
        selection: { kind: "page", pageId: "second" },
        pageOrder: ["second", "first", "third"],
      },
      pins: { version: 1, pagesRevision: 0, pinnedPageIds: ["first"] },
    },
  );
});

test("seeds empty runtime storage and preserves user-owned values", async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), "hitchhiker-default-plugin-state-"));
  await mkdir(join(profileRoot, "profile"));
  const profile = join(profileRoot, "profile");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* createPluginStorage({ profileRoot: profile });
          const migration = state();
          assert.deepEqual(yield* seedDefaultPluginState(storage, migration), {
            model: "seeded",
            pins: "seeded",
          });
          const model = yield* storage.forOwner(DefaultTabModelPluginId);
          const pins = yield* storage.forOwner(DefaultTabPinsPluginId);
          assert.deepEqual((yield* model.read()).value, migration.model);
          assert.deepEqual((yield* pins.read()).value, migration.pins);

          const userValue = { unrelated: { edited: true }, version: 99 };
          yield* model.write((yield* model.read()).revision, userValue);
          assert.deepEqual(yield* seedDefaultPluginState(storage, migration), {
            model: "preserved",
            pins: "preserved",
          });
          assert.deepEqual((yield* model.read()).value, userValue);
        }),
      ),
    );
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
});

const adapter = (options: {
  readonly value?: unknown;
  readonly revision?: number;
  readonly failWrite?: "conflict" | "conflict-still-zero" | "persistence";
}): { readonly adapter: PluginStorageAdapter; readonly writes: () => number } => {
  let revision = options.revision ?? 0;
  let value: Schema.Json = (options.value ?? null) as Schema.Json;
  let writeCount = 0;
  return {
    writes: () => writeCount,
    adapter: {
      read: () => Effect.succeed({ revision, value }),
      write: (_expected, next) => {
        writeCount++;
        if (options.failWrite === "conflict") {
          revision = 1;
          value = { user: "won" };
          return Effect.fail(new PluginStorageError({ code: "conflict", message: "changed" }));
        }
        if (options.failWrite === "conflict-still-zero")
          return Effect.fail(new PluginStorageError({ code: "conflict", message: "changed" }));
        if (options.failWrite === "persistence")
          return Effect.fail(
            new PluginStorageError({ code: "persistence", message: "unavailable" }),
          );
        revision++;
        value = next as Schema.Json;
        return Effect.succeed({ revision });
      },
    },
  };
};

test("does not overwrite a CAS winner and can recover from a split write", async () => {
  const model = adapter({});
  const pins = adapter({ failWrite: "persistence" });
  const storage: DefaultPluginStateStorage = {
    forOwner: (id) => Effect.succeed(id === DefaultTabModelPluginId ? model.adapter : pins.adapter),
  };
  const migration = state();
  await assert.rejects(() => Effect.runPromise(seedDefaultPluginState(storage, migration)));
  assert.deepEqual(await Effect.runPromise(model.adapter.read()), {
    revision: 1,
    value: migration.model,
  });

  const recoveredStorage: DefaultPluginStateStorage = {
    forOwner: (id) =>
      Effect.succeed(id === DefaultTabModelPluginId ? model.adapter : adapter({}).adapter),
  };
  assert.deepEqual(await Effect.runPromise(seedDefaultPluginState(recoveredStorage, migration)), {
    model: "preserved",
    pins: "seeded",
  });

  const conflict = adapter({ failWrite: "conflict" });
  const conflictStorage: DefaultPluginStateStorage = {
    forOwner: () => Effect.succeed(conflict.adapter),
  };
  assert.deepEqual(await Effect.runPromise(seedDefaultPluginState(conflictStorage, migration)), {
    model: "preserved",
    pins: "preserved",
  });
  assert.equal(conflict.writes(), 1);
  assert.deepEqual(await Effect.runPromise(conflict.adapter.read()), {
    revision: 1,
    value: { user: "won" },
  });

  const stillZero = adapter({ failWrite: "conflict-still-zero" });
  assert.deepEqual(
    await Effect.runPromise(
      seedDefaultPluginState({ forOwner: () => Effect.succeed(stillZero.adapter) }, migration),
    ),
    { model: "conflict", pins: "conflict" },
  );
  assert.equal(stillZero.writes(), 2);
});

test("cancellation between owners leaves the remaining owner seedable", async () => {
  const model = adapter({});
  const migration = state();
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const blockedPins: PluginStorageAdapter = {
        read: () => Effect.succeed({ revision: 0, value: null }),
        write: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never as ReturnType<PluginStorageAdapter["write"]>),
          ),
      };
      const interrupted: DefaultPluginStateStorage = {
        forOwner: (id) =>
          Effect.succeed(id === DefaultTabModelPluginId ? model.adapter : blockedPins),
      };
      const running = yield* seedDefaultPluginState(interrupted, migration).pipe(Effect.forkDetach);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
    }),
  );
  assert.equal((await Effect.runPromise(model.adapter.read())).revision, 1);

  const recovered: DefaultPluginStateStorage = {
    forOwner: (id) =>
      Effect.succeed(id === DefaultTabModelPluginId ? model.adapter : adapter({}).adapter),
  };
  assert.deepEqual(await Effect.runPromise(seedDefaultPluginState(recovered, migration)), {
    model: "preserved",
    pins: "seeded",
  });
});
