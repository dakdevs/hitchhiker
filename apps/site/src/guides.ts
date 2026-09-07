export interface GuideSection {
  readonly id: string;
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly code?: string;
  readonly table?: {
    readonly headings: readonly string[];
    readonly rows: readonly (readonly string[])[];
  };
}

export const pluginGuide: readonly GuideSection[] = [
  {
    id: "plugin-architecture",
    title: "A browser assembled from plugins",
    paragraphs: [
      "Hitchhiker is being built as a Chromium host with a shared Native design framework. The target default browser is a composition of plugins: a tab model, vertical or horizontal presentation, optional pinning, navigation, and developer tools. Those pieces must use the same public APIs as third-party plugins.",
      "This migration is not complete. The current SDK can replace the whole interface, while the built-in controller still owns default tab behavior. Independently composed UI contributions, plugin services, and dependency-aware activation are the next framework work. Do not rely on those planned APIs until they appear in the reference.",
    ],
  },
  {
    id: "chromium-capabilities",
    title: "Which Chromium controls are available?",
    paragraphs: [
      "Chromium runs the pages; the plugin host controls access to its services. A private native command, an MCP tool, and a plugin SDK method are different entry points. This table describes the current implementation, not the full planned API.",
      "Hitchhiker capability grants are separate from Chromium site permissions. Raw CDP uses an explicitly authorized relay; browser.full-control does not include cdp.connect. Although a plugin manifest can declare cdp.connect, the plugin dispatcher does not yet expose a CDP method.",
    ],
    table: {
      headings: ["Capability", "Available today", "Plugin SDK"],
      rows: [
        ["Pages", "List, open, navigate, close through plugins and MCP", "Implemented"],
        ["Back / forward / reload / stop", "Private native host and default controller", "Planned"],
        ["DOM inspection and interaction", "Scoped MCP snapshot, click and fill", "Planned"],
        ["CDP", "Explicitly authorized raw relay and private host adapter", "Planned"],
        [
          "Cookies, storage and network",
          "Chromium/CDP capabilities; no typed Hitchhiker service",
          "Planned",
        ],
        ["Site permissions", "Chromium behavior; no public query/configuration service", "Planned"],
        [
          "Downloads",
          "Native handler and page activity protection signal",
          "Management API planned",
        ],
        [
          "Chrome extensions",
          "Trusted review, install, remove and restart replay",
          "Management API planned",
        ],
        [
          "DevTools interface",
          "CEF primitives are available; host integration is unfinished",
          "Default plugin planned",
        ],
      ],
    },
  },
  {
    id: "workspace",
    title: "Create a plugin workspace",
    paragraphs: [
      "The SDK is currently distributed in this repository, not as a published npm release. Add apps/my-browser with the package file below, src/index.ts, and hitchhiker.plugin.json. Run pnpm install from the repository root, then pnpm --filter @hitchhiker/my-browser build. The build produces the single JavaScript file the isolated runtime accepts.",
    ],
    code: JSON.stringify(
      {
        name: "@hitchhiker/my-browser",
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          build:
            "esbuild src/index.ts --bundle --format=iife --platform=browser --target=safari17 --outfile=dist/plugin.js",
        },
        dependencies: {
          "@hitchhiker/plugin-sdk": "workspace:0.1.0",
          "@hitchhiker/ui": "workspace:0.1.0",
        },
        devDependencies: { esbuild: "0.28.2" },
      },
      null,
      2,
    ),
  },
  {
    id: "manifest",
    title: "Declare the required capabilities",
    paragraphs: [
      "Save this as hitchhiker.plugin.json. This example opens a page and replaces the interface, so it declares pages.manage and ui.compose. The ID is stable across updates and must match the principal of a developer grant. A manifest declares requirements; it does not issue permissions.",
    ],
    code: JSON.stringify(
      {
        id: "my-browser",
        name: "My browser",
        version: "0.1.0",
        capabilities: ["pages.manage", "ui.compose"],
      },
      null,
      2,
    ),
  },
  {
    id: "page-surface",
    title: "Put a Chromium page in your interface",
    paragraphs: [
      "Save this entry point as src/index.ts. Native measures the content viewport; the binding associates it with the stable ID returned by the page API. Reorganizing that viewport later does not reload the page. An interface can use several viewports without adopting the default tab model.",
    ],
    code: `import { definePlugin } from "@hitchhiker/plugin-sdk";
import { column, text, viewport } from "@hitchhiker/ui";

definePlugin({
  async activate(browser) {
    const { pageId } = await browser.pages.open("https://example.com");
    await browser.ui.publish({
      root: column("browser", [
        text("heading", "My browser", { padding: 12 }),
        viewport("content", "main", { flex: 1 }),
      ], { flex: 1 }),
      bindings: [{ viewportId: "main", pageId }],
    });
  },
});`,
  },
  {
    id: "plugin-api",
    title: "Plugin API reference",
    paragraphs: [
      "All methods return Promises. Await host calls and handle rejection. Both the declared capability and a live grant are required. Configuration reads currently use configuration.write as well; there is no separate configuration.read capability.",
    ],
    table: {
      headings: ["Method", "Capability", "Result"],
      rows: [
        ["pages.list()", "pages.list", "BrowserPage[] with stable IDs and current lifecycle"],
        ["pages.open(url)", "pages.manage", "{ pageId }"],
        ["pages.navigate(pageId, url)", "pages.manage", "void; retains the page ID"],
        ["pages.close(pageId)", "pages.manage", "void; requests closure through Chromium"],
        ["configuration.get()", "configuration.write", "BrowserConfiguration"],
        ["configuration.set(configuration)", "configuration.write", "void; validated replacement"],
        ["ui.publish(surface)", "ui.compose", "{ revision }; replaces the interface"],
        ["ui.release()", "ui.compose", "void; returns to the default interface"],
      ],
    },
  },
  {
    id: "run-plugin",
    title: "Run and install the compiled plugin",
    paragraphs: [
      "After building the native helpers, issue a developer grant and supply its one-time token through HITCHHIKER_PLUGIN_TOKEN. The commands below use the default profile; pass the same absolute --profile-root to both grants and browser commands for a separate test profile.",
      "For persistent installation, connect an MCP client with plugins.install plus the plugin’s requested capabilities. Call hitchhiker_plugin_install with the parsed manifest as manifest and the contents of dist/plugin.js as code. The server accepts uploaded code, not a filesystem path. Keep the entire JSON request below 256 KiB, including escaping.",
    ],
    code: `pnpm --filter @hitchhiker/browser grants issue \\
  --principal=my-browser --capabilities=pages.manage,ui.compose
export HITCHHIKER_PLUGIN_TOKEN="TOKEN_FROM_ISSUE"
export HITCHHIKER_NATIVE_BINARY="$PWD/work/host-probe/build/Release/hitchhiker-probe.app/Contents/MacOS/hitchhiker-probe"
export HITCHHIKER_PLUGIN_HOST="$PWD/work/plugin-host/build/PluginHost.app/Contents/MacOS/plugin-host"
pnpm --filter @hitchhiker/browser dev --plugin="$PWD/apps/my-browser"`,
  },
  {
    id: "lifecycle",
    title: "Handle events, updates, and recovery",
    paragraphs: [
      "definePlugin accepts an optional onEvent(event, payload) callback. Validate payload as unknown before reading it. Page notifications include pages.created, pages.closed, and pages.titleChanged. ui.event carries input for the current owner and revision; a press event’s nested payload contains the button action. The checked-in canvas example demonstrates this handling and reconciliation when pages close.",
      "Activation completes when its returned Promise resolves. Workers have no Node, filesystem, direct network, or timer APIs. Do not poll or busy-wait; react to forwarded events and use the host API. Unhandled failures, revoked grants, and resource violations stop the worker and restore the trusted interface.",
      "Installing a new revision of the same ID retains one prior revision for rollback. Rollback restores code and interface state, but does not undo navigation, page creation, or configuration changes already performed. The Plugins screen provides enable, disable, rollback, and Remove. Start with --safe-mode to bypass a broken plugin store; persistent installation tools are unavailable for that launch.",
      "Remove, or hitchhiker_plugin_uninstall over MCP, stops the worker, revokes its current and rollback grants, and removes the installation while keeping your pages open. Cached compiled artifacts remain. Historical grants no longer referenced by the installation are not revoked. Removal requires plugins.install over MCP. After a persistence or revocation failure, restart before retrying; a disabled entry retains the information needed to finish removal.",
    ],
  },
  {
    id: "portable-customization",
    title: "Share a browser configuration",
    paragraphs: [
      "Use hitchhiker_customization_export over MCP to receive result.recipe, a portable JSON string. Pass includePlugins: true to include installed Hitchhiker plugin manifests, exact artifact hashes and desired enabled states. Settings export needs configuration.write; plugin metadata also needs plugins.install. Always-awake origins are included and can reveal which sites you configure.",
      "Pass the string as recipe to hitchhiker_customization_import. It applies browser settings and default tab placement together and returns pluginRequirements with pluginsChanged: false. Import never installs code, grants permissions, enables or disables plugins. Install and authorize required plugins separately through the existing plugin tools. A custom plugin interface keeps ownership of its pages and layout.",
      "Recipes accept version 1, up to 64 unique plugin IDs and 128 KiB of UTF-8 JSON. Unknown fields are rejected. Browsing sessions, history, cookies, credentials, plugin storage and executable code are excluded. Chrome extension transfer, plugin-specific settings and automatic sync are not yet included.",
    ],
    code: JSON.stringify(
      {
        version: 1,
        configuration: { colorScheme: "system", sleepAfterMs: 300000, alwaysAwakeOrigins: [] },
        interface: { tabPlacement: "sidebar" },
        plugins: [],
      },
      null,
      2,
    ),
  },
];

