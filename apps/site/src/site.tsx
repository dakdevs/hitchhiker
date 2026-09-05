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
      "Hitchhiker separates a Chromium host, a browser model, and presentation surfaces. The host owns profile isolation, permission decisions, extension compatibility, lifecycle, and performance policy. The model exposes typed browser state and operations. Surfaces render that model using native components or isolated web panels.",
      "The default browser is a first-party surface, not a privileged exception. That is the central contract: a replacement interface should receive the same capabilities and constraints as the built-in experience.",
      "This architecture is proposed and under active host integration. The initial target is macOS. The primary implementation challenge is a native CEF host; no published Hitchhiker release is available yet.",
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
      "Hitchhiker is currently developed from its source repository. Use Node 24.19.0 and pnpm 11.24.0; the commands below install the locked workspace, run its repository checks, and start this documentation site.",
      "The portable core package is implemented and can be used for browser state, configuration, grants, and resource policy. A native Chromium host and runtime plugin loader are still under integration, so there is no released browser scaffold or runtime surface API.",
    ],
    code: "# Development from this source repository\npnpm install --frozen-lockfile\npnpm check\npnpm --filter @hitchhiker/site dev",
  },
  {
    page: "configuration",
    group: "Build",
    title: "Configuration",
    description: "Opinionated defaults that remain easy to change.",
    icon: SlidersHorizontal,
    body: [
      "The implemented core configuration is local-first and contains only portable settings: tab layout, colour scheme, inactivity sleep timing, and explicit always-awake origins. Its export/import helpers reject exports containing browser secrets such as cookies, history, passwords, tokens, sessions, and credentials.",
      "The default layout is a sidebar; top tabs are an equally supported configuration. The core’s tab model treats pinning separately from lifecycle. A native host must still observe live protections and apply sleep decisions to Chromium tabs.",
    ],
    code: 'import { defaultConfiguration, exportConfiguration } from "@hitchhiker/core";\n\nconst configuration = {\n  ...defaultConfiguration,\n  tabLayout: "top" as const,\n  alwaysAwakeOrigins: ["https://meet.example"],\n};\n\nconst exported = exportConfiguration(configuration);\nif (exported.ok) {\n  const portableJson = exported.value; // safe JSON string\n}',
  },
  {
    page: "plugins",
    group: "Build",
    title: "Plugin authoring",
    description: "Build live-installable browser experiences.",
    icon: Puzzle,
    body: [
      "The proposed runtime plugin system would let plugins contribute controls, pages, commands, configuration, and complete replacement interfaces. Runtime installation, disabling, and rollback are host work still in progress. A protected system surface would retain permission review and recovery controls.",
      "The implemented core can parse a bounded, declarative plugin proposal; it does not execute plugins or grant host access. The intended host model gives plugin authors powerful browser building blocks without ambient access to every profile or site.",
    ],
    code: '// Proposed plugin manifest\nexport default {\n  id: "com.example.focus",\n  capabilities: ["tabs.read", "tabs.write"],\n  contributes: { sidebar: "./src/sidebar.tsx" }\n};',
  },
  {
    page: "native-ui",
    group: "Build",
    title: "Native UI composition",
    description: "Compose browser surfaces with a shared design language.",
    icon: PanelLeft,
    body: [
      "The proposed component library is deliberately opinionated about typography, density, focus states, accessibility, and motion. Native browser chrome and isolated web panels both depend on the host integration, which is not released.",
      "A framework surface is intended to replace the whole application shell. Native UI is the preferred path for browser controls; web panels must communicate through an explicit bridge and never become a way around permission or profile isolation.",
    ],
    code: "// Illustrative component contract\nexport function Sidebar({ tabs }: { tabs: BrowserTab[] }) {\n  return <NavRail>{tabs.map(TabRow)}</NavRail>;\n}",
  },
  {
    page: "permissions",
    group: "Trust",
    title: "Permissions & security",
    description: "Useful control without silent escalation.",
    icon: ShieldCheck,
    body: [
      "Permission grants persist within their declared scope. A person can grant an automation client tab control, selected-site access, browser configuration access, plugin installation, or full browser control. A request that expands scope must be reviewed.",
      "The host keeps certain paths outside replacement UI: permission prompts, profile recovery, and Chromium security boundaries. Chrome extension compatibility is a goal under investigation, not a compatibility promise. Any integration must preserve Chromium’s extension and site isolation rules.",
    ],
    code: '// Capability prompts are explicit and reviewable\nrequestCapability({\n  capability: "sites.read",\n  scope: ["https://docs.example.com/*"]\n});',
  },
  {
    page: "automation",
    group: "Trust",
    title: "MCP & CDP",
    description: "Connect agents through scoped, inspectable control.",
    icon: Command,
    body: [
      "MCP is the intended automation interface. It maps its tools onto the same capability model used by plugins and the default UI, so an agent’s authority is visible and revocable.",
      "CDP is a separate developer-control feature. It is intended to be disabled by default, bound locally by default, and explicitly enabled per profile. Raw CDP can access sensitive browsing data, so it is not a substitute for scoped MCP tools. The MCP and CDP endpoints are proposed; neither is published.",
    ],
    code: '// Proposed MCP tool shape\nawait browser.tabs.create({\n  url: "https://example.com",\n  profile: "work"\n});',
  },
  {
    page: "performance",
    group: "Trust",
    title: "Performance",
    description: "Responsive by policy, even after customization.",
    icon: Cpu,
    body: [
      "Hitchhiker treats memory and responsiveness as host responsibilities. Inactive tabs may sleep, including pinned tabs. Audio, calls, downloads, and unsaved input are expected protection signals; people can also designate sites that should stay awake.",
      "Plugins are part of the performance budget. The framework is designed to attribute sustained CPU work, memory growth, and UI stalls to a plugin, then warn, throttle background work, or suspend a persistent offender with a recovery path. Specific thresholds and measurements will be published only after host benchmarking.",
    ],
    code: "Policy signals → observe → warn → throttle → suspend\n\nThe exact budgets are intentionally not specified yet.",
  },
  {
    page: "distribution",
    group: "Ship",
    title: "Custom browser distribution",
    description: "Ship your own browser, not just a theme.",
    icon: Sparkles,
    body: [
      "Hitchhiker is planned as an open-source framework. Teams should be able to distribute a custom browser with their own surface, defaults, plugins, and optional sync provider while retaining the platform’s security and performance policies.",
      "Distribution support is a design target, not a current release feature. Packaging, signing, updater behavior, and Chrome extension compatibility all depend on the native host integration. The initial platform is macOS.",
    ],
    code: "Your browser\n  ├── surface package\n  ├── approved plugin bundle\n  ├── profile defaults\n  └── Hitchhiker host (macOS, proposed)",
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
        <a href="https://github.com/vercel-labs/native" target="_blank" rel="noreferrer">
          Native source <ExternalLink size={13} />
        </a>
      </nav>
      <div className="header-actions">
        <button className="icon-button" aria-label="Toggle theme" onClick={onTheme}>
          {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
        </button>
        <a
          className="github-link"
          href="https://github.com/vercel-labs/native"
          target="_blank"
          rel="noreferrer"
        >
          <Code2 size={17} /> <span>Native source</span>
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
            text="Sidebar tabs and pinned spaces are the default. Top tabs remain one configuration away."
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
