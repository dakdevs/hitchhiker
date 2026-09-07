import type { BrowserPage, BrowserState, ObservedPage } from "@hitchhiker/core";
import {
  defaultConfiguration,
  normalizeWebUrl,
  openPage,
  parseConfiguration,
  type BrowserConfiguration,
} from "@hitchhiker/core";
import {
  createDefaultInterface,
  reconcileInterface,
  renderDefaultSurface,
  type DefaultInterfaceConfiguration,
  type DefaultInterfaceState,
} from "@hitchhiker/default-interface";
import {
  activatePage,
  decodePageLifecycleEvent,
  decodePageResourceEvent,
  decodeCustomizationRecipe,
  EngineConnection,
  EngineError,
  freezePage,
  NativeSurface,
  makePageObservations,
  rememberPageResources,
  selectPageFreezes,
  type PageResourceKnowledge,
  type PortableSettings,
  type SurfaceEvent,
  type PageWatchSubscription,
} from "@hitchhiker/runtime";
import {
  button,
  column,
  design,
  dragRegion,
  reduceNativeTextInput,
  row,
  scroll,
  text,
  windowChrome,
  windowControls,
  type NativeTextInputEvent,
  type NativeTextInputState,
  type Surface,
} from "@hitchhiker/ui";
import { Deferred, Effect, Option, PubSub, Schema, Semaphore, Stream, Scope } from "effect";
import { createDevToolsController, type DevToolsController } from "./devtools.ts";
import type { ProfileWriteLease } from "./profile-write-lease.ts";
import {
  extensionPermissionPages,
  renderExtensionControls,
  type BrowserExtensionControls,
  type ExtensionControlsState,
} from "./extension-controls.ts";
import {
  legacyBootstrapSeedOf,
  loadBrowserPersistence,
  saveBrowserPersistence,
  type BrowserPersistence,
  type LegacyBootstrapSeed,
} from "./persistence.ts";

const ProfileId = "default";
const InitialBrowser: BrowserState = Object.freeze({
  pages: Object.freeze([]),
  viewports: Object.freeze([]),
});
const InitialInput: NativeTextInputState = Object.freeze({
  text: "",
  anchor: 0,
  focus: 0,
  composition: null,
});

const Press = Schema.Struct({ action: Schema.String });
const Input = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("insert_text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literals([
      "delete_backward",
      "delete_forward",
      "delete_word_backward",
      "delete_word_forward",
      "delete_to_start",
      "delete_to_line_start",
      "clear",
      "commit_composition",
      "cancel_composition",
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("move_caret"),
    direction: Schema.Literals(["previous", "next", "previous_word", "next_word", "start", "end"]),
    extend: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("set_selection"),
    anchor: Schema.Number,
    focus: Schema.Number,
    affinity: Schema.Literals(["upstream", "downstream"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("set_composition"),
    text: Schema.String,
    cursor: Schema.Union([Schema.Number, Schema.Null]),
  }),
]);
const decodePress = Schema.decodeUnknownOption(Press, { onExcessProperty: "error" });
const decodeInput = Schema.decodeUnknownOption(Input, { onExcessProperty: "error" });

type PageMetadata = { readonly id: string; readonly url: string; readonly title: string };
type PageBrowserState = {
  readonly generation: number;
  readonly available: boolean;
  readonly committed: boolean;
  readonly loading: boolean;
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
};
type Screen = "browser" | "settings" | "plugins" | "extensions";

const UnknownProtections = Object.freeze({
  audio: true,
  call: true,
  download: true,
  unsavedInput: true,
});

interface ControllerState {
  browser: BrowserState;
  interfaceMode: "legacy" | "plugins";
  interfaceState: DefaultInterfaceState;
  interfaceConfiguration: DefaultInterfaceConfiguration;
  tabsVisible?: boolean;
  configuration: BrowserConfiguration;
  input: NativeTextInputState;
  inputDirty: boolean;
  pageOffset: number;
  newPage: boolean;
  screen: Screen;
  opening: ReadonlyMap<string, PageMetadata>;
}

export interface BrowserPluginSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly capabilities?: readonly string[];
  readonly previousVersion?: string;
  readonly lastFailure?: string;
}
export type PluginManagementAction = "enable" | "disable" | "rollback" | "uninstall";
/** A complete, presentation-neutral inventory for default-plugin state migration. */
export interface RestoredPageInventory {
  readonly pageIds: readonly string[];
  readonly pageOrder: readonly string[];
}

