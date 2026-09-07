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
- September 6 clarification supersedes a monolithic first-party interface: every default product
  feature must ship as a plugin using public APIs. Tab state, horizontal/vertical presentation and
  pinning must be independently composable. DevTools must work by default and be customizable;
  docs must map Chromium capabilities, security controls and CDP with grants and working examples.
  See [PLUGIN-FIRST-PLAN.md](PLUGIN-FIRST-PLAN.md) for the required architecture correction.

## Current implementation

The development browser runs Native UI around live Chromium pages. The default sidebar/top interface
and an independent canvas plugin use public page/viewport/component APIs. Isolated compiled plugins
support persistent MCP installation, updates, rollback and grant revocation. Local stdio MCP and a
separately authorized loopback CDP relay are integrated. The relocatable arm64 developer app passes
real plugin lifecycle and safe-mode checks. Detailed checkpoint evidence appears below.

The browser is not release-ready. Full DOM automation, remote MCP, complete Chrome extension
management/tab compatibility, profile management/export/sync, true renderer discard, Metal/motion,
interactive accessibility/input verification, signing/notarization and updates remain. Native tests
run serially for stable native helper builds and bounded fixture deadlines. Codex sidebar registration remains a
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

### Scoped automation and CPU accounting integration

Commit `b8ac145` publishes the expanded plugin/component docs; its GitHub Check run passed.
This packet adds top-document MCP snapshots, semantic clicks and text filling, and
corrects the isolated plugin watchdog to distinguish process CPU from startup/host-wait time.
Review-driven DOM changes bound isolated-world and lock retention, fail closed on ambiguous password
controls, validate accessibility graph identities, recheck authority immediately before mutation, and
budget the complete MCP response including an escaped request ID. Final review also caught and fixed
in-flight snapshot invalidation, pre-protection authorization, and accessibility cleanup after a
dispatched enable request fails. Independent re-review accepted the resulting packet. Root
`pnpm check` passes, and the native serial lane passes all 74 runtime and 31 browser tests with no
skips (`work/scoped-dom-root-final.log`, `work/scoped-dom-native-final.log`). Focused evidence and
the explicitly unsupported operations are recorded in `SCOPED-DOM-PLAN.md`.

The native budget review accepted the enforcement path with no observed bypass. Seven native tests
also cover hostile thenable/conversion and same-host startup recovery. Process-group cleanup keeps
the worker PID reserved with `waitid(..., WNOWAIT)` until signaling finishes. The worker retains a
500 ms process-CPU slice, the broker has separate 4-second startup and 5-second total-command bounds,
and the existing external 150 MiB supervisor remains active. See `PLUGIN-BUDGET-PLAN.md`.
The original-concurrency native runtime lane also passes all 74 tests without skips or a false
startup kill (`work/plugin-budget-concurrent-final.log`, 11.4 seconds).
The developer app was rebuilt from the finalized sources and copied to a path with spaces outside
the checkout. Strict signature/import checks and all three actual MCP cases pass from that relocated
bundle: scoped DOM, persistent plugin lifecycle, and corrupt-store safe mode. Evidence is in
`work/scoped-dom-bundle-build.log`, `work/scoped-dom-bundle-verify.log`, and
`work/scoped-dom-bundle-native.log`. It remains an ad hoc signed arm64 developer artifact; interactive
macOS verification and release signing/notarization remain outstanding.

### Chrome extension management implementation

The scoped automation/CPU packet is published as `e34bfcb`; GitHub Check run `34017345905` passed.
The next packet implements the unpacked MV3 extension path in `EXTENSIONS-PLAN.md`: a bounded
immutable profile store, typed Chromium load/uninstall control, native local permission review,
durable installation/removal intent, and replay before restoring pages. Raw CDP takes exclusive
browser-pipe ownership and cannot invoke unsafe extension methods. Safe mode omits extension setup.
This is progress toward existing Chrome extension support, not a redefinition of the final browser:
CRX/Web Store distribution, updates, action UI and same-window compatibility remain required work.

