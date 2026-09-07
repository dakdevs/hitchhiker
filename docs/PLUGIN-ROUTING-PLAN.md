# Plugin-owned management routes

The default browser needs independent management screens that can replace the content region without
turning those screens into fixed Chromium tabs or putting their feature logic back in the presenter.
Chrome-extension management is the first consumer. Settings and plugin management can move through
the same seam later.

This document records the architecture and remaining implementation plan. The selectable-route
composition seam and public SDK are implemented; the independent extension-management plugin,
V3 default cohort and six-worker evidence remain outstanding. Existing toolbar contributions and
the presenter's local Settings/Plugins route state do not satisfy those remaining requirements.

## Boundary decision

A route is a contribution selected within a declared composition slot. The trusted runtime owns the
recipe, active plugin identities, activation generations, atomic Native commit and input routing. A
plugin may select or dismiss only its own contribution. It cannot name another plugin, supply an
activation generation, or install a core browser route.

Add two public plugin operations with the same caller binding as `ui.publishContribution(id, surface)`:

```ts
ui.showRoute(contributionId: string): Promise<{ readonly revision: number }>
ui.hideRoute(contributionId: string): Promise<{ readonly revision: number }>
```

Both require the existing `ui.compose` declaration and current grant. The installed launcher closes
the operations over the authenticated plugin ID and activation generation. The wire request contains
only a bounded contribution ID. Hosts without an active composition recipe deny both methods.

Do not route these requests through a plugin service. Service authorization requires a consumer's
effective authority to contain its provider's complete authority. The current presenter has page,
configuration and plugin-management authority, so making it a navigation provider would force every
management-screen consumer to inherit those grants. A separate route-controller service would add a
seventh active worker without improving the self-only operation. The runtime route operation is a
narrow scoped capability, not delegated execution under another plugin's identity.

The core does not own browser history, management-screen names, launcher placement or cross-feature
navigation. It implements only declared selectable contributions. A screen owns its launcher and Back
button. The default presenter may select its own browser contribution when a tab, new-page or address
action should reveal the browser again.

## Recipe and session model

Extend a slot with an optional route declaration and extend contribution declarations with optional
admission:

```ts
{
  key: "content",
  route: {
    fallback: { pluginId: "default-sidebar-tabs", id: "content" }
  },
  contributions: [
    { pluginId: "default-sidebar-tabs", id: "content" },
    { pluginId: "default-extension-management", id: "main", optional: true }
  ]
}
```

Absence of `route` preserves the current ordered, append-all slot behavior. Absence of `optional`
preserves the current required-contribution behavior. Decoding must retain the existing 32-slot,
32-total-contribution and identifier bounds and reject excess properties.

Recipe validation must establish these facts before constructing a session:

- The fallback names exactly one contribution declared in that slot.
- The fallback is required; an optional or missing fallback is invalid.
- Contribution identities remain distinct under the existing plugin-ID/contribution-ID key.
- A plugin still needs to be enabled, runnable, represented in composition and granted `ui.compose`
  before it can publish or select a route.

Session state adds at most one selected route per route slot:

```ts
{
  owner: {
    id: string;
    generation: number;
  }
  contributionId: string;
}
```

The generation comes from the installed activation, never from plugin input. No selection is stored
for the fallback. Showing the fallback contribution normalizes state to no selection.

`showRoute` and `hideRoute` run under the composition session's existing semaphore. `showRoute`
requires an active exact-generation owner, a declared route contribution owned by that caller and a
currently published surface. It constructs and commits the candidate before adopting the new
selection and event routes. `hideRoute` changes the selection only when it exactly matches the
calling owner, generation and contribution; a late Back from an older or hidden route is an
idempotent no-op and cannot dismiss another screen.

A route slot sends exactly one contribution to the compositor. It uses the selected contribution
only while that exact publication and activation remain current; otherwise it uses the fallback.
Inactive contributions remain decoded and stored, but their nodes, actions and viewport bindings are
absent from the committed surface. Updating an inactive contribution must not make it visible.

