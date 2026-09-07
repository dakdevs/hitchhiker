# Public DevTools integration

The next feature is a replaceable DevTools plugin using the same public inspection primitives
available to third-party plugins. This work does not equate a raw CDP relay with a DevTools UI.

## Boundary and ownership

`devtools.manage` is profile-wide authority to open, focus, inspect a coordinate in, query and close
Chromium's DevTools frontend for a live page. The frontend can execute scripts, inspect cross-origin
frames and navigate the target, so an origins list does not constrain this permission. Do not claim
origin isolation for a full inspector frontend. Declaration and a current grant are both required;
`browser.full-control` implies this permission, while `cdp.connect` remains separately granted.
No frontend URL, arbitrary protocol command or native bridge is returned through these methods.

The private host exposes `devtools.status`, `devtools.show` and `devtools.close`, returning
`{ pageId, generation, instance, state }`, with states `closed`, `opening`, `open` and `closing`.
The generation identifies the target incarnation, and instance identifies each inspector creation.
Private cleanup also checks a random ownership lease, which is never exposed to plugins.
Show optionally accepts integer `inspectAt: { x, y }` coordinates from 0 to 32768. The native
adapter validates page/generation identity and caps simultaneous inspectors at four, including
opening and closing windows. CEF owns the real standalone DevTools browser; it is never a normal
page or a tab binding. Closed, replaced and shutdown pages drain their inspector too. Native
`devtools.changed` events describe actual lifecycle transitions, including manual window closure.

The application binds a resource owner to each plugin generation or MCP connection. Showing an
existing inspector transfers cleanup responsibility to that owner; stopping an older owner cannot
close a newer owner's inspector. Explicit close is profile-wide management. Owner cleanup and
revocation must close owned windows, including an inspector whose asynchronous creation has not
finished. Native lifecycle protects inspected pages from automatic freezing, and opening wakes a
sleeping target. Resource state belongs to the core; product controls belong to plugins.

## Work and evidence

- Implement and compile native primitives with page-close/replacement and shutdown coverage.
- Add strict SDK/dispatcher/MCP methods, grant tests and re-authorized lifecycle delivery.
- Add scoped application ownership, revocation cleanup and resource protection tests.
- Exercise real Chromium open/focus/inspect/close, manual closure if possible, target closure,
  rejected requests, process cleanup and document retention.
- Build a default DevTools plugin and a documented replacement example using public APIs.
- Integrate that plugin into a versioned distribution cohort without changing frozen pending
  bootstrap manifests, grants or plans, or reinstalling defaults users removed.
- Verify complete native startup and live feature use, then publish exact-commit CI evidence.

The existing default bundle remains five artifacts/four workers until a compatible, measured
DevTools distribution change is implemented. Standalone CEF presentation is the first supported
presentation; Native docking, DevTools frontend extensions and wider protocol customization remain
required follow-up work and must stay explicitly labeled until implemented and verified.

## Current verification

The native target compiles, and 20 focused portable controller/ownership tests pass. The first
real DevTools fixture timed out before mounting the interface: a captured native sample shows
`CefInitialize` blocked in macOS `SecItemCopyMatching`/Keychain locking. The owned test process
was terminated after collecting evidence. This run does not verify DevTools behavior. The fixture
now forwards its abort signal to Effect. A second run hit the same Keychain stack and still required
manual termination of its owned processes after timeout; startup cancellation is also unresolved.
No Keychain settings or Chromium security flags were changed.

Source review also found stale inspector callbacks could target a replaced page generation.
The native adapter now preserves the old generation/instance and drains late
creation without altering a newer inspector; its corrected target builds successfully
(`work/devtools-native-build-final.log`). CEF exposes no documented DevTools creation-abort
callback; failed creation accounting currently drains when the opener is torn down.

A third fixture explicitly awaited engine readiness before creating the browser controller. It
still timed out in the same Keychain stack and required termination of only its owned processes
(`work/devtools-native-ready-gate.log` and `.sample.txt`). No real inspector assertions ran.

## Isolated Keychain fixture

