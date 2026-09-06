# Plugin removal

Add removal to the trusted manager, MCP and native recovery controls. A successful removal stops
the isolated worker, releases its surface through the existing launcher finalizer, revokes the
current and rollback revision grants, and removes the installed registry entry. Existing pages and
independently authorized plugins remain. Compiled artifacts remain in the bounded profile cache; garbage collection
is a separate operation. Removal does not claim to revoke historical grants no longer referenced
by the installed entry.

Hold the existing process and directory mutation locks throughout removal. Before mutation, check
that each referenced grant still belongs to the plugin and profile; absent grants already have no
authority. Then stop the worker, persist disabled state, revoke the referenced grants, and remove the
registry entry. Keep this sequence uninterruptible so cancellation cannot release the lock while
shutdown or persistence is still running. If a mutation fails, stop further mutations until restart,
as for failed disable. A successfully persisted disabled entry prevents startup after a partial
removal and retains grant references for retry. If the first write fails, the old enabled entry may
remain; the operation has failed and restart behavior follows that durable state.

MCP requires `plugins.install`, accepts only a validated plugin ID, and exposes no filesystem path
or grant ID. Native recovery controls use the same manager operation and stay responsive while the
worker exits. Unknown IDs fail without mutation. Reinstall requires an explicitly authorized install
and receives a fresh delegated grant.

Verification must cover worker shutdown before success, persisted removal after restart, current
and rollback grant revocation without affecting the parent or another plugin, denied MCP access,
partial persistence/revocation failures, cancellation while either registry write is pending, and
real native shutdown with page identity preserved.

## Verification

Root `pnpm check` passes. Eleven manager regressions cover removal/restart/reinstall, independent
plugins, current/previous/absent/duplicate grants, partial revocation, both persistence failures, and
cancellation during worker shutdown and either registry write. The official MCP client verifies
tool discovery, denied/revoked access, rejected excess fields and valid removal dispatch. The native
recovery control test verifies one removal dispatch while browsing stays responsive.

All 188 native-enabled runtime/browser tests pass without skips (96 runtime, 92 browser), including
real compiled canvas installation, update, rollback, removal, restart and fresh authorized reinstall.
Both revision grants are revoked and the original page survives removal/restart. Evidence is in
`work/plugin-removal-{root,native}-final.log`. All eleven relocated developer-bundle checks also pass
without skips, with strict signature/import verification; see `work/plugin-removal-bundle-{build,verify}.log`
and `work/plugin-removal-bundle-native-final.log`.

The first bundle run exposed an existing replacement-fixture timing assumption: it expected a selected
discarded document to remain uncommitted at the next query. Chromium can restore on visibility/focus,
as described by the pinned `TabLifecycleUnit::MaybeLoad`. The fixture now checks stable generation,
URL, selected viewport and retained history; the portable controller test still rejects an unsolicited
Hitchhiker reload command. Production replacement behavior is unchanged. The initial failure remains
recorded in `work/plugin-removal-bundle-native.log`.
