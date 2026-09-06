# Hitchhiker implementation plan

## Purpose and authority

The user approved implementation after a one-question-at-a-time design interview on 2026-09-05.
Build an open-source macOS-first Chromium browser framework using vercel-labs/native, in a
Turborepo at `/Users/dak/projects/hitchhiker`, with a default browser and marketing/docs site.
This living plan is warranted by unknown native engine composition, runtime plugins, multiple
toolchains, and security-sensitive browser automation. `AGENTS.md` is the planning contract.

## Accepted decisions

- OpenAI-inspired design, Lucide icons, shared accessible motion; sidebar/pinned tabs by default,
  top tabs optional. The default interface uses only public framework APIs.
- Existing Chrome extensions and live-installable Hitchhiker TypeScript plugins. Plugins compose
  native components, may replace the interface, and may use isolated web panels.
- Protected core owns permissions, recovery, Chromium security, and performance scheduling.
- Configuration/UI changes apply live; enable, disable, rollback without rebuilding the browser.
- MCP has persistent scoped grants and explicit full-control option. Raw CDP is opt-in per profile,
  local by default and revocable.
- Inactive/pinned tabs may sleep; protect calls, audio, downloads and unsaved input, with per-site
  always-awake exceptions. Warn, throttle and suspend sustained plugin resource offenders.
- Local profiles and configuration/plugin export/import without browsing secrets. Optional sync
  provider API; no required account. Framework and default browser are open source.
- Docs cover configuration, plugins, native UI, automation, performance, and custom distributions.
- Clarification: Chromium owns web-page rendering and browser-engine services; Native owns the
  surrounding interface. Commands and events cross a trusted host adapter. OS window ownership
  can follow whichever integration path supports that separation.
- Further clarification: the core must not impose tabs as its browsing model. It owns pages,
  profile identity, lifecycle/protection signals and viewport bindings. Default tab order, pinning,
  sidebar/top layout and per-interface selection belong to a replaceable first-party interface.
  Several viewports may show distinct pages concurrently; replacing UI must retain page identity.

## Current implementation

The development browser runs Native UI around live Chromium pages. The default sidebar/top interface
and an independent canvas plugin use public page/viewport/component APIs. Isolated compiled plugins
support persistent MCP installation, updates, rollback and grant revocation. Local stdio MCP and a
separately authorized loopback CDP relay are integrated. The relocatable arm64 developer app passes
real plugin lifecycle and safe-mode checks. Detailed checkpoint evidence appears below.

The browser is not release-ready. Scoped DOM automation, remote MCP, complete Chrome extension
management/tab compatibility, profile management/export/sync, true renderer discard, Metal/motion,
interactive accessibility/input verification, signing/notarization and updates remain. Native tests
run serially because they enforce real wall-clock resource budgets. Codex sidebar registration remains a
manual app step because available project tools do not provide it.

## Starting environment (historical)

This repository began empty. The Native source is being inspected at
`/Users/dak/Documents/Codex/2026-09-05/usi/work/native`, commit
`5665a355cae768dff734d79dd4c0bd9d099f83fb`. Its browser example uses layered WebViews;
macOS Chromium embedding uses CEF (Chromium Embedded Framework). TypeScript cores compile
ahead of time, so arbitrary live plugin JavaScript requires a separate runtime and native adapter.
The host has Apple Silicon, Xcode, Node 22.23.2 and pnpm 11.24.0; no global Native or Zig command.

## Milestones and behavioral acceptance

1. **Engine evidence:** install pinned Native tooling, run a minimal Chromium integration,
   verify native controls can coexist with live Chromium content, and test representative Chrome
   extension loading and CDP. Capture limitations before designing against unsupported APIs.
   Promote the integration only when actual web navigation and control are demonstrated.
2. **Framework and default browser:** introduce public state/configuration/component contracts,
   isolated runtime plugin loading, persistent profiles, page navigation and page lifecycle. Verify
   the default interface and an independently loaded alternate interface use the same API.
