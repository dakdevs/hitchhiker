import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Boxes,
  ChevronRight,
  Code2,
  Command,
  Cpu,
  ExternalLink,
  Menu,
  Moon,
  PanelLeft,
  Puzzle,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Terminal,
  Zap,
} from "lucide-react";

type Page =
  | "home"
  | "architecture"
  | "quickstart"
  | "configuration"
  | "plugins"
  | "native-ui"
  | "permissions"
  | "automation"
  | "performance"
  | "distribution";

type Doc = {
  page: Exclude<Page, "home">;
  group: string;
  title: string;
  description: string;
  icon: typeof BookOpen;
  body: string[];
  code?: string;
};

const docs: Doc[] = [
  {
    page: "architecture",
    group: "Start here",
    title: "Framework architecture",
    description: "A small, stable host with replaceable surfaces.",
    icon: Boxes,
    body: [
      "Hitchhiker separates a Chromium process, a trusted TypeScript broker, and Native presentation. The browser model exposes stable pages and independent viewport bindings. A page keeps its document state when an interface rearranges or replaces its viewports.",
      "The default interface is built from public components and owns sidebar/top tabs, pins, ordering, and selection. Plugins can instead present page cards, canvases, splits, or another interaction model. The trusted broker enforces profile boundaries, grants, Native tree limits, and plugin isolation.",
      "The macOS development build has real CEF content, Native UI, private IPC, CDP, and isolated JavaScriptCore plugins. It is public source under active development. Chrome same-window extension tab parity, release packaging, and several framework features remain unfinished.",
    ],
    code: "Host (Chromium + policy)\n        │\nBrowser model ── public capability boundary\n   ┌────┼────┐\nNative UI  Web panels  MCP / CDP",
  },
  {
    page: "quickstart",
    group: "Start here",
    title: "Quickstart",
    description: "Set up a development workspace for the framework.",
    icon: Terminal,
    body: [
      "Use Node 24.19.0 and pnpm 11.24.0. Install the locked Turborepo and run its portable checks. The source repository includes the native browser, public component and plugin packages, an example replacement interface, and this documentation site.",
      "Build the native host using apps/host-probe/README.md, then set HITCHHIKER_NATIVE_BINARY to its absolute executable path and run pnpm --filter @hitchhiker/browser dev. Full launch, grant, MCP/CDP, and plugin commands are in docs/DEVELOPMENT.md. Use a dedicated --profile-root for experiments.",
      "No signed browser release is available yet. Native tests explicitly skip when their executable environment variables are absent; a portable green check does not prove native behavior.",
    ],
    code: 'pnpm install --frozen-lockfile\npnpm check\n# After building the native host:\nexport HITCHHIKER_NATIVE_BINARY="$PWD/work/host-probe/build/Release/hitchhiker-probe.app/Contents/MacOS/hitchhiker-probe"\npnpm --filter @hitchhiker/browser dev',
  },
  {
    page: "configuration",
    group: "Build",
    title: "Configuration",
    description: "Opinionated defaults that remain easy to change.",
    icon: SlidersHorizontal,
    body: [
      "The implemented core configuration is local-first and contains only portable engine settings: colour scheme, inactivity sleep timing, and explicit always-awake origins. Its export/import helpers reject exports containing browser secrets such as cookies, history, passwords, tokens, sessions, and credentials. Page lifecycle and viewport bindings are separate from presentation state.",
      "The first-party default interface owns sidebar or top-tab placement, ordering, pins, and selection in its own configuration and state. The native host supplies live resource signals for reversible freezing. Profile management, synchronization, and an integrated configuration export interface remain in progress.",
    ],
    code: 'import { defaultConfiguration, exportConfiguration } from "@hitchhiker/core";\nimport { defaultInterfaceConfiguration } from "@hitchhiker/default-interface";\n\nconst engineConfiguration = {\n  ...defaultConfiguration,\n  alwaysAwakeOrigins: ["https://meet.example"],\n};\nconst interfaceConfiguration = {\n  ...defaultInterfaceConfiguration,\n  tabPlacement: "top" as const,\n};\n\nconst exported = exportConfiguration(engineConfiguration);\nif (exported.ok) {\n  const portableJson = exported.value; // safe JSON string\n}',
  },
  {
    page: "plugins",
    group: "Build",
    title: "Plugin authoring",
    description: "Build live-installable browser experiences.",
    icon: Puzzle,
    body: [
      "TypeScript plugins use @hitchhiker/plugin-sdk and @hitchhiker/ui. Bundle an entry point as an IIFE and include hitchhiker.plugin.json with an ID, name, version, and declared capabilities. The local developer launcher loads fixed, bounded regular files; it never runs a package’s npm scripts.",
      "Each plugin revision executes in a separate JavaScriptCore worker behind an App-Sandboxed XPC broker. It has no Node, filesystem, network, timer, or generic native bridge. Host calls require both the manifest declaration and a current grant whose principal matches the installed plugin ID.",
      "Activation may be asynchronous. A failed, over-budget, or revoked UI plugin returns control to the trusted interface. The canvas example replaces tabs with cards and two viewports. Persistent installation, live updates, known-good revision rollback, and MCP package management remain under development.",
    ],
    code: 'import { definePlugin } from "@hitchhiker/plugin-sdk";\nimport { column, text } from "@hitchhiker/ui";\n\ndefinePlugin({\n  async activate(browser) {\n    await browser.ui.publish({\n      root: column("welcome", [text("title", "Your browser")], { flex: 1 }),\n      bindings: [],\n    });\n  },\n});',
  },
  {
    page: "native-ui",
    group: "Build",
    title: "Native UI composition",
    description: "Compose browser surfaces with a shared design language.",
    icon: PanelLeft,
    body: [
      "@hitchhiker/ui provides real row, column, stack, scroll, text, button, input, icon, spacer, and viewport building blocks. TypeScript sends bounded component trees to a compiled Native adapter. Twenty-three embedded icons use actual Lucide SVG assets.",
      "Viewport IDs describe positions in the interface; bindings associate them with stable Chromium page IDs. Native measures the rectangles. Replacing sidebar tabs with a canvas does not recreate page documents. The same package builds Hitchhiker’s default interface and the plugin example.",
      "Invalid trees retain the previous interface. Input events carry revisions and trusted owner identity so stale controls or another plugin cannot consume them. Retina raster rendering and idle damage checks are implemented; Metal presentation, full accessibility, interactive IME verification, and polished shared motion remain release work.",
    ],
    code: 'import { column, viewport } from "@hitchhiker/ui";\n\nconst surface = {\n  root: column("layout", [\n    viewport("content", "main", { flex: 1 }),\n  ], { flex: 1 }),\n  bindings: [{ viewportId: "main", pageId: "page-one" }],\n};',
  },
  {
    page: "permissions",
    group: "Trust",
    title: "Permissions & security",
    description: "Useful control without silent escalation.",
    icon: ShieldCheck,
    body: [
      "Local grants persist profile, capability, origin scope, expiry, and revocation. The trusted grant store generates random bearer credentials and persists their hashes in an atomically replaced private file. A cross-process mutation lock prevents concurrent grant writes from losing revocations.",
      "Plugin declarations do not grant authority. Every host call and forwarded event checks the current grant and installed identity. Replacing the UI requires ui.compose. The local grants command is the current trusted issuance and recovery path; an integrated permission-review interface remains unfinished.",
      "browser.full-control excludes raw CDP. A separate cdp.connect permission gives control over the whole Chromium profile and cannot be constrained to selected website origins. Ordinary website content never receives the private host pipes.",
    ],
    code: "pnpm --filter @hitchhiker/browser grants issue \\\n  --principal=my-agent \\\n  --capabilities=pages.list,pages.manage,configuration.write\npnpm --filter @hitchhiker/browser grants list\npnpm --filter @hitchhiker/browser grants revoke GRANT_ID",
  },
  {
    page: "automation",
    group: "Trust",
    title: "MCP & CDP",
    description: "Connect agents through scoped, inspectable control.",
    icon: Command,
    body: [
      "The local stdio MCP server exposes page list/open/navigate/close, configuration get/set, and sidebar/top selection. Each call checks a pre-issued credential against durable grants. Tool results that contain page titles or URLs remain untrusted website content.",
      "CDP uses private inherited Chromium pipes and an explicitly enabled authenticated loopback relay. Playwright has been verified against the real browser, including input changes, profile isolation, and disconnection after grant revocation. Raw CDP is disabled unless separately requested at launch.",
      "Local stdio starts its own browser instance. Attaching to an already-running application, remote MCP for hosted ChatGPT clients, DOM-level MCP tools, and live plugin installation through MCP are still being implemented. See docs/DEVELOPMENT.md for current launch commands.",
    ],
    code: '# Supply a credential issued by the local grants command.\nexport HITCHHIKER_MCP_TOKEN="YOUR_TOKEN"\nnode --experimental-strip-types apps/browser/src/main.ts --mcp',
  },
  {
    page: "performance",
    group: "Trust",
    title: "Performance",
    description: "Responsive by policy, even after customization.",
    icon: Cpu,
    body: [
      "The host owns performance policy. Native output-audio, media-capture, download, and conservative keyboard-edit signals protect pages. Missing resource information fails closed. Always-awake origins and visible viewport bindings also prevent freezing; pins alone do not.",
      "Reversible Chromium freezing stops inactive JavaScript work while retaining the page. It is not tab discard or proof of lower renderer memory use. Raw CDP launch mode disables automatic freezing because unrestricted automation can mutate state outside the trusted input signals.",
      "The isolated plugin host externally enforces a 500 ms synchronous execution slice and a 150 MiB worker footprint budget, plus bounded messages and pending calls. Wall/RSS violations kill that plugin process. Native raster uses Retina scale, retained buffers, damage checks, and idle revision gating. Audio/capture callbacks and interactive smoothness still need device verification.",
    ],
    code: "Visible or protected → stay active\nInactive and eligible → reversible freeze\nSelected again → activate before display\nPlugin exceeds watchdog budget → stop plugin, restore controls",
  },
  {
    page: "distribution",
    group: "Ship",
    title: "Custom browser distribution",
    description: "Ship your own browser, not just a theme.",
    icon: Sparkles,
    body: [
      "Hitchhiker is an open-source browser framework with a macOS-first development build. Teams can build the public source and compose their own Native interface, defaults, and isolated plugins. The repository is published at github.com/dakdevs/hitchhiker.",
      "The current native build and plugin helper are reproducible development artifacts. Developer ID signing, notarization, automatic updates, profile management, optional sync, and complete Chrome extension installation/compatibility are not finished. Do not distribute this build as a production browser.",
    ],
    code: "Your browser\n  ├── Native surface package\n  ├── scoped plugin bundles\n  ├── profile defaults\n  └── Hitchhiker Chromium host",
  },
];

