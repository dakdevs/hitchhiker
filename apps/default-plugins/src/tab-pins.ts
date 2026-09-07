import {
  PluginApiError,
  type Plugin,
  type PluginApi,
  type ObservedPage,
} from "@hitchhiker/plugin-sdk";
import { Pin, PinState, decode, type PinState as PinStateValue } from "./contracts.ts";
import { readPages, serial } from "./state-io.ts";

const empty = (pagesRevision: number): PinStateValue =>
  Object.freeze({ version: 1, pagesRevision, pinnedPageIds: Object.freeze([]) });
const featureEqual = (left: PinStateValue, right: PinStateValue) =>
  left.pinnedPageIds.length === right.pinnedPageIds.length &&
  left.pinnedPageIds.every((id, index) => id === right.pinnedPageIds[index]);
const decodeState = (value: unknown, revision: number) => {
  try {
    return { value: decode(PinState, value), valid: true };
  } catch {
    return { value: empty(revision), valid: false };
  }
};
const reconcile = (
  candidate: PinStateValue,
  revision: number,
  pages: readonly ObservedPage[],
): PinStateValue => {
  const ids = new Set(pages.map((page) => page.id));
  return Object.freeze({
    version: 1,
    pagesRevision: revision,
    pinnedPageIds: Object.freeze([...new Set(candidate.pinnedPageIds.filter((id) => ids.has(id)))]),
  });
};

export const createTabPinsPlugin = (): Plugin => {
  const enqueue = serial();
  let api: PluginApi | undefined;
  let storageRevision = 0;
  let state = empty(0);
  const publish = async () => {
    if (!api) throw new Error("Tab pins are inactive");
    await api.services.publish("pins", state);
    return state;
  };
  const persist = async (
    candidate: PinStateValue,
    intent: (value: PinStateValue) => PinStateValue,
    pages: readonly ObservedPage[],
    pagesRevision: number,
  ) => {
    if (!api) throw new Error("Tab pins are inactive");
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
        );
      }
  };
  const commit = async (
    intent: (value: PinStateValue) => PinStateValue,
    current: { revision: number; pages: readonly ObservedPage[] },
  ) => {
    const candidate = reconcile(intent(state), current.revision, current.pages);
    if (featureEqual(state, candidate)) {
      state = candidate;
      return;
    }
    await persist(candidate, intent, current.pages, current.revision);
  };
  return {
    async activate(host) {
      api = host;
      await enqueue(async () => {
        const current = await readPages(host);
        const saved = await host.storage.read();
        storageRevision = saved.revision;
        const decoded = decodeState(saved.value, current.revision);
        const candidate = reconcile(decoded.value, current.revision, current.pages);
        if (decoded.valid && featureEqual(decoded.value, candidate)) state = candidate;
        else await persist(candidate, (value) => value, current.pages, current.revision);
        await publish();
      });
    },
    services: {
      pins: (method, params) =>
        enqueue(async () => {
          if (!api) throw new Error("Tab pins are inactive");
          if (method !== "set") throw new Error("Unknown pin command");
          const { pageId, pinned } = decode(Pin, params);
          const current = await readPages(api);
          if (!current.pages.some((page) => page.id === pageId)) throw new Error("Unknown page");
          const intent = (value: PinStateValue) => ({
            ...value,
            pinnedPageIds: pinned
              ? value.pinnedPageIds.includes(pageId)
                ? value.pinnedPageIds
                : [...value.pinnedPageIds, pageId]
              : value.pinnedPageIds.filter((id) => id !== pageId),
          });
          await commit(intent, current);
          return publish();
        }),
    },
    onPagesChanged: async () => {
      await enqueue(async () => {
        if (!api) return;
        const current = await readPages(api);
        const before = state;
        await commit((value) => value, current);
        if (before.pagesRevision !== state.pagesRevision) await publish();
      });
    },
  };
};
