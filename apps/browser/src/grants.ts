import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { parseGrant } from "@hitchhiker/core";
import { createGrantStore } from "@hitchhiker/runtime";
import { Clock, Console, Effect, Logger } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

const cli = Command.make("hitchhiker-grants").pipe(
  Command.withSharedFlags({
    profileRoot: Flag.string("profile-root").pipe(
      Flag.withDefault(
        join(homedir(), "Library", "Application Support", "Hitchhiker", "profiles", "default"),
      ),
    ),
  }),
);
const store = Effect.gen(function* () {
  const { profileRoot } = yield* cli;
  if (!isAbsolute(profileRoot)) return yield* Effect.fail("--profile-root must be absolute");
  return yield* createGrantStore({ directory: join(profileRoot, "hitchhiker-grants") });
});
const issue = Command.make(
  "issue",
  {
    principal: Flag.string("principal"),
    capabilities: Flag.string("capabilities"),
    origins: Flag.string("origins").pipe(Flag.withDefault("")),
    expiresIn: Flag.integer("expires-in").pipe(
      Flag.withDefault(0),
      Flag.withDescription("Lifetime in seconds; zero creates a persistent grant"),
    ),
  },
  Effect.fn("Grants.issue")(function* ({ principal, capabilities, origins, expiresIn }) {
    if (expiresIn < 0 || expiresIn > 31_536_000)
      return yield* Effect.fail("--expires-in must be between zero and one year");
    const now = yield* Clock.currentTimeMillis;
    const parsed = parseGrant({
      id: "validation",
      principal,
      profileId: "default",
      capabilities: capabilities.split(","),
      origins: origins === "" ? [] : origins.split(","),
      ...(expiresIn === 0 ? {} : { expiresAt: now + expiresIn * 1000 }),
    });
    if (!parsed.ok) return yield* Effect.fail(parsed.errors.join(" "));
    const grants = yield* store;
    const issued = yield* grants.issue(parsed.value);
    // This command intentionally returns the one-time credential to its local caller.
    yield* Console.log(JSON.stringify(issued));
  }),
);
const list = Command.make(
  "list",
  {},
  Effect.fn("Grants.list")(function* () {
    const grants = yield* store;
    yield* Console.log(JSON.stringify(yield* grants.list()));
  }),
);
const revoke = Command.make(
  "revoke",
  { id: Argument.string("id") },
  Effect.fn("Grants.revoke")(function* ({ id }) {
    const grants = yield* store;
    yield* Console.log(JSON.stringify(yield* grants.revoke(id)));
  }),
);
cli.pipe(
  Command.withSubcommands([issue, list, revoke]),
  Command.run({ version: "0.1.0" }),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain,
);