The unpacked extension manager is integrated with native permission review, immutable profile copies,
durable install/remove intent, explicit retries, startup replay and safe package collection. Independent
review caught and fixed multi-entry replay overwrites, post-submission persistence uncertainty,
interrupted-removal retention and symlink-target chmod. Native testing caught a separate app-shutdown
path that bypassed managed page closure and erased the saved session; native close routing and
controller session preservation are corrected. All 79 runtime and 64 browser native tests pass with
no skips (`work/extensions-native-final.log`). The four-session extension test proves storage, page
restoration, profile isolation and removal across restart. See `EXTENSIONS-PLAN.md` for exact limits.

The website now has a Chrome extensions guide; desktop/mobile checks at 1440, 720 and 390 pixels show
no document overflow or page errors. `docs/EXTENSIONS.md` documents installation and recovery. The
developer bundle was rebuilt and relocated outside the checkout to a path with spaces. Strict
signature/import checks pass, as do all four actual integration cases: managed extensions, MCP DOM,
persistent plugin lifecycle, and safe mode with malformed plugin/extension stores. Evidence is in
`work/extensions-bundle-build.log`, `work/extensions-bundle-verify.log` and
`work/extensions-bundle-native.log`. This is still an ad hoc signed arm64 developer app.

Next correctness work is ordered engine-event draining at process exit: current shutdown may drop
queued tail events under adverse scheduling, despite normal native restart tests passing. Follow with
the real Chromium discard experiment in `DISCARD-PLAN.md`; a Chrome-runtime extension route is plausible
but not verified. Do not describe reversible freezing as actual RAM discard or substitute URL-only
recreation for Chromium session-preserving discard without a product decision.

Commit `6385f23` publishes the extension/session checkpoint; GitHub Check `34050783603` passed.
Current work follows `ENGINE-DRAIN-PLAN.md` to close the buffered-tail delivery gap, while a separate
disposable native experiment evaluates the Chrome `tabs.discard` route from `DISCARD-PLAN.md`.

The corrected discard experiment now passes three repeated disposable native runs. Chromium replaces
its tab/CDP identities while retaining the Hitchhiker page ID and releasing one renderer; measured
renderer RSS falls by about 322 MiB in the synthetic fixture. Explicit reload preserves the tested
history URLs/index, cookie and extension storage. Selection alone remains blank, so automatic discard
is not yet integrated. `DISCARD-PLAN.md` records the evidence and limitations; host lifecycle mapping
is the next step while runtime shutdown draining is implemented independently.

### Ordered engine shutdown

`EngineConnection` now rejects operations promptly while draining parsed host events in FIFO order.
Logical exit waits for direct consumer scopes, including controller session writes, under one bounded
deadline. Failed/interrupted handlers prevent success; timeout cleanup terminates the owned child,
and forced layer closure settles a captured exit effect. Independent re-review accepted the change.
Root `pnpm check` and all 153 native tests (89 runtime, 64 browser, no skips) pass. The contract and
asynchronous-stream handoff limits are recorded in `ENGINE-DRAIN-PLAN.md`. The developer app was
rebuilt and relocated outside the checkout; strict signature/import checks and all four actual bundle
integration cases pass. Evidence is in `work/engine-drain-bundle-{build,verify,native}.log`. Release
signing/notarization and interactive macOS checks remain outstanding.

Commit `a738281` publishes ordered shutdown; GitHub Check `34052824822` passed.

### Preserve native input protection across same-document navigation

Native unsaved-input protection now clears only at a new main document's post-commit `OnLoadStart`.
Previously ordinary address/loading callbacks cleared it, including fragment/history navigation and
subframe loads. Stale browsers remain fenced, and audio/call/download flags are preserved. Independent
review accepted the four native changes.

The regression performs a native macOS Backspace on a populated input, verifies the real text deletion
and protection signal, then checks fragment/history/subframe retention and replacement-document
clearance. The old binary fails on hash retention (`work/input-protection-baseline-backspace.log`);
the patched binary passes (`work/input-protection-patched.log`). Earlier printable-key attempts did
not reach that assertion: Chromium's native macOS CDP builder maps `char` to a key-up platform event.
The regression is automated native input coverage, not a substitute for physical keyboard/IME checks.
Its negative retention assertions use bounded observation after actual navigation conditions.
Root `pnpm check` and all 154 native tests pass (90 runtime, 64 browser, no skips), recorded in
`work/input-protection-root-check.log` and `work/input-protection-native-final.log`.