3. **Automation and boundaries:** exercise MCP navigation/configuration/plugins and explicit CDP
   profile grants against the real host. Verify denied access, revocation, and plugin recovery.
4. **Website and docs:** implement a locally runnable responsive site at `apps/site`, with navigable
   and searchable documentation, real examples, and honest availability labels.
5. **Integration validation:** root typecheck/lint/format/test/build; native interactive smoke,
   representative extension compatibility, plugin live reload/recovery, resource measurements,
   and packaging. Record actual measurements; do not replace behavioral proof with schema tests.

## Execution and recovery

Run pnpm commands from the repository root. `pnpm install` creates the exact-version lockfile;
CI must use `pnpm install --frozen-lockfile`. Root `pnpm check` composes toolchain checks.
Native commands and package scripts will be recorded after inspecting CLI help and actual build
outputs. Keep downloaded toolchains in ignored work/cache directories, not source control.
All browser testing uses a dedicated Hitchhiker profile; do not read existing personal browser data.
Retry builds without deleting unrelated user files. Runtime plugins must retain a known-good
version for rollback and expose a trusted recovery interface independent of the chosen UI.

## Progress

- [x] 2026-09-05: Product interview complete and implementation authorized.
- [x] 2026-09-05: Created project directory and root Turborepo/tooling manifests.
- [x] 2026-09-05: Installed Native 0.10.1; minimal TypeScript/native app check and ReleaseFast build passed (18/18 steps).
- [x] Proved CEF-owned window with embedded Native surface, Native click to Chromium navigation,
      return title event, typed input across zoom/restore, and clean close.
- [x] 2026-09-05: Implemented pure public core policies for configuration, tabs, scoped grants,
      bounded declarative plugin proposals and budget state; eight regression tests pass after review.
- [x] Refactored core into neutral pages/viewports and the public default-interface package;
      seven behavioral test groups and independent review verify the portable contracts.
- [x] Implemented stable native page IDs and arbitrary nonoverlapping viewports using CEF-owned
      child windows. In-process DevTools test passed 100 layout changes with document/state
      preservation and MV3 content-script/worker/storage responses from both pages; 12 temporary-page
      lifecycle cycles completed without losing either original document.
- [ ] Complete multi-page visual/focus/fullscreen checks after the Mac is unlocked.
- [ ] Implement native default interface, runtime plugins and actual host enforcement.
- [ ] Implement MCP/CDP and security/resource enforcement.
- [x] 2026-09-05: Implemented website and nine docs routes; checked desktop/mobile navigation,
      search, table-of-contents route preservation, and console output.
- [ ] Replace runtime API proposals with verified host documentation after engine integration.
- [ ] Complete end-to-end verification and packaging.
- [ ] Register folder in Codex sidebar (tool limitation).

## Surprises and discoveries

- Codex project tools list saved projects but expose no registration operation. CUA denies access
  to the Codex app itself. Manual Add Project is required; the directory exists independently.
- Native has a CEF integration; original assumption that an embedding must start from scratch was
  corrected during the interview. Native-rendered composition and extension parity remain unproven.
- Exact CEF 144 source confirms parent-view embedding forces Alloy, whose Chrome-extension APIs
  were removed in M128. See `ENGINE-FEASIBILITY.md` for sources and the bounded fork acceptance.
- Independent pure-core review found export leakage, NaN expiry bypass, missing active-tab
  successor, and invalid resource sample handling. All four are fixed and passed independent
  re-review. Configuration export now returns `Result<string>` and serializes only allowed fields.

## Decision log

- 2026-09-05, user: approved all accepted decisions above and implementation start.
- 2026-09-05, agent: keep a living plan because real CEF/native/plugin compatibility must be proven.
- 2026-09-05, agent: research engine integration independently while building the website; neither
  workstream may invent host APIs or compatibility claims.
