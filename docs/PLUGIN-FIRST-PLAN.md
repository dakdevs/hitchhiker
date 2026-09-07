# Plugin-first browser framework

## Authority

The user clarified on September 6 that every default product feature must be a plugin. The browser
is a Chromium host and a Native plugin framework. Its familiar default experience is an installed
composition, not privileged controller behavior. The previous whole-interface replacement API does
not satisfy this requirement by itself.

## Required result

- Separate page ownership from the concept of tabs. The core owns Chromium pages and viewports;
  a plugin supplies the tab model, selection, ordering and associated commands.
- Separate the tab model from presentation. Horizontal tabs and vertical tabs are replaceable
  presentation plugins. Pinning is a separate optional feature that composes with those interfaces.
- Move navigation/address/search controls and other default product features behind the same
  public plugin APIs available to third-party authors.
- Ship default plugins as real packages with explicit identities, dependencies, permissions,
  activation, configuration and removal behavior. Renaming controller modules is insufficient.
- Support multiple cooperating plugins. A single last-writer-wins whole-window surface is not
  sufficient to assemble a browser from independent pieces.
- Keep Native components, design tokens, accessibility and motion conventions in the shared
  framework, with documented customization and a path to additional components.
- Ship working DevTools as a default plugin and expose supported opening, docking, configuration,
  extension and automation operations. Authors must be able to compose tooling around Chromium's
  developer APIs rather than being limited to an immutable inspector button.
- Document Chromium page/navigation/storage/permission/network/download/extension/DevTools
  capabilities with executable examples, required grants, profile scope, lifecycle behavior and
  Chromium-imposed constraints. Cover both typed framework APIs and explicitly granted CDP access.
  Security configuration must be discoverable through this reference. Clearly label implemented,
  planned and unsupported capabilities; never imply unimplemented wrappers already work.
- Preserve fast startup and interaction through bounded state/event delivery, incremental
  composition, isolated plugin execution and measurable resource budgets.

The trusted core retains Chromium ownership, profile isolation, permission checks, plugin execution
and lifecycle, resource ceilings, native rendering and a minimal recovery path. It must not grow
another opinionated browser interface under the label of recovery. User-facing policy choices and
their controls belong to plugins; invariant security enforcement stays in the host.

## Current gap

`apps/browser/src/controller.ts` imports the default interface, owns tab selection/order/pins,
dispatches default action strings, and renders navigation/settings/plugin screens. The SDK exposes
whole-window `ui.publish`/`ui.release`, configured independent UI contributions and installed service
dependencies. The default features still use the controller.
Legacy `ui.release` returns to a trusted default, which must become a configured plugin composition.
The installed package manager, grants and isolated worker machinery can be reused, but do not prove
the default experience is plugin-based.

Favicon work is paused before implementation while this architecture is corrected. The composition,
state, command and lifecycle contracts are being implemented before the default-feature migration.
The current private/public Chromium API gaps are recorded in
[CHROMIUM-CAPABILITY-AUDIT.md](CHROMIUM-CAPABILITY-AUDIT.md).
Acceptance requires a default browser assembled entirely through public APIs, replacement/removal
of each tab-related piece, a third-party composition example, and behavioral/performance verification.

## First implementation packet

Build the generic seams before extracting feature packages:

1. Versioned plugin services: manifests declare provided services and required/optional dependencies;
   profile configuration binds each dependency alias to a specific provider and exact contract
   version. Providers own bounded, revisioned state. Consumers can pull the latest state and receive
   bounded notifications. Commands have explicit authorization requirements, bounded queues and
   timeouts. The host supplies caller identity; bearer credentials never cross plugin boundaries.
2. Native UI composition: one configured layout provider declares slots. Independently owned
   fragments fill allowed slots in configured order. The host namespaces node/action/viewport
   identities by owner and activation generation, routes input only to the owner, validates the
   expanded surface and commits it atomically. Invalid or stale contributions cannot displace another
   plugin. Missing required layout enters minimal recovery rather than last-writer ownership.
3. Dependency-aware activation: validate the graph, contracts, configured bindings and grants before
   activation. Start providers before consumers; unwind failed activation and remove dead
   contributions. Optional features can disappear without taking down their required providers.
