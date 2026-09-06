import { button, column, input, lucide, row, scroll, text, type Surface } from "@hitchhiker/ui";
import type { Effect } from "effect";
import type { ExtensionArtifact } from "./extension-artifacts.ts";

export type ExtensionPreview = Omit<ExtensionArtifact, "directory">;
export interface ExtensionControlEntry {
  readonly installationId: string;
  readonly digest: string;
  readonly name: string;
  readonly version: string;
  readonly state: string;
  readonly errorIntent?: "install" | "remove";
  readonly status: string;
}
/** Trusted local controls. This interface is never passed to plugins or MCP. */
export interface BrowserExtensionControls {
  readonly list: () => Effect.Effect<readonly ExtensionControlEntry[], unknown>;
  readonly previewLocal: (path: string) => Effect.Effect<ExtensionPreview, unknown>;
  readonly reviewPrepared: (id: string, digest: string) => Effect.Effect<ExtensionPreview, unknown>;
  readonly confirmInstall: (id: string, digest: string) => Effect.Effect<unknown, unknown>;
  readonly cancelPreview: (id: string, digest: string) => Effect.Effect<unknown, unknown>;
  readonly remove: (id: string) => Effect.Effect<unknown, unknown>;
  readonly readOnly: boolean;
}
export interface ExtensionControlsState {
  readonly entries: readonly ExtensionControlEntry[];
  readonly directory: string;
  readonly preview?: ExtensionPreview;
  readonly permissionPage: number;
  readonly reviewedThrough: number;
  readonly status?: string;
  readonly busy: boolean;
  readonly readOnly: boolean;
  readonly available: boolean;
}
const permissionGroups = [
  ["Required permissions", "permissions"],
  ["Required site access", "host_permissions"],
  ["Optional permissions", "optional_permissions"],
  ["Optional site access", "optional_host_permissions"],
] as const;
export const extensionPermissionRows = (preview: ExtensionPreview) =>
  permissionGroups.flatMap(([label, field]) =>
    preview[field].length
      ? preview[field].map((permission) => `${label}: ${permission}`)
      : [`${label}: none`],
  );
export const extensionPermissionPages = (preview: ExtensionPreview) =>
  Math.ceil(extensionPermissionRows(preview).length / 20);
const displayName = (value: string) =>
  Array.from(value, (scalar) => (scalar.codePointAt(0)! < 32 || scalar === "\u007f" ? " " : scalar))
    .slice(0, 160)
    .join("");

export const renderExtensionControls = (state: ExtensionControlsState): Surface => {
  const preview = state.preview;
  const pages = preview ? extensionPermissionPages(preview) : 1;
  const canChange = state.available && !state.readOnly && !state.busy;
  return {
    root: scroll(
      "extensions",
      [
        text("extensions-title", "Chrome extensions", { fontSize: 18 }),
        text("extensions-description", "Unpacked developer extensions · Manifest V3"),
        text(
          "extensions-compatibility",
          "Content scripts, workers and storage are supported. Chrome Web Store installation, toolbar popups and shared-window tabs are still in development.",
        ),
        ...(state.status ? [text("extensions-status", state.status)] : []),
        ...(!state.available
          ? [
              text(
                "extensions-unavailable",
                "Extension management is unavailable. Safe mode skips extensions; restart normally to manage them.",
              ),
            ]
          : []),
        ...(state.readOnly
          ? [
              text(
                "extensions-read-only",
                "Extension management is read-only during a raw CDP session. Restart without --cdp to make changes.",
              ),
            ]
          : []),
        ...(canChange && !preview
          ? [
              input("extension-directory", "Unpacked extension directory", state.directory, {
                placeholder: "/absolute/path/to/extension",
                action: "extensions.preview",
              }),
              button("extensions-preview", "Review extension…", "extensions.preview", {
                icon: lucide("puzzle"),
              }),
            ]
          : []),
        ...(preview
          ? [
              column(
                "extension-review",
                [
                  text(
                    "extension-review-title",
                    `Review ${displayName(preview.name)} · ${preview.version}`,
                    { fontSize: 15 },
                  ),
                  text(
                    "extension-review-copy",
                    "Installing grants the required Chrome permissions below. Optional permissions may be requested later by the extension.",
                  ),
                  text("extension-review-id", `Chromium ID: ${preview.expectedChromiumId}`),
                  text("extension-review-digest", `Package SHA-256: ${preview.digest}`),
                  ...extensionPermissionRows(preview)
                    .slice(state.permissionPage * 20, (state.permissionPage + 1) * 20)
                    .map((permission, index) => text(`extension-permission-${index}`, permission)),
                  text(
                    "extension-review-page",
                    `Permissions ${state.permissionPage + 1} of ${pages}`,
                  ),
                  row(
                    "extension-review-pages",
                    [
                      ...(state.permissionPage > 0
                        ? [
                            button(
                              "extension-review-previous",
                              "Previous",
                              "extensions.permissions.previous",
                            ),
                          ]
                        : []),
                      ...(state.permissionPage + 1 < pages
                        ? [button("extension-review-next", "Next", "extensions.permissions.next")]
                        : []),
                    ],
                    { gap: 8 },
                  ),
                  ...(canChange
                    ? [
                        row(
                          "extension-review-actions",
                          [
                            ...(state.reviewedThrough >= pages - 1
                              ? [
                                  button(
                                    "extension-install",
                                    "Install extension",
                                    "extensions.install",
                                  ),
                                ]
                              : [
                                  text(
                                    "extension-review-required",
                                    "Review every permissions page to install.",
                                  ),
                                ]),
                            button("extension-cancel", "Cancel", "extensions.cancel"),
                          ],
                          { gap: 8 },
                        ),
                      ]
                    : []),
                ],
                { gap: 8, padding: 12 },
              ),
            ]
          : []),
        text("extensions-installed-title", "Managed extensions", { fontSize: 15 }),
        ...state.entries
          .slice(0, 16)
          .map((entry) =>
            column(
              `extension-${entry.installationId}`,
              [
                text(
                  `extension-${entry.installationId}-name`,
                  `${displayName(entry.name)} · ${entry.version}`,
                ),
                text(`extension-${entry.installationId}-state`, entry.status),
                ...(canChange &&
                !preview &&
                (entry.state === "prepared" ||
                  (entry.state === "error" && entry.errorIntent === "install"))
                  ? [
                      button(
                        `extension-${entry.installationId}-review`,
                        entry.state === "prepared" ? "Resume review" : "Review retry",
                        `extensions.review.${entry.installationId}`,
                      ),
                    ]
                  : []),
                ...(canChange &&
                (entry.state === "enabled" ||
                  entry.state === "removing" ||
                  (entry.state === "error" && entry.errorIntent === "remove"))
                  ? [
                      button(
                        `extension-${entry.installationId}-remove`,
                        entry.state === "enabled" ? "Remove" : "Retry removal",
                        `extensions.remove.${entry.installationId}`,
                      ),
                    ]
                  : []),
              ],
              { gap: 8, padding: 8 },
            ),
          ),
        button("extensions-back", "Back", "interface.settings"),
      ],
      { padding: 20, gap: 12, flex: 1 },
    ),
    bindings: [],
  };
};
