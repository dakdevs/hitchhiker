import type { BrowserConfiguration, Capability } from "@hitchhiker/core";
import { Effect, Schema } from "effect";
import type { GrantStoreApi } from "./grants.ts";
import type { McpBrowserApi } from "./mcp.ts";

export const LivePluginManifest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,62}$/)),
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  capabilities: Schema.Array(
    Schema.Literals([
      "pages.list",
      "pages.manage",
      "pages.read",
      "pages.write",
      "ui.compose",
      "configuration.write",
      "plugins.install",
      "browser.full-control",
      "cdp.connect",
    ]),
  ).check(Schema.isMaxLength(16)),
});
export type LivePluginManifest = typeof LivePluginManifest.Type;
export class PluginCallError extends Schema.TaggedError<PluginCallError>()("PluginCallError", {
  message: Schema.String,
}) {}
const denied = () =>
  new PluginCallError({ message: "Plugin operation is not authorized or supported" });
const PageId = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/));
const Url = Schema.String.check(Schema.isMaxLength(8192));
const Configuration: Schema.Codec<BrowserConfiguration> = Schema.Struct({
  colorScheme: Schema.Literals(["light", "dark", "system"]),
  sleepAfterMs: Schema.Int,
  alwaysAwakeOrigins: Schema.Array(Schema.String),
});
const decode = <A>(schema: Schema.Codec<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(denied),
  );
export interface PluginDispatchOptions {
  readonly manifest: LivePluginManifest;
  readonly profileId: string;
  readonly token: string;
  readonly grants: GrantStoreApi;
  readonly browser: McpBrowserApi;
  readonly publish: (surface: unknown) => Effect.Effect<number, unknown>;
  readonly release: Effect.Effect<void, unknown>;
}

/** Capability declaration and durable grant are both required. There is no generic bridge escape. */
export const createPluginDispatcher = (options: PluginDispatchOptions) =>
  Effect.fn("Plugin.dispatch")(function* (
    method: string,
    params: unknown,
  ): Effect.fn.Return<Schema.Json, PluginCallError> {
    const authorize = Effect.fn("Plugin.authorize")(function* (capability: Capability) {
      if (
        !options.manifest.capabilities.includes(capability) &&
        !options.manifest.capabilities.includes("browser.full-control")
      )
        return yield* denied();
      const grant = yield* options.grants
        .authorize(options.token, { profileId: options.profileId, capability })
        .pipe(Effect.mapError(denied));
      if (grant.principal !== options.manifest.id) return yield* denied();
    });
    switch (method) {
      case "pages.list": {
        yield* authorize("pages.list");
        yield* decode(Schema.Record(Schema.String, Schema.Never), params);
        return yield* options.browser.pages.pipe(
          Effect.flatMap((pages) => decode(Schema.Json, pages)),
        );
      }
      case "pages.open": {
        yield* authorize("pages.manage");
        const { url } = yield* decode(Schema.Struct({ url: Url }), params);
        return { pageId: yield* options.browser.open(url).pipe(Effect.mapError(denied)) };
      }
      case "pages.navigate": {
        yield* authorize("pages.manage");
        const { pageId, url } = yield* decode(Schema.Struct({ pageId: PageId, url: Url }), params);
        yield* options.browser.navigate(pageId, url).pipe(Effect.mapError(denied));
        return null;
      }
      case "pages.close": {
        yield* authorize("pages.manage");
        const { pageId } = yield* decode(Schema.Struct({ pageId: PageId }), params);
        yield* options.browser.close(pageId).pipe(Effect.mapError(denied));
        return null;
      }
      case "configuration.get": {
        yield* authorize("configuration.write");
        return yield* options.browser.configuration.pipe(
          Effect.flatMap((configuration) => decode(Schema.Json, configuration)),
        );
      }
      case "configuration.set": {
        yield* authorize("configuration.write");
        const { configuration } = yield* decode(
          Schema.Struct({ configuration: Configuration }),
          params,
        );
        yield* options.browser.configure(configuration).pipe(Effect.mapError(denied));
        return null;
      }
      case "ui.publish": {
        yield* authorize("ui.compose");
        const { surface } = yield* decode(Schema.Struct({ surface: Schema.Unknown }), params);
        return { revision: yield* options.publish(surface).pipe(Effect.mapError(denied)) };
      }
      case "ui.release": {
        yield* authorize("ui.compose");
        yield* options.release.pipe(Effect.mapError(denied));
        return null;
      }
      default:
        return yield* denied();
    }
  });
