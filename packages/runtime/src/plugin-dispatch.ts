import type { BrowserConfiguration, Capability } from "@hitchhiker/core";
import { Effect, Schema } from "effect";
import type { GrantStoreApi } from "./grants.ts";
import type { McpBrowserApi } from "./mcp.ts";
import { ServiceProviderSchema, ServiceRequirementSchema } from "./service-contracts.ts";
import { PageWatchRequestSchema, type PageWatchSubscription } from "./page-observations.ts";
import { EngineError } from "./engine.ts";
import { PluginStorageError, type PluginStorageAdapter } from "./plugin-storage.ts";

export const LivePluginManifest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,62}$/)),
  version: Schema.String.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  ),
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/),
  ),
  capabilities: Schema.Array(
    Schema.Literals([
      "pages.list",
      "pages.manage",
      "pages.read",
      "pages.write",
      "ui.compose",
      "configuration.write",
      "storage.local",
      "plugins.install",
      "browser.full-control",
      "cdp.connect",
    ]),
  ).check(Schema.isMaxLength(16)),
  provides: Schema.optional(Schema.Array(ServiceProviderSchema).check(Schema.isMaxLength(8))),
  requires: Schema.optional(Schema.Array(ServiceRequirementSchema).check(Schema.isMaxLength(8))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LivePluginManifest = typeof LivePluginManifest.Type;
export class PluginCallError extends Schema.TaggedError<PluginCallError>()("PluginCallError", {
  code: Schema.Literals(["conflict", "denied", "stale-snapshot"]),
  message: Schema.String,
}) {}
const denied = () =>
  new PluginCallError({
    code: "denied",
    message: "Plugin operation is not authorized or supported",
  });
const storageError = (error: unknown) =>
  error instanceof PluginStorageError && error.code === "conflict"
    ? new PluginCallError({ code: "conflict", message: "Plugin storage revision changed" })
    : denied();
const pageWatchError = (error: unknown) =>
  error instanceof EngineError && error.code === "page-watch-stale"
    ? new PluginCallError({
        code: "stale-snapshot",
        message: "Page snapshot changed; restart from offset zero",
      })
    : denied();
const PageId = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/));
const Url = Schema.String.check(Schema.isMaxLength(8192));
const ContributionId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/));
/** Plugin callers may supply only portable tree data; composition identity and placement are host-owned. */
const PublicSurface = Schema.Struct({
  root: Schema.Unknown,
  bindings: Schema.Array(Schema.Struct({ viewportId: Schema.String, pageId: Schema.String })),
});
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
  readonly pageWatch?: PageWatchSubscription["watch"];
  readonly storage?: PluginStorageAdapter;
  /** Trusted owner-bound broker adapter; service callers never select identities or grants. */
  readonly services?: {
    readonly publish: (
      service: string,
      value: Schema.Json,
    ) => Effect.Effect<{ readonly revision: number }, unknown>;
    readonly get: (dependency: string) => Effect.Effect<Schema.Json, unknown>;
    readonly subscribe: (dependency: string) => Effect.Effect<Schema.Json, unknown>;
    readonly call: (
      dependency: string,
      method: string,
      params: Schema.Json,
    ) => Effect.Effect<Schema.Json, unknown>;
    readonly respond: (
      response:
        | { readonly callId: string; readonly result: Schema.Json }
        | { readonly callId: string; readonly error: string },
    ) => Effect.Effect<void, unknown>;
  };
  /** When present, plugins may publish only their host-declared layout or contributions. */
  readonly composition?: {
    readonly publishLayout: (surface: unknown) => Effect.Effect<number, unknown>;
    readonly publishContribution: (id: string, surface: unknown) => Effect.Effect<number, unknown>;
    readonly withdrawContribution: (id: string) => Effect.Effect<number, unknown>;
  };
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
      case "storage.read": {
        yield* authorize("storage.local");
        yield* decode(Schema.Record(Schema.String, Schema.Never), params);
        if (!options.storage) return yield* denied();
        return yield* options.storage.read().pipe(
          Effect.mapError(storageError),
          Effect.flatMap((snapshot) => decode(Schema.Json, snapshot)),
        );
      }
      case "storage.write": {
        yield* authorize("storage.local");
        const { expectedRevision, value } = yield* decode(
          Schema.Struct({
            expectedRevision: Schema.Int.check(
              Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
            ),
            value: Schema.Json,
          }),
          params,
        );
        if (!options.storage) return yield* denied();
        return yield* options.storage.write(expectedRevision, value).pipe(
          Effect.mapError(storageError),
          Effect.flatMap((result) => decode(Schema.Json, result)),
        );
      }
      case "pages.watch": {
        yield* authorize("pages.list");
        const request = yield* decode(PageWatchRequestSchema, params);
        if (!options.pageWatch) return yield* denied();
        return yield* options.pageWatch(request).pipe(
          Effect.mapError(pageWatchError),
          Effect.flatMap((snapshot) => decode(Schema.Json, snapshot)),
        );
      }
      case "pages.back":
      case "pages.forward":
      case "pages.reload":
      case "pages.stop": {
        yield* authorize("pages.manage");
        const { pageId } = yield* decode(Schema.Struct({ pageId: PageId }), params);
        if (!options.browser.history) return yield* denied();
        const action = method.slice(6) as "back" | "forward" | "reload" | "stop";
        yield* options.browser.history(pageId, action).pipe(Effect.mapError(denied));
        return null;
      }
      case "services.publish":
      case "services.get":
      case "services.subscribe":
      case "services.call":
      case "services.respond": {
        const services = options.services;
        if (!services) return yield* denied();
        const grant = yield* options.grants
          .authenticate(options.token, { profileId: options.profileId })
          .pipe(Effect.mapError(denied));
        if (grant.principal !== options.manifest.id) return yield* denied();
        if (method === "services.publish") {
          const { service, value } = yield* decode(
            Schema.Struct({ service: ContributionId, value: Schema.Json }),
            params,
          );
          if (!options.manifest.provides?.some((item) => item.id === service))
            return yield* denied();
          return yield* services.publish(service, value).pipe(Effect.mapError(denied));
        }
        if (method === "services.respond") {
          const callId = Schema.String.check(Schema.isMaxLength(64), Schema.isMinLength(1));
          const response = yield* decode(
            Schema.Union([
              Schema.Struct({ callId, result: Schema.Json }),
              Schema.Struct({ callId, error: Schema.String.check(Schema.isMaxLength(256)) }),
            ]),
            params,
          );
          yield* services.respond(response).pipe(Effect.mapError(denied));
          return null;
        }
        if (method === "services.call") {
          const input = yield* decode(
            Schema.Struct({
              dependency: ContributionId,
              method: Schema.String.check(
                Schema.isMaxLength(128),
                Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]*$/),
              ),
              params: Schema.Json,
            }),
            params,
          );
          if (!options.manifest.requires?.some((item) => item.id === input.dependency))
            return yield* denied();
          return yield* services
            .call(input.dependency, input.method, input.params)
            .pipe(Effect.mapError(denied));
        }
        const { dependency } = yield* decode(Schema.Struct({ dependency: ContributionId }), params);
        if (!options.manifest.requires?.some((item) => item.id === dependency))
          return yield* denied();
        return yield* (
          method === "services.get" ? services.get(dependency) : services.subscribe(dependency)
        ).pipe(Effect.mapError(denied));
      }
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
        if (options.composition) return yield* denied();
        const { surface } = yield* decode(Schema.Struct({ surface: Schema.Unknown }), params);
        return { revision: yield* options.publish(surface).pipe(Effect.mapError(denied)) };
      }
      case "ui.publishLayout": {
        yield* authorize("ui.compose");
        if (!options.composition) return yield* denied();
        const { surface } = yield* decode(Schema.Struct({ surface: PublicSurface }), params);
        return {
          revision: yield* options.composition.publishLayout(surface).pipe(Effect.mapError(denied)),
        };
      }
      case "ui.publishContribution": {
        yield* authorize("ui.compose");
        if (!options.composition) return yield* denied();
        const { id, surface } = yield* decode(
          Schema.Struct({ id: ContributionId, surface: PublicSurface }),
          params,
        );
        return {
          revision: yield* options.composition
            .publishContribution(id, surface)
            .pipe(Effect.mapError(denied)),
        };
      }
      case "ui.withdrawContribution": {
        yield* authorize("ui.compose");
        if (!options.composition) return yield* denied();
        const { id } = yield* decode(Schema.Struct({ id: ContributionId }), params);
        return {
          revision: yield* options.composition
            .withdrawContribution(id)
            .pipe(Effect.mapError(denied)),
        };
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