- 2026-09-05, agent: request user choice between a downstream engine fork preserving both native UI
  and Chrome extensions, or deferring extension support. Browser host work awaits that choice;
  portable core and site verification continue independently.
- 2026-09-05, clarification: supersede the previous either/or question. The user wants Native UI
  surrounding a Chromium renderer with event/command integration, not a particular NSWindow owner.
  Investigate Native embedding inside a CEF-owned window before selecting engine patches. Both
  native UI and Chrome-extension requirements remain; no full engine fork has been approved.
- 2026-09-05, user: tab behavior must be completely replaceable. Separate the underlying page
  lifecycle from the default tab presentation; plugins may build alternate organization and layouts.

## Outcomes and retrospective

Implementation is incomplete; basic host composition and multi-page engine behavior are verified. A temporary Native toolchain smoke app
compiled successfully. The website and pure-domain core pass root `pnpm check`: exact dependencies,
typecheck, oxlint, oxfmt, seven behavioral test groups, and portable production builds. Frozen-lockfile install
passes. Review fixes were re-reviewed; mobile docs search was corrected and manually rechecked.
The separate host experiment now verifies Native/Chromium bidirectional events and document state
across 100 single/split viewport changes, with a local MV3 extension. It is not a production browser.
The CPU-rendered sidebar, incomplete input/accessibility integration, Chrome per-page window semantics,
live plugin runtime, authenticated automation, performance measurement and packaging remain open.
The live website can be started with `pnpm --filter @hitchhiker/site dev --host 127.0.0.1 --port 4173`.

Next action: complete the multi-page desktop checklist when
unlocked. Connect the verified adapter to public framework commands/events before claiming runtime
plugins or MCP control. Keep raw CDP disabled until its separate grant boundary is implemented.

## Revision notes

- 2026-09-05: Initial plan grounded in checked environment and Native source.
- 2026-09-05: Added exact engine incompatibility evidence, successful native toolchain build,
  and pending fork choice. Continued only independent core/site work.
- 2026-09-05: Recorded reviewed portable implementation and website verification; kept all native
  runtime, Chrome-extension and automation milestones explicitly unfinished.
- 2026-09-05: Corrected premature full-fork conclusion after the user's renderer/UI clarification;
  recorded the CEF-owned-window route, remaining tab boundary, and official CEF download evidence.

- 2026-09-05: Made tab presentation optional; recorded seven reviewed behavioral test groups,
  reconciled closed-page presentation state, and added the compiled macOS host experiment.

- 2026-09-05: Verified Native input/navigation/events and multi-page persistence with a local MV3
  extension. Added reviewed close cancellation and popup draining; desktop checks remain pending.

## Full implementation continuation

The active user goal is to complete every accepted browser requirement and publish the repository
to `dakdevs/hitchhiker`. Publishing the source is one deliverable and does not complete the browser.
The public repository was created on 2026-09-05. The first remote clean check found typecheck ordering
that local generated artifacts masked; typecheck now requires dependency builds.

Current execution: introduce a private bounded JSON-lines connection between a per-profile native
engine process and the TypeScript runtime. Web pages cannot access this connection. The runtime will
own persistent state/grants, isolated plugin execution, public interface composition and authenticated
MCP/CDP. Keep the host experiment runnable as a behavioral regression while promoting these paths.
Native runtime component composition and GPU/input integration are being researched against the pinned
source; do not replace the requested Native interface with web chrome.

Completion must include: a usable default native browser; replaceable sidebar/top/custom interfaces;
Chrome extension install/use; live plugin installation, permissions and rollback; MCP plus separately
granted standard CDP; profile persistence/isolation; protected-page resource conservation; shared motion,
Lucide and accessible design; accurate complete public docs; reproducible macOS packaging; and verified
remote source/CI. Untested or proposal-only behavior does not satisfy these requirements.

### Runtime evidence, 2026-09-05

- [x] Private per-profile host IPC and browser-root CDP inherited pipes, with bounded transport and
      fail-closed pipe/engine shutdown.