function isPage(value: string): value is Page {
  return value === "home" || docs.some((doc) => doc.page === value);
}

function pageFromLocation(): Page {
  const fragment = window.location.hash.replace(/^#\/?/, "");
  return isPage(fragment) ? fragment : "home";
}

function navigate(page: Page) {
  window.location.hash = page === "home" ? "" : `/${page}`;
}

export function App() {
  const [page, setPage] = useState<Page>(pageFromLocation);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const onHashChange = () => setPage(pageFromLocation());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const openPage = (next: Page) => {
    navigate(next);
    setMenuOpen(false);
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  return (
    <div className="site-shell">
      <Header
        page={page}
        theme={theme}
        onTheme={() => setTheme(theme === "light" ? "dark" : "light")}
        onMenu={() => setMenuOpen(!menuOpen)}
        onNavigate={openPage}
      />
      {menuOpen && <MobileMenu page={page} onNavigate={openPage} />}
      {page === "home" ? (
        <Home onNavigate={openPage} />
      ) : (
        <Documentation page={page} onNavigate={openPage} />
      )}
      <Footer onNavigate={openPage} />
    </div>
  );
}

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <span />
    </span>
  );
}

function Header({
  page,
  theme,
  onTheme,
  onMenu,
  onNavigate,
}: {
  page: Page;
  theme: "light" | "dark";
  onTheme: () => void;
  onMenu: () => void;
  onNavigate: (page: Page) => void;
}) {
  return (
    <header className="header">
      <button className="brand" onClick={() => onNavigate("home")}>
        <Mark />
        Hitchhiker
      </button>
      <nav className="desktop-nav" aria-label="Main navigation">
        <button className={page === "home" ? "active" : ""} onClick={() => onNavigate("home")}>
          Overview
        </button>
        <button
          className={page !== "home" ? "active" : ""}
          onClick={() => onNavigate("architecture")}
        >
          Documentation
        </button>
        <a href="https://github.com/dakdevs/hitchhiker" target="_blank" rel="noreferrer">
          Source <ExternalLink size={13} />
        </a>
      </nav>
      <div className="header-actions">
        <button className="icon-button" aria-label="Toggle theme" onClick={onTheme}>
          {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
        </button>
        <a
          className="github-link"
          href="https://github.com/dakdevs/hitchhiker"
          target="_blank"
          rel="noreferrer"
        >
          <Code2 size={17} /> <span>Source</span>
        </a>
        <button className="menu-button" aria-label="Open navigation" onClick={onMenu}>
          <Menu size={19} />
        </button>
      </div>
    </header>
  );
}

function MobileMenu({ page, onNavigate }: { page: Page; onNavigate: (page: Page) => void }) {
  return (
    <div className="mobile-menu">
      {["home", ...docs.map((doc) => doc.page)].map((item) => (
        <button
          key={item}
          className={page === item ? "active" : ""}
          onClick={() => onNavigate(item as Page)}
        >
          {item === "home" ? "Overview" : docs.find((doc) => doc.page === item)?.title}
        </button>
      ))}
    </div>
  );
}

function Home({ onNavigate }: { onNavigate: (page: Page) => void }) {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <h1>
            A browser with excellent defaults.
            <br />
            <em>And no fixed idea of itself.</em>
          </h1>
          <p>
            Hitchhiker is an open browser framework for people who want to build their own
            interface, workflows, and agent-controlled browsing experience on a Chromium foundation.
          </p>
          <div className="hero-actions">
            <button className="button primary" onClick={() => onNavigate("architecture")}>
              Read the framework <ArrowRight size={17} />
            </button>
            <button className="button quiet" onClick={() => onNavigate("quickstart")}>
              Explore the docs
            </button>
          </div>
          <p className="status">
            <span /> macOS host integration in progress · no release yet
          </p>
        </div>
        <BrowserPreview />
      </section>
      <section className="principles">
        <p className="section-kicker">A browser that can grow with you</p>
        <div className="principle-grid">
          <Feature
            icon={PanelLeft}
            number="01"
            title="A calm starting point"
            text="The default interface provides sidebar or top tabs, ordering, pins, and selection. Plugins can replace it with any workspace model."
          />
          <Feature
            icon={Puzzle}
            number="02"
            title="Replaceable by design"
            text="The first-party browser uses the same public surface APIs intended for everyone else."
          />
          <Feature
            icon={Command}
            number="03"
            title="Ready for control"
            text="Scoped MCP grants and explicitly enabled CDP make automation powerful and legible."
          />
        </div>
      </section>
      <section className="feature-band">
        <div>
          <p className="section-kicker">A framework, not a skin</p>
          <h2>
            Change the interface
            <br />
            without weakening the browser.
          </h2>
        </div>
        <div className="feature-copy">
          <p>
            Native components give custom surfaces the same thoughtful motion, focus behavior, and
            visual rhythm as the default browser. Isolated web panels make room for richer views,
            while the host continues to guard permissions and Chromium boundaries.
          </p>
          <button className="text-link" onClick={() => onNavigate("native-ui")}>
            Compose a surface <ArrowRight size={16} />
          </button>
        </div>
      </section>
      <section className="contracts">
        <div className="contract-intro">
          <p className="section-kicker">The contract</p>
          <h2>Opinionated where it earns trust.</h2>
          <p>
            Hitchhiker makes choices about performance, animation, and design language. It leaves
            your workflow, layout, and browser product in your hands.
          </p>
        </div>
        <div className="contract-list">
          <Contract
            icon={Zap}
            title="Performance as a shared constraint"
            text="Inactive tabs sleep. Plugins are observed, throttled, and recoverable when they become disruptive."
            onClick={() => onNavigate("performance")}
          />
          <Contract
            icon={ShieldCheck}
            title="Security at the host boundary"
            text="Plugins and agents request scoped powers; the system retains permission and recovery controls."
            onClick={() => onNavigate("permissions")}
          />
          <Contract
            icon={Code2}
            title="A public path to a custom browser"
            text="Ship a different product with its own interface and defaults, built on the same foundation."
            onClick={() => onNavigate("distribution")}
          />
        </div>
      </section>
      <section className="callout">
        <div>
          <p className="section-kicker">For builders</p>
          <h2>Make the browser feel like your own.</h2>
        </div>
        <button className="button primary" onClick={() => onNavigate("quickstart")}>
          Start with the docs <ArrowRight size={17} />
        </button>
      </section>
    </main>
  );
}

