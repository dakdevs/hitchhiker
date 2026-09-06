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
      "Installing a new revision of the same ID retains one prior revision for rollback. Rollback restores code and interface state, but does not undo navigation, page creation, or configuration changes already performed. The Plugins screen provides enable, disable, and rollback. Start with --safe-mode to bypass a broken plugin store; persistent installation tools are unavailable for that launch.",
    ],
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
        ["input(key, label, value, style)", "Text input; style can include placeholder and action"],
        ["icon(key, name, style)", "An embedded Lucide icon"],
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
    id: "surface-limits",
    title: "Keep a surface bounded",
    paragraphs: [
      "The host validates the complete tree before replacing the working interface. Keep trees within 250 nodes, depth 12, and 100 children per container. Page bindings and component keys must be valid and unambiguous. The host measures viewport geometry; plugins cannot supply arbitrary Chromium rectangles.",
      "Keep page organization in your interface state. When a page closes, remove its stale binding before publishing the next surface. Use stable keys when updating labels or input values. Publish only when the interface changes instead of repeatedly sending identical trees.",
    ],
  },
];
