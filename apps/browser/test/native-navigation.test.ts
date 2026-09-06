import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { EngineConnection, NativeSurface, type EngineEvent } from "@hitchhiker/runtime";
import { Effect, Layer, Schedule, Schema, Stream } from "effect";
import { makeBrowserController } from "../src/controller.ts";

const binary = process.env.HITCHHIKER_NATIVE_BINARY;
const decodeValue = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ value: Schema.Json }) }),
);

test(
  "a hidden sleeping page wakes for an in-flight trusted navigation and stays awake until completion",
  { skip: !binary || !isAbsolute(binary), timeout: 45_000 },
  async () => {
    if (!binary || !isAbsolute(binary)) return;
    const directory = await mkdtemp(join(tmpdir(), "hitchhiker-native-navigation-"));
    let releaseHeld: (() => void) | undefined;
    let receivedHeld: (() => void) | undefined;
    const heldReceived = new Promise<void>((resolve) => {
      receivedHeld = resolve;
    });
    const heldReleased = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const server = createServer(async (request, response) => {
      if (request.url === "/hold") {
        receivedHeld?.();
        await heldReleased;
        response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        response.end(
          "<!doctype html><title>Held navigation</title><script>globalThis.done=true</script>",
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(
        "<!doctype html><title>Initial page</title><script>globalThis.initial=true</script>",
      );
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = EngineConnection.layer({
              executable: binary,
              profileRoot: join(directory, "profile"),
              extensionManagement: false,
            });
            yield* Effect.gen(function* () {
              const engine = yield* EngineConnection;
              const controller = yield* makeBrowserController(join(directory, "profile"));
              const events: EngineEvent[] = [];
              yield* engine.events.pipe(
                Stream.runForEach((event) => Effect.sync(() => events.push(event))),
                Effect.forkScoped,
              );
              yield* Effect.addFinalizer(() =>
                engine.request("window.close").pipe(Effect.catch(() => Effect.void)),
              );
              const waitFor = (label: string, condition: () => Effect.Effect<boolean, unknown>) =>
                condition().pipe(
                  Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail(new Error(label)))),
                  Effect.retry({ times: 280, schedule: Schedule.spaced(50) }),
                  Effect.timeoutOrElse({
                    duration: 14_000,
                    orElse: () => Effect.fail(new Error(`Timed out waiting for ${label}`)),
                  }),
                );
              const evaluate = (pageId: string, expression: string) =>
                engine
                  .request("cdp.send", {
                    pageId,
                    method: "Runtime.evaluate",
                    params: { expression, returnByValue: true },
                  })
                  .pipe(
                    Effect.flatMap(decodeValue),
                    Effect.map((value) => value.result.value),
                  );

              yield* controller.start;
              const target = yield* controller.openPage(`${origin}/initial`);
              const control = yield* controller.openPage(`${origin}/control`);
              yield* waitFor("both pages complete", () =>
                controller.snapshot.pipe(
                  Effect.map(
                    (state) =>
                      state.pages.filter((page) => page.lifecycle !== "closed").length === 2,
                  ),
                ),
              );
              yield* waitFor("both initial documents", () =>
                Effect.all([
                  evaluate(target, "globalThis.initial===true"),
                  evaluate(control, "globalThis.initial===true"),
                ]).pipe(Effect.map((values) => values.every((value) => value === true))),
              );
              yield* controller.configure({
                colorScheme: "system",
                sleepAfterMs: 10_000,
                alwaysAwakeOrigins: [],
              });
              yield* controller.dispatch(`page.select:${control}`);
              yield* waitFor("hidden target freeze", () =>
                controller.snapshot.pipe(
                  Effect.map(
                    (state) =>
                      state.pages.find((page) => page.id === target)?.lifecycle === "sleeping",
                  ),
                ),
              );

              const heldUrl = `${origin}/hold`;
              const targetCreated = events.find(
                (event) => event.event === "pages.created" && event.params.pageId === target,
              );
              assert.equal(typeof targetCreated?.params.generation, "number");
              const targetGeneration = targetCreated!.params.generation as number;
              const eventStart = events.length;
              yield* controller.navigatePage(target, heldUrl);
              yield* Effect.promise(() => heldReceived).pipe(
                Effect.timeoutOrElse({
                  duration: 5_000,
                  orElse: () => Effect.fail(new Error("Held navigation did not reach the fixture")),
                }),
              );
              yield* waitFor("current loading event", () =>
                controller.snapshot.pipe(
                  Effect.map(
                    (state) =>
                      state.pages.find((page) => page.id === target)?.lifecycle === "loaded" &&
                      events
                        .slice(eventStart)
                        .some(
                          (event) =>
                            event.event === "pages.navigationChanged" &&
                            event.params.pageId === target &&
                            event.params.generation === targetGeneration &&
                            event.params.loading === true,
                        ),
                  ),
                ),
              );
              const heldSince = performance.now();
              while (performance.now() - heldSince < 10_500) {
                const targetPage = (yield* controller.snapshot).pages.find(
                  (page) => page.id === target,
                );
                if (targetPage?.lifecycle !== "loaded")
                  return yield* Effect.fail(
                    new Error(
                      "Loading target left the loaded lifecycle before the response was released",
                    ),
                  );
                yield* Effect.sleep(50);
              }
              releaseHeld?.();
              yield* waitFor("real navigation completion", () =>
                controller.snapshot.pipe(
                  Effect.map((state) => {
                    const targetPage = state.pages.find((page) => page.id === target);
                    return (
                      targetPage?.url === heldUrl &&
                      targetPage.title === "Held navigation" &&
                      events
                        .slice(eventStart)
                        .some(
                          (event) =>
                            event.event === "pages.navigationChanged" &&
                            event.params.pageId === target &&
                            event.params.generation === targetGeneration &&
                            event.params.loading === false &&
                            event.params.url === heldUrl,
                        )
                    );
                  }),
                ),
              );
              assert.equal(
                yield* controller.lastError,
                undefined,
                "controller event handling failed",
              );
              yield* engine.request("window.close");
              assert.equal(yield* engine.exit, 0);
            }).pipe(Effect.provide(Layer.provideMerge(NativeSurface.layer, runtime)));
          }),
        ).pipe(
          Effect.provide(NodeServices.layer),
          Effect.timeoutOrElse({
            duration: 40_000,
            orElse: () => Effect.fail(new Error("Native navigation regression timed out")),
          }),
        ),
      );
    } finally {
      releaseHeld?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
