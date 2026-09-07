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

Implementation is in progress. Public upload, review and installation APIs are not yet available.

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