The developer app was rebuilt and relocated outside the checkout to a path with spaces. Strict
signature/import verification and all eight relocated checks pass, including managed extensions,
MCP DOM, persistent plugins, corrupt-store safe mode and native resource/input protection. Evidence
is in `work/input-protection-bundle-{build,verify,native}.log`. This remains an ad hoc signed arm64
developer artifact; release signing/notarization and interactive macOS checks remain outstanding.

The separate private discard proof verifies repeated replacement callback ordering, worker stop/wake
through a page CDP session, and an exact logical-page → native CDP target → extension tab-ID join with
duplicate URLs. CEF browser IDs differ from Chrome extension tab IDs despite the pinned header claim.
`DISCARD-PLAN.md` records that correction and the broader debugger permission needed by the identity
fixture. Production discard remains pending; generic replacement correctness is the next packet.

Commit `92ff0ab` publishes input-protection retention; GitHub Check `34054398940` passed. The next
implementation follows `REPLACEMENT-PLAN.md`: generic Chromium browser-generation replacement,
cached metadata, CDP/DOM fencing, conservative resource knowledge and close ordering. Automatic
reload remains a separate positively classified discard operation; no replacement callback alone
is evidence that a reload is safe.

Generic replacement is integrated with browser generations, cached native metadata, conservative
resource knowledge, retired CDP requests/observers and stale DOM-handle rejection. The actual native
fixture passes three discard/explicit-reload cycles with preserved history and stable logical pages.
Root checks, all 160 native-suite tests and ten relocated developer-bundle checks pass. Independent
review found no blocking issue. Root's final closed/unknown-page CDP error correction passes an expanded
native fixture, including individual closure after replacement. Details and the explicit manual-restoration
limit are in `REPLACEMENT-PLAN.md`.

Commit `c81c131` publishes generic browser replacement; GitHub Check `34055724492` passed.
The next bounded proof checks whether querying the current discarded page's native `Target.getTargetInfo`
and joining it to `chrome.debugger.getTargets`/`tabs.get` preserves both discarded state and renderer
release. Record renderer PIDs at each step before any explicit reload; do not assume read-only CDP
attachment is free of renderer activation. The probe owns only ignored `work/restore-classification-probe/`.
No automatic restoration or discard scheduler is enabled yet.

Pinned Chromium source review establishes that explicitly targeted `tabs.discard` bypasses the
normal discard eligibility policy. A controller preflight cannot atomically protect a page across
the asynchronous extension call. Keep this route experimental; automatic discard needs a native
mutation-time guard. The current reversible-freeze scheduler also lacks navigation knowledge.
The controller now tracks loading per browser generation, excludes loading/unknown pages from
freezing, and wakes a frozen page when its current browser reports navigation. Portable tests cover
unknown state, loading, completion, stale generations and wakeup. A real native fixture first sleeps
a hidden page, starts trusted navigation, holds the server response for longer than the inactivity
threshold and verifies the page stays awake until completion. Independent review found no blocker.
Root checks and all 161 native-suite tests pass (91 runtime, 70 browser, no skips), recorded in
`work/navigation-freeze-root-final.log` and `work/navigation-freeze-native-final.log`. This does not
claim cross-process atomic protection or enable destructive discard. The developer app was rebuilt
and relocated outside the checkout. Strict signature/import verification and all eleven relocated
checks pass, including held navigation, replacement, input protection, managed extensions, MCP DOM,
plugin lifecycle and safe mode. Evidence is in `work/navigation-freeze-bundle-{build,verify,native}.log`.
The artifact remains ad hoc signed arm64; release signing and interactive macOS checks are outstanding.

Commit `fa87fb5` publishes navigation-aware freezing; GitHub Check `34056939676` passed.
The next engine packet follows `GUARDED-DISCARD-PLAN.md`: a narrow CEF hook that checks browser-observed
protections at mutation time while retaining Chromium's normal eligibility checks, with an explicit
exception for the host's one-tab-per-window topology. Pinning remains an interface choice, not a
native protection bit. A full Chromium checkout/build has not begun. In parallel, the next
portable customization packet will export only validated engine settings, legacy default tab placement,
and plugin identity/hash/capability metadata. It must exclude page/session data, executable bytes, grants
and runtime storage; importing a recipe must not authorize or start a plugin.

