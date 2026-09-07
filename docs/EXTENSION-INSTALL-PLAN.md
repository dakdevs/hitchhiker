# Public extension installation

This packet completes the path from a plugin or MCP client supplying an extension package to an
explicit local permission review. The current list/remove API is not complete extension management.
The normal composed plugin interface also cannot display the legacy controller's extension screen.

## Required architecture

- A separate `extensions.install` profile grant admits package uploads and review requests. Default
  and third-party plugins use the same interface. No public operation accepts a host filesystem path.
- Transfer bounded binary files in chunks, retaining the existing 512 MiB package, 256 MiB file,
  1 MiB manifest, 10,000-entry, depth-64 and 4,096-byte relative-path limits. The plugin RPC deadline
  is four seconds; MCP requests are bounded to 256 KiB and tool operations to 15 seconds. Package
  finalization must therefore start a background job and expose its status instead of blocking a
  plugin call on a full-tree scan or user review.
- Upload storage is private, owner-bound and disposable. The existing artifact validator copies and
  verifies the completed tree before creating durable review state. Never hand an upload directory
  to Chromium. Cancellation and revocation clean only uploads or artifacts proven never submitted.
- A trusted native permission prompt shows the exact artifact identity, requesting principal,
  profile, required permissions/site access and optional permissions/site access. Confirmation is a
  native button action, not a plugin `ui.event` or an MCP method. All permission pages must be shown
  before installation is enabled. Plugins may replace surrounding product UI, but not mint review
  approval or bypass host authority checks.
- Bind prompt decisions to a private nonce, installation ID and digest. Recheck the current owner
  grant and verified artifact inside the manager's serialization boundary before recording install
  intent. Reuse existing uncertain-outcome shutdown, restart recovery and raw-CDP read-only behavior.
- A disconnected or revoked requesting owner cannot leave a prompt or upload active. An admitted
  durable install transaction must settle safely. No externally visible status implies that a
  cancelled or timed-out mutation could not have executed.

## Implementation sequence and evidence

1. Implement and verify scoped chunked upload storage and native review primitives independently.
   These are trusted internal building blocks until the coordinator and public contract are wired.
2. Add an owner-bound job coordinator, exact SDK/MCP schemas and capabilities, and bounded lifecycle
   cleanup. No raw native bridge or local staging/confirmation methods become public.
3. Compose the installation and inventory UI as a plugin using those public building blocks.
4. Verify real uploaded binary resources, native denial and approval, stale/foreign review decisions,
   grant revocation, owner shutdown, restart recovery and two-profile isolation. Native test prompts
   use disposable profiles. Keep production Keychain and release acceptance distinct.

Public upload and review-request APIs are implemented. The default management plugin, local picker,
and packaged application acceptance remain in progress; see the latest evidence below.

## Internal foundation verification

The owner-bound upload store now accepts bounded binary chunks and cleans private scratch data
following consumption, cancellation, expiry or owner shutdown. Eight portable tests cover replay,
quotas, ownership, revoked authorization, path and inode checks, expiry and consumption cleanup.
Expiry is an explicit internal operation; automatic scheduling belongs to the pending coordinator.
Neither upload paths nor the trusted consumption callback are public plugin contracts.

The native review primitive compiles and passes a real Chromium fixture with a disposable test
Keychain. The fixture rejects malformed, concurrent and synthetic approval requests, binds denial
to the exact nonce, installation ID and digest, and handles repeated cancellation. An interactive
run also passes actual native-button approval and exits zero. Accessibility inspection verifies
that Next requires scrolling the current page and Install requires reviewing every page. Long
identity text remains in the scroll region; control and directional characters are escaped.
This fixture reviews inert metadata; it does not prove end-to-end extension installation.

The first interactive rerun reached the correct approval callback but timed out waiting for stdin
that the Node test child did not receive. Removing that fixture-only acknowledgement lets the test
assert the native decision and close directly. The final run passes in 21 seconds with clean shell
closure (`work/extension-review-interactive.log`). Do not query the fixture app after it closes,
since the UI automation provider can relaunch it outside its disposable test launcher.

