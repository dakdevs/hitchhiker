# Bundled default-plugin bootstrap

This is the remaining distribution startup migration, not a tab policy in the generic host. The
live manager plan is implemented. The state-seeding, managed-grant and exact staged-install retry
prerequisites are published. The packaged bundle index and controller restoration barrier are now
implemented and under verification. The coordinator is under recovery review; management routes and
main startup cutover are not yet implemented.

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
and grant. The manager's idempotent staged-install check validates grant identity without exposing
it over MCP. Any extra/missing identity, incompatible enabled state, changed hash/grant or unrelated
revision is divergence: mark abandoned rather than repairing user choices.

A promotion checkpoint gap is accepted only when the exact target plan is active at expected revision
plus one. Finish the terminal marker. If manager recovery restored the prior empty plan at the expected
revision, resume the pending operation. Any later or different plan means abandonment, never replay.
Unused managed grants may remain after abandonment; they have no returned bearer. Do not delete
possibly user-edited plugin storage as cleanup.

## Remaining integration

Generate a strict default bundle index/digest in `apps/default-plugins/build.mjs`, verify all five
artifacts and both recipes, and copy the bundle into the packaged app's resources. Resolve the bundle
from the controller's installed resource location and reject paths escaping that trusted bundle.

Implement the coordinator and fault-injection tests for every journal/grant/install/seed/promotion
boundary. Test terminal state after removal, divergence in every pending phase, malformed journals,
no duplicate grants, preserved nonzero storage, and both exact presentation plans. Only wire it from
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
is rejected. These portable tests do not prove the unimplemented bootstrap coordinator.

The first full check exposed two existing engine interruption fixtures racing a real 150 ms timeout.
They now wait for a fixture receipt and freeze only the pending operation's test clock; the separate
timeout regression keeps its real clock. All three focused interruption tests pass. Production engine
and plugin deadlines are unchanged. Final `pnpm check` passes: 328 portable tests, 29 native-gated
skips, and successful dependency validation, typecheck, lint, formatting and all builds. Evidence:
`work/default-bootstrap-prerequisites-check-final.log`. The native gate remains failed as documented
in [LIVE-PLUGIN-PLAN.md](LIVE-PLUGIN-PLAN.md).