Publishing or updating the selected contribution, hiding it, withdrawing it, stopping its worker or
removing it from a recipe must produce one atomic candidate commit. A successful commit changes the
stored publications, selection and input routes together. If Native rejects the candidate, the prior
surface, selection and input routes remain authoritative and the existing supervisor recovery path
handles the failure. Cleanup must not report success after a failed fallback commit.

Activation replacement clears publications and selections belonging to the older generation. A new
generation may publish the same contribution but remains on the fallback until it explicitly calls
`showRoute`. Reconfiguration clears selections whose slot or contribution is no longer declared in
the same successful commit.

`complete` continues to require the layout, fallback and every non-optional contribution at its
current generation. Missing optional contributions do not prevent startup, replacement or recovery.
They simply have no launcher and cannot be selected. The session owner set still includes optional
contributors so an enabled instance can activate and publish later.

## Browser viewport and Back behavior

The selected browser page remains a Chromium page owned by the controller. The presenter always
publishes its browser content contribution, even while a management route is visible, and continues
to refresh it from page/model notifications. Since an inactive fallback contributes no viewport
binding to the committed surface, management presentation does not duplicate or cover the browser
viewport. Showing the presenter's `content` route or hiding the management route commits the latest
browser contribution and restores that current viewport binding without navigating or recreating the
page.

Each management screen renders its own Back control. The extension screen handles Back with
`ui.hideRoute("main")`; exact owner-generation matching prevents a delayed event from closing a newer
route. Browser-intent actions owned by the presenter call `ui.showRoute("content")`. Nested state
inside one management screen remains that plugin's state. A future cross-feature history policy, if
needed, belongs in replaceable product plugins and is not part of this core seam.

If a selected management plugin crashes, is disabled, is uninstalled or withdraws `main`, the same
removal transaction selects the browser fallback. Its toolbar launcher disappears through its
separate optional contribution. A replacement generation does not reopen the old screen.

## Default extension-management plugin

Add `default-extension-management` as its own V3 artifact. It publishes `main` into the route-enabled
content slot and a separate optional `launcher` contribution into the existing toolbar slot. Publish
`main` before `launcher` so a visible launcher never points at an unavailable screen. The toolbar is
only the entry point; the feature is a full content route and is not modeled as a fixed browser tab.

The plugin uses only public SDK operations:

- `extensions.list` and `extensions.remove` for profile inventory and removal;
- `extensions.installation.pickLocal`, upload operations, `list`, `status`, `requestReview` and
  `cancel` for installation lifecycle;
- `ui.publishContribution`, `ui.showRoute` and `ui.hideRoute` for presentation; and
- `configuration.get` only if needed to render the current palette.

Its V3 manifest and managed grant are limited to `ui.compose`, `extensions.read`,
`extensions.manage`, `extensions.install` and, if the implementation reads it, `configuration.read`.
It receives no page, plugin-management, storage, raw CDP or native-bridge authority. The presenter
receives no extension capability and contains no extension-specific route or action branch.

The isolated plugin host has no timer globals. The screen must refresh installation progress from the
owner-scoped, coalesced `extensions.installation.changed` invalidation and then read fresh public
`installation.list`/`status` and `extensions.list` snapshots. The event payload contains no path,
review nonce, native decision, raw status or host error. Its producer uses a capacity-one sliding
wakeup per owner and emits only for owner-visible lifecycle changes, not for `list` or `status` reads.
SDK/MCP callers may poll externally, but the default plugin must not synthesize timer polling.

Initial activation and opening the route also read fresh snapshots. Completed commands refresh before
publishing their result. If installs or removals performed by other principals are intended to appear
while this screen is open, durable profile-inventory transitions must invalidate authorized readers;
an installation-job notification scoped only to the initiating owner is insufficient for that case.

All rendered operation collections remain bounded by the public schemas. Product errors use the
existing sanitized error categories. The plugin never displays or stores a chosen local directory,
artifact path, private nonce, grant ID or raw manager diagnostic.

## V3 cohort and worker budget

