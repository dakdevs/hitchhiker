import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfiguration } from "@hitchhiker/core";
import { createDefaultInterface } from "@hitchhiker/default-interface";
import { Effect, Exit, Scope } from "effect";
import {
  legacyBootstrapSeedOf,
  loadBrowserPersistence,
  saveBrowserPersistence,
} from "../src/persistence.ts";

const legacyInterface = {
  ...createDefaultInterface("default"),
  selectedPageId: "first",
  pageOrder: ["first"],
  pinnedPageIds: ["first"],
};

test("V1 converts to a V2 generic restore while retaining one bootstrap seed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-persistence-v2-"));
  try {
    await writeFile(
      join(directory, "browser-state.json"),
      JSON.stringify({
        version: 1,
        configuration: defaultConfiguration,
        interface: {
          tabPlacement: "top",
          selectedPageId: "first",
          pageOrder: ["first", "first", "missing"],
          pinnedPageIds: ["first", "first", "missing"],
        },
        pages: [{ id: "first", url: "https://first.test/", title: "First" }],
      }),
    );
    const v1 = await Effect.runPromise(loadBrowserPersistence(directory, "default"));
    assert.ok(v1);
    await Effect.runPromise(
      saveBrowserPersistence(directory, {
        ...v1,
        format: 2,
        legacyBootstrapSeed: legacyBootstrapSeedOf(v1),
      }),
    );
    const v2 = await Effect.runPromise(loadBrowserPersistence(directory, "default"));
    assert.deepEqual(v2?.interfaceConfiguration, { tabPlacement: "sidebar" });
    assert.deepEqual(v2?.interfaceState, createDefaultInterface("default"));
    assert.deepEqual(legacyBootstrapSeedOf(v2), {
      tabPlacement: "top",
      selectedPageId: "first",
      pageOrder: ["first"],
      pinnedPageIds: ["first"],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V2 saves retain the frozen seed while live configuration and pages change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-persistence-v2-"));
  try {
    const state = {
      configuration: defaultConfiguration,
      interfaceConfiguration: { tabPlacement: "top" as const },
      interfaceState: legacyInterface,
      pages: [{ id: "first", url: "https://first.test/", title: "First" }],
      format: 2 as const,
      legacyBootstrapSeed: {
        tabPlacement: "top" as const,
        selectedPageId: "first",
        pageOrder: ["first"],
        pinnedPageIds: ["first"],
      },
    };
    await Effect.runPromise(saveBrowserPersistence(directory, state));
    await Effect.runPromise(
      saveBrowserPersistence(directory, {
        ...state,
        configuration: { ...defaultConfiguration, colorScheme: "dark" },
        interfaceConfiguration: { tabPlacement: "sidebar" },
        interfaceState: createDefaultInterface("default"),
        pages: [{ id: "second", url: "https://second.test/", title: "Second" }],
      }),
    );
    const decoded = JSON.parse(await readFile(join(directory, "browser-state.json"), "utf8"));
    assert.equal(decoded.version, 2);
    assert.equal("interface" in decoded, false);
    assert.deepEqual(decoded.legacyBootstrapSeed, state.legacyBootstrapSeed);
    assert.deepEqual(
      (await Effect.runPromise(loadBrowserPersistence(directory, "default")))?.pages,
      [{ id: "second", url: "https://second.test/", title: "Second" }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing state is empty, while invalid V1 and strict-invalid V2 fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchhiker-persistence-v2-"));
  try {
    assert.equal(await Effect.runPromise(loadBrowserPersistence(directory, "default")), undefined);
    for (const value of [
      { version: 1, configuration: defaultConfiguration, pages: [] },
      {
        version: 2,
        configuration: defaultConfiguration,
        pages: [{ id: "first\n", url: "https://first.test/", title: "First" }],
      },
      {
        version: 2,
        configuration: defaultConfiguration,
        pages: [],
        legacyBootstrapSeed: {
          tabPlacement: "sidebar",
          pageOrder: [],
          pinnedPageIds: [],
          extra: true,
        },
      },
    ]) {
      await writeFile(join(directory, "browser-state.json"), JSON.stringify(value));
      assert.equal(
        (await Effect.runPromise(Effect.exit(loadBrowserPersistence(directory, "default"))))._tag,
        "Failure",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "scope closure waits for an entered atomic browser-state save",
  { timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-persistence-cancel-"));
    const originalWriteFile = fs.promises.writeFile;
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const scope = await Effect.runPromise(Scope.make());
    try {
      Reflect.set(fs.promises, "writeFile", async (...args: readonly unknown[]) => {
        if (String(args[0]).includes("browser-state.json.") && String(args[0]).endsWith(".tmp")) {
          markWriteStarted();
          await writeGate;
        }
        return Reflect.apply(originalWriteFile, fs.promises, args);
      });
      syncBuiltinESMExports();

      await Effect.runPromise(
        saveBrowserPersistence(directory, {
          configuration: defaultConfiguration,
          interfaceConfiguration: { tabPlacement: "sidebar" },
          interfaceState: {
            ...createDefaultInterface("default"),
            selectedPageId: "saved",
            pageOrder: ["saved"],
            pinnedPageIds: ["saved"],
          },
          pages: [{ id: "saved", url: "https://saved.test/", title: "Saved" }],
        }).pipe(Effect.forkIn(scope)),
      );
      await writeStarted;

      let scopeClosed = false;
      const closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
        scopeClosed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(scopeClosed, false);

      releaseWrite();
      await closing;
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, "browser-state.json"), "utf8")).pages,
        [{ id: "saved", url: "https://saved.test/", title: "Saved" }],
      );
    } finally {
      releaseWrite();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      Reflect.set(fs.promises, "writeFile", originalWriteFile);
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
