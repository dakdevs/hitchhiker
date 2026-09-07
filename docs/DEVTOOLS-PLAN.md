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
