# Independent default management features

Settings and Hitchhiker plugin management currently belong to the sidebar/top presenter. Extract
both into independently replaceable plugins, preserving the frozen V1/V2/V3 cohorts and grants.
The new default cohort must retain separate tabs, pins, layout, DevTools and Chrome extensions.

## Prerequisites and current work

Configuration changes need profile-local invalidation notifications. Add `configuration.changed`
with an empty payload, delivered only to a plugin with declared and currently granted
`configuration.read` (or full control). Consumers read the current configuration through the public
API and refresh without polling. A bounded coalescing controller stream prevents stale snapshot
queues. Subscribe before the initial invalidation so changes during activation cannot be lost.
Persistence failure retains the prior in-memory configuration; a later Native render failure cannot
undo an already durable write, so that write still invalidates readers. Cover successful writes, no-op/failed writes, portable settings import, transport authority,
and layout/presenter/default management refresh. This work does not itself extract either feature.

Presenter switching currently uses `plugins.replaceSelf`, which cannot correctly replace a different
plugin from an independent Settings owner. Resolve that public contract before switching the default
cohort. Do not emulate replacement by disable/enable or silently grant a new plugin broader authority.

## Acceptance for extraction

- Independent Settings and plugin-management artifacts use only public SDK APIs and owned routes.
- Their launchers disappear when disabled; selected-route removal returns to the live page fallback.
- Presenter replacement retains selected pages and documents, pins, Settings and plugin-management
  workers, DevTools, and Chrome extension management.
- Existing journals retain their original artifacts, plans and grants; new authority is explicit in
  the new cohort. Packaging validates the complete fixed manifests and plan.
- Native lifecycle and exact worker-memory measurements cover the increased active cohort before
  declaring it accepted. Worker capacity must not increase without recorded evidence.

## Reviewed extraction contract

Use two plugins: `default-settings` and `default-plugin-management`. Each owns `main` and `launcher`
contributions; publish its destination first. Keep the current presenter-switch button in Settings
through a new generic `plugins.replace(sourceId, targetId, expectedRevision)` operation under
`plugins.manage`. Preserve `replaceSelf`. The manager substitutes source references across enabled
IDs, composition/fallback and service bindings, then applies normal authority, capacity, completeness,
and transaction validation. Failed activation restores the old plan. Caller identity stays host-bound.

Settings needs UI, configuration read/write and plugin read/manage. Plugin management needs UI,
configuration read and plugin read/manage. New presenters drop configuration write and plugin
management authority. Add `plugins.changed` invalidations for external lifecycle changes before
calling the management screen fully reactive.

Fresh V4 will contain nine artifacts and eight active workers. Freeze V1/V2/V3 capability maps before
narrowing presenter grants: existing pending journals must still validate and resume their exact
original artifacts and plan. Do not introduce a half-extracted intermediate cohort. The implementation
sequence is configuration notifications, generic replacement, both artifacts and management
notifications, then V4 bootstrap/packaging and real eight-worker acceptance.

## Configuration verification checkpoint

The portable controller regression verifies subscription-before-initial-delivery, coalesced updates,
no-op/rejected/failed writes, and durable settings import. Session transport tests verify declared
and current grants, including revocation before delivery. Default-plugin tests verify layout,
presenter, DevTools and extension screen refresh; unavailable extension inventory cannot retain
an obsolete palette.

The real Native six-plugin startup fixture passes dark-to-light configuration changes across layout,
presenter, DevTools and extension launcher without restarting any worker or changing the selected
page or open inspector. Its existing sidebar/top replacement, document retention and grant-revocation
checks also pass. The fixture uses a disposable profile and mock Keychain. This proves configuration
propagation through the installed-plugin path, not production startup or V4 extraction completion.

Existing completed V1/V2/V3 journals retain their installed artifact bytes and do not automatically
acquire these new event consumers. Fresh bundles include them; older plugins safely ignore the new
event. No automatic artifact replacement, new grant, worker-cap change or cohort migration occurs
in this prerequisite checkpoint. Full portable checks pass 495 tests with 44 Native-gated skips;
the separate Native startup regression passes without skips.

Generic replacement is implemented: share the existing transactional replacement path,
retain `replaceSelf`, and admit cross-owner source selection only through the installed management
port and `plugins.manage`. Verify a different caller remains running, stale revisions and bad targets
leave the plan unchanged, and failed activation restores the source. No cohort changes in this step.

The independent-manager transaction regression reaches failed target activation and verifies rollback,
stale revision and revoked-target denial, unchanged unrelated generations, and fallback ownership
substitution. The Native compiled-SDK fixture swaps the browser layout/content provider from a
separate management worker, confirms its public call returns and its generation remains unchanged,
retains live document state, and exercises management route disable/re-enable/removal and clean exit.
This uses a disposable mock-Keychain profile. Both management artifacts, lifecycle notifications,
and the eight-worker V4 cohort remain outstanding.

Generic replacement passes the full repository check: 497 portable tests pass, with 45 Native-gated
skips in that run. The separate Native replacement fixture passes without skips and closes cleanly.
The API leaves the six-worker ceiling and current cohort unchanged.

Lifecycle invalidations are now in implementation. The manager emits empty `plugins.changed` events
after registry replacement and running-state changes, coalescing a transaction until it settles.
Subscribe before an initial invalidation, gate each delivery with declared/current `plugins.read`,
and re-read the public snapshot. This process-local stream covers the application manager used by
MCP and installed plugins; it does not watch unsupported direct filesystem edits or other processes.

Lifecycle transport, transaction coalescing and unexpected-worker termination tests pass. The Native
compiled-SDK observer also reacts to another plugin being enabled/disabled, with no polling, then
continues through generic presenter replacement and route cleanup. The source subscribes before its
initial notification and rechecks `plugins.read` authority on every delivery.

Separate Settings and Plugins source modules now build as standalone artifacts. They have independent
owned routes and launchers, public configuration/lifecycle operations, bounded snapshots, and live
configuration/management invalidations. Their two artifacts are deliberately outside the current V3
bootstrap index; V4 must introduce both together with measured eight-worker acceptance. Existing
presenters still contain the legacy management routes until that cohort transition.

The standalone artifact Native fixture now passes public configuration edits, presenter replacement
from both Settings and Plugins, unchanged management worker generations, external lifecycle refresh,
disable/re-enable launcher cleanup, selected-route removal, retained document state and clean exit.
The fixture runs the actual built management artifacts with minimal page/layout providers and a
disposable mock-Keychain profile. Replacing a route fallback intentionally resets host selection;
the originating management plugin explicitly reopens its own route after successful replacement.
This verifies the public composition path with three or four active workers, not the V4 eight-worker
cohort or production application startup.

The full repository check passes 508 portable tests with 46 Native-gated skips, plus typecheck,
lint, formatting and builds. The independent management Native fixture separately passes without
skips. These results leave the global six-worker limit and the current V3 default cohort unchanged.
