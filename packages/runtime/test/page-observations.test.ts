import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit, Scope, Stream } from "effect";
import { makePageObservations } from "../src/page-observations.ts";

const page = (id: string, title = id) => ({
  id,
  profileId: "profile",
  url: `https://${id}.test/`,
  title,
  lifecycle: "loaded" as const,
  protections: { audio: false, call: false, download: false, unsavedInput: false },
  loading: false,
  canGoBack: false,
  canGoForward: false,
});

test("coalesces page changes and ignores equivalent state", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observations = yield* makePageObservations();
        const subscription = yield* observations.bind("owner");
        yield* subscription.watch();
        observations.publish([page("one")]);
        observations.publish([page("one", "updated")]);
        const event = yield* Stream.runCollect(subscription.events.pipe(Stream.take(1)));
        assert.deepEqual(event[0], { event: "pages.changed", payload: { revision: 2 } });
        const snapshot = yield* subscription.watch();
        observations.publish([
          {
            ...page("one", "updated"),
            protections: { audio: false, call: false, download: false, unsavedInput: false },
          },
        ]);
        assert.equal((yield* subscription.watch()).revision, snapshot.revision);
      }),
    ),
  );
});

test("paginates immutable snapshots and rejects stale continuations", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observations = yield* makePageObservations();
        const subscription = yield* observations.bind("owner");
        const input = page("one");
        observations.publish([
          input,
          ...Array.from({ length: 32 }, (_, index) => page(`p${index}`)),
        ]);
        input.title = "mutated";
        const first = yield* subscription.watch();
        assert.equal(first.pages.length, 32);
        assert.equal(first.pages[0]?.title, "one");
        assert.equal(Object.isFrozen(first.pages[0]), true);
        assert.equal(first.nextOffset, 32);
        const second = yield* subscription.watch({
          offset: first.nextOffset,
          revision: first.revision,
        });
        assert.equal(second.pages.length, 1);
        observations.publish([page("one", "new")]);
        assert(
          Exit.isFailure(
            yield* Effect.exit(subscription.watch({ offset: 32, revision: first.revision })),
          ),
        );
      }),
    ),
  );
});

test("enforces duplicate and capacity limits and releases subscriptions with scope", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observations = yield* makePageObservations();
        yield* observations.bind("one");
        assert(Exit.isFailure(yield* Effect.exit(observations.bind("one"))));
        yield* observations.bind("two");
        yield* observations.bind("three");
        yield* observations.bind("four");
        assert(Exit.isFailure(yield* Effect.exit(observations.bind("five"))));
      }),
    ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observations = yield* makePageObservations();
        yield* observations.bind("one");
      }),
    ),
  );
});

test("reuses a released owner and invalidates an old handle after its scope closes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observations = yield* makePageObservations();
        const child = yield* Scope.make();
        const old = yield* observations
          .bind("owner")
          .pipe(Effect.provideService(Scope.Scope, child));
        yield* Scope.close(child, Exit.void);
        assert(Exit.isFailure(yield* Effect.exit(old.watch({}))));
        const replacement = yield* observations.bind("owner");
        assert.equal((yield* replacement.watch({})).pages.length, 0);
      }),
    ),
  );
});

test("concurrent bind attempts preserve four-owner capacity across failed scopes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observations = yield* makePageObservations();
        const attempts = yield* Effect.forEach(
          Array.from({ length: 24 }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              const result = yield* Effect.exit(
                observations
                  .bind(`owner-${index % 6}`)
                  .pipe(Effect.provideService(Scope.Scope, scope)),
              );
              if (Exit.isFailure(result)) yield* Scope.close(scope, Exit.void);
              return { scope, result };
            }),
          { concurrency: "unbounded" },
        );
        const accepted = attempts.filter((entry) => Exit.isSuccess(entry.result));
        assert.equal(accepted.length, 4);
        assert(Exit.isFailure(yield* Effect.exit(observations.bind("extra"))));
        yield* Effect.forEach(accepted, (entry) => Scope.close(entry.scope, Exit.void), {
          discard: true,
        });
        yield* observations.bind("extra");
      }),
    ),
  );
});

test("bounds snapshots by encoded bytes without truncating page metadata", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observations = yield* makePageObservations();
        const subscription = yield* observations.bind("owner");
        const title = "x".repeat(70_000);
        observations.publish([page("one", title), page("two", title)]);
        const first = yield* subscription.watch();
        assert.equal(first.pages.length, 1);
        assert.equal(first.pages[0]?.title, title);
        assert.equal(first.nextOffset, 1);
        assert(Buffer.byteLength(JSON.stringify(first)) < 128 * 1024);
        assert.equal(
          (yield* subscription.watch({ offset: 1, revision: first.revision })).pages[0]?.id,
          "two",
        );
        observations.publish([page("one", "x".repeat(128 * 1024))]);
        assert(Exit.isFailure(yield* Effect.exit(subscription.watch())));
      }),
    ),
  );
});