The docs-only follow-up `a560870` exposed an existing plugin cancellation failure in GitHub Check
`34057245706`: cancelling an update left its candidate revision instead of the known-good revision.
Other runtime test cancellations were downstream of Turbo stopping after this failure. Current repair
work examines the full stop/persist/start recovery boundary and ensures filesystem operations settle
before rollback or mutation-lock release. Use deterministic interruption regressions, not a longer
test sleep or an unexamined CI retry. Native navigation/replacement code is unchanged by this packet.
The implemented repair and deterministic filesystem/worker barriers are described in
`PLUGIN-CANCELLATION-PLAN.md`. All nine new regressions fail against the isolated pre-fix source and
pass with the repair. Root checks and all 170 native-suite tests pass (91 runtime, 79 browser, no
skips). The rebuilt developer app passes strict verification after relocation outside the checkout
and all eleven bundle checks, including real plugin lifecycle and safe mode. Evidence is recorded in
`work/plugin-cancellation-baseline-final.log`, `work/plugin-cancellation-root-final.log`,
`work/plugin-cancellation-native-final.log` and `work/plugin-cancellation-bundle-{build,verify,native}.log`.
Independent review accepted the final cancellation, durable recovery and lock boundaries.
Commit `0c19998` publishes the repair; GitHub Check `34058687172` passed.

Portable customization implementation now follows `CUSTOMIZATION-PLAN.md`: strict versioned recipes,
combined controller settings persistence, MCP export/import and explicit plugin requirements that
never confer permissions or activate code. Existing configuration-only exports remain supported.
The implementation and independent review are complete. Root checks and all 176 native-suite tests
pass (95 runtime, 81 browser, no skips), including real MCP recipe round trips and persisted settings.
Portable tests verify preservation of pages, pinned presentation state and a custom plugin surface,
restart, failed writes, strict input bounds, private-field projection, grants and nonactivation.
The initial native run exposed a pre-command timer comparison in the existing freeze fixture; its
post-acknowledgement comparison is documented in `CUSTOMIZATION-PLAN.md`. Final source evidence is in
`work/customization-root-final.log`, `work/customization-native-final.log` and
`work/customization-projection-tests.log`.
The rebuilt app passes strict signature/import verification after relocation outside the checkout
and all eleven developer-bundle checks, including its packaged MCP customization path. Evidence is in
`work/customization-bundle-{build,verify,native}.log`. This remains an ad hoc signed arm64 developer
artifact; notarization and interactive macOS verification are still outstanding.

Commit `1958afd` publishes portable customization; GitHub Check `34059298413` passed.
The next guarded-discard packet now has a source-only draft under `apps/host-probe/cef-patches/`.
CEF's translator generated the new wrappers and hashes; all 18 existing API versions plus both
untracked versions pass hash validation. This is not a compiled engine change or automatic-discard
implementation. The nine-file patch application, native guard implementation, full source build,
runtime validation and integration gates are distinguished in its README. The build currently needs
a larger APFS volume (150 GB documented minimum versus about 58 GB locally); a location was requested.
Pinned source inspection also found that CEF's persistent internal CDP client triggers Chromium's
debugger protection after freezing or inspection. The source draft now includes an explicit release
operation for CEF's own client rather than weakening that protection. Native pending-call drainage,
observer/cache reset, rejection recovery and external-debugger preservation must be verified before
automatic discard is enabled.

The source draft is published as `e8df6ae`; GitHub Check `34066931763` passed. Full Chromium build
storage remains pending. Independent application work continues with trusted plugin removal through
MCP and native recovery controls. See [PLUGIN-REMOVAL-PLAN.md](PLUGIN-REMOVAL-PLAN.md) for durability,
grant boundaries, retained artifact cache and required behavioral checks.

Plugin removal is implemented and independently reviewed. Portable checks and all 188 native-enabled
runtime/browser tests pass without skips. Real MCP removes a compiled canvas plugin, revokes both
revision grants, preserves the page across restart, and accepts an explicit reinstall with fresh
authority. Eleven new manager regressions cover grant ownership, cancellation and partial failure.
All eleven relocated developer-bundle checks pass without skips, with strict signature/import
verification. The first bundle run exposed a replacement-fixture assumption that a shown discarded
page could not yet have restored; Chromium can restore it on visibility/focus. The corrected test
checks identity/history instead, while portable tests still prohibit a Hitchhiker reload caused only
by replacement. Production replacement behavior is unchanged. Evidence is recorded in the removal plan.

