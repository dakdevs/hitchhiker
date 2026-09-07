import type { BrowserPage, BrowserState } from "@hitchhiker/core";
import {
  defaultSurfaceActions,
  renderDefaultSurface,
  type DefaultInterfaceState,
  type TabPlacement,
} from "@hitchhiker/default-interface";
import {
  PluginApiError,
  type Json,
  type ObservedPage,
  type Plugin,
  type PluginApi,
  type ServiceSnapshot,
} from "@hitchhiker/plugin-sdk";
import {
  column,
  design,
  reduceNativeTextInput,
  text,
  type NativeNode,
  type NativeTextInputEvent,
  type NativeTextInputState,
  type Surface,
} from "@hitchhiker/ui";
import type { Schema } from "effect";

import { PinState, TabState, decode } from "./contracts.ts";
import { Input, Press, ServiceStateEvent, UiEvent } from "./input-contracts.ts";
import { readPages, serial } from "./state-io.ts";

const initialInput = (): NativeTextInputState => ({
  text: "",
  anchor: 0,
  focus: 0,
  composition: null,
});

const children = (node: NativeNode): readonly NativeNode[] => {
  if (!("children" in node)) throw new Error("Default surface structure changed");
  return node.children;
};

const fragments = (
  surface: Surface,
  presentation: TabPlacement,
  tabsVisible: boolean,
): Readonly<Record<"tabs" | "toolbar" | "content", Omit<Surface, "identity">>> => {
  const root = children(surface.root);
  let tabs: NativeNode;
  let toolbar: NativeNode;
  let content: NativeNode;
  if (presentation === "sidebar" && tabsVisible) {
    tabs = root[0]!;
    const main = children(root[1]!);
    toolbar = main[0]!;
    content = main[1]!;
  } else {
    toolbar = root[0]!;
    if (tabsVisible && presentation === "top") {
      tabs = root[1]!;
      content = root[2]!;
    } else {
      tabs = column("hidden-tabs", []);
      content = root[1]!;
    }
  }
  const bindings = content.kind === "viewport" ? surface.bindings : [];
  return Object.freeze({
    tabs: { root: tabs, bindings: [] },
    toolbar: { root: toolbar, bindings: [] },
    content: { root: content, bindings },
  });
};

const withoutPinControls = (node: NativeNode): NativeNode => {
  if (!("children" in node)) return node;
  return {
    ...node,
    children: node.children
      .filter((child) => !child.key.startsWith("page-pin-"))
      .map(withoutPinControls),
  };
};

const withoutUnavailableRoutes = (node: NativeNode, dark: boolean): NativeNode => {
  if (node.kind === "button" && (node.key === "plugins" || node.key === "settings"))
    return text(node.key, node.label, {
      width: 28,
      height: 28,
      fg: dark ? design.dark.muted : design.light.muted,
    });
  if (!("children" in node)) return node;
  return { ...node, children: node.children.map((child) => withoutUnavailableRoutes(child, dark)) };
};

const observedPage = (page: ObservedPage): BrowserPage => ({ ...page, lastUsedAt: 0 });

const requiredState = <A>(snapshot: ServiceSnapshot, schema: Schema.Codec<A>): A => {
  if (!snapshot.available) throw new Error("Required service is unavailable");
  return decode(schema, snapshot.value);
};

const optionalState = <A>(snapshot: ServiceSnapshot, schema: Schema.Codec<A>): A | undefined =>
  snapshot.available ? decode(schema, snapshot.value) : undefined;

const addressUrl = (draft: string): string | undefined => {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return;
  if (/\s/.test(trimmed) || (!trimmed.includes(".") && !trimmed.includes(":")))
    return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") return;
  return scheme === undefined ? `https://${trimmed}` : trimmed;
};