- [x] Live Native trees through a compiled adapter, measured viewport bindings and actual Lucide SVGs.
- [x] Persistent scoped grant store and authenticated loopback CDP relay; real Playwright reads,
      writes and persisted-grant revocation verified against Chromium.
- [x] Two actual profile processes kept fixture cookies/local storage isolated and closed cleanly.
- [x] Public default sidebar/top surface and Native Unicode/IME text reducer portable tests.
- [x] Runnable browser controller integrated and verified, including restoration and event-loop safety.
- [ ] Live isolated plugins, MCP, trusted recovery, performance enforcement, Metal/Retina/accessibility,
      full extension compatibility and packaging.

The first integrated relay test caught a WebSocket callback that treats a successful `null` error as
failure; the callback now accepts both null and undefined. Native's first viewport semantics event
can be zero-sized before layout; only positive measurements are applied. The generic Zig JSON
decoder instantiated unsupported f128 helpers for numeric-array strings, fixed with strict string
and finite-decimal wire decoders. See [RUNTIME.md](RUNTIME.md) for reproducible test commands and limits.

### Browser/framework checkpoint, 2026-09-05

- [x] Actual default browser restore, navigation, pin/order/selection persistence and clean close.
- [x] Fixed a Native parsed-tree use-after-free found by the complete browser test. Retain one prior
      generation through the following frame; 250 changing Native commits then exited cleanly.
- [x] Retina CPU rendering, reused bounded pixel storage, damage updates and idle revision gating.
- [x] Real isolated JavaScriptCore/XPC plugin host with nested Promise activation, sandbox denial,
      wall/RSS termination, process cleanup and recovery tests. Production build excludes test probes.
- [x] Public TypeScript plugin SDK and compiled canvas example composed real Native/Chromium views;
      durable grant revocation returned the real app to its default interface.
- [x] Official MCP client controlled the real browser through stdio, including page creation, tab
      placement, configuration and durable revocation. Stdio framing/concurrency/EOF cleanup tests.
- [x] Cross-process grant mutation locking; concurrent child issuance/revocation preserved state.
- [x] Real default-controller inactivity freezing stopped a page timer, plugin presentation activated
      it before display, and rejection of an invalid replacement retained the working interface.
- [x] Actual download activity protects pages. Native audio/capture callbacks are implemented but
      device/capture-permission verification remains outstanding while the Mac is locked.
- [ ] Integrated package installation/updates/permissions/known-good rollback and full MCP/API coverage.
- [ ] Chrome extension installation and same-window tab compatibility, profile management/export/sync.
- [ ] Shared motion, full accessibility/IME/focus verification, Metal presentation and performance budgets.
- [ ] Signed/notarized distribution and updates; saved-project registration in Codex.

Integration review found two additional failures caught by expanded tests: a fabricated Effect
schedule value silently broke the initial controller timer, replaced with real scoped sleep/forever;
and the UI package instantiated DOM TextEncoder at module load, which JavaScriptCore does not supply.
UTF-8 length handling is now pure ECMAScript and the compiled example passes in the isolated host.
Plugin declarations also constrain forwarded events; UI events are scoped to their trusted owner.
Plugin source reads use fixed regular files, no-follow descriptors and byte limits. Runtime package
compilation and persistent installation remain separate future work.

### Checkpoint verification, 2026-09-05

Root `pnpm check` passes after the integration fixes above. With both native executables supplied,
the runtime suite passes all 49 tests and the browser suite passes all five, with no skips. No native
host or plugin processes remain after shutdown. These checks do not establish interactive focus,
accessibility, device capture or release packaging, which remain open.

Next work is persistent plugin installation/update/rollback and a relocatable developer macOS bundle.
See [NATIVE-PRESENTER.md](NATIVE-PRESENTER.md) for the separate future Metal integration boundary.

### Persistent plugins and developer bundle, 2026-09-05

