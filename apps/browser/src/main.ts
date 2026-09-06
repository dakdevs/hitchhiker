import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  EngineConnection,
  EngineError,
  NativeSurface,
  createGrantStore,
  runMcpStdio,
  openCdpRelay,
} from "@hitchhiker/runtime";
import { Console, Deferred, Effect, Layer, Logger } from "effect";
import { runPluginDirectory } from "./plugin.ts";
import { browserMcpApi } from "./mcp.ts";
import { makeBrowserController } from "./controller.ts";

const argument = (name: string) => {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
};
const executable = process.env.HITCHHIKER_NATIVE_BINARY;
const profileRoot =
  argument("--profile-root") ??
  join(homedir(), "Library", "Application Support", "Hitchhiker", "profiles", "default");

const program = Effect.gen(function* () {
  if (!executable || !isAbsolute(executable) || !isAbsolute(profileRoot))
    return yield* Effect.die("HITCHHIKER_NATIVE_BINARY and --profile-root must be absolute paths");
  const runtime = EngineConnection.layer({ executable, profileRoot });
  const layers = Layer.provideMerge(NativeSurface.layer, runtime);
  yield* Effect.gen(function* () {
    const engine = yield* EngineConnection;
    const fatalRecovery = yield* Deferred.make<never, EngineError>();
    const browserExit = Effect.raceFirst(engine.exit, Deferred.await(fatalRecovery));
    const rawCdp = process.argv.includes("--cdp");
    const controller = yield* makeBrowserController(profileRoot, { freezeEnabled: !rawCdp });
    yield* controller.start;
    const pluginDirectory = argument("--plugin");
    const mcp = process.argv.includes("--mcp");
    const grants = yield* createGrantStore({ directory: join(profileRoot, "hitchhiker-grants") });
    if (rawCdp) {
      const token = process.env.HITCHHIKER_CDP_TOKEN;
      if (!token)
        return yield* Effect.die("--cdp requires a separately issued HITCHHIKER_CDP_TOKEN");
      const initial = yield* grants.authorize(token, {
        profileId: "default",
        capability: "cdp.connect",
      });
      const relay = yield* openCdpRelay({
        engine,
        principal: initial.principal,
        authorize: () =>
          grants.authorize(token, { profileId: "default", capability: "cdp.connect" }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          ),
      });
      yield* Console.error(JSON.stringify({ cdpDiscoveryUrl: relay.discoveryUrl }));
    }
    if (pluginDirectory && !process.argv.includes("--safe-mode")) {
      const pluginExecutable = process.env.HITCHHIKER_PLUGIN_HOST;
      const token = process.env.HITCHHIKER_PLUGIN_TOKEN;
      if (
        !pluginExecutable ||
        !isAbsolute(pluginExecutable) ||
        !isAbsolute(pluginDirectory) ||
        !token
      )
        return yield* Effect.die(
          "--plugin requires an absolute package directory, HITCHHIKER_PLUGIN_HOST, and a pre-issued HITCHHIKER_PLUGIN_TOKEN",
        );
      yield* runPluginDirectory({
        directory: pluginDirectory,
        executable: pluginExecutable,
        token,
        grants,
        controller,
        onRecoveryFailure: Deferred.fail(
          fatalRecovery,
          new EngineError({
            code: "recovery",
            message: "The trusted interface could not be restored; closing the browser",
          }),
        ).pipe(Effect.asVoid),
      }).pipe(
        Effect.catchCause(() => Effect.logError("Plugin stopped.")),
        Effect.forkScoped,
      );
    }
    if (mcp) {
      const token = process.env.HITCHHIKER_MCP_TOKEN;
      if (!token) return yield* Effect.die("--mcp requires a pre-issued HITCHHIKER_MCP_TOKEN");
      yield* Effect.raceFirst(
        browserExit,
        runMcpStdio({ profileId: "default", token, grants, browser: browserMcpApi(controller) }),
      );
    } else yield* browserExit;
  }).pipe(Effect.provide(layers));
}).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
);

NodeRuntime.runMain(program);
