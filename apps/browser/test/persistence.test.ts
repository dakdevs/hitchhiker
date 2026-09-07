import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfiguration } from "@hitchhiker/core";
import { createDefaultInterface } from "@hitchhiker/default-interface";
import { Effect, Exit, Scope } from "effect";
import { saveBrowserPersistence } from "../src/persistence.ts";

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
