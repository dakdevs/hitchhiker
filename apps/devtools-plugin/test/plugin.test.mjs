import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

const execute = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = join(directory, "..");
const pluginPath = join(packageDirectory, "dist", "plugin.js");
const repository = join(packageDirectory, "..", "..");
let built;
const buildPlugin = () =>
  (built ??= execute("pnpm", ["--filter", "@hitchhiker/devtools-plugin", "build"], {
    cwd: repository,
  }));

const page = (id, title = id) => ({
  id,
  profileId: "default",
  url: `https://${id}.example/`,
  title,
  lifecycle: "loaded",
});

const loadPlugin = async (pages = [page("one"), page("two")]) => {
  await buildPlugin();
  const context = { console, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.runInNewContext(await readFile(pluginPath, "utf8"), context, { timeout: 1000 });
  const calls = [];
  const surfaces = [];
  let livePages = pages;
  let inspector = { pageId: "one", generation: 1, instance: 0, state: "closed" };
  let failShow = false;
  const bridge = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "pages.watch") return { revision: 1, pages: livePages };
      if (method === "devtools.status") return { ...inspector, pageId: params.pageId };
      if (method === "devtools.show") {
        if (failShow) throw new Error("denied");
        return (inspector = { pageId: params.pageId, generation: 1, instance: 1, state: "open" });
      }
      if (method === "devtools.close")
        return (inspector = { pageId: params.pageId, generation: 1, instance: 1, state: "closed" });
      if (method === "ui.publish") return (surfaces.push(params), { revision: surfaces.length });
      throw new Error(`Unexpected SDK call ${method}`);
    },
  };
  await context.HitchhikerPlugin.activate(bridge);
  return {
    calls,
    surfaces,
    plugin: context.HitchhikerPlugin,
    setPages: (next) => {
      livePages = next;
    },
    failNextShow: () => {
      failShow = true;
    },
    setInspector: (next) => {
      inspector = next;
    },
  };
};

const press = (plugin, action) =>
  plugin.onEvent("ui.event", { event: "press", payload: { action } });
const normalize = (value) => JSON.parse(JSON.stringify(value));
const bindings = (surface) => normalize(surface.surface.bindings);

test("built IIFE maps DevTools actions through the public SDK and keeps its selected viewport", async () => {
  const fixture = await loadPlugin();
  assert.deepEqual(
    normalize(fixture.calls.slice(0, 2).map(({ method, params }) => [method, params])),
    [
      ["pages.watch", {}],
      ["devtools.status", { pageId: "one" }],
    ],
  );
  assert.deepEqual(bindings(fixture.surfaces.at(-1)), [
    { viewportId: "devtools-selected-page", pageId: "one" },
  ]);
  await press(fixture.plugin, "devtools.select:two");
  await press(fixture.plugin, "devtools.show");
  await press(fixture.plugin, "devtools.close");
  assert.deepEqual(
    normalize(fixture.calls.filter(({ method }) => method.startsWith("devtools.")).slice(-3)),
    [
      { method: "devtools.status", params: { pageId: "two" } },
      { method: "devtools.show", params: { pageId: "two" } },
      { method: "devtools.close", params: { pageId: "two" } },
    ],
  );
  assert.deepEqual(bindings(fixture.surfaces.at(-1)), [
    { viewportId: "devtools-selected-page", pageId: "two" },
  ]);
});

test("page and DevTools lifecycle updates reconcile a closed selected page without polling", async () => {
  const fixture = await loadPlugin();
  await press(fixture.plugin, "devtools.select:two");
  fixture.setInspector({ pageId: "two", generation: 1, instance: 3, state: "open" });
  const statusCallsBefore = fixture.calls.filter(
    ({ method }) => method === "devtools.status",
  ).length;
  await fixture.plugin.onEvent("devtools.changed", {
    pageId: "two",
    generation: 0,
    instance: 0,
    state: "closed",
  });
  assert.match(JSON.stringify(fixture.surfaces.at(-1)), /Inspector open/);
  assert.equal(
    fixture.calls.filter(({ method }) => method === "devtools.status").length,
    statusCallsBefore + 1,
  );
  fixture.setPages([page("one")]);
  const callsBefore = fixture.calls.length;
  await fixture.plugin.onEvent("pages.changed", { revision: 2 });
  assert.deepEqual(bindings(fixture.surfaces.at(-1)), [
    { viewportId: "devtools-selected-page", pageId: "one" },
  ]);
  assert.equal(
    fixture.calls.slice(callsBefore).some(({ method }) => method === "pages.watch"),
    true,
  );
});

test("failed inspector actions publish a bounded error and keep the selected page", async () => {
  const fixture = await loadPlugin();
  fixture.failNextShow();
  await press(fixture.plugin, "devtools.show");
  const surface = normalize(fixture.surfaces.at(-1));
  assert.match(JSON.stringify(surface), /action was denied or could not complete/);
  assert.deepEqual(surface.surface.bindings, [
    { viewportId: "devtools-selected-page", pageId: "one" },
  ]);
});

test("invalid page selection never queries an unknown DevTools target", async () => {
  const fixture = await loadPlugin();
  const before = fixture.calls.length;
  await press(fixture.plugin, "devtools.select:missing");
  assert.equal(
    fixture.calls.slice(before).some(({ method }) => method === "devtools.status"),
    false,
  );
  assert.match(JSON.stringify(fixture.surfaces.at(-1)), /page is no longer open/);
});