The user requested a compact macOS window header matching the supplied Codex screenshot: native
traffic lights followed by sidebar, back and forward icons, with content reaching the top edge and no
separate titlebar strip. Preserve standard window controls, dragging, resizing and fullscreen, and
keep the header/layout replaceable through public framework building blocks. This is the next native
interface change; it must not alter Chromium's page renderer or extension runtime.

The compact-header source passes all 192 native-enabled tests without skips, root portable checks,
and the new AppKit raster fixture. Real desktop checks confirmed sidebar collapse/expansion,
minimize and fullscreen entry. Physical dragging, fullscreen exit and edge resizing remain
unverified. See [COMPACT-WINDOW-PLAN.md](COMPACT-WINDOW-PLAN.md) for the discovered AppKit image-cache
fix, public window controls and remaining checks.

The user supplied a Dia sidebar reference on September 6: compact pinned tiles above a vertical
list of leading-icon tab rows, a rounded selected-row highlight, and a quiet New Tab action.
Apply that presentation to the default interface while retaining the earlier compact-header
arrangement, public framework composition and page identity. Avoid persistent text Pin/Close
buttons beside every row. Keep pin/close actions accessible through concise controls.

The default sidebar now has six-column pinned tiles, native list-item rows, a full selected-row
highlight and New Tab beneath, while retaining the compact macOS header. Desktop verification
with eleven local pages confirmed the layout. Site initials are the current pinned-tile fallback;
favicon acquisition remains unfinished. See [SIDEBAR-TABS-PLAN.md](SIDEBAR-TABS-PLAN.md) for the
restore starvation and close-cancellation fixes discovered during this verification, plus final
portable/native/bundle evidence.

## Live installed plugin plans

The installed manager now persists a revisioned V2 plan for enabled plugins, composition and service
bindings. MCP can stage disabled artifacts and atomically apply a complete replacement plan; compatible
workers retain their generations. Cancellation, rollback, interrupted uninstall cleanup and pending
startup recovery have portable behavioral coverage. The final portable check passed with 316 passing
tests and 29 native-gated skips, plus all builds. The real native sidebar-switch fixture failed during
initial model activation, before any switch assertion. Default bootstrap and the complete feature-plugin
cutover remain unfinished. See [LIVE-PLUGIN-PLAN.md](LIVE-PLUGIN-PLAN.md) for contracts and evidence.

Default bootstrap prerequisites now include owner-bound revision-zero tab/pin migration, idempotent
trusted managed grants, and exact disabled staged-install retry. That earlier portable check passed
328 tests and all builds, with 29 native-gated skips. Startup is now cut over; see
[DEFAULT-BOOTSTRAP-PLAN.md](DEFAULT-BOOTSTRAP-PLAN.md) for permanent completion/abandonment markers,
crash-gap recovery, page-restoration readiness, packaging and management-route prerequisites. Native
startup/clean-shutdown acceptance remains unresolved.

The next startup prerequisites add `controller.restored`, which waits for the complete initial page
cohort and fails on startup/host/scope termination, plus trusted installation identity inspection for
recovery without exposing grant credentials. Controller and manager tests pass together (32 tests).
Default artifact builds now emit a deterministic hash-bound index of five packages and both placement
recipes; packaging verifies and copies it to `Contents/Resources/default-plugins`. The default package
suite passes (18 tests); no native app was built for that change. Coordinator fault recovery is now
reviewed and normal installed-plugin startup uses the composed default interface.

The Chromium documentation contract now explicitly requires API ownership, executable command/result
examples, replacement hooks, security defaults, denial and revocation behavior, persistence and restart
requirements. DevTools UI and its default plugin remain unfinished. Codex project registration remains
manual: the available app API has no add-project operation, and computer use denies access to Codex.

The distribution bootstrap coordinator now has 16 portable recovery tests and an accepted review.
It validates exact stored installation identities, resumes durable install/promotion checkpoint gaps,
preserves nonzero owner state, checkpoints model/pins independently, and permanently respects removal
or profile customization. An uncertain journal write requires restart. The combined check passes 346
tests and all builds, with 29 native-gated skips (`work/default-bootstrap-coordinator-check.log`). Normal startup cutover remains unfinished; this coordinator has not passed native acceptance. The public guide also names the currently exposed
appearance/sleep configuration fields separately from planned Chromium site-permission controls.

