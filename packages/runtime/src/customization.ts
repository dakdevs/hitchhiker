import { parseConfiguration, type BrowserConfiguration } from "@hitchhiker/core";
import { Effect, Schema } from "effect";
import {
  LivePluginManifest,
  type LivePluginManifest as PluginManifest,
} from "./plugin-dispatch.ts";

const InputLimit = 131_072;
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Interface = Schema.Struct({
  tabPlacement: Schema.Literals(["sidebar", "top"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const Plugin = Schema.Struct({
  manifest: LivePluginManifest,
  hash: Hash,
  enabled: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const RecipeWire = Schema.Struct({
  version: Schema.Literal(1),
  configuration: Schema.Unknown,
  interface: Interface,
  plugins: Schema.Array(Plugin).check(Schema.isMaxLength(64)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export interface PortableSettings {
  readonly configuration: BrowserConfiguration;
  readonly interface: { readonly tabPlacement: "sidebar" | "top" };
}
export interface CustomizationRecipe extends PortableSettings {
  readonly version: 1;
  readonly plugins: readonly {
    readonly manifest: PluginManifest;
    readonly hash: string;
    readonly enabled: boolean;
  }[];
}
export class CustomizationError extends Schema.TaggedError<CustomizationError>()(
  "CustomizationError",
  { message: Schema.String },
) {}
const failure = (message: string) => new CustomizationError({ message });
const projectManifest = (manifest: PluginManifest) => ({
  id: manifest.id,
  version: manifest.version,
  name: manifest.name,
  capabilities: [...manifest.capabilities],
  ...(manifest.provides === undefined
    ? {}
    : {
        provides: manifest.provides.map(({ id, contract }) => ({
          id,
          contract: { name: contract.name, version: contract.version, digest: contract.digest },
        })),
      }),
  ...(manifest.requires === undefined
    ? {}
    : {
        requires: manifest.requires.map(({ id, contract, optional }) => ({
          id,
          contract: { name: contract.name, version: contract.version, digest: contract.digest },
          optional,
        })),
      }),
});

const canonicalize = (
  value: typeof RecipeWire.Type,
): Effect.Effect<CustomizationRecipe, CustomizationError> =>
  Effect.gen(function* () {
    const configuration = parseConfiguration(value.configuration);
    if (!configuration.ok) return yield* failure("Customization configuration is invalid");
    if (new Set(value.plugins.map((plugin) => plugin.manifest.id)).size !== value.plugins.length)
      return yield* failure("Customization plugins must have unique IDs");
    const recipe = {
      version: 1,
      configuration: configuration.value,
      interface: { tabPlacement: value.interface.tabPlacement },
      plugins: value.plugins
        .map((plugin) => ({
          manifest: projectManifest(plugin.manifest),
          hash: plugin.hash,
          enabled: plugin.enabled,
        }))
        .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)),
    } satisfies CustomizationRecipe;
    if (Buffer.byteLength(JSON.stringify(recipe), "utf8") > InputLimit)
      return yield* failure("Customization recipe exceeds 131072 UTF-8 bytes");
    return recipe;
  });

export const decodeCustomizationRecipe = (value: unknown) =>
  Schema.decodeUnknownEffect(RecipeWire, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => failure("Customization recipe is invalid")),
    Effect.flatMap(canonicalize),
  );

export const importCustomizationRecipe = (serialized: string) =>
  Effect.gen(function* () {
    if (Buffer.byteLength(serialized, "utf8") > InputLimit)
      return yield* failure("Customization recipe exceeds 131072 UTF-8 bytes");
    const value = yield* Effect.try({
      try: () => JSON.parse(serialized),
      catch: () => failure("Customization recipe is not valid JSON"),
    });
    return yield* decodeCustomizationRecipe(value);
  });

export const exportCustomizationRecipe = (value: CustomizationRecipe) =>
  decodeCustomizationRecipe({
    version: value.version,
    configuration: {
      colorScheme: value.configuration.colorScheme,
      sleepAfterMs: value.configuration.sleepAfterMs,
      alwaysAwakeOrigins: value.configuration.alwaysAwakeOrigins,
    },
    interface: { tabPlacement: value.interface.tabPlacement },
    plugins: value.plugins.map((plugin) => ({
      manifest: projectManifest(plugin.manifest),
      hash: plugin.hash,
      enabled: plugin.enabled,
    })),
  }).pipe(Effect.map((recipe) => JSON.stringify(recipe)));
