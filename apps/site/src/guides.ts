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
      "This migration is not complete. Installed plugins can now exchange declared services with dependency-aware activation, while the built-in controller still owns default tab behavior. The manager supports live composition and service plans through MCP; native switching verification and the default-browser migration remain unfinished. Do not assume that every default-browser feature is a plugin yet.",
    ],
  },
  {
    id: "chromium-capabilities",
    title: "Which Chromium controls are available?",
    paragraphs: [
      "Chromium runs the pages; the plugin host controls access to its services. A private native command, an MCP tool, and a plugin SDK method are different entry points. This table describes the current implementation, not the full planned API.",
      "Hitchhiker capability grants are separate from Chromium site permissions. Raw CDP uses an explicitly authorized relay; browser.full-control does not include cdp.connect. Although a plugin manifest can declare cdp.connect, the plugin dispatcher does not yet expose a CDP method.",
      "The current configuration service exposes colorScheme, sleepAfterMs, and alwaysAwakeOrigins for appearance and page sleeping. Chromium site permission queries and decisions require a separate service, which is still planned. The API reference lists the exact public methods and grants available today.",
      "The planned DevTools plugin will use public inspection and presentation APIs. Customizing its Native controls, extending the DevTools frontend, and changing Chromium itself are different capabilities; each will be documented separately as it becomes available. Security controls will document their defaults, profile or origin scope, persistence, and restart requirements alongside the grant needed to change them.",
    ],
    table: {
      headings: ["Capability", "Available today", "Plugin SDK"],
      rows: [
        ["Pages", "List, open, navigate, close through plugins and MCP", "Implemented"],
        ["Back / forward / reload / stop", "Plugin SDK and MCP with pages.manage", "Implemented"],
        [
          "Page state watch",
          "Revisioned snapshots and coalesced invalidations with pages.list",
          "Implemented",
        ],
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
    title: "Put a Chromium page in a legacy interface",
    paragraphs: [
      "Save this entry point as src/index.ts. Native measures the content viewport; the binding associates it with the stable ID returned by the page API. Reorganizing that viewport later does not reload the page. An interface can use several viewports without adopting the default tab model. ui.publish is a legacy whole-window operation. In a composed profile it aliases ui.publishLayout and is accepted only for the configured layout owner. New layout plugins should use ui.publishLayout.",
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
    id: "composition",
    title: "Compose independently installed UI plugins",
    paragraphs: [
      "The active plugin plan selects one layout plugin and ordered, declared contributions for each slot. Version 2 persists this plan in hitchhiker-plugins/plugins.json; composition.json is only a Version 1 migration input. The checked-in composition example maps split-layout to the content slot, then split-left/page and split-right/page.",
      "The recipe arranges artifacts only. Stage each new plugin disabled with hitchhiker_plugin_stage, read hitchhiker_plugin_plan, then submit the returned revision and complete candidate to hitchhiker_plugin_apply_plan. Staging delegates only permissions allowed by your MCP grant; the plan itself grants no access. Composition retains the existing maximum of four workers. --safe-mode ignores the recipe, and missing layouts keep legacy plugin management visible during the migration. Native emergency recovery can also restore it. Each activation has a bounded input inbox, so early actions are retained and an overflowing owner cannot stall another plugin.",
      "A layout calls ui.publishLayout. A contributor calls ui.publishContribution with its configured ID and can call ui.withdrawContribution to remove that fragment. The public surface has no identity, slot, or provider field because the host owns those decisions. ui.release is reusable: in a composed profile it releases the caller's UI contributions, and in legacy mode it returns to the trusted default UI.",
    ],
    code: `import { definePlugin } from "@hitchhiker/plugin-sdk";
import { column, text } from "@hitchhiker/ui";

definePlugin({
  async activate(browser) {
    await browser.ui.publishContribution("page", {
      root: column("panel", [text("label", "Ready")], { flex: 1 }),
      bindings: [],
    });
  },
});`,
  },
  {
    id: "plugin-plans",
    title: "Apply a complete plugin plan",
    paragraphs: [
      "All three plan tools require plugins.install. Stage the artifacts first, then read hitchhiker_plugin_plan. Pass its revision as expectedRevision when calling hitchhiker_plugin_apply_plan; the example below uses 7 only as an illustration. A stale revision is rejected before workers stop. Plugin IDs must refer to installed artifacts with valid grants.",
      "A successful switch retains compatible workers, Chromium pages and plugin storage. A failed switch restores the prior plan; if restoration fails, a durable recovery marker blocks further mutations until restart. Uninstall records pending cleanup after plan promotion so startup can finish grant revocation and storage removal after a crash. The older hitchhiker_plugin_install tool still auto-admits individual plugins during migration; use staged admission for composed cohorts.",
    ],
    code: JSON.stringify(
      {
        expectedRevision: 7,
        candidate: {
          enabled: ["split-layout", "split-left", "split-right"],
          composition: {
            layout: "split-layout",
            slots: [
              {
                key: "content",
                contributions: [
                  { pluginId: "split-left", id: "page" },
                  { pluginId: "split-right", id: "page" },
                ],
              },
            ],
          },
          serviceBindings: [],
        },
      },
      null,
      2,
    ),
  },
  {
    id: "plugin-services",
    title: "Connect installed plugins with services",
    paragraphs: [
      "Services work for installed plugins without a UI layout. Declare each provided service and dependency in hitchhiker.plugin.json with the same exact contract { name, version, digest }. A contract digest records the agreement between plugins; each plugin still validates its own state and command data. Set serviceBindings in the complete plugin plan to select a provider service for each consumer dependency alias. This never installs code or grants permissions. The old services.json file is only read during Version 1 migration.",
      "The manager starts providers before required consumers. Disabling, uninstalling, or replacing a required provider stops dependent workers but retains their enabled preference, so they resume when the provider is usable again. Optional consumers stay running and see unavailable state. A consumer's effective grant must contain the provider's authority, including origins; cdp.connect must be granted explicitly even when browser.full-control is present.",
      "Use services.publish(service, value), get(dependency), subscribe(dependency), and call(dependency, method, params). subscribe returns the current snapshot, then service.state announces revisions; use get for the current value. Providers register handlers under definePlugin({ services }). Calls time out after three seconds and the SDK never retries them automatically, because a timed-out provider may still complete a side effect.",
      "Each JSON state, input, and result is limited to 128 KiB, depth 32, 4,096 nodes, and 64 KiB of combined string and key bytes. Published state shares a 1 MiB broker budget. The broker permits 16 pending calls per consumer, 32 per provider, and 128 total; subscriptions retain only the latest revision for each dependency.",
    ],
    code: `// service-provider.hitchhiker.plugin.json
{
  "id": "service-provider",
  "name": "Counter service",
  "version": "1.0.0",
  "capabilities": [],
  "provides": [{
    "id": "counter",
    "contract": {
      "name": "example.counter",
      "version": "1.0.0",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }]
}

// candidate.serviceBindings in hitchhiker_plugin_apply_plan
{
  "serviceBindings": [{
    "consumer": "service-consumer",
    "dependency": "counter",
    "provider": "service-provider",
    "service": "counter"
  }]
}`,
  },
  {
    id: "service-api",
    title: "Publish state and handle commands",
    paragraphs: [
      "The consumer manifest declares requires with the same counter contract and may mark a dependency optional: true. The provider can publish initial state during activate. Consumers should use the snapshot returned by subscribe during activation because service event forwarding begins after activation resolves.",
    ],
    code: `import { definePlugin, type PluginApi } from "@hitchhiker/plugin-sdk";

let api: PluginApi;
let value = 0;
definePlugin({
  async activate(host) {
    api = host;
    await api.services.publish("counter", { value });
  },
  services: {
    async counter(method) {
      if (method !== "increment") throw new Error("Unknown counter command");
      value += 1;
      await api.services.publish("counter", { value });
      return { value };
    },
  },
});

`,
  },
  {
    id: "service-consumer",
    title: "Read a dependency during activation",
    paragraphs: [
      "This is a complete consumer entry point. Its manifest declares counter in requires with the exact contract shown for the provider, and the applied plugin plan binds that dependency before the consumer activates.",
    ],
    code: `import { definePlugin } from "@hitchhiker/plugin-sdk";

definePlugin({
  async activate(api) {
    const initial = await api.services.subscribe("counter");
    const current = await api.services.get("counter");
    const result = await api.services.call("counter", "increment", null);
    await api.services.publish("report", { initial, current, result });
  },
});`,
  },
  {
    id: "plugin-storage-and-page-state",
    title: "Store local state and observe pages",
    paragraphs: [
      "Declare storage.local to use api.storage. Storage belongs to the installed plugin identity within its browser profile; workers never select another owner or profile. read returns { revision, value }, initially { revision: 0, value: null }. write(expectedRevision, value) is compare-and-swap and rejects a stale revision with PluginApiError code conflict instead of overwriting a concurrent update. Reread and reconcile before retrying; other failures are not conflicts. Values are portable JSON limited to 128 KiB, depth 32, and 4,096 nodes. State survives worker restarts, updates, disable/enable, and browser restart; uninstall removes that plugin's stored value.",
      "Declare pages.list to use api.pages.watch. A snapshot includes open-page metadata plus loading, canGoBack, and canGoForward. Each response contains at most 32 pages and 128 KiB. Continue with { offset: nextOffset, revision }; on PluginApiError code stale-snapshot, discard accumulated pages and restart from offset zero. Bound retries during continuous navigation; do not retry denied operations as snapshot conflicts. definePlugin({ onPagesChanged }) receives coalesced revision invalidations after watch has begun, so fetch a fresh snapshot instead of treating the callback as a page delta.",
      "pages.back, pages.forward, pages.reload, and pages.stop require pages.manage and operate only on an existing page ID. MCP exposes the matching hitchhiker_page_back, hitchhiker_page_forward, hitchhiker_page_reload, and hitchhiker_page_stop tools when the browser history adapter is available; they also require pages.manage on the connection's current profile grant.",
    ],
    code: `import { definePlugin } from "@hitchhiker/plugin-sdk";

definePlugin({
  async activate(api) {
    const saved = await api.storage.read();
    await api.storage.write(saved.revision, { selectedPageId: null });
    const first = await api.pages.watch();
    if (first.pages[0]) await api.pages.reload(first.pages[0].id);
  },
  async onPagesChanged() {
    // Call pages.watch() again; this notification is intentionally coalesced.
  },
});`,
  },
  {
    id: "plugin-management",
    title: "Build Settings and plugin management",
    paragraphs: [
      "Installed plugins can build Native management screens through configuration.get/set and plugins.snapshot/enable/disable/rollback/uninstall/replaceSelf. The bundled sidebar and top presenters use these same APIs. Their Settings and Plugins routes replace only their content contribution, preserving Chromium page identity. The normal default-browser startup migration and native acceptance are still unfinished.",
      "Declare plugins.read for snapshots and plugins.manage for lifecycle commands. Lifecycle permission cannot stage executable code, choose grants, or install revisions; those operations retain separate plugins.install authority over MCP. Every call checks the current profile, caller identity, declaration and live grant. Revoking the grant denies future calls. Accepted commands run in the application scope and can finish after their caller stops; revocation does not undo an already admitted command.",
      "A snapshot contains a plan revision and up to 16 summaries: id, name, version, enabled, running, capabilities, and optional removing, previousVersion and lastFailure. It excludes hashes, credentials and filesystem paths. During a transition the revision describes the committed plan while running flags may change. Snapshots may be read during activation; lifecycle commands require completed activation. At most 16 admitted management commands may be pending across the application.",
      "replaceSelf changes the authenticated caller's enabled ID, layout/contribution ownership and service bindings to a distinct disabled installed target. Other plan entries are retained and ordinary dependency, grant and four-worker validation still apply. A stale revision or incompatible target is denied without applying the candidate. Re-read the snapshot before retrying. The old presenter may stop before receiving a response, so a replacement must initialize from public state in its own activation.",
      "There is no management change event yet. Refresh the snapshot when opening a screen or on an explicit Refresh action. Configuration replacement validates and persists the complete object; read first and preserve fields your screen does not edit. Uninstall also removes that plugin's owner storage and revokes its current and rollback grants. These lifecycle changes persist across restart.",
    ],
    code: `import type { PluginApi } from "@hitchhiker/plugin-sdk";

// Call from a UI handler after activation. Both plugins must already be installed.
// Manifest and profile grant: plugins.read and plugins.manage.
export async function useOtherPresenter(api: PluginApi) {
  const before = await api.plugins.snapshot();
  await api.plugins.replaceSelf("my-other-presenter", before.revision);
  // This activation may stop before the reply arrives.
  // The replacement reads plugins.snapshot() during activation to render current state.
}`,
  },
  {
    id: "plugin-api",
    title: "Plugin API reference",
    paragraphs: [
      "All methods return Promises. Await host calls and handle rejection. Both the declared capability and a live grant are required. Configuration reads use configuration.read when it is declared; existing plugins that declare only configuration.write retain read access. The installed-plugin management port is unavailable to developer --plugin launches.",
    ],
    table: {
      headings: ["Method", "Capability", "Result"],
      rows: [
        ["pages.list()", "pages.list", "BrowserPage[] with stable IDs and current lifecycle"],
        [
          "pages.watch({ offset?, revision? })",
          "pages.list",
          "PageWatchSnapshot; chunks of at most 32 pages and 128 KiB",
        ],
        ["pages.open(url)", "pages.manage", "{ pageId }"],
        ["pages.navigate(pageId, url)", "pages.manage", "void; retains the page ID"],
        ["pages.close(pageId)", "pages.manage", "void; requests closure through Chromium"],
        ["pages.back(pageId)", "pages.manage", "void; routes Chromium history back"],
        ["pages.forward(pageId)", "pages.manage", "void; routes Chromium history forward"],
        ["pages.reload(pageId)", "pages.manage", "void; reloads an existing page"],
        ["pages.stop(pageId)", "pages.manage", "void; stops loading an existing page"],
        [
          "storage.read() / storage.write(expectedRevision, value)",
          "storage.local",
          "Revisioned owner-and-profile local JSON state",
        ],
        [
          "configuration.get()",
          "configuration.read (legacy writers also supported)",
          "BrowserConfiguration",
        ],
        ["configuration.set(configuration)", "configuration.write", "void; validated replacement"],
        ["plugins.snapshot()", "plugins.read", "Revision and up to 16 public plugin summaries"],
        [
          "plugins.enable(id) / disable(id) / rollback(id) / uninstall(id)",
          "plugins.manage",
          "Updated management snapshot; accepted changes survive caller shutdown",
        ],
        [
          "plugins.replaceSelf(targetId, expectedRevision)",
          "plugins.manage",
          "Replaces caller references in the existing plan; caller may stop before receiving a reply",
        ],
        [
          "services.publish(service, value)",
          "Declared provides; bound consumer authority",
          "{ revision }; publishes portable provider state",
        ],
        [
          "services.get(dependency)",
          "Declared requires; profile binding and authority containment",
          "ServiceSnapshot; unavailable optional providers return { available: false }",
        ],
        [
          "services.subscribe(dependency)",
          "Declared requires; profile binding and authority containment",
          "ServiceSnapshot; later revisions arrive as service.state events",
        ],
        [
          "services.call(dependency, method, params)",
          "Declared requires; profile binding and authority containment",
          "JSON result; provider handler has a three-second response deadline",
        ],
        [
          "ui.publish(surface)",
          "ui.compose",
          "{ revision }; legacy whole-window API, or layout-owner alias in composition",
        ],
        ["ui.publishLayout(surface)", "ui.compose", "{ revision }; configured layout only"],
        [
          "ui.publishContribution(id, surface)",
          "ui.compose",
          "{ revision }; configured contribution only",
        ],
        ["ui.withdrawContribution(id)", "ui.compose", "{ revision }; removes a contribution"],
        [
          "ui.release()",
          "ui.compose",
          "void; releases caller contributions, or returns legacy UI to default",
        ],
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