The runtime default bundle reader now resolves the packaged resource directory explicitly and verifies
its complete fixed inventory, hashes, manifests and recipes before returning code to the coordinator.
Nine new portable tests include a relocated real build and tampering/path/size/encoding rejection.
The combined check passes 355 tests with 29 native-gated skips and all builds
(`work/default-bundle-reader-check.log`). The reader is now used by normal startup. The management
API implementation and its remaining native gate are described below. Native startup and clean
shutdown remain open gates.

## Public plugin management and presenter routes

Installed plugins now use `plugins.read` for bounded public snapshots and `plugins.manage` for
enable, disable, rollback, uninstall and authenticated self-replacement. Staging executable code and
selecting grants remain outside this worker API. Read-only configuration access is available; legacy
configuration writers retain read access. The launcher binds caller identity and readiness, and the
application admits at most 16 lifecycle commands independently of their reply waiters. Snapshot reads
can run during activation without waiting for the transaction mutex. Shutdown interrupts admitted
work; stopping a requesting presenter does not cancel its accepted replacement.

The default presenters now supply Native Settings/Plugins content through public APIs. They preserve
page bindings when returning to browsing, refresh tab/navigation state while management is open,
apply appearance through the layout service, and read a fresh revision before switching presenters.
Layout manifests have read-only configuration authority; presenters have eight exact capabilities.
Pending bootstrap journals from the previous cohort recover their original artifacts and grants
without adopting new management permissions.

In installed-plugin mode, the MCP `hitchhiker_tabs_set` operation rejects requests because tab
presentation belongs to the plugin composition plan. The V1 customization export/import operations
are omitted because their recipes encode controller-owned placement. Generic configuration and public
plugin-plan operations remain available; legacy safe/developer mode retains its V1 operations.

Normal installed-plugin startup now reads persistence under the profile lease before controller
startup, uses V2 generic configuration/pages persistence, and permits legacy-seed import only until
the default bootstrap journal is terminal. It restores pages before seeding default plugins, then
removes that seed only after the durable terminal journal; a failed retirement retains it without
permitting reimport. Safe mode and developer `--plugin` bypass bootstrap while preserving the V2 seed.
Normal mode requires an absolute plugin-host path, so it
cannot silently fall back to legacy UI. The controller exposes no legacy tab policy in installed mode;
the composed default presenter owns the normal UI. Plugin management snapshot reads are available
during activation, while management mutations stay paused through restore and bootstrap and open only
after bootstrap returns. Development may set `HITCHHIKER_DEFAULT_PLUGINS` to an absolute trusted
bundle directory; production resolves the packaged resource directory.

The final full check passes 378 portable tests with 30 native-gated skips, including dependency
validation, typecheck, lint, formatting, tests, and builds
(`work/plugin-startup-cutover-final-check.log`). Native public-action switching with retained document
markers/storage and four-worker limits remains open. DevTools, broad Chromium APIs, extension UI and
release requirements also remain open.

The native bootstrap seam fixture has since passed a migrated V1 two-page profile through the actual
host, including five installed plugins, four running workers, selected viewport restoration, V2 seed
retirement, a completed journal, explicit window close, and engine exit zero
(`work/native-default-startup.log`, 1 pass, 0 skips). It does not establish full main-entrypoint or
release acceptance, live public presenter switching, or a complete shutdown fix: prior intermittent
activation/shutdown failures remain regression concerns, and this fixture logged an IPC
request-queue-full message during shutdown.

## DevTools integration in progress

The startup cutover is published at `745f480`, with exact-commit CI success and a real native
bootstrap fixture. Next, [DEVTOOLS-PLAN.md](DEVTOOLS-PLAN.md) defines public DevTools primitives,
profile-wide frontend authority, resource ownership and a replaceable default plugin. The native
adapter, SDK/MCP contract and application lifecycle integration are being implemented independently.
No DevTools feature or expanded default cohort is verified yet.

The DevTools working tree now passes the complete portable check: 389 tests pass, 31 native-gated
tests skip, and dependency/type/lint/format/build checks pass (`work/devtools-full-check-final.log`).
The corrected native target compiles. Public SDK/MCP controls, profile-wide grants, resource
ownership/revocation tests, the standalone plugin and [API reference](DEVTOOLS.md) are implemented.
Three native fixture runs stalled before inspector assertions in macOS Keychain access during
`CefInitialize`; each required cleanup of its owned processes. Readiness gating and an abort signal
did not settle startup cancellation. Default-bundle integration and native lifecycle acceptance
remain open; these changes are not yet published. The existing controller replacement test now
uses a revisioned page-watch sentinel rather than fixed sleeps to observe prior lifecycle events.

