import type {
  ExtensionInstallationSnapshot,
  ExtensionManagementSnapshot,
  Plugin,
  PluginApi,
} from "@hitchhiker/plugin-sdk";
import {
  button,
  column,
  design,
  iconButton,
  row,
  scroll,
  spacer,
  text,
  type Surface,
} from "@hitchhiker/ui";

import { decode } from "./contracts.ts";
import { Press, UiEvent } from "./input-contracts.ts";
import { serial } from "./state-io.ts";

const main = "main";
const launcher = "launcher";
const pickLocal = "extensions.pick-local";
const back = "extensions.back";
const removePrefix = "extensions.remove:";
const reviewPrefix = "extensions.review:";
const cancelPrefix = "extensions.cancel:";
const maxRows = 32;

const actionFrom = (payload: unknown): string | undefined => {
  const event = decode(UiEvent, payload);
  if (event.event !== "press") return;
  return decode(Press, event.payload).action;
};

const installationLabel = (job: ExtensionInstallationSnapshot) => {
  const suffix = job.error === undefined ? "" : " Needs attention.";
  const identity = job.extension?.name ?? `Installation ${job.operationId.slice(-6)}`;
  return `${identity} ${job.state.replaceAll("_", " ")}.${suffix}`;
};

const extensionLabel = (name: string, version: string, state: string) =>
  `${name} ${version} · ${state}`;
const cancelable = (state: string) =>
  state === "choosing" ||
  state === "receiving" ||
  state === "validating" ||
  state === "awaiting_review" ||
  state === "reviewing" ||
  state === "installing" ||
  state === "error";

/** A self-contained route for the public extension inventory and native review workflow. */
export const createExtensionManagementPlugin = (): Plugin => {
  let api: PluginApi | undefined;
  let inventory: ExtensionManagementSnapshot | undefined;
  let jobs: readonly ExtensionInstallationSnapshot[] = [];
  let error: string | undefined;
  let dark = false;
  let refreshQueued = false;
  const run = serial();

  const publish = async (): Promise<void> => {
    if (!api) throw new Error("Extension management plugin has not activated");
    const colors = dark ? design.dark : design.light;
    const extensionRows = (inventory?.extensions ?? [])
      .slice(0, maxRows)
      .map((extension) =>
        row(
          `extension-${extension.installationId}`,
          [
            text(
              `extension-label-${extension.installationId}`,
              extensionLabel(extension.name, extension.version, extension.state),
              { fg: colors.foreground, flex: 1 },
            ),
            ...(inventory?.readOnly || extension.state === "removed"
              ? []
              : [
                  iconButton(
                    `extension-remove-${extension.installationId}`,
                    `Remove ${extension.name}`,
                    `${removePrefix}${extension.installationId}`,
                    "x",
                    { fg: colors.muted },
                  ),
                ]),
          ],
          { gap: design.spacing.compact, padding: design.spacing.compact },
        ),
      );
    const jobRows = jobs.slice(0, maxRows).map((job) =>
      row(
        `extension-job-${job.operationId}`,
        [
          text(`extension-job-label-${job.operationId}`, installationLabel(job), {
            fg: colors.muted,
            flex: 1,
          }),
          ...(job.state === "awaiting_review"
            ? [
                button(
                  `extension-review-${job.operationId}`,
                  "Request review",
                  `${reviewPrefix}${job.operationId}`,
                ),
              ]
            : []),
          ...(cancelable(job.state)
            ? [
                iconButton(
                  `extension-cancel-${job.operationId}`,
                  "Cancel installation",
                  `${cancelPrefix}${job.operationId}`,
                  "x",
                ),
              ]
            : []),
        ],
        { gap: design.spacing.compact, padding: design.spacing.compact },
      ),
    );
    const empty = inventory !== undefined && inventory.extensions.length === 0 && jobs.length === 0;
    const surface: Omit<Surface, "identity"> = {
      root: column(
        "extensions-main",
        [
          row(
            "extensions-header",
            [
              iconButton("extensions-back", "Back", back, "arrow-left", { fg: colors.muted }),
              text("extensions-title", "Extensions", { fg: colors.foreground }),
              spacer("extensions-header-spacer"),
              ...(inventory === undefined || inventory.readOnly
                ? [text("extensions-read-only", "Read-only", { fg: colors.muted })]
                : [button("extensions-pick-local", "Add extension", pickLocal)]),
            ],
            { gap: design.spacing.compact, padding: design.spacing.panel },
          ),
          ...(error === undefined ? [] : [text("extensions-error", error, { fg: colors.muted })]),
          ...(empty
            ? [text("extensions-empty", "No extensions installed.", { fg: colors.muted })]
            : []),
          scroll("extensions-list", [...extensionRows, ...jobRows], { flex: 1 }),
        ],
        { bg: colors.canvas },
      ),
      bindings: [],
    };
    await api.ui.publishContribution(main, surface);
    await api.ui.publishContribution(launcher, {
      root: iconButton("extensions-launcher", "Extensions", "extensions.open", "puzzle", {
        fg: colors.foreground,
      }),
      bindings: [],
    });
  };

  const refresh = async (preserveActionError = false): Promise<void> => {
    if (!api) throw new Error("Extension management plugin has not activated");
    try {
      const [configuration, nextInventory, nextJobs] = await Promise.all([
        api.configuration.get(),
        api.extensions.list(),
        api.extensions.installation.list(),
      ]);
      dark = configuration.colorScheme === "dark";
      inventory = nextInventory;
      jobs = nextJobs.slice(0, maxRows);
      if (!preserveActionError) error = undefined;
    } catch {
      inventory = undefined;
      jobs = [];
      error = preserveActionError
        ? (error ?? "That extension action could not complete.")
        : "Extensions could not refresh.";
    }
    await publish();
  };

  const action = async (value: string): Promise<void> => {
    if (!api) throw new Error("Extension management plugin has not activated");
    try {
      if (value === "extensions.open") await api.ui.showRoute(main);
      else if (value === back) await api.ui.hideRoute(main);
      else if (value === pickLocal) await api.extensions.installation.pickLocal();
      else if (value.startsWith(removePrefix))
        await api.extensions.remove(value.slice(removePrefix.length));
      else if (value.startsWith(reviewPrefix))
        await api.extensions.installation.requestReview(value.slice(reviewPrefix.length));
      else if (value.startsWith(cancelPrefix))
        await api.extensions.installation.cancel(value.slice(cancelPrefix.length));
      else return;
      error = undefined;
    } catch {
      error = "That extension action could not complete.";
      await refresh(true);
      return;
    }
    await refresh();
  };

  const invalidate = (): Promise<void> | undefined => {
    if (refreshQueued) return;
    refreshQueued = true;
    return run(async () => {
      refreshQueued = false;
      await refresh();
    });
  };

  return {
    async activate(host) {
      api = host;
      await run(refresh);
    },
    onEvent(event, payload) {
      if (event === "extensions.installation.changed") return invalidate();
      if (event !== "ui.event") return;
      try {
        const value = actionFrom(payload);
        return value === undefined ? undefined : run(() => action(value));
      } catch {
        // The host validates UI events; malformed messages cannot affect this route.
      }
    },
  };
};