## Remaining public integration contract

Use a distinct `extensions.install` capability and bind installation operations to the profile,
principal and immutable grant ID. Upload and review methods return bounded operation status; tree
validation and installation run in an application-owned background job. Reauthorize before durable
preparation, before showing review and inside the serialized manager immediately before install
intent. Public responses omit native approval nonces, filesystem paths and raw host errors.

Persist the source owner with prepared artifacts in a versioned registry, preserving legacy local
records explicitly. Scratch uploads do not survive restart. Cancellation must distinguish work that
was never admitted from installation already committed to durable intent. Revoking an upload grant
does not implicitly uninstall an extension that the user already approved.

The default plugin also needs a native local-directory picker whose public result is an operation
ID. The chosen path remains private. SDK and MCP upload clients use the same coordinator, and the
default extension UI uses the same public API as third-party plugins. A new default cohort must
preserve old grants rather than silently adding installation authority.

## Durable ownership integration

The internal manager now writes registry V2 source ownership. V1 records load as `legacy-local`;
owner-bound preparation records the authenticated principal and immutable grant ID. Existing local
review callers cannot approve public records. Owner-bound review, confirmation and cancellation
compare the exact source after restart, as well as rechecking live authority.
Profile identity remains bound by the manager's canonical profile and held lease.

The existing profile-wide inventory and removal contract remains separate: authorized management
can remove enabled extensions regardless of original installer, while unsubmitted reviews require
owner-bound cancellation. Source credentials must not appear in the public inventory projection.

V2 requires an explicit source on every record. V1 records with unexpected source fields are invalid;
they are not silently downgraded to legacy ownership. A write migrates validated V1 records to V2
without resetting installation state or recovery attempts. Principal and grant identifiers are bounded
to 256 characters. This is an internal persistence format, not a plugin storage API.

Preparation checks live authority before copying and again before recording durable review state.
Review checks before and after artifact verification. Confirmation checks after verification inside
the manager lock and profile lease, immediately before durable install intent. Once admitted, the
existing installation settlement and restart recovery remain authoritative. Public coordinator wiring
and automatic owner-revocation cleanup are still pending.

Coordinator integration must use an owner-required preparation wrapper, discover only the requesting
owner's pending records, and persist any operation-ID mapping needed after restart. A separate trusted
abandonment path must match exact ownership while permitting cleanup after revocation; public cancel
must continue requiring live authority. Reconcile existing grants at startup as well as watching
revocation events. Legacy controls must suppress actions for public pending reviews. These requirements
remain open and are not satisfied by the manager's new optional owner argument.

Linux CI exposed an inode-reuse assumption in the upload tampering fixture: deleting the original
root allowed the replacement symlink to receive the same inode. The test now renames and retains
the original root before replacement, making the identity check deterministic. Production code did
not change. The accompanying runtime cancellation followed Turbo stopping remaining work after
that failure; its focused ten-test suite passes. The corrected full local check passes 429 portable
tests (`work/extension-owner-portable-fix-check.log`).

## Owned jobs and native review adapter

The manager now provides owner-required preparation, owner-filtered record discovery and a trusted
exact-owner abandonment operation. A public record may retain its original 32-character operation ID;
older V2 records without one remain readable. Duplicate operation IDs within one principal/grant
are invalid, both at preparation and when loading persisted state. Discovery returns reviewed
metadata and the operation ID, without the source identity or raw manager status.

Abandonment is an internal cleanup primitive, deliberately separate from public cancellation. It
requires exact principal, grant, installation ID and digest and accepts only `prepared` records.
It must never interrupt or erase an installation that has entered durable intent. Startup reconciliation
and the coordinator's revocation subscription remain to be connected.

The trusted native review adapter subscribes before showing the prompt, binds decisions to a fresh
private nonce and exact artifact, and rechecks authority before returning approval. During a prompt,
it checks authority every 500 ms; stopping the caller, revocation or a failed decision cancels the
exact native prompt. Failed cancellation invokes the application's supplied recovery callback.
The adapter owns at most one active review, and its deadline is bounded independently of public RPC
requests. It is not itself a public approval method.

