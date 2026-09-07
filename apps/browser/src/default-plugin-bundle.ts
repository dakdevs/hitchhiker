import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  LivePluginManifest,
  PluginCompositionRecipeSchema,
  ServiceBindingSchema,
  type InstalledPluginPlanInput,
} from "@hitchhiker/runtime";
import { Effect, Schema } from "effect";
import type { DefaultPluginBundle } from "./default-plugin-bootstrap.ts";

const ids = [
  "default-tab-model",
  "default-tab-pins",
  "default-browser-layout",
  "default-sidebar-tabs",
  "default-top-tabs",
] as const;
const placements = ["sidebar", "top"] as const;
type Placement = (typeof placements)[number];
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/), Schema.isTrimmed());
const ArtifactIndex = Schema.Struct({
  id: Schema.Literals(ids),
  manifest: Schema.String,
  code: Schema.String,
  manifestSha256: Digest,
  codeSha256: Digest,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const PlanIndex = Schema.Struct({
  composition: Schema.String,
  compositionSha256: Digest,
  services: Schema.String,
  servicesSha256: Digest,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const BundleIndex = Schema.Struct({
  format: Schema.Literal(1),
  artifacts: Schema.Array(ArtifactIndex).check(Schema.isMaxLength(ids.length)),
  plans: Schema.Struct({ sidebar: PlanIndex, top: PlanIndex }).annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
  digest: Digest,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const Services = Schema.Struct({
  bindings: Schema.Array(ServiceBindingSchema).check(Schema.isMaxLength(3)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export class DefaultPluginBundleError extends Schema.TaggedError<DefaultPluginBundleError>()(
  "DefaultPluginBundleError",
  { message: Schema.String },
) {}
const failure = (message: string) => new DefaultPluginBundleError({ message });
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** The packaged controller is in Resources/controller/dist; never search the working directory. */
export const packagedDefaultPluginBundleDirectory = (controllerModule: URL): string =>
  resolve(fileURLToPath(new URL("../../default-plugins/", controllerModule)));

const expectedPlan = (placement: Placement): InstalledPluginPlanInput => {
  const presenter = `default-${placement}-tabs`;
  return {
    enabled: [ids[0], ids[1], ids[2], presenter],
    composition: {
      layout: ids[2],
      slots: ["tabs", "toolbar", "content"].map((key) => ({
        key,
        contributions: [{ pluginId: presenter, id: key }],
      })),
    },
    serviceBindings: [
      { consumer: presenter, dependency: "model", provider: ids[0], service: "model" },
      { consumer: presenter, dependency: "pins", provider: ids[1], service: "pins" },
      { consumer: presenter, dependency: "layout", provider: ids[2], service: "layout" },
    ],
  };
};

const decodeJson = <A>(schema: Schema.Codec<A>, bytes: Uint8Array, label: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    catch: () => failure(`Bundled ${label} is not valid UTF-8 JSON`),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })),
    Effect.mapError(() => failure(`Bundled ${label} is invalid`)),
  );

/**
 * Read a trusted application distribution payload without profile writes or execution.
 * The index checks consistency, not authenticity. Callers must supply an app-owned resource path;
 * downloaded bundles need separate provenance verification before reaching this reader.
 */
export const loadDefaultPluginBundle = Effect.fn("DefaultPluginBundle.load")(function* (
  directory: string,
): Effect.fn.Return<DefaultPluginBundle, DefaultPluginBundleError> {
  if (!isAbsolute(directory)) return yield* failure("Default plugin bundle path must be absolute");
  const root = yield* Effect.tryPromise({
    try: async () => {
      const named = await lstat(resolve(directory));
      if (!named.isDirectory() || named.isSymbolicLink()) throw failure("Invalid bundle directory");
      const path = await realpath(directory);
      const resolved = await lstat(path);
      if (named.dev !== resolved.dev || named.ino !== resolved.ino)
        throw failure("Bundle directory changed");
      return { path, dev: named.dev, ino: named.ino };
    },
    catch: () => failure("Default plugin bundle directory is unavailable or redirected"),
  });
  const directories = new Map<string, { readonly dev: number; readonly ino: number }>();
  directories.set(root.path, root);
  const checkDirectory = async (path: string) => {
    const [named, resolved] = await Promise.all([lstat(path), realpath(path)]);
    if (!named.isDirectory() || named.isSymbolicLink() || resolved !== path)
      throw failure("Default plugin bundle directory is redirected");
    const previous = directories.get(path);
    if (previous && (previous.dev !== named.dev || previous.ino !== named.ino))
      throw failure("Default plugin bundle directory changed");
    directories.set(path, { dev: named.dev, ino: named.ino });
  };
  const read = (relative: string, limit: number) =>
    Effect.tryPromise({
      try: async () => {
        // Only literal inventory paths constructed below reach this helper.
        const path = join(root.path, relative);
        const parent = dirname(path);
        await checkDirectory(root.path);
        if (parent !== root.path) await checkDirectory(parent);
        const named = await lstat(path);
        if (!named.isFile() || named.isSymbolicLink() || named.size > limit)
          throw failure(`Bundled ${relative} must be a bounded regular file`);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await file.stat();
          if (
            !before.isFile() ||
            before.dev !== named.dev ||
            before.ino !== named.ino ||
            before.size !== named.size ||
            before.size > limit
          )
            throw failure(`Bundled ${relative} changed`);
          const bytes = Buffer.alloc(limit + 1);
          let length = 0;
          while (length < bytes.length) {
            const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          const [after, current] = await Promise.all([file.stat(), lstat(path)]);
          if (
            length > limit ||
            length !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs ||
            current.dev !== before.dev ||
            current.ino !== before.ino ||
            !current.isFile() ||
            current.isSymbolicLink()
          )
            throw failure(`Bundled ${relative} changed while reading`);
          await checkDirectory(root.path);
          if (parent !== root.path) await checkDirectory(parent);
          return bytes.subarray(0, length);
        } finally {
          await file.close();
        }
      },
      catch: (error) =>
        error instanceof DefaultPluginBundleError
          ? error
          : failure(`Could not read bundled ${relative}`),
    });
  const index = yield* decodeJson(BundleIndex, yield* read("bundle.json", 16 * 1024), "index");
  const unsigned = { format: index.format, artifacts: index.artifacts, plans: index.plans };
  if (sha256(JSON.stringify(unsigned)) !== index.digest || index.artifacts.length !== ids.length)
    return yield* failure("Default plugin bundle index digest or inventory is invalid");
  for (const [position, id] of ids.entries()) {
    const item = index.artifacts[position];
    if (
      item.id !== id ||
      item.manifest !== `${id}/hitchhiker.plugin.json` ||
      item.code !== `${id}/plugin.js`
    )
      return yield* failure("Default plugin bundle index paths are invalid");
  }
  for (const placement of placements) {
    const item = index.plans[placement];
    if (
      item.composition !== `${placement}/composition.json` ||
      item.services !== `${placement}/services.json`
    )
      return yield* failure("Default plugin bundle index paths are invalid");
  }
  const packages: DefaultPluginBundle["packages"][number][] = [];
  for (const [position, id] of ids.entries()) {
    const item = index.artifacts[position];
    const manifestBytes = yield* read(`${id}/hitchhiker.plugin.json`, 16 * 1024);
    const codeBytes = yield* read(`${id}/plugin.js`, 512 * 1024);
    if (sha256(manifestBytes) !== item.manifestSha256 || sha256(codeBytes) !== item.codeSha256)
      return yield* failure(`Bundled ${id} hash mismatch`);
    const manifest = yield* decodeJson(LivePluginManifest, manifestBytes, `${id} manifest`);
    if (manifest.id !== id) return yield* failure(`Bundled ${id} manifest identity mismatch`);
    const code = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(codeBytes),
      catch: () => failure(`Bundled ${id} code is not valid UTF-8`),
    });
    packages.push({ manifest, code });
  }
  const loadPlan = Effect.fn("DefaultPluginBundle.plan")(function* (placement: Placement) {
    const item = index.plans[placement];
    const compositionBytes = yield* read(`${placement}/composition.json`, 16 * 1024);
    const servicesBytes = yield* read(`${placement}/services.json`, 16 * 1024);
    if (
      sha256(compositionBytes) !== item.compositionSha256 ||
      sha256(servicesBytes) !== item.servicesSha256
    )
      return yield* failure(`Bundled ${placement} recipe hash mismatch`);
    const composition = yield* decodeJson(
      PluginCompositionRecipeSchema,
      compositionBytes,
      "composition",
    );
    const services = yield* decodeJson(Services, servicesBytes, "services");
    const expected = expectedPlan(placement);
    const plan = { enabled: expected.enabled, composition, serviceBindings: services.bindings };
    if (!isDeepStrictEqual(plan, expected))
      return yield* failure(`Bundled ${placement} recipe does not match the default plan`);
    return plan;
  });
  const sidebar = yield* loadPlan("sidebar");
  const top = yield* loadPlan("top");
  // Detect an index replacement while its referenced payload was being read.
  const finalIndex = yield* decodeJson(BundleIndex, yield* read("bundle.json", 16 * 1024), "index");
  if (!isDeepStrictEqual(finalIndex, index))
    return yield* failure("Default plugin bundle index changed");
  return { packages, plans: { sidebar, top } };
});
