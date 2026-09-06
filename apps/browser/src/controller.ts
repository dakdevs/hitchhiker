import type { BrowserPage, BrowserState } from "@hitchhiker/core";
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
  decodePageResourceEvent,
  EngineConnection,
  EngineError,
  freezePage,
  NativeSurface,
  rememberPageResources,
  selectPageFreezes,
  type PageResourceKnowledge,
} from "@hitchhiker/runtime";
import {
  button,
  column,
  reduceNativeTextInput,
  row,
  text,
  type NativeTextInputEvent,
  type NativeTextInputState,
  type Surface,
} from "@hitchhiker/ui";
import { Effect, Option, PubSub, Schema, Semaphore, Stream } from "effect";
import {
  loadBrowserPersistence,
  saveBrowserPersistence,
  type BrowserPersistence,
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
type Screen = "browser" | "settings" | "plugins";

interface ControllerState {
  browser: BrowserState;
  interfaceState: DefaultInterfaceState;
  interfaceConfiguration: DefaultInterfaceConfiguration;
  configuration: BrowserConfiguration;
  input: NativeTextInputState;
  inputDirty: boolean;
  pageOffset: number;
  newPage: boolean;
  screen: Screen;
  opening: ReadonlyMap<string, PageMetadata>;
}

export interface BrowserController {
  readonly start: Effect.Effect<void, EngineError>;
  readonly dispatch: (action: string) => Effect.Effect<void, EngineError>;
  readonly snapshot: Effect.Effect<BrowserState>;
  /** Trusted broker entrypoints; plugins and MCP never receive EngineConnection. */
  readonly openPage: (url: string) => Effect.Effect<string, EngineError>;
  readonly navigatePage: (pageId: string, url: string) => Effect.Effect<void, EngineError>;
  readonly closePage: (pageId: string) => Effect.Effect<void, EngineError>;
  readonly configure: (configuration: BrowserConfiguration) => Effect.Effect<void, EngineError>;
  readonly configuration: Effect.Effect<BrowserConfiguration>;
  /** Surfaces errors from controller event fibers instead of silently dropping them. */
  readonly publishPluginSurface: (
    owner: string,
    surface: unknown,
  ) => Effect.Effect<number, EngineError>;
  readonly releasePluginSurface: (owner: string) => Effect.Effect<void, EngineError>;
  readonly pluginEvents: (
    owner: string,
  ) => Stream.Stream<{ readonly event: string; readonly payload: unknown }>;
  readonly lastError: Effect.Effect<string | undefined>;
}
export interface BrowserControllerOptions {
  readonly freezeEnabled?: boolean;
}

const now = () => Date.now();
const pageId = () => `p${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

const asPersistence = (state: ControllerState): BrowserPersistence => ({
  configuration: state.configuration,
  interfaceConfiguration: state.interfaceConfiguration,
  interfaceState: state.interfaceState,
  pages: state.browser.pages
    .filter((page) => page.lifecycle !== "closed")
    .map((page) => ({ id: page.id, url: page.url, title: page.title })),
});

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
        button("settings-back", "Back", "screen.browser"),
      ],
      { padding: 20, gap: 12, flex: 1 },
    ),
    bindings: Object.freeze([]),
  });

const renderPlugins = (): Surface =>
  Object.freeze({
    root: column(
      "plugins",
      [
        text("plugins-title", "Plugins", { fontSize: 18 }),
        text("plugins-copy", "Developer plugins run in an isolated native host."),
        text(
          "plugins-installation",
          "Launch with --plugin to load a compiled package. Installation controls are coming next.",
        ),
        button("plugins-back", "Back", "screen.browser"),
      ],
      { padding: 20, gap: 12, flex: 1 },
    ),
    bindings: Object.freeze([]),
  });

const render = (state: ControllerState): Surface => {
  if (state.screen === "settings") return renderSettings(state);
  if (state.screen === "plugins") return renderPlugins();
  const interfaceState = state.newPage
    ? { ...state.interfaceState, selectedPageId: undefined }
    : state.interfaceState;
  return renderDefaultSurface(state.browser, interfaceState, state.interfaceConfiguration, {
    addressDraft: state.input.text,
    dark: state.configuration.colorScheme === "dark",
    pageOffset: state.pageOffset,
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
    const lock = yield* Semaphore.make(1);
    let state: ControllerState = {
      browser: InitialBrowser,
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
    let inputCommitScheduled = false;
    let lastError: string | undefined;
    let restoring = false;
    let pluginSurface: unknown;
    let pluginBindings: Surface["bindings"] = [];
    let pluginOwner: string | undefined;
    let knownResources: PageResourceKnowledge = new Map();
    let resourceSignalsAvailable = false;
    const pluginEvents = yield* PubSub.bounded<{
      readonly owner: string;
      readonly event: string;
      readonly payload: unknown;
    }>({ capacity: 32 });
    yield* Effect.addFinalizer(() => PubSub.shutdown(pluginEvents));

    const persist = Effect.fn("BrowserController.persist")(function* () {
      return yield* saveBrowserPersistence(profileRoot, asPersistence(state)).pipe(
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
      const revision = yield* surface.commit(next);
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
        const next = render(state);
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
          const next = render(state);
          yield* applySurface(next, next.bindings);
          pluginOwner = undefined;
          pluginSurface = undefined;
          pluginBindings = [];
        }),
      );
    });
    const change = (
      operation: () => Effect.Effect<void, EngineError>,
      persistChange = false,
      shouldRender: () => boolean = () => true,
    ) =>
      lock.withPermit(
        Effect.suspend(() =>
          operation().pipe(
            Effect.andThen(persistChange ? persist() : Effect.void),
            Effect.andThen(Effect.suspend(() => (shouldRender() ? commit() : Effect.void))),
          ),
        ),
      );

    const open = Effect.fn("BrowserController.open")(function* (
      url: string,
      id = pageId(),
      title = url,
    ) {
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

    const dispatch = (action: string) =>
      change(
        () =>
          Effect.gen(function* () {
            const page = selected(state);
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
    const closeTrusted = Effect.fn("BrowserController.closeTrusted")(function* (id: string) {
      yield* lock.withPermit(
        Effect.suspend(() => {
          if (!state.browser.pages.some((page) => page.id === id && page.lifecycle !== "closed"))
            return Effect.fail(new EngineError({ code: "not-found", message: "Page is not open" }));
          return engine.request("pages.close", { id }).pipe(Effect.asVoid);
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

    // Native can queue several key events at one revision. Coalescing their
    // redraw keeps that revision alive long enough for every queued edit.
    const updateInput = (event: NativeTextInputEvent) =>
      lock.withPermit(
        Effect.gen(function* () {
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
        if (event.event === "pages.resourcesChanged") {
          return decodePageResourceEvent(event).pipe(
            Effect.flatMap(({ params }) =>
              lock.withPermit(
                Effect.gen(function* () {
                  const page = state.browser.pages.find(
                    (entry) => entry.id === params.pageId && entry.lifecycle !== "closed",
                  );
                  if (!page && !state.opening.has(params.pageId)) return;
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
            "pages.closed",
            "pages.titleChanged",
            "pages.navigationChanged",
          ].includes(event.event)
        )
          return Effect.void;
        const id = typeof event.params.pageId === "string" ? event.params.pageId : undefined;
        if (!id) return Effect.void;
        if (event.event === "pages.created" && !state.opening.has(id)) return Effect.void;
        if (
          event.event !== "pages.created" &&
          !state.browser.pages.some((page) => page.id === id) &&
          !state.opening.has(id)
        )
          return Effect.void;
        return change(
          () =>
            Effect.sync(() => {
              if (event.event === "pages.created") {
                const metadata = state.opening.get(id);
                if (!metadata) return;
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
                state = {
                  ...state,
                  browser: opened.value,
                  opening,
                  interfaceState: {
                    ...state.interfaceState,
                    selectedPageId: state.interfaceState.selectedPageId ?? id,
                    pageOrder: Object.freeze(
                      state.interfaceState.pageOrder.includes(id)
                        ? state.interfaceState.pageOrder
                        : [...state.interfaceState.pageOrder, id],
                    ),
                  },
                  input: { ...InitialInput, text: metadata.url },
                  inputDirty: false,
                };
              } else if (event.event === "pages.closed") {
                const remainingResources = new Map(knownResources);
                remainingResources.delete(id);
                knownResources = remainingResources;
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
                const interfaceState = reconcileInterface(browser, {
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
                });
                state = {
                  ...state,
                  browser,
                  interfaceState,
                  ...(state.interfaceState.selectedPageId === id
                    ? {
                        input: {
                          ...InitialInput,
                          text:
                            browser.pages.find((page) => page.id === interfaceState.selectedPageId)
                              ?.url ?? "",
                        },
                        inputDirty: false,
                      }
                    : {}),
                };
              } else if (
                event.event === "pages.titleChanged" &&
                typeof event.params.title === "string"
              )
                state = {
                  ...state,
                  browser: replacePage(state.browser, id, { title: event.params.title }),
                };
              else if (
                event.event === "pages.navigationChanged" &&
                typeof event.params.url === "string" &&
                normalizeWebUrl(event.params.url).ok
              )
                state = {
                  ...state,
                  browser: replacePage(state.browser, id, { url: event.params.url }),
                  ...(state.interfaceState.selectedPageId === id && !state.inputDirty
                    ? { input: { ...InitialInput, text: event.params.url } }
                    : {}),
                };
            }),
          true,
          () => !restoring,
        );
      });

    const handleSurface = (event: {
      readonly event: string;
      readonly nodeId: string;
      readonly payload: unknown;
    }) => {
      if (pluginOwner !== undefined) {
        const owner = pluginOwner;
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
      if (event.event === "input" && event.nodeId === "address") {
        const input = decodeInput(event.payload);
        return Option.isNone(input)
          ? Effect.void
          : updateInput(input.value as NativeTextInputEvent);
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
      Stream.runForEach((event) => handleEngine(event).pipe(Effect.catch(recordEventError))),
      Effect.forkScoped,
    );

    const start = Effect.gen(function* () {
      const ready = yield* engine.ready;
      resourceSignalsAvailable = ready.params.pageResourceSignals === true;
      const persisted = yield* loadBrowserPersistence(profileRoot, ProfileId).pipe(
        Effect.mapError(
          (error) => new EngineError({ code: "persistence", message: error.message }),
        ),
      );
      yield* lock.withPermit(
        Effect.sync(() => {
          if (persisted)
            state = {
              ...state,
              configuration: persisted.configuration,
              interfaceConfiguration: persisted.interfaceConfiguration,
              interfaceState: persisted.interfaceState,
            };
        }).pipe(Effect.andThen(commit())),
      );
      restoring = persisted !== undefined && persisted.pages.length > 0;
      if (persisted)
        for (const page of persisted.pages)
          yield* lock.withPermit(open(page.url, page.id, page.title));
    });

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
                  knownResources,
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

    return {
      start,
      dispatch,
      snapshot: Effect.sync(() => state.browser),
      openPage: openTrusted,
      navigatePage: navigateTrusted,
      closePage: closeTrusted,
      configure,
      configuration: Effect.sync(() => state.configuration),
      publishPluginSurface,
      releasePluginSurface,
      pluginEvents: (owner) =>
        Stream.fromPubSub(pluginEvents).pipe(
          Stream.filter((event) => event.owner === owner),
          Stream.map(({ event, payload }) => ({ event, payload })),
        ),
      lastError: Effect.sync(() => lastError),
    } satisfies BrowserController;
  });