export interface BrowserController {
  readonly interfaceMode: "legacy" | "plugins";
  readonly devtools: DevToolsController;
  readonly start: Effect.Effect<void, EngineError>;
  /** Initial page creation events, persistence, and rendering have settled. */
  readonly restored: Effect.Effect<void, EngineError>;
  /** Waits for restoration, then returns only fully live pages in controller order. */
  readonly restoredPageInventory: Effect.Effect<RestoredPageInventory, EngineError>;
  /** Removes the frozen V1 UI seed after bootstrap is durably completed or abandoned. */
  readonly retireLegacyBootstrapSeed: () => Effect.Effect<void, EngineError>;
  readonly dispatch: (action: string) => Effect.Effect<void, EngineError>;
  readonly snapshot: Effect.Effect<BrowserState>;
  readonly observePages: (
    owner: string,
  ) => Effect.Effect<PageWatchSubscription, EngineError, Scope.Scope>;
  /** Trusted broker entrypoints; plugins and MCP never receive EngineConnection. */
  readonly openPage: (url: string) => Effect.Effect<string, EngineError>;
  readonly navigatePage: (pageId: string, url: string) => Effect.Effect<void, EngineError>;
  readonly closePage: (pageId: string) => Effect.Effect<void, EngineError>;
  readonly pageHistory: (
    pageId: string,
    action: "back" | "forward" | "reload" | "stop",
  ) => Effect.Effect<void, EngineError>;
  /** Records a conservative native-write lease before a scoped DOM mutation. */
  readonly protectDomWrite: (pageId: string) => Effect.Effect<void, EngineError>;
  readonly configure: (configuration: BrowserConfiguration) => Effect.Effect<void, EngineError>;
  readonly configuration: Effect.Effect<BrowserConfiguration>;
  readonly portableSettings: Effect.Effect<PortableSettings>;
  readonly applyPortableSettings: (settings: PortableSettings) => Effect.Effect<void, EngineError>;
  readonly updatePluginControls: (
    plugins: readonly BrowserPluginSummary[],
    action: (operation: PluginManagementAction, id: string) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<void, EngineError>;
  /** Surfaces errors from controller event fibers instead of silently dropping them. */
  readonly publishPluginSurface: (
    owner: string,
    surface: unknown,
  ) => Effect.Effect<number, EngineError>;
  readonly recoverPluginSurface: (owner: string) => Effect.Effect<number, EngineError>;
  readonly registerPluginEventHandler: (
    owner: string,
    handler: (event: SurfaceEvent) => Effect.Effect<void, EngineError>,
  ) => Effect.Effect<void, EngineError, Scope.Scope>;
  readonly releasePluginSurface: (owner: string) => Effect.Effect<void, EngineError>;
  readonly pluginEvents: (
    owner: string,
  ) => Stream.Stream<{ readonly event: string; readonly payload: unknown }>;
  readonly lastError: Effect.Effect<string | undefined>;
}
export interface BrowserControllerOptions {
  readonly freezeEnabled?: boolean;
  readonly onDevToolsFailure?: Effect.Effect<void>;
  /** Plugin mode retains browser state but exposes only a trusted recovery surface until composed UI arrives. */
  readonly interfaceMode?: "legacy" | "plugins";
  /** A single predecoded load owned by startup orchestration; skips controller disk I/O. */
  readonly initialPersistence?: { readonly value: BrowserPersistence | undefined };
  readonly extensions?: BrowserExtensionControls;
  readonly profileLease?: ProfileWriteLease;
}

const now = () => Date.now();
const pageId = () => `p${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

const asPersistence = (
  state: ControllerState,
  format?: 2,
  legacyBootstrapSeed?: LegacyBootstrapSeed,
): BrowserPersistence => {
  const pages = state.browser.pages
    .filter((page) => page.lifecycle !== "closed")
    .map((page) => ({ id: page.id, url: page.url, title: page.title }));
  const livePageIds = new Set(pages.map((page) => page.id));
  return {
    configuration: state.configuration,
    interfaceConfiguration: state.interfaceConfiguration,
    interfaceState: state.interfaceState,
    pages: [
      ...pages,
      ...[...state.opening.values()]
        .filter((page) => !livePageIds.has(page.id))
        .map((page) => ({ id: page.id, url: page.url, title: page.title })),
    ],
    ...(format === undefined ? {} : { format }),
    ...(legacyBootstrapSeed === undefined ? {} : { legacyBootstrapSeed }),
  };
};

const selected = (state: ControllerState) =>
  state.browser.pages.find(
    (page) => page.id === state.interfaceState.selectedPageId && page.lifecycle !== "closed",
  );

const replacePage = (
  browser: BrowserState,
  pageId: string,
  update: Partial<BrowserPage>,
): BrowserState =>
  Object.freeze({
    ...browser,
    pages: Object.freeze(
      browser.pages.map((page) =>
        page.id === pageId ? Object.freeze({ ...page, ...update }) : page,
      ),
    ),
  });

const renderSettings = (state: ControllerState): Surface =>
  Object.freeze({
    root: column(
      "settings",
      [
        text("settings-title", "Settings", { fontSize: 18 }),
        text("settings-placement", `Tabs: ${state.interfaceConfiguration.tabPlacement}`),
        row(
          "settings-tabs",
          [
            button("settings-sidebar", "Sidebar tabs", "settings.tabs.sidebar"),
            button("settings-top", "Top tabs", "settings.tabs.top"),
          ],
          { gap: 8 },
        ),
        text("settings-color", `Appearance: ${state.configuration.colorScheme}`),
        row(
          "settings-color-actions",
          [
            button("settings-light", "Light", "settings.color.light"),
            button("settings-dark", "Dark", "settings.color.dark"),
            button("settings-system", "System", "settings.color.system"),
          ],
          { gap: 8 },
        ),
        text(
          "settings-sleep",
          `Sleep after: ${state.configuration.sleepAfterMs / 1000}s (reversible freezing; pages stay in memory)`,
        ),
        row(
          "settings-sleep-actions",
          [
            button("settings-sleep-60", "60 seconds", "settings.sleep.60"),
            button("settings-sleep-300", "5 minutes", "settings.sleep.300"),
          ],
          { gap: 8 },
        ),
        button("settings-extensions", "Chrome extensions", "interface.extensions"),
        button("settings-back", "Back", "screen.browser"),
      ],
      { padding: 20, gap: 12, flex: 1 },
    ),
    bindings: Object.freeze([]),
  });

const renderPlugins = (plugins: readonly BrowserPluginSummary[], status?: string): Surface =>
  Object.freeze({
    root: scroll(
      "plugins",
      [
        text("plugins-title", "Plugins", { fontSize: 18 }),
        ...(status ? [text("plugins-status", status)] : []),
        text("plugins-copy", "Plugins run in an isolated native host with revocable permissions."),
        text(
          "plugins-installation",
          "Install compiled plugins through an authorized MCP connection, or use --plugin for development.",
        ),
        ...plugins.flatMap((plugin) => [
          text(`plugin-${plugin.id}-name`, `${plugin.name} · ${plugin.version}`, { fontSize: 15 }),
          text(
            `plugin-${plugin.id}-state`,
            plugin.running ? "Running" : plugin.enabled ? "Enabled" : "Disabled",
          ),
          ...(plugin.capabilities
            ? [
                text(
                  `plugin-${plugin.id}-permissions`,
                  `Permissions: ${plugin.capabilities.join(", ") || "none"}`,
                ),
              ]
            : []),
          ...(plugin.lastFailure
            ? [
                text(
                  `plugin-${plugin.id}-failure`,
                  Array.from(plugin.lastFailure).slice(0, 120).join(""),
                ),
              ]
            : []),
          row(
            `plugin-${plugin.id}-actions`,
            [
              button(
                `plugin-${plugin.id}-toggle`,
                plugin.enabled ? "Disable" : "Enable",
                `plugins.${plugin.enabled ? "disable" : "enable"}.${plugin.id}`,
              ),
              ...(plugin.previousVersion
                ? [
                    button(
                      `plugin-${plugin.id}-rollback`,
                      `Restore ${plugin.previousVersion}`,
                      `plugins.rollback.${plugin.id}`,
                    ),
                  ]
                : []),
              button(`plugin-${plugin.id}-uninstall`, "Remove", `plugins.uninstall.${plugin.id}`),
            ],
            { gap: 8 },
          ),
        ]),
        button("plugins-back", "Back", "screen.browser"),
      ],
      { padding: 20, gap: 12, flex: 1 },
    ),
    bindings: Object.freeze([]),
  });

const render = (
  state: ControllerState,
  plugins: readonly BrowserPluginSummary[] = [],
  pluginStatus?: string,
  extensions?: ExtensionControlsState,
): Surface => {
  const header = (surface: Surface): Surface => ({
    ...surface,
    root: column(
      "trusted-screen",
      [
        row(
          "window-header",
          [
            windowControls("window-controls"),
            dragRegion("window-drag-region", { flex: 1, height: windowChrome.height }),
          ],
          {
            height: windowChrome.height,
            bg:
              state.configuration.colorScheme === "dark" ? design.dark.canvas : design.light.canvas,
          },
        ),
        surface.root,
      ],
      { flex: 1 },
    ),
  });
  if (state.interfaceMode === "plugins")
    return header({
      root: column(
        "plugin-recovery",
        [
          text("plugin-recovery-title", "Hitchhiker", { fontSize: 18 }),
          text("plugin-recovery-status", "No plugin interface is active."),
        ],
        { padding: 20, gap: 12, flex: 1 },
      ),
      bindings: Object.freeze([]),
    });
  if (state.screen === "extensions" && extensions)
    return header(renderExtensionControls(extensions));
  if (state.screen === "settings") return header(renderSettings(state));
  if (state.screen === "plugins") return header(renderPlugins(plugins, pluginStatus));
  const interfaceState = state.newPage
    ? { ...state.interfaceState, selectedPageId: undefined }
    : state.interfaceState;
  return renderDefaultSurface(state.browser, interfaceState, state.interfaceConfiguration, {
    addressDraft: state.input.text,
    dark: state.configuration.colorScheme === "dark",
    pageOffset: state.pageOffset,
    tabsVisible: state.tabsVisible,
  });
};

export const normalizeAddressDraft = (draft: string) => {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return undefined;
  if (/\s/.test(trimmed) || (!trimmed.includes(".") && !trimmed.includes(":")))
    return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  const normalized = normalizeWebUrl(trimmed);
  return normalized.ok ? normalized.value : undefined;
};

export const makeBrowserController = (
  profileRoot: string,
  options: BrowserControllerOptions = {},
) =>
  Effect.gen(function* () {
    const engine = yield* EngineConnection;
    const surface = yield* NativeSurface;
    const mutex = yield* Semaphore.make(1);
    let state: ControllerState = {
      browser: InitialBrowser,
      interfaceMode: options.interfaceMode ?? "legacy",
      interfaceState: createDefaultInterface(ProfileId),
      interfaceConfiguration: { tabPlacement: "sidebar" },
      configuration: defaultConfiguration,
      input: InitialInput,
      inputDirty: false,
      pageOffset: 0,
      newPage: false,
      screen: "browser",
      opening: new Map(),
    };
    let persistenceFormat: 2 | undefined = options.interfaceMode === "plugins" ? 2 : undefined;
    let legacyBootstrapSeed: LegacyBootstrapSeed | undefined;
    const persistedState = () => asPersistence(state, persistenceFormat, legacyBootstrapSeed);
    let inputCommitScheduled = false;
    let lastError: string | undefined;
    let pluginSummaries: readonly BrowserPluginSummary[] = [];
    let pluginStatus: string | undefined;
    let managingPlugin = false;
    let extensionInput = InitialInput;
    let extensionControls: ExtensionControlsState = {
      entries: [],
      directory: "",
      permissionPage: 0,
      reviewedThrough: 0,
      busy: false,
      readOnly: options.extensions?.readOnly ?? false,
      available: options.extensions !== undefined,
    };
    const controllerScope = yield* Effect.scope;
    let pluginAction:
      | ((operation: PluginManagementAction, id: string) => Effect.Effect<void, unknown>)
      | undefined;
    let restoring = false;
    let restoreRequestsCompleted = false;
    let restorationCompleted = false;
    const restoration = yield* Deferred.make<void, EngineError>();
    yield* Effect.addFinalizer(() =>
      Deferred.fail(
        restoration,
        new EngineError({
          code: "restore-closed",
          message: "Controller closed during restoration",
        }),
      ),
    );
    let closeCancellationGeneration = 0;
    let closingPersistence: BrowserPersistence | undefined;
    let pluginSurface: unknown;
    let pluginBindings: Surface["bindings"] = [];
    let pluginOwner: string | undefined;
    let knownResources: PageResourceKnowledge = new Map();
    const pendingDomWrites = new Set<string>();
    const inspectedPages = new Map<
      string,
      { readonly generation: number; readonly instance: number }
    >();
    let resourceSignalsAvailable = false;
    let pageBrowserGenerationAvailable = false;
    let pageBrowsers = new Map<string, PageBrowserState>();
    const observations = yield* makePageObservations();
    const observedPages = (): readonly ObservedPage[] =>
      state.browser.pages
        .filter((page) => page.lifecycle !== "closed")
        .map((page) => ({
          id: page.id,
          profileId: page.profileId,
          url: page.url,
          title: page.title,
          lifecycle: page.lifecycle,
          protections: page.protections,
          loading: pageBrowsers.get(page.id)?.loading ?? false,
          canGoBack: pageBrowsers.get(page.id)?.canGoBack ?? false,
          canGoForward: pageBrowsers.get(page.id)?.canGoForward ?? false,
        }));
    // Publish after each serialized reduction, including state retained on an operation failure.
    // Usage timestamps are not observed, so a plugin redraw cannot feed back into another redraw.
    const lock = {
      withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        mutex.withPermit(
          effect.pipe(Effect.ensuring(Effect.sync(() => observations.publish(observedPages())))),
        ),
    };
    const completeRestoration = Effect.suspend(() =>
      restorationCompleted
        ? Effect.void
        : mutex.withPermit(
            Effect.gen(function* () {
              if (!restoreRequestsCompleted || restoring) return;
              yield* Deferred.succeed(restoration, undefined);
              restorationCompleted = true;
            }),
          ),
    );
    const pluginEventHandlers = new Map<
      string,
      (event: SurfaceEvent) => Effect.Effect<void, EngineError>
    >();
    const pluginEvents = yield* PubSub.bounded<{
      readonly owner: string;
      readonly event: string;
      readonly payload: unknown;
    }>({ capacity: 32 });
    yield* Effect.addFinalizer(() => PubSub.shutdown(pluginEvents));

    const persist = Effect.fn("BrowserController.persist")(function* () {
      const write = saveBrowserPersistence(profileRoot, closingPersistence ?? persistedState());
      return yield* (options.profileLease ? options.profileLease.withWrite(write) : write).pipe(
        Effect.mapError(
          (error) => new EngineError({ code: "persistence", message: error.message }),
        ),
      );
    });
    const applySurface = Effect.fn("BrowserController.applySurface")(function* (
      next: unknown,
      bindings: Surface["bindings"],
    ) {
      const shown = new Set(bindings.map((binding) => binding.pageId));
      for (const page of state.browser.pages) {
        if (!shown.has(page.id) || page.lifecycle !== "sleeping") continue;
        yield* activatePage(engine, page.id);
        state = {
          ...state,
          browser: replacePage(state.browser, page.id, { lifecycle: "loaded", lastUsedAt: now() }),
        };
      }
      const revision = yield* surface
        .commit(next)
        .pipe(
          Effect.mapError((error) =>
            error.code === "-32003"
              ? new EngineError({ code: "window-closing", message: error.message })
              : error,
          ),
        );
      const wasShown = new Set(state.browser.viewports.map((viewport) => viewport.pageId));
      const timestamp = now();
      state = {
        ...state,
        browser: Object.freeze({
          ...state.browser,
          pages: Object.freeze(
            state.browser.pages.map((page) =>
              Object.freeze({
                ...page,
                lastUsedAt:
                  shown.has(page.id) || wasShown.has(page.id) ? timestamp : page.lastUsedAt,
              }),
            ),
          ),
          viewports: Object.freeze(
            bindings.map((binding) =>
              Object.freeze({
                id: binding.viewportId,
                profileId: ProfileId,
                pageId: binding.pageId,
              }),
            ),
          ),
        }),
      };
      return revision;
    });
    const commit = Effect.fn("BrowserController.commit")(function* () {
      if (pluginOwner === undefined) {
        const next = render(state, pluginSummaries, pluginStatus, extensionControls);
        yield* applySurface(next, next.bindings);
      } else yield* applySurface(pluginSurface, pluginBindings);
    });
    const publishPluginSurface = Effect.fn("BrowserController.publishPluginSurface")(function* (
      owner: string,
      value: unknown,
    ) {
      const envelope = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          root: Schema.Unknown,
          bindings: Schema.Array(
            Schema.Struct({ viewportId: Schema.String, pageId: Schema.String }),
          ),
        }),
        { onExcessProperty: "error" },
      )(value).pipe(
        Effect.mapError(
          () => new EngineError({ code: "surface", message: "Malformed plugin surface" }),
        ),
      );
      return yield* lock.withPermit(
        Effect.gen(function* () {
          if (
            envelope.bindings.some(
              (binding) =>
                !state.browser.pages.some(
                  (page) => page.id === binding.pageId && page.lifecycle !== "closed",
                ),
            )
          )
            return yield* new EngineError({
              code: "surface",
              message: "Plugin binding references a page outside this profile",
            });
          const next = { ...envelope, identity: `plugin:${owner}` };
          const revision = yield* applySurface(next, envelope.bindings);
          pluginSurface = next;
          pluginBindings = envelope.bindings;
          pluginOwner = owner;
          return revision;
        }),
      );
    });
    const releasePluginSurface = Effect.fn("BrowserController.releasePluginSurface")(function* (
      owner: string,
    ) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          if (pluginOwner !== owner) return;
          const next = render(state, pluginSummaries, pluginStatus, extensionControls);
          yield* applySurface(next, next.bindings);
          pluginOwner = undefined;
          pluginSurface = undefined;
          pluginBindings = [];
        }),
      );
    });
    const change = (
      operation: () => Effect.Effect<void, EngineError>,
      persistChange: boolean | (() => boolean) = false,
      shouldRender: () => boolean = () => true,
      renderChange: () => Effect.Effect<void, EngineError> = commit,
    ) =>
      lock.withPermit(
        Effect.suspend(() =>
          operation().pipe(
            Effect.andThen(
              Effect.suspend(() =>
                (typeof persistChange === "function" ? persistChange() : persistChange)
                  ? persist()
                  : Effect.void,
              ),
            ),
            Effect.andThen(Effect.suspend(() => (shouldRender() ? renderChange() : Effect.void))),
          ),
        ),
      );

    const open = Effect.fn("BrowserController.open")(function* (
      url: string,
      id = pageId(),
      title = url,
    ) {
      if (!pageBrowserGenerationAvailable)
        return yield* new EngineError({
          code: "capability",
          message: "The native host does not support page browser generations",
        });
      state = {
        ...state,
        opening: new Map(state.opening).set(id, { id, url, title }),
        newPage: false,
        screen: "browser",
      };
      yield* engine.request("pages.open", { id, url });
    });

    const navigate = Effect.fn("BrowserController.navigate")(function* () {
      const url = normalizeAddressDraft(state.input.text);
      if (url === undefined) return;
      const page = selected(state);
      if (page && !state.newPage) {
        state = { ...state, inputDirty: false };
        yield* engine.request("pages.navigate", { id: page.id, url });
        return;
      }
      yield* open(url);
    });

    const dispatchDefault = (action: string) =>
      change(
        () =>
          Effect.gen(function* () {
            const page = selected(state);
            if (action === "interface.tabs.toggle") {
              state = { ...state, tabsVisible: state.tabsVisible === false };
              return;
            }
            if (action === "browser.navigate") return yield* navigate();
            if (action === "browser.new-page") {
              state = {
                ...state,
                newPage: true,
                screen: "browser",
                input: InitialInput,
                inputDirty: false,
              };
              return;
            }
            if (
              action === "browser.back" ||
              action === "browser.forward" ||
              action === "browser.reload"
            ) {
              if (!page) return;
              const method =
                action === "browser.back"
                  ? "pages.back"
                  : action === "browser.forward"
                    ? "pages.forward"
                    : "pages.reload";
              yield* engine.request(method, { id: page.id });
              return;
            }
            if (action === "interface.settings") {
              state = { ...state, screen: "settings" };
              return;
            }
            if (action === "interface.plugins") {
              state = { ...state, screen: "plugins" };
              return;
            }
            if (action === "interface.extensions") {
              state = { ...state, screen: "extensions" };
              return;
            }
            if (action === "screen.browser") {
              state = { ...state, screen: "browser" };
              return;
            }
            if (action === "settings.tabs.sidebar" || action === "settings.tabs.top") {
              state = {
                ...state,
                interfaceConfiguration: {
                  tabPlacement: action.endsWith("sidebar") ? "sidebar" : "top",
                },
              };
              return;
            }
            if (action.startsWith("settings.color.")) {
              const colorScheme = action.slice("settings.color.".length);
              if (colorScheme === "light" || colorScheme === "dark" || colorScheme === "system")
                state = { ...state, configuration: { ...state.configuration, colorScheme } };
              return;
            }
            if (action === "settings.sleep.60" || action === "settings.sleep.300") {
              state = {
                ...state,
                configuration: {
                  ...state.configuration,
                  sleepAfterMs: action.endsWith("60") ? 60_000 : 300_000,
                },
              };
              return;
            }
            if (action === "pages.slice.previous" || action === "pages.slice.next") {
              state = {
                ...state,
                pageOffset: Math.max(0, state.pageOffset + (action.endsWith("next") ? 30 : -30)),
              };
              return;
            }
            const match =
              /^(page\.select|page\.close|page\.pin|page\.unpin):([A-Za-z][A-Za-z0-9_-]{0,63})$/.exec(
                action,
              );
            if (!match) return;
            const [, operation, id] = match;
            if (operation === "page.select") {
              if (
                state.browser.pages.some((entry) => entry.id === id && entry.lifecycle !== "closed")
              )
                state = {
                  ...state,
                  interfaceState: { ...state.interfaceState, selectedPageId: id },
                  newPage: false,
                  input: {
                    ...InitialInput,
                    text: state.browser.pages.find((entry) => entry.id === id)?.url ?? "",
                  },
                  inputDirty: false,
                };
            } else if (operation === "page.close") yield* engine.request("pages.close", { id });
            else {
              const pinned = operation === "page.pin";
              const ids = state.interfaceState.pinnedPageIds;
              state = {
                ...state,
                interfaceState: {
                  ...state.interfaceState,
                  pinnedPageIds: pinned
                    ? Object.freeze([...new Set([...ids, id])])
                    : Object.freeze(ids.filter((entry) => entry !== id)),
                },
              };
            }
          }),
        action.startsWith("settings.") ||
          action.startsWith("page.") ||
          action === "browser.new-page",
      );

    const dispatch = Effect.fn("BrowserController.dispatch")(function* (action: string) {
      if (state.interfaceMode === "plugins") return;
      if (action === "interface.extensions" && options.extensions) {
        yield* options.extensions.list().pipe(
          Effect.match({
            onSuccess: (entries) => {
              extensionControls = { ...extensionControls, entries };
            },
            onFailure: () => {
              extensionControls = {
                ...extensionControls,
                status:
                  "Extension metadata is unavailable. Restart in safe mode if this continues.",
              };
            },
          }),
        );
      }
      if (action.startsWith("extensions.")) {
        const controls = options.extensions;
        if (state.screen !== "extensions" || !controls || extensionControls.busy) return;
        if (
          action === "extensions.permissions.next" ||
          action === "extensions.permissions.previous"
        ) {
          const preview = extensionControls.preview;
          if (!preview) return;
          const page = Math.max(
            0,
            Math.min(
              extensionPermissionPages(preview) - 1,
              extensionControls.permissionPage + (action.endsWith("next") ? 1 : -1),
            ),
          );
          extensionControls = {
            ...extensionControls,
            permissionPage: page,
            reviewedThrough: Math.max(extensionControls.reviewedThrough, page),
          };
          yield* lock.withPermit(commit());
          return;
        }
        if (controls.readOnly) return;
        const preview = extensionControls.preview;
        let operation: Effect.Effect<unknown, unknown> | undefined;
        if (action === "extensions.preview" && !preview) {
          const directory = extensionInput.text;
          operation = controls.previewLocal(directory).pipe(
            Effect.tap((next) =>
              Effect.sync(() => {
                extensionControls = {
                  ...extensionControls,
                  preview: next,
                  permissionPage: 0,
                  reviewedThrough: 0,
                };
              }),
            ),
          );
        } else if (
          action === "extensions.install" &&
          preview &&
          extensionControls.reviewedThrough >= extensionPermissionPages(preview) - 1
        ) {
          operation = controls.confirmInstall(preview.installationId, preview.digest).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                extensionControls = { ...extensionControls, preview: undefined };
              }),
            ),
          );
        } else if (action === "extensions.cancel" && preview) {
          const existing = extensionControls.entries.find(
            (entry) => entry.installationId === preview.installationId,
          );
          operation = (
            existing?.state === "error"
              ? Effect.void
              : controls.cancelPreview(preview.installationId, preview.digest)
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                extensionControls = { ...extensionControls, preview: undefined };
              }),
            ),
          );
        } else {
          const review = /^extensions\.review\.([a-f0-9]{32})$/.exec(action);
          const entry =
            review &&
            extensionControls.entries.find(
              (item) =>
                item.installationId === review[1] &&
                (item.state === "prepared" ||
                  (item.state === "error" && item.errorIntent === "install")),
            );
          if (entry && !preview)
            operation = controls.reviewPrepared(entry.installationId, entry.digest).pipe(
              Effect.tap((next) =>
                Effect.sync(() => {
                  extensionControls = {
                    ...extensionControls,
                    preview: next,
                    permissionPage: 0,
                    reviewedThrough: 0,
                  };
                }),
              ),
            );
          const removal = /^extensions\.remove\.([a-f0-9]{32})$/.exec(action);
          if (
            removal &&
            extensionControls.entries.some(
              (entry) =>
                entry.installationId === removal[1] &&
                (entry.state === "enabled" ||
                  entry.state === "removing" ||
                  (entry.state === "error" && entry.errorIntent === "remove")),
            )
          )
            operation = controls.remove(removal[1]!);
        }
        if (!operation) return;
        extensionControls = {
          ...extensionControls,
          busy: true,
          status: "Applying extension change…",
        };
        yield* lock.withPermit(commit());
        yield* operation.pipe(
          Effect.andThen(controls.list()),
          Effect.match({
            onSuccess: (entries) => {
              extensionControls = { ...extensionControls, entries, status: undefined };
            },
            onFailure: () => {
              extensionControls = {
                ...extensionControls,
                status:
                  "The extension change could not be completed. Restart before retrying an interrupted installation or removal.",
              };
            },
          }),
          Effect.ensuring(
            lock
              .withPermit(
                Effect.gen(function* () {
                  extensionControls = { ...extensionControls, busy: false };
                  if (state.screen === "extensions" && pluginOwner === undefined) yield* commit();
                }),
              )
              .pipe(Effect.ignoreCause),
          ),
          Effect.forkIn(controllerScope),
        );
        return;
      }
      const operation =
        /^plugins\.(enable|disable|rollback|uninstall)\.([a-z][a-z0-9-]{1,62})$/.exec(action);
      if (operation && pluginAction) {
        if (managingPlugin) return;
        const name = operation[1];
        if (
          name === "enable" ||
          name === "disable" ||
          name === "rollback" ||
          name === "uninstall"
        ) {
          managingPlugin = true;
          pluginStatus = "Applying plugin change…";
          if (state.screen === "plugins" && pluginOwner === undefined)
            yield* lock.withPermit(commit());
          // Activation may take several seconds. Keep the input stream responsive,
          // and never hold the controller lock while the manager releases a surface.
          yield* pluginAction(name, operation[2]!).pipe(
            Effect.match({
              onSuccess: () => {
                pluginStatus = undefined;
              },
              onFailure: () => {
                pluginStatus =
                  name === "uninstall"
                    ? "Removal could not be completed. Restart the browser before retrying."
                    : "The plugin change could not be completed. Check its permissions or try a previous version.";
              },
            }),
            Effect.ensuring(
              lock
                .withPermit(
                  Effect.gen(function* () {
                    managingPlugin = false;
                    if (state.screen === "plugins" && pluginOwner === undefined) yield* commit();
                  }),
                )
                .pipe(Effect.ignoreCause),
            ),
            Effect.forkIn(controllerScope),
          );
        }
        return;
      }
      yield* dispatchDefault(action);
    });

    const openTrusted = Effect.fn("BrowserController.openTrusted")(function* (url: string) {
      const normalized = normalizeWebUrl(url);
      if (!normalized.ok)
        return yield* new EngineError({
          code: "invalid-url",
          message: normalized.errors.join(" "),
        });
      const id = pageId();
      yield* lock.withPermit(
        Effect.suspend(() => open(normalized.value, id).pipe(Effect.andThen(commit()))),
      );
      return id;
    });
    const navigateTrusted = Effect.fn("BrowserController.navigateTrusted")(function* (
      id: string,
      url: string,
    ) {
      const normalized = normalizeWebUrl(url);
      if (!normalized.ok)
        return yield* new EngineError({
          code: "invalid-url",
          message: normalized.errors.join(" "),
        });
      yield* lock.withPermit(
        Effect.suspend(() => {
          if (!state.browser.pages.some((page) => page.id === id && page.lifecycle !== "closed"))
            return Effect.fail(new EngineError({ code: "not-found", message: "Page is not open" }));
          return engine
            .request("pages.navigate", { id, url: normalized.value })
            .pipe(Effect.asVoid);
        }),
      );
    });
    const pageHistory = Effect.fn("BrowserController.pageHistory")(function* (
      id: string,
      action: "back" | "forward" | "reload" | "stop",
    ) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          const page = state.browser.pages.find(
            (entry) => entry.id === id && entry.lifecycle !== "closed",
          );
          if (!page)
            return yield* new EngineError({ code: "not-found", message: "Page is not open" });
          if (page.lifecycle === "sleeping") {
            yield* activatePage(engine, id);
            state = {
              ...state,
              browser: replacePage(state.browser, id, { lifecycle: "loaded", lastUsedAt: now() }),
            };
          }
          yield* engine.request(`pages.${action}`, { id });
        }),
      );
    });
    const closeTrusted = Effect.fn("BrowserController.closeTrusted")(function* (id: string) {
      yield* lock.withPermit(
        Effect.suspend(() => {
          if (!state.browser.pages.some((page) => page.id === id && page.lifecycle !== "closed"))
            return Effect.fail(new EngineError({ code: "not-found", message: "Page is not open" }));
          return engine.request("pages.close", { id }).pipe(Effect.asVoid);
        }),
      );
    });
    const protectDomWrite = Effect.fn("BrowserController.protectDomWrite")(function* (id: string) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          const page = state.browser.pages.find(
            (entry) => entry.id === id && entry.lifecycle !== "closed",
          );
          if (page === undefined)
            return yield* new EngineError({ code: "not-found", message: "Page is not open" });
          if (page.lifecycle === "sleeping") {
            yield* activatePage(engine, id);
            state = {
              ...state,
              browser: replacePage(state.browser, id, { lifecycle: "loaded", lastUsedAt: now() }),
            };
          }
          pendingDomWrites.add(id);
        }),
      );
    });
    const configure = Effect.fn("BrowserController.configure")(function* (
      configuration: BrowserConfiguration,
    ) {
      const parsed = parseConfiguration(configuration);
      if (!parsed.ok)
        return yield* new EngineError({
          code: "invalid-configuration",
          message: parsed.errors.join(" "),
        });
      yield* change(
        () =>
          Effect.sync(() => {
            state = { ...state, configuration: parsed.value };
          }),
        true,
      );
    });
    const applyPortableSettings = Effect.fn("BrowserController.applyPortableSettings")(function* (
      settings: PortableSettings,
    ) {
      const parsed = yield* decodeCustomizationRecipe({
        ...settings,
        version: 1,
        plugins: [],
      }).pipe(
        Effect.mapError(
          (error) => new EngineError({ code: "invalid-configuration", message: error.message }),
        ),
      );
      yield* lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (closingPersistence !== undefined)
              return yield* new EngineError({
                code: "closing",
                message: "The browser window is closing",
              });
            const next = {
              ...state,
              configuration: parsed.configuration,
              ...(state.interfaceMode === "legacy"
                ? { interfaceConfiguration: parsed.interface }
                : {}),
            };
            const write = saveBrowserPersistence(
              profileRoot,
              asPersistence(next, persistenceFormat, legacyBootstrapSeed),
            );
            yield* (options.profileLease ? options.profileLease.withWrite(write) : write).pipe(
              Effect.mapError(
                (error) => new EngineError({ code: "persistence", message: error.message }),
              ),
            );
            state = next;
            yield* commit();
          }),
        ),
      );
    });

    // Native can queue several key events at one revision. Coalescing their
    // redraw keeps that revision alive long enough for every queued edit.
    const updateInput = (event: NativeTextInputEvent, extension = false) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (extension) {
            if (
              state.screen !== "extensions" ||
              extensionControls.busy ||
              extensionControls.preview
            )
              return;
            const next = reduceNativeTextInput(extensionInput, event);
            if (Buffer.byteLength(next.text, "utf8") > 4000) return;
            extensionInput = next;
            extensionControls = { ...extensionControls, directory: next.text };
          } else
            state = {
              ...state,
              input: reduceNativeTextInput(state.input, event),
              inputDirty: true,
            };
          if (inputCommitScheduled) return;
          inputCommitScheduled = true;
          yield* Effect.sleep(16).pipe(
            Effect.andThen(
              lock.withPermit(
                Effect.sync(() => {
                  inputCommitScheduled = false;
                }).pipe(Effect.andThen(commit())),
              ),
            ),
            Effect.forkScoped,
          );
        }),
      );

    const handleEngine = (event: {
      readonly event: string;
      readonly params: Record<string, unknown>;
    }) =>
      Effect.suspend(() => {
        if (event.event === "window.closing")
          return lock.withPermit(
            Effect.gen(function* () {
              // Shutdown drains real pages, but the next session must retain them.
              closingPersistence ??= persistedState();
              yield* persist();
            }),
          );
        if (event.event === "window.closeCancelled")
          return lock.withPermit(
            Effect.gen(function* () {
              // Some pages can finish closing before another cancels its prompt.
              // Resume persistence from the actual survivors; late closes are normal.
              closingPersistence = undefined;
              closeCancellationGeneration += 1;
              yield* persist();
              yield* commit();
            }),
          );
        if (event.event === "pages.resourcesChanged") {
          return decodePageResourceEvent(event).pipe(
            Effect.flatMap(({ params }) =>
              lock.withPermit(
                Effect.gen(function* () {
                  const browser = pageBrowsers.get(params.pageId);
                  const page = state.browser.pages.find(
                    (entry) => entry.id === params.pageId && entry.lifecycle !== "closed",
                  );
                  if (
                    page === undefined ||
                    browser === undefined ||
                    !browser.available ||
                    !browser.committed ||
                    browser.generation !== params.generation
                  )
                    return;
                  knownResources = rememberPageResources(knownResources, params);
                  const protections = {
                    audio: params.audio,
                    call: params.call,
                    download: params.download,
                    unsavedInput: params.unsavedInput,
                  };
                  state = {
                    ...state,
                    browser: replacePage(state.browser, params.pageId, { protections }),
                  };
                  if (page?.lifecycle === "sleeping" && Object.values(protections).some(Boolean)) {
                    yield* activatePage(engine, params.pageId);
                    state = {
                      ...state,
                      browser: replacePage(state.browser, params.pageId, {
                        lifecycle: "loaded",
                        lastUsedAt: now(),
                      }),
                    };
                  }
                }),
              ),
            ),
            Effect.mapError(
              () =>
                new EngineError({
                  code: "resources",
                  message: "Could not apply native page protection signal",
                }),
            ),
          );
        }
        if (
          ![
            "pages.created",
            "pages.browserUnavailable",
            "pages.replaced",
            "pages.documentCommitted",
            "pages.closed",
            "pages.titleChanged",
            "pages.navigationChanged",
          ].includes(event.event)
        )
          return Effect.void;
        return decodePageLifecycleEvent(event).pipe(
          Effect.flatMap((lifecycle) =>
            change(
              () =>
                Effect.gen(function* () {
                  const { params } = lifecycle;
                  const id = params.pageId;
                  const browser = pageBrowsers.get(id);
                  const page = state.browser.pages.find(
                    (entry) => entry.id === id && entry.lifecycle !== "closed",
                  );
                  const clearCurrentBrowserState = () => {
                    pendingDomWrites.delete(id);
                    inspectedPages.delete(id);
                    const remainingResources = new Map(knownResources);
                    remainingResources.delete(id);
                    knownResources = remainingResources;
                    if (page)
                      state = {
                        ...state,
                        browser: replacePage(state.browser, id, {
                          lifecycle: "loaded",
                          protections: UnknownProtections,
                        }),
                      };
                  };
                  if (lifecycle.event === "pages.created") {
                    if (browser !== undefined || params.generation !== 1) return;
                    const metadata = state.opening.get(id);
                    if (!metadata) return;
                    pageBrowsers = new Map(pageBrowsers).set(id, {
                      generation: params.generation,
                      available: true,
                      committed: false,
                      loading: true,
                    });
                    const opened = openPage(state.browser, {
                      id,
                      profileId: ProfileId,
                      url: metadata.url,
                      title: metadata.title,
                      now: now(),
                    });
                    if (!opened.ok) return;
                    const opening = new Map(state.opening);
                    opening.delete(id);
                    if (restoring && opening.size === 0) restoring = false;
                    const selectedPageId =
                      state.interfaceMode === "legacy"
                        ? (state.interfaceState.selectedPageId ?? id)
                        : undefined;
                    state = {
                      ...state,
                      browser: replacePage(opened.value, id, { protections: UnknownProtections }),
                      opening,
                      ...(state.interfaceMode === "legacy"
                        ? {
                            interfaceState: {
                              ...state.interfaceState,
                              selectedPageId,
                              pageOrder: Object.freeze(
                                state.interfaceState.pageOrder.includes(id)
                                  ? state.interfaceState.pageOrder
                                  : [...state.interfaceState.pageOrder, id],
                              ),
                            },
                          }
                        : {}),
                      ...(selectedPageId === id
                        ? { input: { ...InitialInput, text: metadata.url }, inputDirty: false }
                        : {}),
                    };
                  } else if (
                    lifecycle.event === "pages.closed" &&
                    params.generation === 0 &&
                    browser === undefined &&
                    state.opening.has(id)
                  ) {
                    const opening = new Map(state.opening);
                    opening.delete(id);
                    if (restoring && opening.size === 0) restoring = false;
                    state = { ...state, opening };
                  } else if (
                    browser === undefined ||
                    (lifecycle.event !== "pages.replaced" &&
                      browser.generation !== params.generation)
                  )
                    return;
                  else if (lifecycle.event === "pages.browserUnavailable") {
                    if (!browser.available) return;
                    pageBrowsers = new Map(pageBrowsers).set(id, { ...browser, available: false });
                    clearCurrentBrowserState();
                  } else if (lifecycle.event === "pages.replaced") {
                    if (
                      lifecycle.params.previousGeneration !== browser.generation ||
                      params.generation !== browser.generation + 1
                    )
                      return;
                    pageBrowsers = new Map(pageBrowsers).set(id, {
                      generation: params.generation,
                      available: true,
                      committed: false,
                      loading: true,
                    });
                    clearCurrentBrowserState();
                  } else if (lifecycle.event === "pages.documentCommitted") {
                    if (!browser.available) return;
                    pageBrowsers = new Map(pageBrowsers).set(id, {
                      ...browser,
                      committed: true,
                      loading: true,
                    });
                  } else if (lifecycle.event === "pages.closed") {
                    if (!page) return;
                    if (closingPersistence && lifecycle.params.reason === "page-close") {
                      const pages = closingPersistence.pages.filter((page) => page.id !== id);
                      closingPersistence = {
                        ...closingPersistence,
                        pages,
                        ...(state.interfaceMode === "legacy"
                          ? {
                              interfaceState: {
                                ...closingPersistence.interfaceState,
                                pageOrder: closingPersistence.interfaceState.pageOrder.filter(
                                  (pageId) => pageId !== id,
                                ),
                                pinnedPageIds:
                                  closingPersistence.interfaceState.pinnedPageIds.filter(
                                    (pageId) => pageId !== id,
                                  ),
                                selectedPageId:
                                  closingPersistence.interfaceState.selectedPageId === id
                                    ? pages[0]?.id
                                    : closingPersistence.interfaceState.selectedPageId,
                              },
                            }
                          : {}),
                      };
                    }
                    pendingDomWrites.delete(id);
                    inspectedPages.delete(id);
                    const remainingResources = new Map(knownResources);
                    remainingResources.delete(id);
                    knownResources = remainingResources;
                    const remainingBrowsers = new Map(pageBrowsers);
                    remainingBrowsers.delete(id);
                    pageBrowsers = remainingBrowsers;
                    const closed = replacePage(state.browser, id, { lifecycle: "closed" });
                    const retainedClosed = new Set(
                      closed.pages
                        .filter((page) => page.lifecycle === "closed")
                        .slice(-32)
                        .map((page) => page.id),
                    );
                    const browser: BrowserState = {
                      ...closed,
                      pages: closed.pages.filter(
                        (page) => page.lifecycle !== "closed" || retainedClosed.has(page.id),
                      ),
                    };
                    const interfaceState =
                      state.interfaceMode === "legacy"
                        ? reconcileInterface(browser, {
                            ...state.interfaceState,
                            ...(state.interfaceState.selectedPageId === id
                              ? { selectedPageId: undefined }
                              : {}),
                            pageOrder: Object.freeze(
                              state.interfaceState.pageOrder.filter((entry) => entry !== id),
                            ),
                            pinnedPageIds: Object.freeze(
                              state.interfaceState.pinnedPageIds.filter((entry) => entry !== id),
                            ),
                          })
                        : state.interfaceState;
                    state = {
                      ...state,
                      browser,
                      ...(state.interfaceMode === "legacy" ? { interfaceState } : {}),
                      ...(state.interfaceMode === "legacy" &&
                      state.interfaceState.selectedPageId === id
                        ? {
                            input: {
                              ...InitialInput,
                              text:
                                browser.pages.find(
                                  (page) => page.id === interfaceState.selectedPageId,
                                )?.url ?? "",
                            },
                            inputDirty: false,
                          }
                        : {}),
                    };
                  } else if (
                    lifecycle.event === "pages.titleChanged" &&
                    browser.available &&
                    browser.committed
                  )
                    state = {
                      ...state,
                      browser: replacePage(state.browser, id, { title: lifecycle.params.title }),
                    };
                  else if (lifecycle.event === "pages.navigationChanged" && browser.available) {
                    pageBrowsers = new Map(pageBrowsers).set(id, {
                      ...browser,
                      loading: lifecycle.params.loading,
                      canGoBack: lifecycle.params.canGoBack,
                      canGoForward: lifecycle.params.canGoForward,
                    });
                    if (lifecycle.params.loading && page?.lifecycle === "sleeping") {
                      yield* activatePage(engine, id);
                      state = {
                        ...state,
                        browser: replacePage(state.browser, id, {
                          lifecycle: "loaded",
                          lastUsedAt: now(),
                        }),
                      };
                    }
                    if (browser.committed && normalizeWebUrl(lifecycle.params.url).ok)
                      state = {
                        ...state,
                        browser: replacePage(state.browser, id, { url: lifecycle.params.url }),
                        ...(state.interfaceMode === "legacy" &&
                        state.interfaceState.selectedPageId === id &&
                        !state.inputDirty
                          ? { input: { ...InitialInput, text: lifecycle.params.url } }
                          : {}),
                      };
                  }
                }),
              () => !restoring,
              () => !restoring && closingPersistence === undefined,
              () =>
                commit().pipe(
                  Effect.catch((error) =>
                    error.code === "window-closing" ? Effect.void : Effect.fail(error),
                  ),
                ),
            ),
          ),
          Effect.mapError(
            () =>
              new EngineError({
                code: "lifecycle",
                message: "Could not apply native page lifecycle event",
              }),
          ),
        );
      });

    const handleSurface = (event: SurfaceEvent) => {
      if (pluginOwner !== undefined) {
        const owner = pluginOwner;
        const handler = pluginEventHandlers.get(owner);
        if (handler) return handler(event);
        return Effect.sync(() =>
          PubSub.publishUnsafe(pluginEvents, { owner, event: "ui.event", payload: event }),
        ).pipe(
          Effect.flatMap((published) => (published ? Effect.void : releasePluginSurface(owner))),
        );
      }
      if (event.event === "press") {
        const pressed = decodePress(event.payload);
        return Option.isNone(pressed) ? Effect.void : dispatch(pressed.value.action);
      }
      if (
        event.event === "input" &&
        (event.nodeId === "address" || event.nodeId === "extension-directory")
      ) {
        const input = decodeInput(event.payload);
        return Option.isNone(input)
          ? Effect.void
          : updateInput(
              input.value as NativeTextInputEvent,
              event.nodeId === "extension-directory",
            );
      }
      return Effect.void;
    };

    const recordEventError = (error: unknown) =>
      Effect.sync(() => {
        if (lastError === undefined)
          lastError = error instanceof Error ? error.message : String(error);
      });
    yield* surface.events.pipe(
      Stream.runForEach((event) => handleSurface(event).pipe(Effect.catch(recordEventError))),
      Effect.forkScoped,
    );
    yield* engine.events.pipe(
      Stream.runForEach((event) =>
        handleEngine(event).pipe(
          Effect.tapCause((cause) => Deferred.failCause(restoration, cause)),
          Effect.andThen(completeRestoration),
          Effect.catch(recordEventError),
        ),
      ),
      Effect.forkScoped,
    );

    const start = Effect.gen(function* () {
      const ready = yield* engine.ready;
      pageBrowserGenerationAvailable = ready.params.pageBrowserGeneration === true;
      if (!pageBrowserGenerationAvailable)
        return yield* new EngineError({
          code: "capability",
          message: "The native host does not support page browser generations",
        });
      resourceSignalsAvailable = ready.params.pageResourceSignals === true;
      const persisted =
        options.initialPersistence === undefined
          ? yield* loadBrowserPersistence(profileRoot, ProfileId).pipe(
              Effect.mapError(
                (error) => new EngineError({ code: "persistence", message: error.message }),
              ),
            )
          : options.initialPersistence.value;
      if (state.interfaceMode === "plugins") {
        persistenceFormat = 2;
        legacyBootstrapSeed = legacyBootstrapSeedOf(persisted);
      } else if (persisted?.format === 2) {
        persistenceFormat = 2;
        legacyBootstrapSeed = persisted.legacyBootstrapSeed;
      }
      const restorePages = persisted?.pages ?? [];
      yield* lock.withPermit(
        Effect.sync(() => {
          restoring = restorePages.length > 0;
          if (persisted)
            state = {
              ...state,
              configuration: persisted.configuration,
              ...(state.interfaceMode === "legacy"
                ? {
                    interfaceConfiguration: persisted.interfaceConfiguration,
                    interfaceState: persisted.interfaceState,
                  }
                : {}),
              opening: new Map(restorePages.map((page) => [page.id, page])),
              newPage: false,
              screen: "browser",
            };
        }).pipe(Effect.andThen(Effect.suspend(() => (restoring ? Effect.void : commit())))),
      );
      // Metadata is already staged. Lifecycle consumers must be able to acquire
      // the model lock while the host is replying to restore requests.
      for (const page of restorePages) {
        while (true) {
          const cancellationGeneration = closeCancellationGeneration;
          const result = yield* engine.request("pages.open", { id: page.id, url: page.url }).pipe(
            Effect.as("opened" as const),
            Effect.catch((error) => {
              if (error.code !== "-32003") return Effect.fail(error);
              // This specific rejection guarantees no page was created. Wait
              // for a canceled close before retrying the same staged page.
              const canceled = Effect.gen(function* () {
                while (closeCancellationGeneration === cancellationGeneration)
                  yield* Effect.sleep(25);
                return "retry" as const;
              });
              const exited = engine.exit.pipe(
                Effect.flatMap((code) =>
                  code === 0
                    ? Effect.succeed("closed" as const)
                    : Effect.fail(
                        new EngineError({ code: "exit", message: "Host exited during restore" }),
                      ),
                ),
              );
              return Effect.raceFirst(canceled, exited);
            }),
          );
          if (result === "closed") return;
          if (result === "opened") break;
        }
      }
      restoreRequestsCompleted = true;
      yield* completeRestoration;
    }).pipe(Effect.tapCause((cause) => Deferred.failCause(restoration, cause)));

    yield* lock
      .withPermit(
        Effect.gen(function* () {
          const ids =
            options.freezeEnabled === false
              ? []
              : selectPageFreezes(
                  state.browser,
                  state.configuration,
                  now(),
                  2,
                  resourceSignalsAvailable,
                  new Map(
                    [...knownResources]
                      .filter(([id]) => {
                        const browser = pageBrowsers.get(id);
                        return browser?.available && browser.committed && !browser.loading;
                      })
                      .map(([id, resources]) => [
                        id,
                        pendingDomWrites.has(id) || inspectedPages.has(id)
                          ? Object.freeze({ ...resources, unsavedInput: true })
                          : resources,
                      ]),
                  ),
                );
          for (const id of ids) {
            yield* freezePage(engine, id);
            state = {
              ...state,
              browser: replacePage(state.browser, id, { lifecycle: "sleeping" }),
            };
          }
        }),
      )
      .pipe(
        Effect.catch(recordEventError),
        Effect.andThen(Effect.sleep(1000)),
        Effect.forever,
        Effect.forkScoped,
      );

    const devtools = yield* createDevToolsController({
      engine,
      onFailure: options.onDevToolsFailure,
      protect: (status) =>
        lock.withPermit(
          Effect.gen(function* () {
            const browser = pageBrowsers.get(status.pageId);
            const page = state.browser.pages.find(
              (entry) => entry.id === status.pageId && entry.lifecycle !== "closed",
            );
            if (!page || !browser?.available || browser.generation !== status.generation) return;
            const previous = inspectedPages.get(status.pageId);
            if (
              previous !== undefined &&
              previous.generation === status.generation &&
              previous.instance > status.instance
            )
              return;
            if (status.state === "closed") {
              if (
                previous !== undefined &&
                previous.generation === status.generation &&
                previous.instance === status.instance
              )
                inspectedPages.delete(status.pageId);
              return;
            }
            inspectedPages.set(status.pageId, {
              generation: status.generation,
              instance: status.instance,
            });
            if (page.lifecycle === "sleeping") {
              yield* activatePage(engine, status.pageId);
              state = {
                ...state,
                browser: replacePage(state.browser, status.pageId, {
                  lifecycle: "loaded",
                  lastUsedAt: now(),
                }),
              };
            }
          }),
        ),
    });

    return {
      start,
      devtools,
      restored: Effect.raceFirst(
        Deferred.await(restoration),
        engine.exit.pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new EngineError({ code: "restore-exit", message: "Host exited during restoration" }),
            ),
          ),
        ),
      ),
      interfaceMode: options.interfaceMode ?? "legacy",
      restoredPageInventory: Effect.raceFirst(
        Deferred.await(restoration),
        engine.exit.pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new EngineError({ code: "restore-exit", message: "Host exited during restoration" }),
            ),
          ),
        ),
      ).pipe(
        Effect.andThen(
          lock.withPermit(
            Effect.sync(() => {
              const pageIds = Object.freeze(
                state.browser.pages
                  .filter((page) => page.lifecycle !== "closed" && !state.opening.has(page.id))
                  .map((page) => page.id),
              );
              return Object.freeze({ pageIds, pageOrder: Object.freeze([...pageIds]) });
            }),
          ),
        ),
      ),
      retireLegacyBootstrapSeed: () =>
        lock.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (closingPersistence !== undefined)
                return yield* new EngineError({
                  code: "closing",
                  message: "The browser window is closing",
                });
              if (legacyBootstrapSeed === undefined) return;
              const previous = legacyBootstrapSeed;
              legacyBootstrapSeed = undefined;
              const write = saveBrowserPersistence(profileRoot, persistedState());
              const result = yield* (
                options.profileLease ? options.profileLease.withWrite(write) : write
              ).pipe(
                Effect.mapError(
                  (error) => new EngineError({ code: "persistence", message: error.message }),
                ),
                Effect.exit,
              );
              if (result._tag === "Failure") {
                // A failed directory sync may follow rename. Keeping redundant input is safe:
                // startup has already made the terminal bootstrap journal durable.
                legacyBootstrapSeed = previous;
                return yield* Effect.failCause(result.cause);
              }
            }),
          ),
        ),
      dispatch,
      snapshot: Effect.sync(() => state.browser),
      observePages: (owner) =>
        mutex.withPermit(
          Effect.gen(function* () {
            const subscription = yield* observations.bind(owner);
            return {
              events: subscription.events,
              watch: (request) =>
                mutex.withPermit(
                  Effect.sync(() => observations.publish(observedPages())).pipe(
                    Effect.andThen(subscription.watch(request)),
                  ),
                ),
            } satisfies PageWatchSubscription;
          }),
        ),
      openPage: openTrusted,
      navigatePage: navigateTrusted,
      closePage: closeTrusted,
      pageHistory,
      protectDomWrite,
      configure,
      configuration: Effect.sync(() => state.configuration),
      portableSettings: lock.withPermit(
        Effect.sync(() => ({
          configuration: state.configuration,
          interface: state.interfaceConfiguration,
        })),
      ),
      applyPortableSettings,
      updatePluginControls: (plugins, action) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (state.interfaceMode === "plugins") return;
            const changed = JSON.stringify(plugins) !== JSON.stringify(pluginSummaries);
            pluginSummaries = plugins;
            pluginAction = action;
            if (changed && state.screen === "plugins" && pluginOwner === undefined) yield* commit();
          }),
        ),
      publishPluginSurface,
      recoverPluginSurface: (owner) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (pluginOwner !== undefined && pluginOwner !== owner)
              return yield* new EngineError({
                code: "composition",
                message: "Another interface owns the window",
              });
            const next = render(
              { ...state, screen: "plugins" },
              pluginSummaries,
              pluginStatus,
              extensionControls,
            );
            const revision = yield* applySurface(next, next.bindings);
            state = { ...state, screen: "plugins" };
            pluginOwner = undefined;
            pluginSurface = undefined;
            pluginBindings = [];
            return revision;
          }),
        ),
      registerPluginEventHandler: (owner, handler) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            if (pluginEventHandlers.has(owner) || pluginEventHandlers.size >= 4)
              return yield* new EngineError({
                code: "composition",
                message: "Interface event handler already registered or at capacity",
              });
            pluginEventHandlers.set(owner, handler);
          }),
          () =>
            Effect.sync(() => {
              if (pluginEventHandlers.get(owner) === handler) pluginEventHandlers.delete(owner);
            }),
        ),
      releasePluginSurface,
      pluginEvents: (owner) =>
        Stream.fromPubSub(pluginEvents).pipe(
          Stream.filter((event) => event.owner === owner),
          Stream.map(({ event, payload }) => ({ event, payload })),
        ),
      lastError: Effect.sync(() => lastError),
    } satisfies BrowserController;
  });