A real Native fixture now exercises approval through this adapter, including scrolling both permission
pages and clicking the native button. It passes and closes cleanly with a disposable test Keychain
(`work/extension-review-adapter-native.log`). This validates the adapter and prompt, not the pending
full upload-to-install coordinator or production Keychain startup.

Cancellation review found that marking a finalizer interruptible could inherit the caller's pending
interruption and skip asynchronous cleanup. The adapter now starts a fresh bounded child for native
cancellation and inspects its complete outcome from an uninterruptible finalizer. Delayed cancellation
finishes before caller shutdown returns; stalled cancellation reaches its five-second deadline and
invokes recovery. Portable tests exercise both paths. A real Native fixture also passes caller
interruption, exact prompt denial and clean closure (`work/extension-review-adapter-cancel-native.log`).

Explicit manager tests confirm abandonment preserves installing, enabled, error, removing and removed
records byte-for-byte and never discards their artifacts. Owned discovery retains compatibility with
older public records without operation IDs. This does not replace startup grant reconciliation,
which still belongs to the pending coordinator.

## Public coordinator integration in progress

The working implementation adds the `extensions.install` capability, eight typed SDK/MCP
operations, owner-bound background jobs, and browser activation wiring. Startup reconciliation
checks persisted preparation owners against current grants before installation ports become
available; revocation events and periodic checks remove only unsubmitted prepared artifacts.
Authorization failures caused by storage errors preserve those records for recovery.

Portable manager/reconciliation checks and an SDK binary-transfer test pass. The SDK test runs
the actual bundled SDK without browser globals and verifies canonical encoding through the
64 KiB chunk limit. Coordinator lifecycle testing and the real upload-to-native-review-to-install
fixture are pending. This section records ongoing work, not a verified public release.

The first real coordinator integration fixture passes: bounded SDK-shaped upload operations stage
a complete MV3 package, request the trusted Native prompt, accept its actual Install button, observe
the content script in a new Chromium page, remove the extension and close with exit zero
(`work/extension-installation-native.log`, one pass, no skips). It uses a disposable mock-Keychain
profile. This proves the isolated upload/review/install path, not the packaged application, public
transport wiring in Chromium, or the still-pending cancellation and recovery acceptance.

## Public coordinator checkpoint

Nine coordinator tests pass for nonblocking background jobs, owner isolation, denial, admitted
transaction cancellation, revocation, restart discovery, failed-review cancellation, expiry, durable
removal refresh, bounded admission and owner-close prompt cleanup. Jobs use the application scope;
owner closure waits for shared cleanup. Unsubmitted artifacts alone can be abandoned. Durable
metadata supplies extension details without duplicating those arrays in terminal jobs.

The SDK/MCP contract exposes eight installation operations under `extensions.install`, with
strict input/output schemas and current grants. The browser wires fixed-owner ports into developer
and installed plugin activations and MCP. The SDK encodes bounded Uint8Array chunks without
requiring browser globals. Startup reconciliation and periodic revocation checks preserve
admitted records and refuse to treat grant-storage errors as proof of revocation.

The full repository check passes 453 portable tests, with 38 Native-gated skips, and passes dependency,
type, lint, formatting and build checks (`work/extension-installation-full-check.log`). A separate
Native run verifies a binary resource containing zero and high bytes through upload, approval,
extension fetch, removal and clean exit (`work/extension-installation-native-binary.log`, one pass,
no skips). No fixture host remains running. The public extension reference and marketing guide
record signatures, permissions, bounds, status polling and cancellation limits.

Remaining acceptance: actual compiled-plugin and MCP installation in Chromium, two-profile
installation isolation, the default extension UI and private native picker, legacy pending-review
control filtering, and full packaged startup with the production Keychain. Existing default grants
are unchanged. The browser-framework and release goals are not complete.

## Native local selection and default management plugin

