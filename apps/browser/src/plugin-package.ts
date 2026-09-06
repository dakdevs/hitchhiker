import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";

export class PluginPackageError extends Schema.TaggedError<PluginPackageError>()(
  "PluginPackageError",
  { message: Schema.String },
) {}

/** Fixed, regular files only. Hold the no-follow descriptor while checking and reading its bound. */
export const readPluginPackage = Effect.fn("Plugin.readPackage")(function* (directory: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const root = await realpath(directory);
      const dist = join(root, "dist");
      if (
        !(await lstat(root)).isDirectory() ||
        !(await lstat(dist)).isDirectory() ||
        (await lstat(dist)).isSymbolicLink()
      )
        throw new Error("Invalid plugin directory");
      const read = async (relative: string, limit: number) => {
        const path = join(root, relative);
        const before = await lstat(path);
        const canonical = await realpath(path);
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          !canonical.startsWith(`${root}${sep}`) ||
          canonical !== resolve(path)
        )
          throw new Error("Plugin package paths must be regular files inside the package");
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.ino !== before.ino ||
            stat.dev !== before.dev ||
            stat.size > limit
          )
            throw new Error("Plugin package changed or exceeds its size limit");
          const buffer = Buffer.alloc(limit + 1);
          let length = 0;
          while (length <= limit) {
            const { bytesRead } = await file.read(buffer, length, limit + 1 - length, null);
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          if (length > limit) throw new Error("Plugin package exceeds its size limit");
          return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
        } finally {
          await file.close();
        }
      };
      return {
        manifest: await read("hitchhiker.plugin.json", 16 * 1024),
        code: await read("dist/plugin.js", 512 * 1024),
      };
    },
    catch: () =>
      new PluginPackageError({
        message: "Plugin package could not be read as bounded regular files",
      }),
  });
});
