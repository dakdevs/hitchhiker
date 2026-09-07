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
whole-window `ui.publish`/`ui.release`; installed plugins cannot independently contribute and compose
features. `ui.release` returns to a trusted default, which must become a configured plugin composition.
The installed package manager, grants and isolated worker machinery can be reused, but do not prove
the default experience is plugin-based.

Favicon work is paused before implementation while this architecture is corrected. A read-only
audit is identifying the composition, state, command and lifecycle contracts before migration.
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