- [x] Compiled artifacts are bounded, hashed, immutable profile data; no package scripts run.
- [x] MCP installation delegates only the caller's allowed capabilities, persists no child bearer,
      and respects inherited origin/profile/expiry restrictions and ancestor revocation.
- [x] Install/update/enable/disable/rollback and startup restore run fresh isolated workers. Tests cover
      interrupted activation, health-window failure, rollback failure, revoked recovery grants and
      bounded crash recovery. The native Plugins screen shows permissions and lifecycle controls.
- [x] Actual MCP client exercised install/update/rollback/disable/enable/restart against the native
      browser, retaining the page identity, then revoked the parent grant and observed durable disable.
- [x] Native profile `flock` denies a second engine before readiness and releases after a crash.
      Canonical CEF root/cache paths prevent macOS `/var` aliases from falling back to memory storage.
- [x] Native-enabled runtime checkpoint: 59 passed, no skips. Browser suite: 24 passed, no skips.
- [x] Expanded native runtime suite: 60 passed, no skips, in a serial test run. Instrumented concurrent
      runs confirmed the 500 ms wall watchdog killed the initial plugin activation under contention;
      a separate EOF deadline was also affected. `pnpm test:native` provides an explicit serial lane.
      Temporary watchdog instrumentation was removed. Separating cold worker startup from execution
      accounting remains a performance refinement; the watchdog has not been loosened.
- [x] Final native-enabled browser suite: 25 passed, no skips. The added pinned DOM feasibility probe
      verifies top-frame isolation, hostile-main-world resistance, loaded child-frame AX exclusion,
      and rejection of old contexts/objects after navigation. Public scoped DOM tools remain next work;
      see `SCOPED-DOM-PLAN.md`. The separate Chrome extension design is in `EXTENSIONS-PLAN.md`.
- [x] Relocatable ad hoc signed arm64 app includes the production controller, pinned Node, CEF and
      isolated PluginHost. The launcher and engine share the outer application's CEF resources;
      nesting the complete CEF app was rejected after an initialization crash. A relocated path with
      spaces passes both actual MCP plugin lifecycle and corrupt-store safe-mode tests. Packaging
      builds in an isolated copy and leaves the developer dependency installation unchanged.
- [ ] Interactive Command–Shift–Escape recovery validation after macOS unlock. Native event monitor
      and trusted broker recovery are compiled; no plugin-provided action can invoke this path.
- [ ] Graphical permission issuance, artifact garbage collection/catalog, and isolated source compiler.

The default Plugin controls remain responsive while an isolated worker starts; duplicate clicks do
not enqueue repeated starts. One prior revision is retained. A plugin's earlier page/configuration
side effects are not rolled back. Registry mutation uses a private directory lock; a process killed
while holding that lock can leave it stale. Stop all profile writers before manually removing
`hitchhiker-plugins/.plugin-write-lock`. Safe mode bypasses registry restoration even when its data is
invalid; a metadata failure does not terminate the default browser.

### Next implementation packet

Commit `fdfcc96` is published to `dakdevs/hitchhiker`; its GitHub Check run passed. The scoped DOM
implementation now follows the verified top-document contract in `SCOPED-DOM-PLAN.md`: bounded
snapshots, connection-local refs, semantic click/fill, repeated origin authorization, and conservative
write protection. General keyboard input and child-frame actions remain excluded from this packet.
In parallel, assess separating plugin startup and CPU execution accounting without weakening the
external watchdog, sandbox, memory limit, or asynchronous activation recovery.

The website's Plugin authoring and Native UI pages now include workspace/manifest/build examples,
capability and component tables, event/recovery guidance, and searchable section navigation. The
TypeScript excerpts compile against the current workspace SDK. Desktop (1440 px), mobile (390 px),
and narrow layout (720 px) checks show no document overflow or page errors; tables and code scroll
within their own regions. A separate source/screenshot review returned `ship` with no material findings.