The next implementation adds public `pickLocal()` with no caller arguments. It allocates an
owned operation in `choosing`, returns promptly, and uses an application-scoped native picker.
The private protocol binds a fresh nonce and operation ID to show/cancel/decision messages.
Only the native panel can select a directory; cancellation omits the directory. The chosen path
never enters public snapshots, plugin events, credentials or the durable registry. Selection
continues through the existing copied-artifact validation and separate permission review.

Use a directory-only, single-selection asynchronous NSOpenPanel sheet with a five-minute watchdog.
Picker and permission prompt must not overlap. Native close, owner shutdown, grant revocation and
adapter timeout cancel the exact picker; failed cleanup invokes recovery. SDK/MCP `pickLocal`
requires the existing profile-scoped installation grant. It cannot supply an initial path or
approve permissions. Apple documents the [directory selection controls](https://developer.apple.com/documentation/appkit/nsopenpanel/canchoosedirectories?language=objc)
and [asynchronous Open panels](https://developer.apple.com/documentation/appkit/nsopenpanel).

A separate default management artifact will use these public operations. Before it can own a full
management screen, the default plugins need generic owner-scoped route selection so sidebar/top presenters do
not gain extension-specific branches. New default grants require a new cohort and must preserve
existing profile choices. This routing/cohort work is not satisfied by adding a toolbar button or
copying controller extension screens into presenter code.

Verification in progress: private picker identity/cancel lifecycle, public no-argument protocol,
nonblocking coordinator selection/validation, rejection/revocation/owner cleanup, actual Native
folder selection and independent native permission approval. The default management plugin remains
open until its public composition and real browser behavior are verified.

### Native picker verification

The compiled host and public coordinator now pass actual NSOpenPanel folder selection followed by
separate native permission approval, binary-resource verification in Chromium, removal and clean exit.
The same run passes malformed and synthetic selection rejection, concurrent-prompt rejection,
wrong-operation cancellation denial, single-fire exact cancellation and window-close cleanup
(`work/extension-picker-native-interactive.log`, two passes, no skips). The existing permission-review
regression passes separately (`work/extension-picker-review-regression.log`). No fixture host remains.

Five adapter and eleven coordinator tests pass for exact private identity, early decisions, invalid
paths, user cancellation, interrupted/revoked owners, cleanup recovery, prompt/validation handoff and
existing installation lifecycle. Full dependency, type, lint, formatting, test and build validation
passes 460 portable tests with 40 Native-gated skips (`work/extension-picker-full-check.log`).
The SDK, MCP and marketing references document `pickLocal` as the ninth installation operation.
The default management artifact, generic routing/cohort integration and packaged application
acceptance remain open. This checkpoint does not claim they are complete.

### Public compiled-plugin installation evidence

Both developer and installed plugins now pass a real Chromium installation fixture using the
compiled public SDK. The plugin uploads a manifest, content script and binary resource, requests
separate native approval, and observes completion through owner-scoped installation invalidations.
Chromium executes the content script and verifies all binary bytes before removal and clean exit
(`work/extension-public-plugin-native.log`, two passes, no skips). These disposable profiles use
the test-only mock Keychain. An initial run loaded stale runtime output; rebuilding the runtime
resolved the missing event forwarding before the passing run.

The invalidation carries an empty payload and requires a current installation grant. Plugins read
fresh snapshots after it; isolated workers do not need timers. The independent default management
screen still needs the generic composition route and new default cohort. Native MCP installation,
cross-profile acceptance and production startup remain outstanding.

Full dependency, type, lint, formatting, test and build checks pass: 462 portable tests and 42
Native-gated skips (`work/extension-install-events-full-check.log`). The two interactive Native
cases above ran separately without skips. The owner queue coalesces pending notifications, excludes
other ports and closes with its owner; runtime tests reject undeclared and revoked delivery.

The [generic route prerequisite](PLUGIN-ROUTING-PLAN.md) now has public SDK calls and real Chromium
verification, including removal of optional screens without losing browser pages. The independent
extension-management plugin can now be built on that framework. Its V3 default cohort, six-worker
resource evidence and complete installation UI remain outstanding.