function BrowserPreview() {
  return (
    <div className="browser-wrap" aria-label="Illustrative browser interface" role="img">
      <div className="browser">
        <aside>
          <div className="traffic">
            <i />
            <i />
            <i />
          </div>
          <div className="sidebar-top">
            <span className="side-symbol">H</span>
            <span className="preview-icon">+</span>
          </div>
          <div className="side-label">Pinned</div>
          {["Atlas", "Notes", "Linear"].map((tab, index) => (
            <div className={index === 0 ? "tab selected" : "tab"} key={tab}>
              <b>{["A", "N", "L"][index]}</b>
              <span>{tab}</span>
            </div>
          ))}
          <div className="side-label lower">Today</div>
          {["Agent browser", "Native docs"].map((tab) => (
            <div className="tab" key={tab}>
              <b className="muted-dot" />
              <span>{tab}</span>
            </div>
          ))}
        </aside>
        <div className="browser-main">
          <div className="toolbar">
            <span className="preview-icon">
              <ChevronRight size={14} />
            </span>
            <div className="address">
              <span />
              <span>hitchhiker.dev</span>
            </div>
            <span className="preview-icon">
              <Sparkles size={15} />
            </span>
          </div>
          <div className="preview-content">
            <div className="preview-label">Workspace</div>
            <h3>
              Build your browser
              <br />
              around your work.
            </h3>
            <div className="preview-lines">
              <i />
              <i />
              <i />
            </div>
            <div className="preview-card">
              <span>Focused tabs</span>
              <strong>Memory-aware by default</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Feature({
  icon: Icon,
  number,
  title,
  text,
}: {
  icon: typeof PanelLeft;
  number: string;
  title: string;
  text: string;
}) {
  return (
    <article className="feature">
      <div className="feature-top">
        <Icon size={19} />
        <span>{number}</span>
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}
function Contract({
  icon: Icon,
  title,
  text,
  onClick,
}: {
  icon: typeof Zap;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button className="contract" onClick={onClick}>
      <Icon size={19} />
      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
      <ArrowRight size={17} />
    </button>
  );
}

function Documentation({
  page,
  onNavigate,
}: {
  page: Exclude<Page, "home">;
  onNavigate: (page: Page) => void;
}) {
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const active = docs.find((doc) => doc.page === page) ?? docs[0];
  const filtered = useMemo(
    () =>
      docs.filter((doc) =>
        `${doc.title} ${doc.description} ${doc.body.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [query],
  );
  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  };
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  return (
    <main className="docs-layout">
      <aside className="docs-nav" data-searching={query.trim().length > 0}>
        <button className="docs-home" onClick={() => onNavigate("home")}>
          <ArrowRight size={15} /> Back to overview
        </button>
        <label className="search">
          <Search size={16} />
          <input
            ref={searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search docs"
            aria-label="Search documentation"
          />
          <kbd>⌘K</kbd>
        </label>
        {filtered.length === 0 && <p role="status">No matching pages.</p>}
        {["Start here", "Build", "Trust", "Ship"]
          .filter((group) => filtered.some((doc) => doc.group === group))
          .map((group) => (
            <div className="nav-group" key={group}>
              <p>{group}</p>
              {filtered
                .filter((doc) => doc.group === group)
                .map((doc) => (
                  <button
                    className={doc.page === page ? "active" : ""}
                    key={doc.page}
                    onClick={() => onNavigate(doc.page)}
                  >
                    <doc.icon size={16} />
                    {doc.title}
                  </button>
                ))}
            </div>
          ))}
      </aside>
      <article className="doc-content">
        <div id="overview" className="doc-heading">
          <active.icon size={23} />
          <p>{active.group}</p>
          <h1>{active.title}</h1>
          <span>{active.description}</span>
        </div>
        <div id="current-status" className="notice">
          <Sparkles size={17} />
          <p>
            <strong>Design contract.</strong> Hitchhiker is under active development. APIs, package
            names, and code shown here communicate intended architecture, not a published release.
          </p>
        </div>
        {active.body.map((paragraph) => (
          <p className="doc-paragraph" key={paragraph}>
            {paragraph}
          </p>
        ))}
        {active.code && (
          <pre id="illustrative-contract">
            <code>{active.code}</code>
          </pre>
        )}
        <div className="doc-footer">
          <button onClick={() => onNavigate(previous(active.page))}>
            ← {docs.find((doc) => doc.page === previous(active.page))?.title ?? "Overview"}
          </button>
          <button onClick={() => onNavigate(next(active.page))}>
            {docs.find((doc) => doc.page === next(active.page))?.title} →
          </button>
        </div>
      </article>
      <aside className="doc-on-page">
        <p>On this page</p>
        <button onClick={() => scrollToSection("overview")}>Overview</button>
        <button onClick={() => scrollToSection("current-status")}>Current status</button>
        <button onClick={() => scrollToSection("illustrative-contract")}>
          Illustrative contract
        </button>
      </aside>
    </main>
  );
}

function previous(page: Exclude<Page, "home">): Page {
  const index = docs.findIndex((doc) => doc.page === page);
  return index <= 0 ? "home" : docs[index - 1].page;
}
function next(page: Exclude<Page, "home">): Page {
  const index = docs.findIndex((doc) => doc.page === page);
  return index >= docs.length - 1 ? "home" : docs[index + 1].page;
}
function Footer({ onNavigate }: { onNavigate: (page: Page) => void }) {
  return (
    <footer>
      <button className="brand" onClick={() => onNavigate("home")}>
        <Mark />
        Hitchhiker
      </button>
      <p>Browser framework · macOS first · work in progress</p>
      <div>
        <button onClick={() => onNavigate("architecture")}>Docs</button>
        <a href="https://github.com/vercel-labs/native" target="_blank" rel="noreferrer">
          Native SDK
        </a>
      </div>
    </footer>
  );
}
