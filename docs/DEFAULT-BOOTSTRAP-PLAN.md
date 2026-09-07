# Bundled default-plugin bootstrap

This is the remaining distribution startup migration, not a tab policy in the generic host. The
live manager plan is implemented. The state-seeding, managed-grant and exact staged-install retry
prerequisites, packaged bundle index and controller restoration barrier are published. The coordinator
now passes its focused recovery tests and review. The runtime bundle reader and public management
routes have portable coverage. Normal installed-plugin startup is now wired; Native acceptance of that
cutover remains open.

## Current cohort

Fresh eligible profiles use V3: seven artifacts, six enabled workers, a separate DevTools toolbar,
and independent extension management. The manager limit is six for all plugins. Existing V1/V2
journals retain their frozen plans and grants: pending work resumes its original cohort, and
terminal records remain terminal. Neither predecessor automatically receives extension authority.
The V1 journal details and checkpoint evidence below remain for recovery compatibility. See the
[V3 routing checkpoint](PLUGIN-ROUTING-PLAN.md#v3-integration-checkpoint) for current implementation
and the remaining performance and release acceptance.

## Eligibility and ownership

Run only in normal installed-plugin mode, before exposing MCP or interactive management actions.
Safe mode and developer `--plugin` do not read/write this bootstrap journal or issue default grants.
Capture decoded legacy browser persistence under the profile lease before controller startup can
save newer state. Restore the same Chromium pages through the controller, then run manager recovery
before bootstrap. Use the complete restored page inventory to prepare plugin state. The current
`controller.start` finishes issuing restore requests but does not itself await every staged page
lifecycle event. `startDefaultPluginInterface` awaits `controller.restoredPageInventory` before
capturing that inventory or starting default workers; it settles after all initial requests and staged
page events, persistence and rendering.
Startup errors, host exit and controller closure fail pending waiters. Do not seed from a transient
partial `controller.snapshot`.

A permanent journal at `hitchhiker-plugins/default-bootstrap.json` decides whether bootstrap may run.
With no journal, only a revision-zero empty plan and an empty installed-plugin list are eligible.
An existing customized profile gets a terminal `abandoned` journal, with no plugin changes. A terminal
`completed` journal stays terminal even if every bundled plugin is later removed, disabled or replaced.
Never use missing default IDs as a reason to reinstall them.

The coordinator uses public artifact, managed-grant, storage and manager APIs. It never writes
`plugins.json`, calls private plugin operations, or reopens Chromium pages. The V1 cohort is
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
existing lazy bundle shape, which normal startup now uses after management routes became available.
The bundle and controller share the application distribution trust boundary. The index digest checks
consistency, not publisher authenticity: this reader must not accept arbitrary downloaded bundles.
Authenticating the whole application and its sealed resources remains part of the unfinished signing
and notarization release gate. Development paths are explicitly trusted by their caller.

The coordinator is wired from `main.ts` after public presenter routes are available. Normal startup
loads persistence under the profile write lease before creating the controller, starts the controller
in installed-plugin mode, restores pages, and then invokes the coordinator. The generic controller
persists browser configuration and pages in V2 while carrying a frozen legacy tab seed only for
migration. That seed is removed only after a durable terminal `completed` or `abandoned` journal.
Safe mode and developer `--plugin` bypass bootstrap and retain the V2 seed for a later normal launch.
Normal startup requires an absolute `HITCHHIKER_PLUGIN_HOST`; it cannot silently select legacy UI.
Legacy tab fields are not authoritative in installed-plugin mode; the host displays only its minimal
trusted loading/recovery surface until composition publishes the presenter UI. Browser persistence
flushes its file and parent directory before reporting success. If seed retirement fails after a
terminal journal, the seed remains conservatively stored, and that terminal journal prevents it from
being imported again.

In a development launch, `HITCHHIKER_DEFAULT_PLUGINS` may select the trusted default-plugin build
directory. It must be an absolute path. Production uses the packaged resource directory instead;
there is no current-directory fallback.

The native bootstrap seam fixture passes a migrated V1 two-page profile through the actual host:
five plugins install, four workers run, the selected viewport is restored, V2 seed retirement and a
completed journal are durable, and explicit window close reaches engine exit zero. Evidence:
`work/native-default-startup.log` (1 pass, 0 skips; fixture 6.24 s, run 6.88 s). This is not full
main-entrypoint or release acceptance, and does not prove a live public presenter switch. Earlier
intermittent activation/shutdown failures remain regression concerns; the fixture recorded a host IPC
request-queue-full message during shutdown despite exit zero.

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
the durable state through the manager. The portable coordinator tests do not prove the wired startup
path in the Native host.

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

The implemented SDK separates `configuration.read`, `plugins.read` and `plugins.manage` from code
installation authority. A bounded public management snapshot exposes display metadata and lifecycle
state, never grant IDs, artifact paths or credentials. Lifecycle operations use `plugins.manage`;
executable staging and grant delegation retain `plugins.install`. Existing configuration writers retain read access; new layout manifests use read-only authority.
Pending journals from the previous capability cohort finish with their frozen artifacts and grants,
without loading the new bundle or upgrading authority. Fresh bootstrap requires the new exact cohort.

The authenticated `replaceSelf(targetId, expectedRevision)` operation substitutes the caller
references in the existing plan, preserving unrelated entries and using ordinary complete-plan
validation. Sidebar/top switching then replaces only the presenter and keeps model/pins/layout
workers, page identities and owner storage. Portable tests cover stale revisions, missing or incompatible targets, authority denial, and
preservation of unrelated entries. A real portable manager fixture also initiates replacement from
the requesting worker and verifies that stopping it does not cancel the committed transition.

Accepted management mutations must run in an application-owned scope. Stopping the calling presenter
must not cancel the transaction that replaces it. A late-bound port is created before the installed
launcher, bound once before restore, and fails closed while unbound. The dispatcher authorizes and
decodes each request before admission. Developer plugins receive no port by default. Snapshot reads bypass the transaction mutex so activation can inspect state without deadlocking.
Management mutations are paused through controller restoration, manager recovery and bootstrap, and
are enabled only after bootstrap returns. They remain denied until activation completes and after
stopping. Admitted work is bounded to 16
commands and owned by the application scope; independent Deferred replies let caller cancellation
leave work running while application shutdown interrupts it. Five port tests cover binding, caller
cancellation, application shutdown, readiness and bounded admission. A native public-action switch
test remains required; portable manager tests do not prove native startup or shutdown.

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

## Public management verification

The initial full check after startup wiring passes 378 portable tests with 29 native-gated skips,
including dependency validation, typecheck, lint, formatting, tests, and builds
(`work/plugin-startup-cutover-check.log`). This is not Native acceptance. Native public-action
switching, startup/cutover and clean shutdown remain required.
