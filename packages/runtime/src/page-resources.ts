import {
  defaultConfiguration,
  selectPageEvictions,
  type BrowserConfiguration,
  type BrowserState,
} from "@hitchhiker/core";
import { Effect, Schema } from "effect";
import type { JsonObject } from "./engine.ts";
import { AttachedPageGeneration } from "./page-lifecycle.ts";

/** A complete native protection snapshot for one stable page ID. */
export const PageResourceSignal = Schema.Struct({
  pageId: Schema.String,
  audio: Schema.Boolean,
  call: Schema.Boolean,
  download: Schema.Boolean,
  unsavedInput: Schema.Boolean,
});
export type PageResourceSignal = typeof PageResourceSignal.Type;

/** The private host event carrying a complete PageResourceSignal snapshot. */
export const PageResourceEvent = Schema.Struct({
  event: Schema.Literal("pages.resourcesChanged"),
  params: Schema.Struct({
    ...PageResourceSignal.fields,
    generation: AttachedPageGeneration,
    known: Schema.Literal(true),
  }),
});
export const decodePageResourceEvent = Schema.decodeUnknownEffect(PageResourceEvent);

export type PageResourceKnowledge = ReadonlyMap<string, PageResourceSignal>;

/**
 * Signals are complete snapshots, so replacement is safe and idempotent. A
 * page absent from this map is intentionally treated as protected below.
 */
export const rememberPageResources = (
  known: PageResourceKnowledge,
  signal: PageResourceSignal,
): PageResourceKnowledge => {
  const next = new Map(known);
  next.set(signal.pageId, Object.freeze({ ...signal }));
  return next;
};

const unknownProtections = Object.freeze({
  audio: true,
  call: true,
  download: true,
  unsavedInput: true,
});

/**
 * Returns pages eligible for a reversible CDP freeze. Missing native support
 * and missing per-page snapshots are both fail-closed: they produce no freeze.
 * This intentionally does not model discard; CDP exposes no safe discard API.
 */
export const selectPageFreezes = (
  state: BrowserState,
  configuration: BrowserConfiguration = defaultConfiguration,
  now: number,
  limit: number,
  signalsAvailable: boolean,
  known: PageResourceKnowledge,
): readonly string[] => {
  if (!signalsAvailable) return [];
  const pages = state.pages.map((page) => {
    const resources = known.get(page.id);
    return Object.freeze({
      ...page,
      protections: resources
        ? Object.freeze({
            audio: resources.audio,
            call: resources.call,
            download: resources.download,
            unsavedInput: resources.unsavedInput,
          })
        : unknownProtections,
    });
  });
  return selectPageEvictions(
    Object.freeze({ ...state, pages: Object.freeze(pages) }),
    configuration,
    now,
    limit,
  );
};

/** Minimal trusted capability required to invoke a page-scoped DevTools call. */
export interface PageLifecycleTransport<E = never> {
  readonly request: (method: string, params: JsonObject) => Effect.Effect<unknown, E>;
}

/** Freeze is reversible and must only be requested after eligibility is checked. */
export const freezePage = Effect.fn("PageResources.freezePage")(function* <E>(
  transport: PageLifecycleTransport<E>,
  pageId: string,
): Effect.fn.Return<void, E> {
  yield* transport.request("cdp.send", {
    pageId,
    method: "Page.setWebLifecycleState",
    params: { state: "frozen" },
  });
});

/** Activate before placing a frozen page in a visible viewport. */
export const activatePage = Effect.fn("PageResources.activatePage")(function* <E>(
  transport: PageLifecycleTransport<E>,
  pageId: string,
): Effect.fn.Return<void, E> {
  yield* transport.request("cdp.send", {
    pageId,
    method: "Page.setWebLifecycleState",
    params: { state: "active" },
  });
});