4. Prove the seams with real isolated tab-model, vertical-tabs and optional pinning packages, plus
   horizontal-tabs as a replaceable presentation. Then migrate navigation/address/search,
   welcome/new-page, settings, plugin/extension management and DevTools through those same seams.

Service authorization must check caller and provider grants, declared dependencies and the active
binding. A consumer must not gain a provider's broader browser authority through a command. The
implementation review must resolve delegated execution context and contract authority before
security-sensitive commands are enabled; a plugin-supplied capability label alone does not prove
that its command cannot perform more privileged work. Raw CDP retains its separate explicit grant.

Test grant intersections/revocation, graph/version errors, bounded queues, provider failure/removal,
stale generations, deterministic composition and preserved page identity across presentation and
pinning changes. Measure startup, actual aggregate plugin memory, event-to-frame latency and idle
work with the full default set. Existing per-process watchdog limits are ceilings, not evidence that
many tiny feature processes meet the performance goal. Do not give first-party plugins privileged
API shortcuts or weaken isolation to obtain better numbers.

## Composition foundation in progress

The first code slice extracts the Native surface validator and introduces a deterministic compositor
and a trusted composition session. Layout slots receive independently owned fragments in configured
order. Keys, actions and viewport identities are namespaced by owner, activation generation and
contribution; page identities are unchanged. Final validation applies to the expanded tree, including
global node/depth limits and distinct page bindings. A real Chromium fixture verifies Native viewport
layout and retained document state across an unrelated layout update.

The session must publish state and input routes only after Native accepts the complete candidate,
reject stale worker generations, and fall back to an injected recovery surface when the layout is
absent. This is host infrastructure, not a claim that installed plugins or defaults have migrated.
Public worker dispatch, dependency services, profile recipe persistence, activation transactions and
the separate default plugin packages remain required before the first implementation packet is done.

Native tree adoption and changed-page placement invalidation now use one `ui.commit` transaction.
Rejected trees keep the previous placements; successful commits invalidate changed bindings before
replying, then accept measured geometry for the new revision. Closing windows reject commits.
A missing acknowledgement or interrupted raw commit terminates the uncertain engine connection;
callers must recover the process rather than retry against unknown Native state. Surface state adoption
is uninterruptible once admitted, and stale plugin cleanup is an idempotent no-op.

Verification on September 6: all 219 native runtime/browser tests passed without skips after the
transaction changes, including retained documents under composed Native viewports, rejected commit
state preservation, geometry arriving before acknowledgement, and fatal timeout/interruption behavior.
This verifies the host composition foundation, not installed-plugin composition or performance of a
complete default plugin set.

## Installed composition integration

The public SDK now has `ui.publishLayout`, `ui.publishContribution`, and `ui.withdrawContribution`.
A profile-local `hitchhiker-plugins/composition.json` binds installed plugin identities to layout slots.
The installed launcher assigns activation generations and shares one host composition session.
Only configured UI owners may activate together; the four-worker limit remains unchanged. Legacy
whole-window publication is denied in a composed profile. `ui.release` clears the caller's publications
without disabling its activation; stopping a worker removes that generation. Missing layout keeps the trusted plugin-management interface visible so the user can repair it without MCP. The existing native emergency recovery also exposes the legacy
plugin-management interface during migration; it is not the final plugin-based recovery architecture.

`apps/composition-example` builds three independent SDK artifacts. A real Native fixture installs the
page panels before the layout, verifies two retained Chromium documents, removes and re-enables a
panel and the layout, then restores all three through the persistent manager. This does not yet move
the default tabs or navigation out of the controller. Recipes are currently edited on disk and loaded
at startup; live recipe editing, contract declarations, dependencies and activation graph validation
remain pending.

## Generic service authority decision

The first service protocol will require the consumer's effective host authority to contain the
provider's entire effective authority, including profile, origins, ancestor grants and separate CDP
permission. This is cooperation between independently authorized plugins, not delegated least
privilege. The provider continues to execute under its own fixed identity. Core will not embed tab
commands or tab-state schemas; contracts, state and behavior remain plugin-owned. Exact bindings,
versions/schema digests, activation generations, bounded calls/state and current grants remain host
responsibilities. Private provider storage exposed through a service is intentional data sharing and
must not be described as equivalent self-storage authority. The authority helper now implements this
decision; installed service integration remains pending.