/** A real isolated presentation assembled entirely through public page, service, and UI APIs. */
export const createPresenterPlugin = (presentation: TabPlacement): Plugin => {
  let api: PluginApi | undefined;
  let model: TabState | undefined;
  let pins: PinState | undefined;
  let pages: readonly ObservedPage[] = [];
  let tabsVisible = true;
  let pageOffset = 0;
  let input = initialInput();
  let inputDirty = false;
  let refreshDirty = false;
  let refreshing: Promise<void> | undefined;
  const runCommand = serial();

  const selectedPage = () => {
    const id = model?.selection?.kind === "page" ? model.selection.pageId : undefined;
    return id === undefined ? undefined : pages.find((page) => page.id === id);
  };

  const publish = async (): Promise<void> => {
    if (!api) throw new Error("Presenter plugin has not activated");
    const pageSnapshot = await readPages(api);
    const modelSnapshot = await api.services.get("model");
    const pinSnapshot = await api.services.get("pins");
    const nextModel = requiredState(modelSnapshot, TabState);
    const nextPins = optionalState(pinSnapshot, PinState);
    const liveIds = new Set(pageSnapshot.pages.map((page) => page.id));
    const selectedId =
      nextModel.selection?.kind === "page" && liveIds.has(nextModel.selection.pageId)
        ? nextModel.selection.pageId
        : undefined;
    const profileId = pageSnapshot.pages[0]?.profileId ?? "default";
    const browser: BrowserState = {
      pages: pageSnapshot.pages.map(observedPage),
      viewports: [],
    };
    const state: DefaultInterfaceState = {
      profileId,
      ...(selectedId === undefined ? {} : { selectedPageId: selectedId }),
      pageOrder: nextModel.pageOrder.filter((id) => liveIds.has(id)),
      pinnedPageIds: (nextPins?.pinnedPageIds ?? []).filter((id) => liveIds.has(id)),
    };
    if (!inputDirty) {
      const text = pageSnapshot.pages.find((page) => page.id === selectedId)?.url ?? "";
      input = { text, anchor: -1, focus: -1, composition: null };
    }
    const configuration = await api.configuration.get();
    const dark = configuration.colorScheme === "dark";
    const rendered = renderDefaultSurface(
      browser,
      state,
      { tabPlacement: presentation },
      {
        addressDraft: input.text,
        dark,
        pageOffset,
        tabsVisible,
      },
    );
    model = nextModel;
    pins = nextPins;
    pages = pageSnapshot.pages;
    const parts = fragments(
      { ...rendered, root: withoutUnavailableRoutes(rendered.root, dark) },
      presentation,
      tabsVisible,
    );
    const tabSurface =
      nextPins === undefined
        ? { ...parts.tabs, root: withoutPinControls(parts.tabs.root) }
        : parts.tabs;
    await api.ui.publishContribution("tabs", tabSurface);
    await api.ui.publishContribution("toolbar", parts.toolbar);
    await api.ui.publishContribution("content", parts.content);
  };

  const requestRefresh = (): Promise<void> => {
    refreshDirty = true;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      while (refreshDirty) {
        refreshDirty = false;
        await publish();
      }
    })().finally(async () => {
      refreshing = undefined;
      // A notification can arrive after the loop's final check but before this cleanup runs.
      if (refreshDirty) await requestRefresh();
    });
    return refreshing;
  };

  const callModel = (method: string, params: Json) => {
    if (!api) throw new Error("Presenter plugin has not activated");
    return api.services.call("model", method, params);
  };

  const handlePress = async (action: string): Promise<void> => {
    if (!api) throw new Error("Presenter plugin has not activated");
    if (action === defaultSurfaceActions.toggleTabs) {
      tabsVisible = !tabsVisible;
      await api.services.call("layout", "setPresentation", {
        presentation: presentation === "sidebar" && !tabsVisible ? "top" : presentation,
      });
    } else if (action === defaultSurfaceActions.newPage) {
      await callModel("new", {});
      input = initialInput();
      inputDirty = false;
    } else if (action === defaultSurfaceActions.navigate) {
      const url = addressUrl(input.text);
      if (url !== undefined) {
        const page = selectedPage();
        if (page && model?.selection?.kind === "page") await api.pages.navigate(page.id, url);
        else await callModel("open", { url });
        inputDirty = false;
      }
    } else if (action === defaultSurfaceActions.back) {
      const page = selectedPage();
      if (page) await api.pages.back(page.id);
    } else if (action === defaultSurfaceActions.forward) {
      const page = selectedPage();
      if (page) await api.pages.forward(page.id);
    } else if (action === defaultSurfaceActions.reload) {
      const page = selectedPage();
      if (page) await api.pages.reload(page.id);
    } else if (action === defaultSurfaceActions.previousSlice) {
      pageOffset = Math.max(0, pageOffset - 30);
    } else if (action === defaultSurfaceActions.nextSlice) {
      pageOffset += 30;
    } else {
      const pageAction = /^(page\.(?:select|close|pin|unpin)):([A-Za-z][A-Za-z0-9_-]{0,63})$/.exec(
        action,
      );
      const reorder = /^page\.reorder:([A-Za-z][A-Za-z0-9_-]{0,63}):(\d{1,3})$/.exec(action);
      if (pageAction) {
        const [, operation, pageId] = pageAction;
        if (operation === "page.select") {
          await callModel("select", { pageId });
          inputDirty = false;
        } else if (operation === "page.close") await callModel("close", { pageId });
        else if (pins !== undefined)
          await api.services.call("pins", "set", { pageId, pinned: operation === "page.pin" });
      } else if (reorder) {
        await callModel("reorder", { pageId: reorder[1]!, index: Number(reorder[2]) });
      }
      // Settings and Plugins stay visible for screenshot parity. They intentionally have no
      // private route; public management-screen composition is a tracked cutover prerequisite.
    }
    await requestRefresh();
  };

  return {
    async activate(host) {
      api = host;
      await api.services.call("layout", "setPresentation", { presentation });
      await api.services.subscribe("model");
      await api.services.subscribe("pins");
      await api.services.subscribe("layout");
      await requestRefresh();
    },
    onPagesChanged() {
      return requestRefresh();
    },
    onEvent(event, payload) {
      if (event === "service.state") {
        decode(ServiceStateEvent, payload);
        return requestRefresh();
      }
      if (event !== "ui.event") return;
      const uiEvent = decode(UiEvent, payload);
      if (uiEvent.event === "input" && uiEvent.nodeId === "address") {
        const change = decode(Input, uiEvent.payload) as NativeTextInputEvent;
        input = reduceNativeTextInput(input, change);
        inputDirty = true;
        return requestRefresh();
      }
      if (uiEvent.event !== "press") return;
      const press = decode(Press, uiEvent.payload);
      return runCommand(() => handlePress(press.action)).catch((error) => {
        if (error instanceof PluginApiError) return;
        throw error;
      });
    },
  };
};
