import { Effect, Scope } from "effect";
import type { GrantStoreApi } from "./grants.ts";
import type { LivePluginManifest } from "./plugin-dispatch.ts";
import {
  makeScopedDomSession,
  ScopedDomError,
  type ScopedDomDriver,
  type ScopedDomSession,
} from "./scoped-dom.ts";

export interface PluginDomOptions {
  readonly manifest: LivePluginManifest;
  readonly profileId: string;
  readonly token: string;
  readonly grants: GrantStoreApi;
  /** Shared trusted driver; each activation receives a separate finite reference namespace. */
  readonly driver?: ScopedDomDriver;
}

const declaresDom = (manifest: LivePluginManifest) =>
  manifest.capabilities.includes("pages.read") ||
  manifest.capabilities.includes("pages.write") ||
  manifest.capabilities.includes("browser.full-control");

/**
 * Creates the only DOM session a live plugin may use. The driver is shared by the host, while
 * references, invalidation subscription, and authorization callback are scoped to this activation.
 */
export const makePluginDomSession = Effect.fn("makePluginDomSession")(function* (
  options: PluginDomOptions,
): Effect.fn.Return<ScopedDomSession | undefined, never, Scope.Scope> {
  if (options.driver === undefined || !declaresDom(options.manifest)) return undefined;
  return yield* makeScopedDomSession({
    driver: options.driver,
    authorize: (capability, origin) =>
      Effect.gen(function* () {
        if (
          !options.manifest.capabilities.includes(capability) &&
          !options.manifest.capabilities.includes("browser.full-control")
        )
          return yield* new ScopedDomError({
            code: "not_authorized",
            message: "The plugin did not declare this DOM capability.",
          });
        const grant = yield* options.grants
          .authorize(options.token, { profileId: options.profileId, capability, origin })
          .pipe(
            Effect.mapError(
              () =>
                new ScopedDomError({
                  code: "not_authorized",
                  message: "The plugin is not authorized for this page origin.",
                }),
            ),
          );
        if (grant.principal !== options.manifest.id)
          return yield* new ScopedDomError({
            code: "not_authorized",
            message: "The plugin identity is not authorized for this page origin.",
          });
      }),
  });
});
