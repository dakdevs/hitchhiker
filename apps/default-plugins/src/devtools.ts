import type { DevToolsStatus, Plugin, PluginApi } from "@hitchhiker/plugin-sdk";
import { design, iconButton, row, text, type Surface } from "@hitchhiker/ui";

import { TabState, decode, type TabState as TabStateValue } from "./contracts.ts";
import { Press, ServiceStateEvent, UiEvent } from "./input-contracts.ts";

const inspectAction = "default-devtools.inspect";
const closeAction = "default-devtools.close";

const selectedPageId = (model: TabStateValue | undefined): string | undefined =>
  model?.selection?.kind === "page" ? model.selection.pageId : undefined;

const statusLabel = (status: DevToolsStatus | undefined, pageId: string | undefined): string => {
  if (pageId === undefined) return "Choose a page to inspect.";
  if (status === undefined) return "Inspector status is unavailable.";
  return `Inspector ${status.state}.`;
};

const actionFrom = (payload: unknown): string | undefined => {
  const event = decode(UiEvent, payload);
  if (event.event !== "press") return;
  return decode(Press, event.payload).action;
};

/**
 * A small toolbar contribution that owns inspector controls for the currently selected page.
 * Page identity comes solely from the tab-model service; this plugin never reads page state itself.
 */
export const createDevToolsPlugin = (): Plugin => {
  let api: PluginApi | undefined;
  let model: TabStateValue | undefined;
  let status: DevToolsStatus | undefined;
  let error: string | undefined;
  let tail: Promise<void> = Promise.resolve();

  const publish = async (): Promise<void> => {
    if (!api) throw new Error("DevTools plugin has not activated");
    const pageId = selectedPageId(model);
    const colors = design.light;
    const controls =
      pageId === undefined
        ? []
        : [
            iconButton(
              "default-devtools-inspect",
              "Inspect selected page",
              inspectAction,
              "search",
              { fg: colors.foreground },
            ),
            ...(status?.state === "open" || status?.state === "opening"
              ? [
                  iconButton("default-devtools-close", "Close inspector", closeAction, "x", {
                    fg: colors.foreground,
                  }),
                ]
              : []),
          ];
    const surface: Omit<Surface, "identity"> = {
      root: row(
        "default-devtools-toolbar",
        [
          text("default-devtools-status", statusLabel(status, pageId), {
            fg: error === undefined ? colors.muted : colors.foreground,
          }),
          ...controls,
          ...(error === undefined
            ? []
            : [text("default-devtools-error", error, { fg: colors.muted })]),
        ],
        { gap: design.spacing.compact, padding: design.spacing.compact },
      ),
      bindings: [],
    };
    await api.ui.publishContribution("toolbar", surface);
  };

  const readModel = async (): Promise<string | undefined> => {
    if (!api) throw new Error("DevTools plugin has not activated");
    const snapshot = await api.services.get("model");
    model = snapshot.available ? decode(TabState, snapshot.value) : undefined;
    return selectedPageId(model);
  };

  /** Always re-read the model before status so delayed lifecycle events cannot revive stale selection. */
  const refresh = async (): Promise<void> => {
    if (!api) throw new Error("DevTools plugin has not activated");
    try {
      const pageId = await readModel();
      status = pageId === undefined ? undefined : await api.devtools.status(pageId);
      error = undefined;
    } catch {
      model = undefined;
      status = undefined;
      error = "Developer tools could not refresh.";
    }
    await publish();
  };

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  };

  const act = async (action: string): Promise<void> => {
    if (!api) throw new Error("DevTools plugin has not activated");
    if (action !== inspectAction && action !== closeAction) return;
    let pageId: string | undefined;
    try {
      pageId = await readModel();
    } catch {
      model = undefined;
      status = undefined;
      error = "Developer tools could not refresh.";
      await publish();
      return;
    }
    if (pageId === undefined) {
      status = undefined;
      error = "Choose a page to inspect.";
      await publish();
      return;
    }
    try {
      if (action === inspectAction) await api.devtools.show(pageId);
      else await api.devtools.close(pageId);
      error = undefined;
    } catch {
      error = "Developer tools action was denied or could not complete.";
      await publish();
      return;
    }
    await refresh();
  };

  return {
    async activate(host) {
      api = host;
      await api.services.subscribe("model");
      await enqueue(refresh);
    },
    onEvent(event, payload) {
      if (event === "service.state") {
        try {
          const changed = decode(ServiceStateEvent, payload);
          if (changed.dependency === "model") return enqueue(refresh);
        } catch {
          // A malformed notification is not a reason to tear down this independent toolbar.
        }
        return;
      }
      if (event === "devtools.changed") return enqueue(refresh);
      if (event !== "ui.event") return;
      try {
        const action = actionFrom(payload);
        return action === undefined ? undefined : enqueue(() => act(action));
      } catch {
        // Ignore malformed UI input; host-side event validation remains authoritative.
      }
    },
  };
};