The current V2 plan installs six artifacts and runs five workers: model, pins, layout, one presenter
and DevTools. `MaxInstalledPluginWorkers` is five and is enforced during plan admission and again by
the manager. The independent extension-management plugin makes the V3 active set six. Keeping the
limit at five would require merging the screen into a more privileged worker or removing an existing
default feature, so V3 raises the reviewed public limit to six. A seventh runnable plugin remains
denied.

This changes a resource ceiling. Per-worker watchdog limits do not prove that the aggregate is
acceptable. Before calling V3 verified, run the real six-worker default application and record:

- all six exact worker identities reaching ready state and restoring after restart;
- combined worker RSS over startup, idle, picker/review/install, removal and shutdown;
- startup-to-ready and route-event-to-committed-frame latency;
- idle raster/update behavior and clean worker/process shutdown; and
- crash/revocation of extension management with browser fallback and the other five workers intact.

Use the V2 measurement of 32,288 KiB peak combined worker RSS during its short five-worker fixture as
comparison evidence, not as an established budget or a prediction. No six-worker RAM or latency
result exists yet, and no acceptance threshold has been approved. Record the measurements and obtain
review before treating the capacity change as release-ready.

V3 is a fresh default cohort. Add a correlated `default-browser-v3` journal and a new bundle format
with seven installed artifacts, six enabled workers, the route recipe and extension grant. A pristine
profile with no journal and no customized plan may receive V3. Completed, abandoned or pending V1/V2
journals retain their exact IDs, cohort membership, artifact hashes, grant keys, capabilities, plans,
completion revisions and terminal behavior. Pending old journals resume from their already staged
artifacts and never read authority or packages from V3. Existing profiles do not gain extension
installation authority or a new default plugin without a separately approved migration policy.

## Implementation boundaries

Implement in dependency order while keeping each boundary independently testable:

1. In `packages/runtime/src/composition-session.ts`, extend the strict recipe schema, parse route-slot
   invariants, store exact-generation selections and implement transactional show/hide operations.
   Filter route slots to one contribution before calling `composePluginSurface`; keep the compositor
   itself free of browser product policy.
2. In `packages/runtime/src/plugin-dispatch.ts` and `packages/plugin-sdk/src/index.ts`, add strict
   self-only calls. In `apps/browser/src/composition.ts` and `apps/browser/src/plugin.ts`, bind them to
   the installed activation owner exactly as publication is bound today. Do not add a caller-supplied
   plugin ID, generation, slot, profile or route target.
3. Update `apps/browser/src/installed-plugin-plan.ts` and both manager admission/runtime guards to six
   workers. Keep installed-plugin and contribution bounds unchanged otherwise.
4. Add the extension-management entry point, rendering logic and focused tests under
   `apps/default-plugins`. Update its strict generated manifest, build inventory and sidebar/top V3
   recipes. Both presentations use the same independent route plugin.
5. Update `apps/browser/src/default-plugin-bundle.ts` and
   `apps/browser/src/default-plugin-bootstrap.ts` with explicit V3 bundle/journal/cohort branches.
   Retain V1/V2 decoding and recovery fixtures rather than normalizing them to current defaults.
6. Add portable integration coverage, then the real Native six-worker fixture and resource evidence.
   Update public SDK/default-plugin documentation only after behavior and bounds are verified.

No change belongs in the legacy controller to recognize extension routes. No fixed-tab convention,
raw browser bridge, synthetic review approval or trusted extension-specific route table is added.

## Acceptance

Portable composition tests must prove:

- a caller can show only its own declared, published route contribution;
- malformed IDs, non-route contributions, absent publications, stale generations and foreign owners
  are denied without changing the committed surface;
- inactive route nodes, actions and viewport bindings are absent, while Back restores the presenter's
  latest browser viewport binding;
- late `hideRoute` from an old generation or a no-longer-selected route cannot close the current
  screen;
- optional absence does not block `complete`, while a missing fallback or required contribution does;
- selected update, hide, withdrawal, crash and recipe removal commit the correct target atomically;
- a commit failure preserves the old selection, surface and event routes and reaches recovery; and
- reactivation with a higher generation remains on fallback until an explicit show.