The pinned Chromium OSCrypt implementation supports `--use-mock-keychain` for testing
([source](https://github.com/chromium/chromium/blob/144.0.7559.59/components/os_crypt/sync/os_crypt_mac.mm#L88)).
A temporary wrapper under `work/` accepts only the disposable DevTools fixture profile prefix and
passes the profile-lock helper through unchanged. This allows inspector testing without changing
production launch arguments, touching existing profiles, or changing the user's Keychain settings.
It does not establish production Keychain/startup acceptance.

The first isolated run reached Native mount and the test page, then exposed native parameter bugs:
JSON integers and the initial zero inspector instance were rejected, while guarded cleanup's
`expectedLeaseId` was omitted from the close allowlist. Those private validation paths are corrected;
real lifecycle verification is continuing. The failing fixture exited and cleaned up without a
manual kill (`work/devtools-native-isolated-keychain.log`).

The corrected native lifecycle fixture passes with that disposable Keychain: one pass, zero skips,
6.42 seconds. It exercises status/open/focus/coordinate inspection/close, ownership transfer,
revocation cleanup, document marker retention, reopening, target closure, capacity rejection at
four inspectors, ordinary-page accounting and engine exit zero
(`work/devtools-native-isolated-keychain-2.log`). GPU mailbox messages occurred during the run;
visual/physical interaction and production Keychain acceptance remain separate checks.

The compiled standalone plugin also passes against the real JavaScriptCore plugin host, Native
surface and Chromium (`work/devtools-native-plugin.log`, one pass, zero skips, 3.04 seconds).
That fixture injects synthetic toolbar events at the trusted Native surface boundary, then checks
real inspector transitions, lifecycle status rendering, revocation cleanup, preserved page and
engine exit zero. It does not assert physical mouse input or default-cohort integration.

Startup cleanup is now bounded at the runtime's process-spawner boundary (`forceKillAfter: 100`).
A portable no-ready host that ignores SIGTERM verifies scoped cancellation and child exit. A
subsequent real launch with the normal Keychain still failed readiness, but returned the typed
startup error in 30.28 seconds and left no owned host process, without manual termination
(`work/devtools-native-bounded-startup.log`). This fixes cleanup, not Keychain availability.

The independent default toolbar factory is implemented and covered by five focused tests in
`apps/default-plugins/src/devtools.ts`. It consumes the existing model selection service. Its direct API calls need
`ui.compose` and `devtools.manage`, but the current broker also requires its manifest and grant to
contain the model provider authority: `pages.list`, `pages.manage` and `storage.local`. The module
does not call pages APIs or own page state; these additional capabilities are binding requirements.
A narrower grant fails service admission. Do not weaken containment to bypass that requirement. It is not yet in the default bundle. Integration requires a
sixth artifact, fifth active worker, additional toolbar contribution and model-service binding.
The new bootstrap cohort must preserve old pending journal artifacts/grants, honor completed or
abandoned journals, and leave removed/custom plans unchanged. The standalone whole-surface example
and this toolbar feature must use distinct installed identities before they can coexist.

The implementation checkpoint is published at `11bb9ca1410efd0cea5baff7985b4e9782a94491`;
[exact-commit CI](https://github.com/dakdevs/hitchhiker/actions/runs/34110688643) passed.

## Default cohort V2 implementation

Fresh profiles will receive bundle format 2: six installed artifacts and five active workers,
including `default-devtools` as a second compact toolbar contribution. Its six capabilities are
`ui.compose`, `devtools.manage`, `pages.list`, `pages.manage`, `storage.local` and
`configuration.read`. Model/layout bindings preserve provider authority containment and supply
selection plus appearance invalidations. The standalone example becomes `devtools-workbench` so it
can coexist with the default toolbar.

The same durable journal path will decode explicitly correlated V1 and V2 identities. V1 pending
journals retain five artifacts, their original capabilities, grant keys, plan and completion
revision; V1 terminal journals remain terminal. New eligible profiles write V2 with six artifacts
and a seventh-revision promotion. No existing customized, removed or terminal profile is upgraded
automatically. Recovery uses frozen artifacts and does not read a new distribution payload.

The installed-manager limit becomes five for all plugins, with sixth-worker denial and rollback
coverage. This is an explicit bounded capacity change; the existing execution and memory limits
remain enforced. Native fresh startup, inspector use through the composed plugin, retained pages,
revocation and resource measurements are required before claiming default integration verified.

## V2 integration evidence

The real Native bootstrap fixture now passes with six installed artifacts and five running workers.
Synthetic events use the committed, namespaced toolbar buttons to open and close the real Chromium
inspector, reopen it and revoke its plugin grant. Revocation closes the inspector, both original
pages remain, the V2 journal completes at revision 7, and the engine exits zero. This is the
installed-startup seam, not a physical click or full application entrypoint test.

`work/default-devtools-v2-native.log` records one pass with no skips using the disposable
mock-Keychain wrapper. `work/default-devtools-v2-resources.json` samples worker processes every
200 ms during that approximately five-second run: five workers were observed, with peak combined
worker RSS of 32,288 KiB. This excludes Chromium and the controller; it does not establish a
long-running idle, total-browser RAM or loading-performance benchmark. Native raster telemetry
reports 135 ticks, 13 updates and 122 idle ticks. A request-queue-full diagnostic still appears
during shutdown despite exit zero and remains an explicit regression concern. Production Keychain,
physical UI, full application startup and broader performance acceptance remain open.

The final V2 repository check passes 398 portable tests with 32 native-gated skips, plus dependency,
type, lint, formatting and build checks (`work/default-devtools-v2-check.log`). The renamed standalone
`devtools-workbench` also passes its real compiled-plugin fixture with one pass and no skips
(`work/default-devtools-v2-workbench.log`). Both Native runs leave no host or plugin worker process.
A separate read-only integration review found no concrete bootstrap, bundle or capacity blocker.

## Public presenter retention acceptance

Extend the V2 Native startup fixture to invoke the composed Settings replacement controls through
public plugin events, switching sidebar to top and back. Verify selection, model/pins persistence,
five workers, JavaScript document markers, session storage, live form values and the same open
inspector incarnation across both replacements. Update the older direct-manager regression to V2
while preserving its failed-replacement rollback and stable provider-generation checks.

This acceptance now passes against the actual Native and JavaScriptCore hosts with disposable test
Keychains: `work/presenter-public-retention-native.log` records one pass, no skips, and both public
Settings replacements while the same inspector stays open. Document globals, session storage and
live input values survive; selection and model/pins storage remain unchanged. Inspector revocation
still closes only the inspector, and the engine exits zero. The events are synthetic at the trusted
NativeSurface boundary, not physical mouse clicks.

`work/presenter-v2-rollback-native.log` records two passes, no skips, covering both starting tab
placements with five workers, optional pin-provider removal/restoration, stable model/pins/layout/
DevTools worker generations, retained Chromium documents, failed-presenter rollback and restore.
The deliberately failing plugin logs its activation error as expected. The public-startup fixture
still logs the previously recorded shutdown request-queue-full diagnostic; physical interaction,
production Keychain and comprehensive performance acceptance remain open.

## Shutdown diagnostic correction

The IPC admission path used one diagnostic for two conditions: a stopped bridge and the unchanged
64-request capacity limit. Buffered plugin input arriving after normal window closure could therefore
report saturation. Separate the stopped-bridge return from the capacity diagnostic, matching the
existing stopped check when dispatched input is processed. Rebuild the Native host and rerun the
public-retention fixture; verify inspector/page lifecycle and exit zero while checking captured
stderr for the misleading message. This does not change the input limit or claim a broader shutdown
redesign.

The Native host rebuild passed (`work/shutdown-diagnostic-build.log`). All three current-cohort
Native cases pass without skips (`work/shutdown-diagnostic-native.log`), with three clean shell
closures and no request-queue-full diagnostic. The unchanged 64-request admission bound still has
its saturation diagnostic; this run verifies the shutdown case, not a synthetic saturation stress
test. The test-only Keychain wrapper remains restricted to disposable fixture profile prefixes.
