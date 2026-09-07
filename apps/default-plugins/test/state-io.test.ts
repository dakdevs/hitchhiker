import assert from "node:assert/strict";
import test from "node:test";
import { PluginApiError, type PluginApi, type PageWatchSnapshot } from "@hitchhiker/plugin-sdk";
import { readPages, serial } from "../src/state-io.ts";

const apiWith = (watch: PluginApi["pages"]["watch"]) => ({ pages: { watch } });
test("page reads restart on stale chunks and never retry denied operations", async () => {
  let calls = 0;
  const api = apiWith(async (request) => {
    calls++;
    if (calls === 1) return { revision: 1, pages: [], nextOffset: 32 };
    if (calls === 2) {
      assert.deepEqual(request, { offset: 32, revision: 1 });
      throw new PluginApiError("stale-snapshot");
    }
    return { revision: 2, pages: [] };
  });
  assert.deepEqual(await readPages(api), { revision: 2, pages: [] });
  assert.equal(calls, 3);
  let failures = 0;
  await assert.rejects(
    readPages(
      apiWith(async () => {
        failures++;
        throw new PluginApiError("denied");
      }),
    ),
    { code: "denied" },
  );
  assert.equal(failures, 1);
  failures = 0;
  await assert.rejects(
    readPages(
      apiWith(async () => {
        failures++;
        throw new PluginApiError("stale-snapshot");
      }),
    ),
    { code: "stale-snapshot" },
  );
  assert.equal(failures, 3);
});
test("page reads reject nonadvancing continuations", async () => {
  const snapshot: PageWatchSnapshot = { revision: 1, pages: [], nextOffset: 32 };
  await assert.rejects(readPages(apiWith(async () => snapshot)), /Invalid page continuation/);
});
test("serialized commands preserve order and recover after a rejected command", async () => {
  const run = serial();
  const sequence: number[] = [];
  const first = run(async () => {
    await Promise.resolve();
    sequence.push(1);
    throw new Error("failed");
  });
  const second = run(async () => {
    sequence.push(2);
    return 2;
  });
  await assert.rejects(first, /failed/);
  assert.equal(await second, 2);
  assert.deepEqual(sequence, [1, 2]);
});
