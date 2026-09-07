import {
  PluginApiError,
  type Plugin,
  type PluginApi,
  type ObservedPage,
} from "@hitchhiker/plugin-sdk";
import {
  Empty,
  Open,
  Reorder,
  Select,
  TabState,
  decode,
  type TabState as TabStateValue,
} from "./contracts.ts";
import { readPages, serial } from "./state-io.ts";

const newPage = Object.freeze({ kind: "new-page" } as const);
const selectPage = (pageId: string) => Object.freeze({ kind: "page" as const, pageId });
const empty = (pagesRevision: number): TabStateValue =>
  Object.freeze({ version: 1, pagesRevision, selection: newPage, pageOrder: Object.freeze([]) });
const featureEqual = (left: TabStateValue, right: TabStateValue) => {
  const selectionEqual =
    left.selection === right.selection ||
    (left.selection?.kind === right.selection?.kind &&
      (left.selection?.kind !== "page" ||
        right.selection?.kind !== "page" ||
        left.selection.pageId === right.selection.pageId));
  return (
    selectionEqual &&
    left.pageOrder.length === right.pageOrder.length &&
    left.pageOrder.every((id, index) => id === right.pageOrder[index])
  );
};
const decodeState = (value: unknown, revision: number) => {
  try {
    return { value: decode(TabState, value), valid: true };
  } catch {
    return { value: empty(revision), valid: false };
  }
};
const reconcile = (
  candidate: TabStateValue,
  revision: number,
  pages: readonly ObservedPage[],
  pending: ReadonlySet<string>,
): TabStateValue => {
  const ids = new Set(pages.filter((page) => !pending.has(page.id)).map((page) => page.id));
  const order = [...new Set(candidate.pageOrder.filter((id) => ids.has(id)))];
  for (const page of pages)
    if (!pending.has(page.id) && !order.includes(page.id)) order.push(page.id);
  const selection =
    candidate.selection === null ||
    candidate.selection.kind === "new-page" ||
    ids.has(candidate.selection.pageId)
      ? candidate.selection
      : order[0]
        ? selectPage(order[0])
        : newPage;
  return Object.freeze({
    version: 1,
    pagesRevision: revision,
    selection,
    pageOrder: Object.freeze(order),
  });
};

export const createTabModelPlugin = (): Plugin => {
  const enqueue = serial();
  const pendingClose = new Set<string>();
  let pendingOpenSelection: string | undefined;
  let api: PluginApi | undefined;
  let storageRevision = 0;
  let state = empty(0);
  const snapshot = async () => {
    if (!api) throw new Error("Tab model is inactive");
    const current = await readPages(api);
    for (const id of pendingClose)
      if (!current.pages.some((page) => page.id === id)) pendingClose.delete(id);
    return current;
  };
  const publish = async () => {
    if (!api) throw new Error("Tab model is inactive");
    await api.services.publish("model", state);
    return state;
  };
  const persist = async (
    candidate: TabStateValue,
    intent: (value: TabStateValue) => TabStateValue,
    pages: readonly ObservedPage[],
    pagesRevision: number,
  ) => {
    if (!api) throw new Error("Tab model is inactive");
    for (let attempt = 0; attempt < 3; attempt++)
      try {
        const written = await api.storage.write(storageRevision, candidate);
        storageRevision = written.revision;
        state = candidate;
        return;
      } catch (error) {
        if (!(error instanceof PluginApiError) || error.code !== "conflict" || attempt === 2)
          throw error;
        const current = await api.storage.read();
        storageRevision = current.revision;
        candidate = reconcile(
          intent(decodeState(current.value, pagesRevision).value),
          pagesRevision,
          pages,
          pendingClose,
        );
      }
  };
  const commit = async (
    intent: (value: TabStateValue) => TabStateValue,
    current: { revision: number; pages: readonly ObservedPage[] },
  ) => {
    const candidate = reconcile(intent(state), current.revision, current.pages, pendingClose);
    if (featureEqual(state, candidate)) {
      state = candidate;
      return;
    }
    await persist(candidate, intent, current.pages, current.revision);
  };
  const command = (method: string, params: unknown) =>
    enqueue(async () => {
      if (!api) throw new Error("Tab model is inactive");
      if (method === "select") {
        const { pageId } = decode(Select, params);
        const current = await snapshot();
        if (!current.pages.some((page) => page.id === pageId)) throw new Error("Unknown page");
        await commit((value) => ({ ...value, selection: selectPage(pageId) }), current);
        pendingOpenSelection = undefined;
        return publish();
      }
      if (method === "new") {
        decode(Empty, params);
        await commit((value) => ({ ...value, selection: newPage }), await snapshot());
        pendingOpenSelection = undefined;
        return publish();
      }
      if (method === "open") {
        const { url } = decode(Open, params);
        const opened = await api.pages.open(url);
        const current = await snapshot();
        if (!current.pages.some((page) => page.id === opened.pageId)) {
          pendingOpenSelection = opened.pageId;
          return publish();
        }
        await commit((value) => ({ ...value, selection: selectPage(opened.pageId) }), current);
        pendingOpenSelection = undefined;
        return publish();
      }
      if (method === "close") {
        const { pageId } = decode(Select, params);
        const before = await snapshot();
        if (!before.pages.some((page) => page.id === pageId)) throw new Error("Unknown page");
        await api.pages.close(pageId);
        pendingClose.add(pageId);
        const intent = (value: TabStateValue) => {
          const order = value.pageOrder.filter((id) => id !== pageId);
          const index = value.pageOrder.indexOf(pageId);
          const fallback = order[Math.min(Math.max(index, 0), Math.max(order.length - 1, 0))];
          return {
            ...value,
            pageOrder: order,
            selection:
              value.selection?.kind === "page" && value.selection.pageId === pageId
                ? fallback
                  ? selectPage(fallback)
                  : newPage
                : value.selection,
          };
        };
        await commit(intent, await snapshot());
        return publish();
      }
      if (method === "reorder") {
        const { pageId, index } = decode(Reorder, params);
        const current = await snapshot();
        if (!current.pages.some((page) => page.id === pageId)) throw new Error("Unknown page");
        const intent = (value: TabStateValue) => {
          const order = value.pageOrder.filter((id) => id !== pageId);
          order.splice(Math.min(index, order.length), 0, pageId);
          return { ...value, pageOrder: order };
        };
        await commit(intent, current);
        return publish();
      }
      throw new Error("Unknown tab command");
    });
  return {
    async activate(host) {
      api = host;
      await enqueue(async () => {
        const current = await snapshot();
        const saved = await host.storage.read();
        storageRevision = saved.revision;
        const decoded = decodeState(saved.value, current.revision);
        const candidate = reconcile(decoded.value, current.revision, current.pages, pendingClose);
        if (decoded.valid && featureEqual(decoded.value, candidate)) state = candidate;
        else await persist(candidate, (value) => value, current.pages, current.revision);
        await publish();
      });
    },
    services: { model: command },
    onPagesChanged: async () => {
      await enqueue(async () => {
        const current = await snapshot();
        const before = state;
        const pending = pendingOpenSelection;
        if (pending && current.pages.some((page) => page.id === pending)) {
          await commit((value) => ({ ...value, selection: selectPage(pending) }), current);
          pendingOpenSelection = undefined;
        } else await commit((value) => value, current);
        if (before.pagesRevision !== state.pagesRevision) await publish();
      });
    },
  };
};