Dispatcher, browser-adapter and SDK tests must prove strict parameter decoding, `ui.compose`
declaration plus current-grant enforcement, owner closure, denied legacy/non-composed use and the
absence of caller-controlled owner/generation fields.

Default-plugin tests must run with timer globals absent and prove launcher-to-route, public inventory,
picker/upload progress, native-review waiting, denial, approval, cancellation, removal, sanitized
errors, Back and coalesced invalidation refresh. They must also show that the presenter has no
extension branch or extension grant.

Plan/bootstrap tests must admit exactly six runnable V3 workers, reject seven, preserve manager
rollback on failed activation and retain V1/V2 journal, artifact and grant fixtures byte-for-byte.
Real Native acceptance must preserve live Chromium document state while opening and closing the
management route, exercise the actual picker and trusted review, fall back after plugin failure, close
with no remaining host/plugin processes and produce the RAM/latency evidence listed above.

## Current status

The repository has ordered and selectable composition slots, owner/generation event routing,
bounded plugin UI inboxes, public extension inventory/removal/installation APIs, trusted local
selection and native review. These provide the framework for the independent management plugin.

The route recipe, self-only show/hide calls, optional composition readiness and atomic route state
now have portable behavioral coverage. A real installed-SDK fixture passes hidden Chromium bindings,
return to the latest page, retained JavaScript state and clean shutdown
(`work/plugin-routes-native.log`, one pass without skips). Its disposable profile uses the test-only
mock Keychain; it does not prove production startup or six-worker performance.

Installed plans now distinguish required owners from optional declarations. Portable tests cover
optional removal, restart and reinstallation with fresh authorization, required-fallback rejection
before persistence, activation rollback and presenter replacement. The native fixture also passes
optional disable, re-enable and uninstall while preserving the recipe and live browser pages.
Fallback loss now commits recovery and clears the selection; fallback repair never reopens an old
management route without a fresh show request.

Full dependency, type, lint, formatting, test and build checks pass with 472 portable tests and
43 Native-gated skips (`work/plugin-routes-full-check.log`). The native route lifecycle fixture
above ran separately and passed without skips. No fixture host or worker process remains.

Still unimplemented are the
default extension-management artifact, V3 bundle and journal, six-worker capacity change, complete
timer-free default screen, six-worker Native regression and resource measurements. Do not describe
independent default extension management as shipped until those items and the acceptance above pass.

## V3 integration checkpoint

The current worktree builds seven default artifacts and admits six active workers, including the
independent extension-management plugin. Strict V3 bootstrap and packaging validation preserve
predecessor journals without adding grants. The combined portable check passes; the public SDK now
includes the picker's existing `choosing` state, with a typed fixture instead of an unsafe cast.

The interactive Native fixture passes local directory selection, native permission review, real
Chromium installation, content-script execution and binary-resource integrity, removal, selected
plugin disable/re-enable, browser fallback, retained document state, and clean engine exit. Other
five activation generations remain unchanged during extension-plugin disable. A process inspection
after the run found no remaining host, broker, or worker processes. This is graceful lifecycle
coverage, not abrupt-crash or grant-revocation coverage. Evidence: `work/default-extensions-native.log`.

That run observed six-worker startup at 3.89 seconds and combined worker RSS of 64,720 KiB at startup,
65,040 KiB with the picker, 65,168 KiB during review, 66,192 KiB after installation, and 66,112 KiB
after removal/re-enable. These are short-run system-wide worker-name samples, excluding Chromium,
brokers, and GPU memory. No other Native fixture ran concurrently, but automated process-tree
attribution and teardown assertions remain required. The 252 ms route observation uses a 250 ms
polling interval and is not a frame-latency measurement. Restart, crash, idle rendering, production
Keychain startup, and release acceptance remain open.

Independent review also identified a presenter publication race: route destinations now publish
before their toolbar launchers. The portable presenter fixture rejects launchers whose destinations
are absent. Packaging now compares every complete manifest to the fixed V3 declaration, and a portable
regression rejects excess extension authority even when the artifact and index are rehashed. A
distribution hash alone does not prove that its capabilities match the approved default cohort.