Installed composition uses a direct trusted controller event sink and bounded per-activation inboxes.
Events published before activation completes remain queued. Overflow fails only that activation,
including a worker still awaiting activation, and cleanup removes its contribution. Missing layout
keeps the repair interface visible, including when contributors are enabled before the layout.
Configured UI owners without UI authority are rejected. Worker scope shutdown is marked expected
before child scopes close. The application scope now closes inside the engine layer lifetime, so
plugin cleanup completes before the engine closes. A real MCP fresh-process restart verifies that
enabled composition plugins return, disabled features stay disabled, and existing pages survive.
Safe mode also starts with an invalid composition recipe.

Activation and removal adopt the composition session and its generation-specific event inbox as one
uninterruptible transaction after permit admission. A gated cancellation regression verifies that a
committed replacement generation can still publish and receive input after its launch is interrupted.

Full native validation exposed a separate window-close race: an older navigation event may redraw
after Native starts closing but before the controller receives `window.closing`. Native now returns
a method-specific closing rejection for `ui.commit`; the controller classifies it at that boundary
and skips only the lifecycle redraw. State and persistence still update, other failures remain
errors, and a cancelled close redraws normally. The deterministic regression and focused thirty-page
Native restoration check pass with the synchronized controller and Native binary.

Browser-state saves now finish their atomic filesystem operation before cancellation completes.
This also protects controllers without a profile write lease from leaving an in-flight write behind
when their scope closes; the existing lease already imposed that ordering in the application.

Final verification on September 6: all 232 native runtime/browser tests passed without skips
(122 runtime, 110 browser), including installed composition, MCP fresh-process restore, thirty-page
window close, activation interruption and gated persistence cancellation. This remains a framework
composition checkpoint; the default-feature plugin extraction and generic services are still pending.

The rebuilt developer bundle passes file/signature verification, but its composition restart test
remains unverified: two clean packaged launches timed out before Native mounted. A process sample
shows Chromium initialization waiting in macOS `SecItemCopyMatching`; the source-run native suite
passes. The orphaned test engines were terminated. Investigate this packaged startup issue without
disabling Keychain or weakening encryption. Source commit `adf8144` passed GitHub CI.

## Service broker implementation

The next packet adds generic `provides` and `requires` declarations with exact contract identity
`{ name, version, digest }`. Profile bindings connect one consumer dependency alias to one provider
service. Required dependencies must be bound; bound optional dependencies also impose startup order.
Validate duplicate identities, absent endpoints, tuple mismatches and cycles before activation.
The digest identifies an agreed contract; it does not prove behavioral conformance or mean the host
interprets arbitrary JSON Schema. Payloads remain bounded JSON and feature contracts stay plugin-owned.

The broker must validate live authority on calls and delivery, bind requests to activation generations,
bound concurrency and response size, and invalidate work when a participant stops or loses its grant.
Provider-owned state uses revisions so consumers can read the current snapshot after a notification.
This is implementation in progress, not a claim that the default tab feature is already extracted.

Installed integration must use the same lifecycle coordinator for restore, enable, update, rollback
and recovery. Validate the enabled artifacts and bindings before starting workers, then start in
provider-first graph order. The launcher binds all service operations to the selected durable grant
and one authoritative activation generation. Mark providers ready only after plugin activation
completes. Stop required consumers before their providers on deliberate shutdown; optional provider
loss publishes unavailable state. Keep the four-worker ceiling until measurements justify a change.
Developer `--plugin` launches are not implicitly admitted to an installed profile's service graph.

The service graph, authority checks and dispatcher have focused behavioral coverage, including
revoked ancestors, contract mismatches and strict identity-free wire envelopes. The SDK artifacts
build successfully. The isolated native transport fixture passes: two real SDK workers exchange
initial state and a command without page authority, and provider grant revocation terminates its
required consumer. Existing native plugin lifecycle tests also pass. Eight broker tests cover
activation interruption, replacement, optional dependencies, notification authority, cleanup,
JSON/state budgets, concurrency and a real deadline with late-response rejection. Installed service
recipe/manager wiring and default feature extraction remain unimplemented.

