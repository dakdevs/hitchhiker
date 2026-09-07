import assert from "node:assert/strict";
import test from "node:test";

type DomApi = {
  readonly snapshot: (request: {
    readonly pageId: string;
    readonly maxDepth?: number;
    readonly interactiveOnly?: boolean;
  }) => Promise<{
    readonly pageId: string;
    readonly snapshotId: string;
    readonly nodes: readonly {
      readonly role: string;
      readonly name?: string;
      readonly ref?: string;
    }[];
    readonly truncated: boolean;
  }>;
  readonly click: (request: {
    readonly pageId: string;
    readonly ref: string;
  }) => Promise<{ readonly clicked: true }>;
  readonly fill: (request: {
    readonly pageId: string;
    readonly ref: string;
    readonly value: string;
  }) => Promise<{ readonly filled: true }>;
};
type RegisteredPlugin = {
  readonly activate: (host: {
    readonly call: <A>(method: string, params: object) => Promise<A>;
  }) => Promise<void> | void;
};
type Sdk = {
  readonly definePlugin: (plugin: {
    readonly activate: (api: { readonly dom: DomApi }) => void;
  }) => void;
  readonly PluginApiError: new (code: string) => Error & { readonly code: string };
};

const loadSdk = () =>
  import(new URL("../../plugin-sdk/src/index.ts", import.meta.url).href) as Promise<Sdk>;

const withRegisteredPlugin = async <A>(
  activate: (api: { readonly dom: DomApi }) => void,
  run: (plugin: RegisteredPlugin) => Promise<A>,
): Promise<A> => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "HitchhikerPlugin");
  const { definePlugin } = await loadSdk();
  definePlugin({ activate });
  try {
    return await run(
      (globalThis as typeof globalThis & { HitchhikerPlugin: RegisteredPlugin }).HitchhikerPlugin,
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "HitchhikerPlugin", descriptor);
    else Reflect.deleteProperty(globalThis, "HitchhikerPlugin");
  }
};

test("SDK DOM bridge exposes frozen snapshot, click, and fill calls", async () => {
  let dom: DomApi | undefined;
  const calls: { readonly method: string; readonly params: object }[] = [];
  const snapshot = {
    pageId: "page-a",
    snapshotId: "snapshot-a",
    nodes: [{ role: "button", name: "Save", ref: "ref-a" }],
    truncated: false,
  } as const;

  await withRegisteredPlugin(
    (api) => {
      dom = api.dom;
    },
    async (plugin) => {
      await plugin.activate({
        call: async <A>(method: string, params: object): Promise<A> => {
          calls.push({ method, params });
          if (method === "dom.snapshot") return snapshot as A;
          if (method === "dom.click") return { clicked: true } as A;
          if (method === "dom.fill") return { filled: true } as A;
          throw new Error("unexpected method");
        },
      });
    },
  );

  assert.ok(dom);
  assert(Object.isFrozen(dom));
  assert.deepEqual(
    await dom.snapshot({ pageId: "page-a", maxDepth: 4, interactiveOnly: true }),
    snapshot,
  );
  assert.deepEqual(await dom.click({ pageId: "page-a", ref: "ref-a" }), { clicked: true });
  assert.deepEqual(await dom.fill({ pageId: "page-a", ref: "ref-a", value: "done" }), {
    filled: true,
  });
  assert.deepEqual(calls, [
    {
      method: "dom.snapshot",
      params: { pageId: "page-a", maxDepth: 4, interactiveOnly: true },
    },
    { method: "dom.click", params: { pageId: "page-a", ref: "ref-a" } },
    { method: "dom.fill", params: { pageId: "page-a", ref: "ref-a", value: "done" } },
  ]);
});

test("SDK DOM bridge exposes only recognized own error codes", async () => {
  let dom: DomApi | undefined;
  const { PluginApiError } = await loadSdk();
  const recognized = [
    "not_authorized",
    "page_gone",
    "stale_ref",
    "covered",
    "unsupported",
    "limit",
    "browser_error",
  ];

  await withRegisteredPlugin(
    (api) => {
      dom = api.dom;
    },
    async (plugin) => {
      await plugin.activate({
        call: async <A>(): Promise<A> => {
          throw Object.assign(new Error("untrusted host detail"), { code: recognized.shift()! });
        },
      });
    },
  );

  assert.ok(dom);
  for (const code of [
    "not_authorized",
    "page_gone",
    "stale_ref",
    "covered",
    "unsupported",
    "limit",
    "browser_error",
  ]) {
    await assert.rejects(dom.snapshot({ pageId: "page-a" }), (error: unknown) => {
      assert(error instanceof PluginApiError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes("untrusted host detail"), false);
      return true;
    });
  }

  const inheritedCode = Object.create({ code: "stale_ref" }) as Error;
  inheritedCode.message = "untrusted inherited detail";
  await withRegisteredPlugin(
    (api) => {
      dom = api.dom;
    },
    async (plugin) => {
      await plugin.activate({
        call: async <A>(): Promise<A> => {
          throw inheritedCode;
        },
      });
    },
  );
  await assert.rejects(dom.snapshot({ pageId: "page-a" }), (error: unknown) => {
    assert(error instanceof PluginApiError);
    assert.equal(error.code, "denied");
    assert.equal(error.message.includes("untrusted inherited detail"), false);
    return true;
  });

  await withRegisteredPlugin(
    (api) => {
      dom = api.dom;
    },
    async (plugin) => {
      await plugin.activate({
        call: async <A>(): Promise<A> => {
          throw Object.assign(new Error("untrusted unknown detail"), { code: "unexpected" });
        },
      });
    },
  );
  await assert.rejects(dom.snapshot({ pageId: "page-a" }), (error: unknown) => {
    assert(error instanceof PluginApiError);
    assert.equal(error.code, "denied");
    assert.equal(error.message.includes("untrusted unknown detail"), false);
    return true;
  });
});
