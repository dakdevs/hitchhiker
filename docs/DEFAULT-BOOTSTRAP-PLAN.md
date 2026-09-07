# Bundled default-plugin bootstrap

This is the remaining distribution startup migration, not a tab policy in the generic host. The
live manager plan is implemented. The state-seeding, managed-grant and exact staged-install retry
prerequisites, packaged bundle index and controller restoration barrier are published. The coordinator
now passes its focused recovery tests, review and combined repository check. The runtime bundle
reader is implemented with portable tests. Public management routes and main startup cutover remain.

## Eligibility and ownership

Run only in normal installed-plugin mode, before exposing MCP or interactive management actions.
Safe mode and developer `--plugin` do not read/write this bootstrap journal or issue default grants.
Capture decoded legacy browser persistence under the profile lease before controller startup can
save newer state. Restore the same Chromium pages through the controller, then run manager recovery
before bootstrap. Use the complete restored page inventory to prepare plugin state. The current
`controller.start` finishes issuing restore requests but does not itself await every staged page
lifecycle event. Await `controller.restored` before capturing that inventory or starting default
workers; it settles after all initial requests and staged page events, persistence and rendering.
Startup errors, host exit and controller closure fail pending waiters. Do not seed from a transient
partial `controller.snapshot`.

A permanent journal at `hitchhiker-plugins/default-bootstrap.json` decides whether bootstrap may run.
With no journal, only a revision-zero empty plan and an empty installed-plugin list are eligible.
An existing customized profile gets a terminal `abandoned` journal, with no plugin changes. A terminal
`completed` journal stays terminal even if every bundled plugin is later removed, disabled or replaced.
Never use missing default IDs as a reason to reinstall them.

The coordinator uses public artifact, managed-grant, storage and manager APIs. It never writes
`plugins.json`, calls private plugin operations, or reopens Chromium pages. The normal cohort is
model, pins, layout and one presenter: five artifacts installed, four workers enabled. Default grants
match the frozen bundled manifests exactly, have empty origin restrictions, and exclude raw CDP and
full-control authority. The ordinary public capability checks still apply on every plugin call.

## Durable journal

Use a strict, bounded (64 KiB) version-one union. Every variant carries `id: "default-browser-v1"`.

- `pending`: frozen placement, five artifact descriptors (`id`, immutable `hash`, capabilities,
  managed grant key), complete target plan, model/pins seed JSON, expected plan revision, fixed-order
  installed prefix, and per-owner storage-present checkpoints.
- `completed`: the promoted plan revision.
- `abandoned`: `profile-customized` or `bootstrap-state-diverged`.

Read only bounded regular private files, reject symlinks/invalid schema, and never interpret corruption
as absence. Write a private exclusive temporary, sync the file, rename, then sync the directory under
the held profile write lease. Serialize coordinator operations. An indeterminate write requires
restart/reinspection; do not continue from assumed in-memory state.

Stage and validate all five bundled artifacts before creating the first journal. A crash before the
journal leaves only inert content-addressed blobs. Freeze their returned hashes, recipes and seeds in
the pending journal before issuing grants. Recovery reads these exact profile artifacts rather than
switching to a newer application bundle halfway through bootstrap.

## Recovery sequence

1. Resolve manager pending/removal recovery first. Stop on manager failure.
2. Honor terminal bootstrap state; otherwise create or validate a pending journal.
3. Ensure each managed grant with its fixed key `default-bootstrap/1/<plugin-id>`. The grant store
   atomically creates or returns that exact active request. It never adopts an unmanaged grant,
   returns a bearer, renews revoked authority or replaces a different request under the same key.
4. Install disabled artifacts in this order: model, pins, layout, sidebar, top. Checkpoint each
   installed prefix and plan revision. Exact hash/grant, disabled, non-removing staged installation
   uses the idempotent manager operation; mismatched existing identities fail.
5. Seed model and pin stores only at revision zero using CAS. Preserve any nonzero payload. On a
   conflict reread once; never overwrite a concurrent winner. A checkpointed-present store becoming
   empty is divergence. Freeze seeds in the journal so recovery does not reinterpret newer legacy data.
6. Apply the complete frozen four-worker plan with the recorded expected revision.
7. After successful promotion write `completed` permanently.

A staged-install checkpoint gap is accepted only at exactly expected revision plus one, with an
otherwise empty active plan, the exact expected installed prefix and the exact next disabled hash
and grant. The manager's trusted `inspectInstallation` method verifies the exact stored identity,
including removing/suspended state, without exposing credentials or adding an MCP endpoint. Any
extra/missing identity, incompatible enabled state, changed hash/grant or unrelated
revision is divergence: mark abandoned rather than repairing user choices.

A promotion checkpoint gap is accepted only when the exact target plan is active at expected revision
plus one, all five installations retain the expected hash/grant/enablement, and both checkpointed
stores remain nonempty. Finish the terminal marker. If manager recovery restored the prior empty plan at the expected
revision, resume the pending operation. Any later or different plan means abandonment, never replay.
Unused managed grants may remain after abandonment; they have no returned bearer. Do not delete
possibly user-edited plugin storage as cleanup.

## Remaining integration

