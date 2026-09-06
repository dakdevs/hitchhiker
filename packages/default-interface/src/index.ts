import type { BrowserState, Result } from "@hitchhiker/core";

export {
  defaultSurfaceActions,
  renderDefaultSurface,
  type DefaultSurfaceAction,
  type DefaultSurfaceRenderOptions,
} from "./surface.ts";

/** First-party presentation state. It intentionally has no browser-engine authority. */
export type TabPlacement = "sidebar" | "top";
export interface DefaultInterfaceConfiguration {
  readonly tabPlacement: TabPlacement;
}
export const defaultInterfaceConfiguration: DefaultInterfaceConfiguration = Object.freeze({
  tabPlacement: "sidebar",
});
export interface DefaultInterfaceState {
  readonly profileId: string;
  readonly selectedPageId?: string;
  readonly pageOrder: readonly string[];
  readonly pinnedPageIds: readonly string[];
}
export const createDefaultInterface = (profileId: string): DefaultInterfaceState =>
  Object.freeze({ profileId, pageOrder: Object.freeze([]), pinnedPageIds: Object.freeze([]) });
export const defaultInterfaceState = createDefaultInterface("default");
const unique = (ids: readonly string[]): readonly string[] => Object.freeze([...new Set(ids)]);
const validPage = (browser: BrowserState, state: DefaultInterfaceState, pageId: string): boolean =>
  browser.pages.some(
    (page) =>
      page.id === pageId && page.profileId === state.profileId && page.lifecycle !== "closed",
  );
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (...errors: string[]): Result<never> => ({ ok: false, errors });
/** Removes closed or other-profile pages after browser lifecycle changes. Sleeping pages remain presentable. */
export const reconcileInterface = (
  browser: BrowserState,
  state: DefaultInterfaceState,
): DefaultInterfaceState => {
  const livePageIds = new Set(
    browser.pages
      .filter((page) => page.profileId === state.profileId && page.lifecycle !== "closed")
      .map((page) => page.id),
  );
  const pageOrder = unique(state.pageOrder.filter((pageId) => livePageIds.has(pageId)));
  const pinnedPageIds = unique(state.pinnedPageIds.filter((pageId) => livePageIds.has(pageId)));
  const selectedPageId =
    state.selectedPageId !== undefined && livePageIds.has(state.selectedPageId)
      ? state.selectedPageId
      : pageOrder[0];
  return Object.freeze({
    profileId: state.profileId,
    ...(selectedPageId === undefined ? {} : { selectedPageId }),
    pageOrder,
    pinnedPageIds,
  });
};
/** Selection belongs to this interface instance and only references a live page in its profile. */
export const selectPage = (
  browser: BrowserState,
  state: DefaultInterfaceState,
  pageId: string,
): Result<DefaultInterfaceState> => {
  if (!validPage(browser, state, pageId))
    return fail("Page is not live in this interface profile.");
  const reconciled = reconcileInterface(browser, state);
  return ok(
    Object.freeze({
      ...reconciled,
      selectedPageId: pageId,
      pageOrder: unique([...reconciled.pageOrder, pageId]),
    }),
  );
};
export const setPagePinned = (
  browser: BrowserState,
  state: DefaultInterfaceState,
  pageId: string,
  pinned: boolean,
): Result<DefaultInterfaceState> => {
  if (!validPage(browser, state, pageId))
    return fail("Page is not live in this interface profile.");
  const reconciled = reconcileInterface(browser, state);
  return ok(
    Object.freeze({
      ...reconciled,
      pageOrder: unique([...reconciled.pageOrder, pageId]),
      pinnedPageIds: pinned
        ? unique([...reconciled.pinnedPageIds, pageId])
        : Object.freeze(reconciled.pinnedPageIds.filter((id) => id !== pageId)),
    }),
  );
};
export const reorderPage = (
  browser: BrowserState,
  state: DefaultInterfaceState,
  pageId: string,
  index: number,
): Result<DefaultInterfaceState> => {
  const reconciled = reconcileInterface(browser, state);
  if (
    !validPage(browser, reconciled, pageId) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= reconciled.pageOrder.length
  )
    return fail("Page reorder is invalid.");
  const from = reconciled.pageOrder.indexOf(pageId);
  if (from < 0) return fail("Page is not ordered by this interface.");
  const pageOrder = [...reconciled.pageOrder];
  pageOrder.splice(from, 1);
  pageOrder.splice(index, 0, pageId);
  return ok(Object.freeze({ ...reconciled, pageOrder: Object.freeze(pageOrder) }));
};