DevTools checkpoint verification now passes the complete repository check: 395 portable tests,
32 native-gated skips, and dependency/type/lint/format/build checks
(`work/devtools-checkpoint-final-check.log`). The native host compiles, and two real fixtures pass
with a disposable mock-Keychain profile: inspector ownership/revocation/document retention/capacity/
shutdown, and compiled plugin controls with synthetic Native toolbar events. Normal Keychain
startup still fails readiness on this machine, but bounded process cleanup now returns the startup
error after 30 seconds with no remaining host or plugin worker. The public API reference documents
this distinction. The default toolbar factory has five focused tests; default bundle integration,
physical UI validation, docking/frontend extension APIs and production Keychain acceptance remain
open. [DEVTOOLS-PLAN.md](DEVTOOLS-PLAN.md) records the evidence and versioned-cohort requirements.

Published DevTools checkpoint `11bb9ca` has exact-commit CI success (run `34110688643`). Before
adding the toolbar to a new default cohort, account for service-authority containment: binding the
existing model requires `pages.list`, `pages.manage` and `storage.local` in addition to the toolbar’s
direct `ui.compose`/`devtools.manage` authority. The factory uses no pages API, but a two-capability
manifest cannot bind this provider under the current broker. Preserve that boundary during
integration; old profiles must not silently adopt the expanded default grant.

The V2 default cohort now bundles DevTools as its sixth artifact and fifth active plugin. The
versioned bootstrap preserves frozen V1 recovery and terminal profiles without new grants. A real
Native startup fixture passes composed inspector open/close, revocation cleanup, page retention
and exit zero using a disposable mock-Keychain profile. Five workers were observed at 32,288 KiB
peak combined RSS during the short fixture; this is not a full-browser performance claim.
[The DevTools plan](DEVTOOLS-PLAN.md#v2-integration-evidence) records the scope and remaining
Keychain, physical UI, full-entrypoint, shutdown-diagnostic and performance gaps.

Public presenter replacement now has real Native coverage through the composed Settings controls.
The sidebar-to-top-to-sidebar round trip retains document globals, session storage, live form values,
selection, pins and the same open inspector. The direct-manager regression now uses the V2 five-worker
cohort and passes failed replacement rollback and provider-generation stability for both placements.
Three native cases pass without skips using disposable test Keychains;
[the evidence and limits](DEVTOOLS-PLAN.md#public-presenter-retention-acceptance) distinguish synthetic
Native input from physical clicks and keep production startup and performance requirements open.

The misleading shutdown IPC diagnostic is corrected: late input on a stopped bridge returns quietly,
while the unchanged 64-request capacity branch still reports actual saturation. The Native rebuild
and all three V2 retention/rollback cases pass; captured output contains three clean shell closures
and no queue-full diagnostic. This resolves the observed warning, not production Keychain startup
or every release/shutdown acceptance requirement.

## Public plugin DOM integration

[PLUGIN-DOM-PLAN.md](PLUGIN-DOM-PLAN.md) adds SDK snapshot/click/fill through the same scoped service
as MCP, with per-activation references and current origin/profile/principal grants. No new default
permissions or raw CDP methods are introduced. Runtime, SDK and compiled Native verification are
in progress; the [public reference](PLUGIN-DOM.md) records the exact API boundary.

Published checkpoint `3b9dc09` completes that scoped DOM packet: 407 portable tests pass and two
real Native fixtures cover developer and installed plugin use, navigation invalidation, origin denial
and revocation. Exact-commit CI run `34116306804` passes. The DOM reference and plan retain the
limits around child frames, passwords, in-flight revocation and native DevTools attachment.

The next Chromium capability inventory pass maps Chrome-extension management. Local staged review,
install/remove and recovery exist, but no public SDK/MCP management port exists. The
[extension reference](EXTENSIONS.md#framework-api-availability) now distinguishes those trusted
operations from public APIs. Public installation needs a separate artifact-transfer and review
contract; exposing the private local-directory or confirmation methods is not that contract.