The builder and packager already produce and verify the index and resource payload. The runtime
reader resolves `Resources/default-plugins` relative to the installed
`Resources/controller/dist` module, with no current-directory or missing-bundle fallback. It validates
the strict versioned index, its digest, all five manifests/code hashes and both exact recipes. It reads
bounded regular UTF-8 files through nofollow descriptors, checking fixed parent directories and
file identity; it never evaluates code or stages profile artifacts while reading. Development callers may
provide their explicit build directory. Tests use an isolated real build and relocated resource tree
plus tampered, redirected, malformed and oversized payloads. The reader returns the coordinator's
existing lazy bundle shape; main startup remains gated on the public management routes.
The bundle and controller share the application distribution trust boundary. The index digest checks
consistency, not publisher authenticity: this reader must not accept arbitrary downloaded bundles.
Authenticating the whole application and its sealed resources remains part of the unfinished signing
and notarization release gate. Development paths are explicitly trusted by their caller.

The coordinator and its current fault-injection coverage are described below. Only wire it from
`main.ts` once Settings/Plugins are functional through public composed plugin routes. Then remove
legacy default-interface ownership from normal startup; retain only the minimal trusted recovery
surface. Legacy tab fields may remain inert during migration but cannot stay authoritative.

Native acceptance still must prove startup/cutover and sidebar/top switching with retained page IDs,
JavaScript document markers, storage values, at most four workers, and clean process shutdown. The
current native timeout/shutdown evidence does not satisfy that gate.

## Prerequisite verification

The migration adapter has four behavioral tests covering current-page reconciliation, schema-agnostic
preservation, CAS races, split failure and cancellation recovery. Managed issuance has five focused
tests covering independent stores/restart, a failed acknowledgement after durable rename, request/key
mismatch, malformed managed metadata, and an existing grant expiring without renewal. Exact staged
retry retains registry bytes/revision and launches no worker; changed grant/hash or enabled identity
is rejected. These prerequisite tests are supplemented by the coordinator cases below.

The first full check exposed two existing engine interruption fixtures racing a real 150 ms timeout.
They now wait for a fixture receipt and freeze only the pending operation's test clock; the separate
timeout regression keeps its real clock. All three focused interruption tests pass. Production engine
and plugin deadlines are unchanged. Final `pnpm check` passes: 328 portable tests, 29 native-gated
skips, and successful dependency validation, typecheck, lint, formatting and all builds. Evidence:
`work/default-bootstrap-prerequisites-check-final.log`. The native gate remains failed as documented
in [LIVE-PLUGIN-PLAN.md](LIVE-PLUGIN-PLAN.md).

## Coordinator verification

Sixteen focused tests now cover both exact presentation plans, permanent completion after every
default is removed, checkpointed prefix recovery, interruption after the second durable install,
artifact/grant/extra-plugin divergence, separate model/pins checkpoints, CAS conflicts that remain at
revision zero, promotion checkpoint gaps, enabled grant identity, frozen artifacts across bundle
changes, malformed/incoherent/private-file checks, customized profiles and safe/developer bypass.
A lease acknowledgement failure after a durable journal write also verifies that the current
process must restart before retrying. The fixtures use the real portable artifact, grant, storage
and manager services with controlled failures and mock workers; they are not native cutover evidence.

Read-only review accepted the material recovery decisions. Concurrent double-bootstrap calls and
an actual filesystem sync failure remain useful additional coverage; promotion-gap tests simulate
the durable state through the manager. Normal startup is deliberately not wired yet: it still needs
functional public Settings/Plugins routes before the default cutover.

The combined `pnpm check` passes 346 portable tests with 29 native-gated skips, including dependency
validation, typecheck, lint, formatting and all builds. Evidence:
`work/default-bootstrap-coordinator-check.log`. Native startup and clean shutdown remain unverified
for this coordinator; previous failed native gates remain open.

## Public management route design

Settings and Plugins are presenter-owned Native content contributions. Opening either screen removes
the page viewport binding; returning to browsing binds the same selected page. Page events must not
force a route change. Shared route rendering can compile into both alternative presenters without
adding a fifth worker or moving tab-model, pinning or layout ownership into the presenter. The host
must not recognize product route names or call the legacy controller screens.

The next API slice separates `configuration.read`, `plugins.read` and `plugins.manage` from code
installation authority. A bounded public management snapshot exposes display metadata and lifecycle
state, never grant IDs, artifact paths or credentials. Lifecycle operations use `plugins.manage`;
executable staging and grant delegation retain `plugins.install`. These new capabilities and routes
are a design, not an implemented SDK contract.

A proposed authenticated `replaceSelf(targetId, expectedRevision)` operation substitutes the caller
references in the existing plan, preserving unrelated entries and using ordinary complete-plan
validation. Sidebar/top switching then replaces only the presenter and keeps model/pins/layout
workers, page identities and owner storage. Before accepting this API, test stale revisions, missing
or incompatible targets, authority denial and preservation of unrelated entries.

Accepted management mutations must run in an application-owned scope. Stopping the calling presenter
must not cancel the transaction that replaces it. A late-bound port is created before the installed
launcher, bound once before restore, and fails closed while unbound. The dispatcher authorizes and
decodes each request before admission. Developer plugins receive no port by default. A deterministic
cancellation test and a native public-action switch test are required; direct manager-plan tests alone
do not prove this lifecycle.

## Runtime reader verification

Nine portable tests build the real default artifacts in isolation, relocate them into an app resource
tree, load both recipes, and stage the returned bytes through the public artifact store. Rejection
cases cover changed hashes, redirected index paths, unexpected fields, missing/duplicate identities,
rehashed identity/recipe mismatches, linked roots/directories/files, oversized payloads, invalid UTF-8
and missing or relative resource paths. The reader neither executes plugins nor writes profile state.

The combined `pnpm check` passes 355 portable tests with 29 native-gated skips, dependency validation,
typecheck, lint, formatting and all builds. Evidence: `work/default-bundle-reader-check.log`. This
verifies the portable reader and existing suite; it does not establish normal startup cutover or
native acceptance.