Verification on September 6: `pnpm check` passed, and the complete native suite passed all 252 tests
without skips (142 runtime, 110 browser). This verifies the generic service foundation and SDK
transport fixture, not installed service composition or the performance of the final default plugins.

## Installed services integration

Use a separate profile-local `hitchhiker-plugins/services.json` for trusted service bindings so a
headless service graph does not require a UI layout. The file is bounded, strictly decoded and read
at startup; it grants no authority and does not install code. Manager orchestration must validate
the prospective enabled cohort before replacing live workers. Restore, updates, rollback and crash
recovery must use that same coordinator. Deliberate provider changes stop required consumers as
expected lifecycle changes, preserving their enabled preferences; failed providers must not trigger
unrelated consumer rollback. Optional providers may disappear without restarting their consumers.
The installed launcher now binds the broker to the manager-selected grant and activation generation.
Manager preflight checks the prospective runnable cohort before mutations, preserves enabled
preferences for consumers blocked by missing required providers, and reconciles in dependency order.
Broker reconfiguration retains optional consumers and unchanged state. Same-artifact grant changes
restart the worker and its required dependents. Before automatic provider fallback, expected dependent
stops are explicitly joined so a draining old worker cannot suppress its replacement.

Focused manager tests cover required suspension/resumption, optional consumer retention, incompatible
contract rejection, changed credential bindings and gated crash cleanup before fallback. A real MCP
fixture installs the two SDK examples, replaces the provider, restores both after a fresh process,
removes/reinstalls the provider, and starts safe mode with a malformed service recipe. Exported plugin
requirements retain service declarations. The marketing-site guide includes the service APIs,
permissions, binding example and complete provider/consumer entry points.

Final integration verification on September 6: `pnpm check` passed and all 264 native tests passed
without skips (146 runtime, 118 browser). The first concurrent repository check hit the existing
two-second MCP child shutdown deadline; its focused suite and the full rerun passed without changing
the deadline. The default-feature plugin extraction and complete Chromium/DevTools API coverage
remain unfinished.

## Chromium and DevTools documentation contract

The public documentation must let authors determine exactly which Chromium operations they can
use, observe and customize through Hitchhiker. For each operation, document its public SDK method,
events and payloads, required grants and profile/origin scope, lifecycle behavior, limits, example,
and verified support status. Distinguish the Hitchhiker SDK, Chrome extension APIs, CDP domains and
native embedding APIs; an upstream Chromium feature is not automatically an exposed plugin API.

DevTools must work in the default distribution through a replaceable plugin. Document opening and
closing tools, target selection, presentation and available customization hooks, with separate
coverage for protocol automation and DevTools frontend customization. Mark unavailable bridges as
planned or unsupported rather than implying that CDP exposes every Chromium internal API.

Security-related customization is part of this API inventory: permission decisions, origin-scoped
access, network policies, profiles and debugging access. Identify configurable policies separately
from the host's enforced isolation and grant boundaries. Plugins cannot grant themselves authority
or bypass Chromium's sandbox. Privileged operations require explicit, revocable authority; CDP
continues to require its separate grant. The same public contracts must serve bundled and third-party
plugins. These are acceptance requirements; complete API coverage and the default DevTools plugin
remain unfinished.

## Plugin state prerequisites in progress

Add `storage.local` with owner/profile-bound JSON reads and compare-and-set writes. Storage survives
updates, disable and restart; uninstall deletes that owner's data only after its workers stop. Writes
must finish atomic replacement before cancellation completes. The host profile lease remains the
cross-process writer boundary; storage also serializes same-process instances.

Add `pages.watch` with revisioned, bounded snapshot chunks and coalesced `pages.changed` notifications
from the controller after reduction. Register the subscription and take the initial snapshot under
the same controller lock. Snapshot data excludes usage timestamps so a presentation commit cannot
create a watch/redraw feedback loop. Native page events remain available for compatibility but are
not the authoritative model feed. Both primitives are implementation in progress.