export const nativeUiGuide: readonly GuideSection[] = [
  {
    id: "components",
    title: "Component reference",
    paragraphs: [
      "Every node has a stable key. Container children form the Native tree; style is an optional final argument. Buttons name an action that returns in an owner-scoped input event.",
    ],
    table: {
      headings: ["Constructor", "Purpose"],
      rows: [
        ["row(key, children, style)", "Horizontal layout"],
        ["column(key, children, style)", "Vertical layout"],
        ["stack(key, children, style)", "Layered native content"],
        ["scroll(key, children, style)", "Scrollable native content"],
        ["text(key, label, style)", "Text using native typography tokens"],
        ["button(key, label, action, style)", "Action control; style can include a Lucide icon"],
        [
          "listItem(key, label, action, style)",
          "Compact, left-aligned action row with an optional leading icon",
        ],
        ["input(key, label, value, style)", "Text input; style can include placeholder and action"],
        ["icon(key, name, style)", "An embedded Lucide icon"],
        [
          "iconButton(key, label, action, name, style)",
          "Icon-only control with a required semantic label",
        ],
        ["windowControls(key)", "Reserves 80 × 36 points for macOS traffic lights"],
        ["dragRegion(key, style)", "Empty, measured space that starts native window dragging"],
        ["spacer(key, flex)", "Flexible empty space; flex defaults to 1"],
        ["viewport(key, viewportId, style)", "A slot for a bound Chromium page"],
      ],
    },
  },
  {
    id: "style-tokens",
    title: "Use the shared design tokens",
    paragraphs: [
      "Style accepts width, height, flex, padding, gap, bg, fg, radius, and fontSize. Import design for the current light/dark palettes, spacing, radii, and motion durations. Motion values are a shared contract; they do not animate Native trees automatically in the current renderer.",
      "Import lucideNames for the supported icon names, or use lucide(name) for a button icon. Native surfaces currently support 23 embedded Lucide assets. Arbitrary SVG, CSS, DOM components, and web script are not Native node types.",
    ],
    code: `import { button, design, lucide } from "@hitchhiker/ui";

const control = button("new", "New page", "new-page", {
  icon: lucide("plus"),
  padding: design.spacing.control,
  radius: design.radius.control,
  bg: design.light.sidebar,
  fg: design.light.foreground,
});`,
  },
  {
    id: "window-header",
    title: "Build your own window header",
    paragraphs: [
      "Buttons also accept ghost or secondary variants and an accessibilityLabel for abbreviated visible text. The default pinned tiles use site initials as a fallback; real page favicons are not yet supplied by the host.",
      "The macOS shell draws into the full window. Reserve its real close, minimize, and fullscreen buttons with windowControls at the top-left; do not draw substitute traffic lights. windowChrome exports the 36-point header height and 80-point controls width.",
      "Place iconButton controls and an empty dragRegion beside that reserve. Give the drag region a height and enough width to grab. Native measures its bounds and excludes buttons, inputs, Chromium viewports, and visible system buttons. A drag region cannot contain children. Your plugin chooses the actions, page organization, and remaining layout.",
    ],
    code: `import { dragRegion, iconButton, row, windowChrome, windowControls } from "@hitchhiker/ui";

const header = row("header", [
  windowControls("system-buttons"),
  iconButton("organize", "Show pages", "pages.show", "panel-left", {
    width: 28, height: windowChrome.height,
  }),
  dragRegion("move-window", { height: windowChrome.height }),
], { height: windowChrome.height, gap: 4 });`,
  },
  {
    id: "surface-limits",
    title: "Keep a surface bounded",
    paragraphs: [
      "The host validates the complete tree before replacing the working interface. Keep trees within 250 nodes, depth 12, and 100 children per container. Page bindings and component keys must be valid and unambiguous. The host measures viewport geometry; plugins cannot supply arbitrary Chromium rectangles.",
      "Keep page organization in your interface state. When a page closes, remove its stale binding before publishing the next surface. Use stable keys when updating labels or input values. Publish only when the interface changes instead of repeatedly sending identical trees.",
    ],
  },
];
