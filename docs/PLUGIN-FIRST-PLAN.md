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
whole-window `ui.publish`/`ui.release` and configured independent UI contributions. Service dependencies
are not yet connected to installed workers, and the default features still use the controller.
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