The state prerequisites are now wired through installed and developer launchers. Installed storage
uses a manager-selected owner and survives worker replacement; uninstall removes it after workers
stop and grants are revoked. Page subscriptions belong to a worker scope and publish only after
controller reduction. History controls are available through the SDK and the MCP facade. Focused
coverage includes CAS and grant revocation, manager update/restart/removal, snapshot pagination,
concurrent subscription admission, and controller navigation flags. A real isolated SDK fixture
passed page-change delivery and storage persistence across disable, update and a fresh browser
process, followed by uninstall/reinstall. Full repository/native verification is pending for this
checkpoint; default tab feature extraction remains the next architectural step.

Review tightened two contracts before release: subscription reservations are scoped unique tokens,
so failed/old scopes cannot erase a replacement owner's reservation; public PluginApiError codes
separate conflict and stale-snapshot from denied. Storage conflicts require reread/reconciliation;
stale page snapshots require restarting pagination. Neither permits automatic retry of a revoked
operation. The isolated SDK fixture explicitly checks the conflict code.

DevTools follow-up audit: the current host has private cdp.send/ExecuteDevToolsMethod but no
ShowDevTools/CloseDevTools/HasDevTools RPC. The pinned CEF exposes those operations and
OnBeforeDevToolsPopup plus BrowserView popup delegates. Stock window hosting and custom frontend
presentation are separate integration tasks. Define the inspection permission contract before
exposing them; navigation authority alone must not silently become unrestricted debugger authority.

Native verification on September 6 passed all 283 tests with no skips (162 runtime, 121 browser).
The initial parallel repository check exposed the existing MCP harness startup/shutdown timing
coupling. The harness now waits for explicit stderr readiness and bounds initialization separately,
then preserves the original two-/three-second operation shutdown deadlines. No product timeout was
relaxed. `pnpm check` passed after that harness correction, including typechecking, lint, formatting, tests
and production builds.

## Default plugin artifacts in progress

Build actual isolated SDK artifacts for tab model, pins, layout, sidebar and top presentation.
Canonical service contract files determine manifest digests; feature schemas stay in the plugin
package. The normal cohort uses four workers: layout/model/pins/one presenter. Both presenters ship.
Use bounded snapshot restart and storage conflict reconciliation. Keep profile migration, live plan
switching and functional Settings/Plugins routing as explicit cutover gates; do not remove the old
interface or silently replace user profiles before those gates are implemented. This artifact stage
is part of the migration, not a claim that the shipped browser is already fully plugin-based.

The five artifact packages now build from public SDK entry points. Authored Effect schemas compile
into standalone validators so isolated JavaScriptCore workers require no Web globals or runtime
schema library; compiler parity tests cover strict objects, identifiers, uniqueness and UTF-16
string bounds. Generated packages carry their validator dependency's MIT notice. All artifacts are
under 32 KiB, which measures bundle size only, not process RAM or rendering performance.

The native sidebar and top fixtures pass independently: four installed workers publish the selected
Chromium page, optional pin-provider removal retains the presenter and removes pin controls, and
worker-manager restoration preserves selection, pin storage and both documents' JavaScript markers.
Evidence: `work/default-plugins-native-focused.log` (2 passed, no skips). Initial timeout diagnostics
showed a 2.735-second worker startup delay under extreme machine load; the successful trace completed
model activation in 4.187 seconds. No isolation timeout was relaxed. A follow-up transport issue is
recorded: activation-time resource/crash monitoring currently starts after activation, so failures
can surface as generic timeouts. Fixture assertions now inspect composed labels/icons because the
host deliberately hashes plugin node/action IDs.

The final artifact checkpoint passes `pnpm check` (typechecking, lint, formatting, portable tests and
production builds). The strengthened native fixtures also verify pin controls return after provider
re-enablement; both passed without skips before the review changes. Browser typechecking
passes after that assertion change. This checkpoint does not claim a fresh full native-suite run,
live UI interaction coverage, or a completed default-interface migration.

Review found and corrected a presenter lifecycle issue: expected public API failures from UI commands
now resolve the event instead of terminating the worker. Tests cover rejected `https://` navigation,
retained draft and subsequent success, plus optional pin-provider loss between render and press.
Unexpected errors still propagate. A delayed open's pending selection is cleared only after a newer
selection/new-page/immediate-open commit succeeds, preventing stale intent from stealing selection.
The default-plugin package now has 17 portable tests.

