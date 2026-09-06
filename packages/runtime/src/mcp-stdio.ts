import { Deferred, Effect, Layer, Logger, Predicate, Schema, Sink, Stream } from "effect";
import { NodeServices } from "@effect/platform-node";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import * as Stdio from "effect/Stdio";
import { type McpOptions, registerBrowserMcp } from "./mcp.ts";

/** The largest accepted newline-delimited JSON-RPC request, matching the host frame limit. */
export const mcpStdioInputLimit = 256 * 1024;
export const mcpStdioOutputLimit = 4 * 1024 * 1024;
export const mcpStdioMaxInFlight = 32;

export class McpTransportError extends Schema.TaggedError<McpTransportError>()(
  "McpTransportError",
  { message: Schema.String },
) {}

const transportError = (message: string) => new McpTransportError({ message });

const server = McpServer.layerStdio({
  name: "Hitchhiker",
  version: "0.1.0",
  protocols: [McpProtocol.v2025_06_18],
});

/** Bound NDJSON frames and outstanding JSON-RPC requests before server dispatch. */
const boundedStdio = (closed: Deferred.Deferred<void, McpTransportError>) =>
  Layer.effect(
    Stdio.Stdio,
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      const inputDecoder = new TextDecoder("utf-8", { fatal: true });
      const outputDecoder = new TextDecoder("utf-8", { fatal: true });
      const active = new Set<string | number>();
      let inputBuffer = "";
      let outputBuffer = "";

      const halt = <A>(error: McpTransportError): Effect.Effect<A> =>
        Effect.uninterruptibleMask((restore) =>
          restore(
            Stream.make(`${error.message}\n`).pipe(
              Stream.run(stdio.stderr()),
              Effect.timeoutOrElse({ duration: 100, orElse: () => Effect.void }),
              Effect.catch(() => Effect.void),
            ),
          ).pipe(Effect.andThen(Deferred.fail(closed, error))),
        ).pipe(Effect.andThen(Effect.never));

      const parse = (line: string, direction: "input" | "output") =>
        Effect.try({
          try: () => JSON.parse(line) as unknown,
          catch: () => transportError(`Malformed MCP ${direction} JSON-RPC frame`),
        }).pipe(Effect.catch(halt));

      const inspectInput = Effect.fn("McpStdio.inspectInput")(function* (
        chunk: Uint8Array,
      ): Effect.fn.Return<Uint8Array> {
        const text = yield* Effect.try({
          try: () => inputDecoder.decode(chunk, { stream: true }),
          catch: () => transportError("MCP stdio input is not valid UTF-8"),
        }).pipe(Effect.catch((error) => halt<string>(error)));
        inputBuffer += text;
        let newline = inputBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = inputBuffer.slice(0, newline);
          inputBuffer = inputBuffer.slice(newline + 1);
          if (Buffer.byteLength(line) > mcpStdioInputLimit)
            return yield* halt<Uint8Array>(transportError("MCP stdio request exceeds 256 KiB"));
          if (line.length > 0) {
            const message = yield* parse(line, "input");
            if (!Predicate.isObject(message))
              return yield* halt<Uint8Array>(
                transportError("MCP JSON-RPC batches and non-object messages are not supported"),
              );
            if (typeof message.method === "string" && "id" in message && message.id !== null) {
              const id = message.id;
              if ((typeof id !== "string" && typeof id !== "number") || active.has(id))
                return yield* halt<Uint8Array>(
                  transportError("MCP JSON-RPC request id is invalid or already active"),
                );
              if (active.size >= mcpStdioMaxInFlight)
                return yield* halt<Uint8Array>(
                  transportError("MCP stdio connection has too many in-flight requests"),
                );
              active.add(id);
            }
          }
          newline = inputBuffer.indexOf("\n");
        }
        if (Buffer.byteLength(inputBuffer) > mcpStdioInputLimit)
          return yield* halt<Uint8Array>(transportError("MCP stdio request exceeds 256 KiB"));
        return chunk;
      });

      const finishInput = Effect.fn("McpStdio.finishInput")(function* (): Effect.fn.Return<never> {
        yield* Effect.try({
          try: () => inputDecoder.decode(),
          catch: () => transportError("MCP stdio input is not valid UTF-8"),
        }).pipe(Effect.catch((error) => halt<string>(error)));
        if (inputBuffer.length > 0)
          return yield* halt<never>(
            transportError("MCP stdio input ended with an unterminated frame"),
          );
        yield* Deferred.succeed(closed, undefined);
        return yield* Effect.never as Effect.Effect<never>;
      });

      const stdin = stdio.stdin.pipe(
        Stream.mapEffect(inspectInput),
        Stream.concat(Stream.fromEffectDrain(finishInput())),
        Stream.catchCause(() =>
          Stream.fromEffectDrain(halt<void>(transportError("MCP stdio input failed"))),
        ),
      );

      const inspectOutput = Effect.fn("McpStdio.inspectOutput")(function* (
        data: string | Uint8Array,
      ): Effect.fn.Return<string | Uint8Array> {
        const text =
          typeof data === "string"
            ? data
            : yield* Effect.try({
                try: () => outputDecoder.decode(data, { stream: true }),
                catch: () => transportError("MCP stdio output is not valid UTF-8"),
              }).pipe(Effect.catch((error) => halt<string>(error)));
        outputBuffer += text;
        let newline = outputBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = outputBuffer.slice(0, newline);
          outputBuffer = outputBuffer.slice(newline + 1);
          if (Buffer.byteLength(line) > mcpStdioOutputLimit)
            return yield* halt<string | Uint8Array>(
              transportError("MCP stdio response exceeds 4 MiB"),
            );
          const message = yield* parse(line, "output");
          if (Predicate.isObject(message) && "id" in message) {
            const id = message.id;
            const response = "result" in message !== "error" in message;
            if (response && (typeof id === "string" || typeof id === "number") && active.has(id))
              active.delete(id);
          }
          newline = outputBuffer.indexOf("\n");
        }
        if (Buffer.byteLength(outputBuffer) > mcpStdioOutputLimit)
          return yield* halt<string | Uint8Array>(
            transportError("MCP stdio response exceeds 4 MiB"),
          );
        return data;
      });

      const stdout = (options?: { readonly endOnDone?: boolean }) =>
        Sink.mapInputEffect(stdio.stdout(options), inspectOutput).pipe(
          Sink.catchCause(() => halt<void>(transportError("MCP stdio output failed"))),
        );
      return Stdio.make({ ...stdio, stdin, stdout });
    }),
  );

/**
 * Runs a single pre-authorized MCP stdio connection. Credentials are supplied by the trusted
 * launcher and are never accepted from JSON-RPC parameters or used to issue a new grant.
 */
export const runMcpStdio = Effect.fn("runMcpStdio")(function* (options: McpOptions) {
  const closed = yield* Deferred.make<void, McpTransportError>();
  const connection = Effect.gen(function* () {
    yield* registerBrowserMcp(options);
    return yield* Effect.never;
  }).pipe(
    Effect.provide(server),
    Effect.provide(boundedStdio(closed)),
    Effect.provide(NodeServices.layer),
    Effect.provideService(Logger.LogToStderr, true),
    Effect.catchCause(() => Deferred.fail(closed, transportError("MCP server failed"))),
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* connection.pipe(Effect.forkScoped);
      return yield* Deferred.await(closed);
    }),
  );
});
