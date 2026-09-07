import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { EngineError, PluginCompositionRecipeSchema } from "@hitchhiker/runtime";

/** A profile recipe selects existing installed identities. Reading it grants no capabilities. */
export const readCompositionRecipe = Effect.fn("Browser.readCompositionRecipe")(function* (
  profileRoot: string,
) {
  const directory = join(profileRoot, "hitchhiker-plugins");
  const path = join(directory, "composition.json");
  const source = yield* Effect.tryPromise({
    try: async () => {
      try {
        const parent = await lstat(directory);
        if (
          !parent.isDirectory() ||
          parent.isSymbolicLink() ||
          (await realpath(directory)) !== directory
        )
          throw new Error("Invalid composition directory");
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await file.stat();
          if (!before.isFile() || before.nlink !== 1 || before.size > 32768)
            throw new Error("Invalid composition file");
          const bytes = Buffer.alloc(32769);
          let length = 0;
          while (length < bytes.length) {
            const part = await file.read(bytes, length, bytes.length - length, null);
            if (!part.bytesRead) break;
            length += part.bytesRead;
          }
          const after = await file.stat();
          if (length > 32768 || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
            throw new Error("Composition changed during read");
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    catch: () =>
      new EngineError({
        code: "composition",
        message: "Could not read profile composition. Restart in safe mode to repair it.",
      }),
  });
  if (source === undefined) return undefined;
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PluginCompositionRecipeSchema), {
    onExcessProperty: "error",
  })(source).pipe(
    Effect.mapError(
      () =>
        new EngineError({
          code: "composition",
          message: "Invalid profile composition. Restart in safe mode to repair it.",
        }),
    ),
  );
});
