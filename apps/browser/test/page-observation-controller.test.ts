import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineConnection, NativeSurface, type EngineEvent } from "@hitchhiker/runtime";
import { Effect, Layer, PubSub, Schedule, Stream } from "effect";
import { makeBrowserController } from "../src/controller.ts";

test("controller observations retain trusted open URLs and history routes only live pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchhiker-page-observations-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<EngineEvent>();
          const history: Array<readonly [string, string]> = [];
          const engine = EngineConnection.of({
            pid: 1,
            ready: Effect.succeed({ event: "host.ready", params: { pageBrowserGeneration: true } }),
            exit: Effect.never,
            events: Stream.fromPubSub(events),
            request: (method, params = {}) =>
              Effect.gen(function* () {
                if (method === "pages.open" && typeof params.id === "string") {
                  // The created event intentionally omits a URL. The controller must
                  // retain the trusted requested URL in its reduced page metadata.
                  yield* PubSub.publish(events, {
                    event: "pages.created",
                    params: { pageId: params.id, generation: 1 },
                  });
                  yield* PubSub.publish(events, {
                    event: "pages.navigationChanged",
                    params: {
                      pageId: params.id,
                      generation: 1,
                      url: "https://known.test/path",
                      loading: false,
                      canGoBack: true,
                      canGoForward: false,
                    },
                  });
                  return {};
                }
                if (method.startsWith("pages.") && typeof params.id === "string")
                  history.push([method, params.id]);
                return {};
              }),
            loadUnpacked: () => Effect.die("unused"),
            uninstall: () => Effect.die("unused"),
            claimRawCdp: Effect.die("unused"),
          });
          const controller = yield* makeBrowserController(root).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(EngineConnection, engine),
                Layer.succeed(
                  NativeSurface,
                  NativeSurface.of({ events: Stream.empty, commit: () => Effect.succeed(1) }),
                ),
              ),
            ),
          );
          yield* controller.start;
          const subscription = yield* controller.observePages("observer");
          const pageId = yield* controller.openPage("https://known.test/path");
          const first = yield* subscription.watch({}).pipe(
            Effect.flatMap((snapshot) =>
              snapshot.pages.length === 1 && snapshot.pages[0]?.canGoBack
                ? Effect.succeed(snapshot)
                : Effect.fail("not reduced"),
            ),
            Effect.retry({ times: 30, schedule: Schedule.spaced(10) }),
          );
          assert.deepEqual(
            first.pages.map((page) => ({
              id: page.id,
              url: page.url,
              loading: page.loading,
              canGoBack: page.canGoBack,
              canGoForward: page.canGoForward,
            })),
            [
              {
                id: pageId,
                url: "https://known.test/path",
                loading: false,
                canGoBack: true,
                canGoForward: false,
              },
            ],
          );
          const revision = first.revision;
          for (const action of ["back", "forward", "reload", "stop"] as const)
            yield* controller.pageHistory(pageId, action);
          assert.deepEqual(history, [
            ["pages.back", pageId],
            ["pages.forward", pageId],
            ["pages.reload", pageId],
            ["pages.stop", pageId],
          ]);
          yield* controller.dispatch("interface.tabs.toggle");
          assert.equal(
            (yield* subscription.watch({})).revision,
            revision,
            "history/UI activity must not publish lastUsedAt-only changes",
          );
          assert(
            (yield* Effect.exit(controller.pageHistory("missing", "back")))._tag === "Failure",
          );
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
