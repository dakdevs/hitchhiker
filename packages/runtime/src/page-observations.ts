import type { ObservedPage, PageWatchRequest, PageWatchSnapshot } from "@hitchhiker/core";
import { Effect, Queue, Schema, Stream } from "effect";
import { EngineError } from "./engine.ts";

const invalid = (message: string) => new EngineError({ code: "page-watch", message });
const samePage = (left: ObservedPage, right: ObservedPage) =>
  left.id === right.id &&
  left.profileId === right.profileId &&
  left.url === right.url &&
  left.title === right.title &&
  left.lifecycle === right.lifecycle &&
  left.loading === right.loading &&
  left.canGoBack === right.canGoBack &&
  left.canGoForward === right.canGoForward &&
  left.protections.audio === right.protections.audio &&
  left.protections.call === right.protections.call &&
  left.protections.download === right.protections.download &&
  left.protections.unsavedInput === right.protections.unsavedInput;
const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const PageWatchRequestSchema = Schema.Struct({
  offset: Schema.optional(Revision),
  revision: Schema.optional(Revision),
});
export const PageChangedSchema = Schema.Struct({ revision: Revision });
export interface PageWatchSubscription {
  readonly watch: (request?: PageWatchRequest) => Effect.Effect<PageWatchSnapshot, EngineError>;
  readonly events: Stream.Stream<{
    readonly event: string;
    readonly payload: { readonly revision: number };
  }>;
}

/** The caller serializes publish/watch with its state reduction lock. No native events enter this hub. */
export const makePageObservations = Effect.fn("PageObservations.make")(function* () {
  let pages: readonly ObservedPage[] = Object.freeze([]);
  let revision = 0;
  let closed = false;
  const subscriptions = new Map<
    string,
    { readonly queue: Queue.Queue<number>; watching: boolean }
  >();
  const reservations = new Map<string, object>();
  const publish = (next: readonly ObservedPage[]) => {
    if (closed) return;
    if (next.length === pages.length && next.every((page, index) => samePage(page, pages[index]!)))
      return;
    if (revision >= Number.MAX_SAFE_INTEGER)
      throw invalid("Page observation revision limit reached");
    pages = Object.freeze(
      next.map((page) =>
        Object.freeze({
          id: page.id,
          profileId: page.profileId,
          url: page.url,
          title: page.title,
          lifecycle: page.lifecycle,
          protections: Object.freeze({ ...page.protections }),
          loading: page.loading,
          canGoBack: page.canGoBack,
          canGoForward: page.canGoForward,
        }),
      ),
    );
    revision += 1;
    for (const subscription of subscriptions.values())
      if (subscription.watching) Queue.offerUnsafe(subscription.queue, revision);
  };
  const bind = Effect.fn("PageObservations.bind")(function* (owner: string) {
    // Reserve synchronously before queue allocation: Queue.sliding yields, so a
    // check-then-acquire sequence would otherwise admit duplicate owners or five
    // concurrent subscriptions.
    const reservation = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (
            closed ||
            subscriptions.has(owner) ||
            reservations.has(owner) ||
            subscriptions.size + reservations.size >= 4
          )
            throw invalid("Page observation owner already exists or is at capacity");
          const token = {};
          reservations.set(owner, token);
          return token;
        },
        catch: () => invalid("Page observation owner already exists or is at capacity"),
      }),
      (token) =>
        Effect.sync(() => {
          if (reservations.get(owner) === token) reservations.delete(owner);
        }),
    );
    const queue = yield* Effect.acquireRelease(Queue.sliding<number>(1), Queue.shutdown);
    const subscription = { queue, watching: false };
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (closed || reservations.get(owner) !== reservation)
            throw invalid("Page observation owner is inactive");
          reservations.delete(owner);
          subscriptions.set(owner, subscription);
        },
        catch: () => invalid("Page observation owner is inactive"),
      }),
      () =>
        Effect.sync(() => {
          if (subscriptions.get(owner) === subscription) subscriptions.delete(owner);
        }),
    );
    const watch = Effect.fn("PageObservations.watch")(function* (request: PageWatchRequest = {}) {
      const decoded = yield* Schema.decodeUnknownEffect(PageWatchRequestSchema, {
        onExcessProperty: "error",
      })(request).pipe(Effect.mapError(() => invalid("Invalid page watch request")));
      if (closed || subscriptions.get(owner) !== subscription)
        return yield* invalid("Page observation owner is inactive");
      const offset = decoded.offset ?? 0;
      if (offset > 0 && decoded.revision === undefined)
        return yield* invalid("Page snapshot continuation requires a revision");
      if (decoded.revision !== undefined && decoded.revision !== revision)
        return yield* new EngineError({
          code: "page-watch-stale",
          message: "Page snapshot changed; restart from offset zero",
        });
      if (offset > pages.length) return yield* invalid("Page snapshot offset is invalid");
      const chunk: ObservedPage[] = [];
      let bytes = 1024;
      for (let index = offset; index < pages.length && chunk.length < 32; index++) {
        const page = pages[index]!;
        const size = Buffer.byteLength(JSON.stringify(page), "utf8") + 1;
        if (bytes + size > 128 * 1024) {
          if (chunk.length === 0) return yield* invalid("Page metadata exceeds snapshot limits");
          break;
        }
        chunk.push(page);
        bytes += size;
      }
      subscription.watching = true;
      const nextOffset = offset + chunk.length;
      return Object.freeze({
        revision,
        pages: Object.freeze(chunk),
        ...(nextOffset < pages.length ? { nextOffset } : {}),
      }) satisfies PageWatchSnapshot;
    });
    return Object.freeze({
      watch,
      events: Stream.fromQueue(subscription.queue).pipe(
        Stream.map((current) => ({
          event: "pages.changed",
          payload: { revision: current },
        })),
      ),
    }) satisfies PageWatchSubscription;
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      reservations.clear();
      const active = [...subscriptions.values()];
      subscriptions.clear();
      return active;
    }).pipe(
      Effect.flatMap((active) =>
        Effect.forEach(active, (subscription) => Queue.shutdown(subscription.queue), {
          discard: true,
        }),
      ),
    ),
  );
  return Object.freeze({ publish, bind });
});