Final review accepted the error boundary and selection-intent fixes. The post-review repository check
passes in `work/default-plugins-check-final.log`; native evidence uses the rebuilt final artifacts.

Post-review native rerun: sidebar passes, but top presentation times out during worker activation
(`work/default-plugins-native-final.log`). A separate top-only retry also times out
(`work/default-plugins-native-top-final.log`), with machine load averages still above 260. Earlier
both-mode functional runs passed, but startup reliability under load remains unresolved; the final
native rerun is not green. These artifacts remain opt-in development packages, not the shipped default.

## Live default-plan migration in progress

The next cutover prerequisite follows [LIVE-PLUGIN-PLAN.md](LIVE-PLUGIN-PLAN.md). A generic live-plan
transaction must change enabled identities, composition recipe and service bindings together, preserve
pages/storage, respect grants and the four-worker limit, and restore the prior plan on failure. Startup recovery
must resolve any durable transaction marker before launching workers. The API must serve replacement
third-party interfaces as well as bundled sidebar/top presenters.

In parallel, fix worker termination observation at the transport boundary. Resource/crash events
must fail pending activation immediately and remain observable across the activation/ready handoff,
even if no event subscriber existed when the worker stopped. Preserve existing CPU, wall, RSS and
request limits; this improves diagnosis and lifecycle correctness, not startup performance by itself.

Worker termination is now a persistent transport failure observed during activation, ready hooks and
idle sessions. Resource/crash events terminate pending requests without depending on event-subscriber
timing; bounded cleanup is uninterruptible. Eight focused portable tests and two real isolated-worker
tests pass, including explicit resource-error classification and trusted UI release. The repository
check passes for this transport change (`work/plugin-terminal-check.log`).

Dynamic composition now has candidate reconfiguration, retained-publication remapping, a completeness
query and a synchronized browser owner view. A real three-worker fixture reverses composed Chromium
page order without relaunching workers, preserves both document markers, then restores the original
order. It also retains the previous removal/restart checks (`work/live-composition-native.log`). Final
review and combined verification remain pending. This is the compositor prerequisite, not the durable
manager plan transaction or a user-facing sidebar/top switch.

Review corrected mutable recipe checks so publication and withdrawal authorization occurs under the
same permit as reconfiguration. A gated concurrency regression exercises a changed layout role and
removed contribution. Historical generation entries are capped at 256 distinct activated identities
per compositor lifetime; current identities may advance generations at capacity, and a new identity
requires restart once full. The cap prevents unbounded history without admitting stale activations.
The final independent review accepted these fixes. Combined repository/native verification follows.

The combined local check passed typechecking, lint and formatting but failed the existing MCP stdio
fixture readiness deadline while machine load exceeded 550 (`work/live-composition-check.log`). No
MCP implementation or readiness deadline changed in this checkpoint. The earlier transport-only
check and focused composition checks passed. Dedicated CI and a focused readiness rerun are needed
before calling the combined portable validation green.

Code checkpoint `0ee787ad03fce0ccdd715ddecf9686bced50f93f` passed dedicated GitHub Check
`34086901299`. The isolated MCP rerun passes all six tests in
`work/live-composition-mcp-focused.log`. The final three-test native rerun is not green:
`work/live-composition-native-final.log` records a browser fixture timeout and two worker startup
failures. The earlier three-test native run passed before the final permit/cap review fixes.

After the browser fixture timed out, its host remained alive for more than three minutes after
`HITCHHIKER_SHELL_CLOSED`. A stack sample (`work/live-composition-native-hang.sample.txt`) places the
main thread in CEF beneath `main+1888`; disassembly maps that return address to the call to
`CefShutdown` (`work/live-composition-native-disassembly.txt`, address `0x10000c064`). This proves the
observed hang is during CEF shutdown, not a still-open native window. It does not establish the
underlying CEF/macOS cause. The sample also contains a Security/Keychain cleanup thread, which needs
investigation rather than a Keychain bypass. The failed fixture host was explicitly killed after
sampling; the test runner completed and no owned native/plugin host processes remained. Startup and
shutdown reliability under load remains an open gate; no timing or isolation limit was relaxed.
