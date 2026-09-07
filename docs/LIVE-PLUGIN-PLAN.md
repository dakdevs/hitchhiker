# Live installed plugin plans

This document defines the live-plan prerequisite. The manager transaction and public MCP adapters
are implemented and under integration verification. The default-interface cutover remains incomplete.

At the start of this migration, the application reads `composition.json` and `services.json` once in
[`apps/browser/src/main.ts`](../apps/browser/src/main.ts), constructs a fixed composition in
[`apps/browser/src/composition.ts`](../apps/browser/src/composition.ts), and gives the manager fixed
`compositionOwners` and `serviceBindings` options. The service broker can already reconfigure a
validated graph, but [`packages/runtime/src/composition-session.ts`](../packages/runtime/src/composition-session.ts)
previously captured one recipe for its entire lifetime. Dynamic composition is now implemented,
and the manager now owns a durable active plan rather than fixed startup-only composition and
service choices. Native verification of the complete switching path is tracked below.

## Public manager contract

The installed plugin manager remains the only lifecycle coordinator. Add these generic types and
methods; no default tab, pin, or presentation schema belongs in the manager.

```ts
interface InstalledPluginPlanInput {
  readonly enabled: readonly string[];
  readonly composition?: PluginCompositionRecipe;
  readonly serviceBindings: readonly ServiceBinding[];
}

interface InstalledPluginPlan extends InstalledPluginPlanInput {
  readonly revision: number;
}

interface PluginManager {
  readonly plan: () => Effect.Effect<InstalledPluginPlan, PluginManagerError>;
  readonly applyPlan: (
    expectedRevision: number,
    candidate: InstalledPluginPlanInput,
  ) => Effect.Effect<InstalledPluginPlan, PluginManagerError>;
}
```

The host assigns monotonically increasing safe-integer revisions. `expectedRevision` prevents a
stale Settings, MCP, or future customization client from replacing a newer plan. Existing
`enable` and `disable` operations become small plan updates. Disabling an identity required by the
current composition must fail unless the caller supplies a complete replacement plan. For cohort construction, install new identities disabled with `install(hash, grantId, { staged: true })`;
a caller stages every artifact, then admits the intended cohort with one `applyPlan` call. The
existing two-argument install and `hitchhiker_plugin_install` retain automatic admission temporarily
for compatibility. New cohort workflows use `hitchhiker_plugin_stage`, `hitchhiker_plugin_plan` and
`hitchhiker_plugin_apply_plan`. Removing that legacy automatic admission is part of default cutover,
not a completed requirement of this migration. Updating or rolling back the artifact for
an already enabled identity must validate and reconcile against the same active plan.

`enabled` records the desired durable preference. It does not mean that every identity is currently
runnable. A consumer whose required provider is absent stays enabled but blocked, matching
[`apps/browser/src/installed-service-plan.ts`](../apps/browser/src/installed-service-plan.ts).
Only the admitted service graph and actual worker count are limited to four. Dormant bindings may
refer to disabled or not-yet-installed endpoints and are checked when both endpoints enter the
admitted cohort. A visible composition is stricter: its layout and configured contributions must be
runnable and complete before a candidate plan can be promoted. Blocked headless plugins may coexist
with a complete visible composition.

## Durable transaction

Move the active plan into version 2 of `hitchhiker-plugins/plugins.json`, alongside immutable artifact
and revision metadata. Do not attempt to coordinate independent writes to `plugins.json`,
`composition.json`, and `services.json`.

```ts
interface RegistryV2 {
  readonly version: 2;
  readonly plugins: readonly StoredPluginV2[];
  readonly activePlan: InstalledPluginPlan;
  readonly pendingPlan?: {
    readonly candidate: InstalledPluginPlan;
  };
}
```

`activePlan` remains the last known-good plan while a switch is running. Starting a switch first
validates the entire candidate without changing files, workers, broker state, composition state,
pages, or storage. The manager then atomically writes `pendingPlan`, using the existing directory
mutation lock, temporary-file write, file sync, rename, and directory sync. The registry size bound
must be raised deliberately to accommodate the already bounded composition and binding schemas.

After the marker is durable, the manager may stop and start workers. When every target worker is
ready and the target composition reports complete, one atomic registry write promotes the candidate
to `activePlan` and removes `pendingPlan`. A crash before that write leaves the old plan active and a
pending marker. Startup always discards the pending candidate and restores `activePlan` before
launching any worker. A crash during the final rename observes either the old plan plus marker or the
fully promoted plan.

Cancellation after the pending write follows the same path as failure. Use an interruptible body
inside an uninterruptible recovery mask: stop candidate activations, restore the old service graph
and composition, restart only old workers that were stopped, verify the old composition, and then
clear the marker. If runtime rollback fails, keep the pending marker, show the trusted recovery
surface, poison further mutations, and require restart. Never persist the candidate merely because
rollback failed.

Promotion removes the transaction history. A later worker crash must not roll the whole plan back.
Per-plugin revision fallback remains separate and must revalidate the active plan before activating
the previous artifact. Runtime failure may suspend a worker and its required dependents while
preserving their enabled preferences; it must not silently rewrite the chosen plan.

## Preparation and runtime order

Candidate preparation loads the installed artifacts selected by `enabled`, checks revision metadata,
validates current grants, builds the admitted service graph, verifies exact active contract tuples and
same-authority service relationships, and checks the four-worker ceiling. It also verifies that every
composition owner is enabled, runnable, and has `ui.compose` or `browser.full-control`, and that every
enabled UI plugin is represented by the composition. An absent composition is valid only for a
headless installed plan. Developer `--plugin` remains the separate direct whole-window path.

Compute the stop set before mutating runtime state. Seed it with:

- disabled identities and artifact-hash or grant changes;
- consumers whose required service binding changes;
- owners whose layout role or configured contribution-ID set changes; and
- the layout owner when the layout slot-key set changes.

Close required dependents over the union of the old and candidate graphs. Optional binding changes
do not restart consumers; [`packages/runtime/src/plugin-service-broker.ts`](../packages/runtime/src/plugin-service-broker.ts)
already invalidates affected calls and publishes the latest available or unavailable notification.
Moving the same owner/contribution ID to another slot may retain that worker and its publication.

Mark the full stop set expected before stopping anything. Stop consumers before providers, then
reconfigure the service broker and composition. Start missing target workers in a deterministic
order: service providers before consumers, preferring the layout among workers whose services are
ready. A contributor may provide a service required by the layout; composition does not add a
reverse dependency or require that the layout publish first. Every
new or replacement process receives a fresh process-global generation from the existing allocator.
An identity with the same artifact, grant, required bindings, and compatible composition role keeps
its worker and generation. Chromium pages belong to the controller and plugin storage belongs to the
profile, so neither is recreated or deleted by a plan switch.

## Dynamic composition prerequisite

The first cohesive implementation slice is composition reconfiguration. Its source and focused
checks are implemented; final evidence is recorded in [PLUGIN-FIRST-PLAN.md](PLUGIN-FIRST-PLAN.md).
The durable manager transaction is implemented; final integration evidence is still being collected.

In [`packages/runtime/src/composition-session.ts`](../packages/runtime/src/composition-session.ts):

- extract semantic recipe validation into a prepare operation;
- allow an initial recipe and a reconfiguration candidate to be `undefined`;
- add `reconfigure(recipe | undefined)` and `complete` to the session;
- compose current compatible publications against the candidate under the existing permit;
- commit Native first, then adopt allowed owners, configured IDs, recipe, state, and routes; and
- retain the prior recipe and routes if validation, composition, or Native commit fails.

`undefined` represents an unconfigured headless installed plan. It permits no composition owners and
uses the trusted recovery surface; it counts as complete only when the plan contains no enabled UI
plugin. The browser must construct this stable composition coordinator unconditionally at startup so
a profile that starts headless can switch live into a composed plan. The installed launcher must not
capture `composition === undefined` for the process lifetime.

Reconfiguration rejects removal of an active owner; the manager must quiesce it first. Publications
whose owner and contribution ID remain configured are reusable, including a slot remap. Publications
for removed IDs are pruned only after a successful commit. Expose dynamic `allows(id)` or an owner
snapshot from [`apps/browser/src/composition.ts`](../apps/browser/src/composition.ts) instead of the
current fixed `owners` set. Keep generation-bound inbox replacement, queue bounds, overflow failure,
and event routing unchanged. `complete` must confirm a current layout publication and every configured
contribution required by the active recipe. The implementation caps retained generation history at
256 distinct activated owner IDs per compositor lifetime. Existing identities can still advance
generations at capacity; admitting another identity requires restarting the browser.

The next slices are:

1. The internal `apps/browser/src/installed-plugin-plan.ts` preparer and diff policy are implemented.
   The manager uses them to validate candidate cohorts and compute restart sets.
2. Registry V2 migration, `plan`, `applyPlan`, journaling, forward reconciliation, and rollback are implemented in
   [`apps/browser/src/plugin-manager.ts`](../apps/browser/src/plugin-manager.ts).
3. The installed launcher in [`apps/browser/src/plugin.ts`](../apps/browser/src/plugin.ts) uses the stable dynamic composition
   coordinator; [`apps/browser/src/main.ts`](../apps/browser/src/main.ts) restores the manager-owned
   active plan. Emergency recovery applies one empty enabled plan instead of disabling UI owners
   individually.
4. Keep [`apps/browser/src/composition-recipe.ts`](../apps/browser/src/composition-recipe.ts) and
   [`apps/browser/src/service-recipe.ts`](../apps/browser/src/service-recipe.ts) only as bounded legacy
   migration readers. On a Version 1 profile, construct the initial plan from its enabled flags and
   legacy files, validate it, and persist Version 2. Invalid legacy input stays repairable through safe
   mode and must not be overwritten as though migration succeeded.

## Legacy whole-window compatibility

Version 1 profiles without a composition recipe may contain one enabled whole-window UI plugin.
During migration, synthesize `{ layout: pluginId, slots: [] }` for that identity. Zero enabled UI
plugins produces a headless plan; more than one is invalid and must remain repairable without
rewriting Version 1. An existing explicit composition recipe remains authoritative.

The dispatcher supports `ui.publish` as a deprecated alias for `ui.publishLayout` only for the
host-assigned current layout owner. Contributors cannot select that role or publish a whole-window
surface. This uses the same surface validation, grant checks, owner namespacing, viewport bindings
and event routing as ordinary layout publication; it grants no additional authority. All installed
Version 2 UI still uses the compositor, with no parallel legacy execution path or durable exception
flag. Developer `--plugin` retains its separately selected direct path.

The dispatcher adapter is implemented and its portable test covers viewport binding, original action
routing, release/re-publication, malformed input, contributor denial and revoked grants. Profile
migration is implemented and its invalid-input preservation and concurrent safe-mode writer are
covered by portable tests. Native migration verification remains unfinished.

## Acceptance evidence

Portable composition tests must prove that a successful slot remap retains compatible owner
generations and reroutes events, a failed Native commit preserves the prior surface and routes,
removing an active owner is rejected, removing it after quiescence succeeds, and incomplete recipes
report incomplete or recovery without being promoted.

Manager tests must prove all validation occurs before the pending write and before worker stops;
stale plan revisions, invalid grants, active contract mismatches, and a fifth runnable worker leave
the active plan and workers unchanged. They must also prove optional provider changes retain the
consumer, required binding changes restart the correct union closure, unchanged workers keep their
generations, replacements receive fresh generations, interruption rolls back, startup resolves a
pending marker to the old plan, and rollback failure retains the marker and blocks further mutation.

The native acceptance test switches a live four-worker default sidebar plan to the top presenter and
back. It must show that model, layout, and pin workers were not relaunched, only the presenter received
a fresh generation, the same Chromium page IDs and JavaScript document markers survived, plugin
storage revisions and values survived, the selected viewport remained correct, and no fifth worker
ran. A deliberately failing target presenter must restore the prior sidebar plan and its routed input.

Passing the composition slice alone proves only dynamic composition mechanics. Passing portable plan
transactions and the native switch proves the live-plan prerequisite. It still does not complete the
default-interface migration, Settings/Plugins routing, startup performance work, DevTools extraction,
or removal of the legacy controller interface.

## Plan preparer verification — September 6

The pure preparer now validates installed identities, the runnable service cohort, composition
membership and the four-worker limit. Its diff retains optional-service consumers and compatible
slot remaps, while restarting required dependents and owners whose artifact, grant or composition
role changes. Layout priority never introduces a reverse service dependency.

Node 24.19.0 verification: focused planner cases passed; browser typecheck, root lint, formatting
and the complete build passed. The full `pnpm check` reached tests but failed the controller shutdown
case and interrupted-extension handoff case under machine load above 400. Turbo then interrupted
remaining browser tests. Serial reruns of those two files passed 36 tests; the separate planner,
manager and uninstall run also passed. Logs are local under `work/plugin-plan-{check,focused,
regression,build}.log`. No native test was rerun for this pure planning change. The earlier native
shutdown/startup failures remain unresolved.

That preparer-only checkpoint has now been superseded by the manager integration below.

## Manager integration in progress

The existing registry directory checks, no-follow reads, bounded read loop, artifact metadata checks,
mutation lock and fsync/rename writes are retained. Version 2 adds strict active/pending plan schemas,
a 256 KiB registry bound and an enabled-preference mirror. New profiles start with an empty V2 plan;
legacy composition and service files are read only while migrating an actual V1 registry. Invalid
migration input does not overwrite V1. A safe-mode legacy writer rechecks the registry version under
its mutation lock, so a concurrent V2 migration cannot send it through a legacy write path.

Forward switching writes old metadata plus the pending candidate before changing runtime state.
Rollback compares actual generations with the pre-switch snapshot so it does not restart old workers
that were never touched. A failed restore preserves the pending marker and poisons mutations. Startup
restores the active plan before clearing the marker. A worker crash persists suspension and stops its
required dependents while keeping enabled preferences; explicit enable retries it. The existing
single revision fallback remains bounded to one attempt.

Uninstall has two commit boundaries. Cancellation before plan promotion restores the previous plan
and grants. Promotion atomically disables the identity and marks it `removing`; revocation and storage
cleanup then run under the same interruption mask, outside plan rollback. A crash or cleanup failure
leaves that marker durable. Startup, including safe-mode manager recovery, validates the recorded
grant ownership and resumes idempotent cleanup before launching workers. The marker is removed only
with the final registry deletion. Read-only plugin metadata exposes `removing: true` while recovery is
pending.

The public MCP plan tools require `plugins.install` on every call and reject caller-selected profiles,
grants and malformed plan envelopes. Disabled staging delegates a grant within the connection's
existing authority and revokes it if staging fails. Plan input schemas are shared by MCP and the
manager. The developer `--plugin` path remains direct and rejects a profile with an active installed
plan.

Portable acceptance now covers four-worker presenter replacement, generation retention, failed
presenter rollback, stale/capacity/grant rejection before side effects, cancellation with an untouched
worker, poisoned rollback with a retained journal, pending startup recovery, strict migration, the
safe-mode migration race, and uninstall cancellation/partial cleanup. Native fixtures have been
updated to stage complete cohorts and switch sidebar/top presenters through the manager. Their actual
run results, and the unresolved prior CEF shutdown behavior, must be recorded before claiming native
completion. Default bootstrap, Settings/Plugins extraction, performance proof and full Chromium/API
coverage remain separate unfinished work.

Native switch attempt: `work/live-plan-native-switch.log` reached Chromium page creation and then
failed while activating `default-tab-model` with `PluginHostError: Plugin host did not reply`. No
presenter switch assertion was reached, so this run does not prove native switching. The fixture
and owned host exited; the previous multi-minute `CefShutdown` hang was not reproduced in this run.
Machine load was above 500 during verification, but the timeout alone does not establish its cause.
A read-only shutdown audit found queued audio/CDP tasks worth tracing, not a confirmed shutdown fix.

Recovery verification: failed crash-state persistence now poisons subsequent mutations. Pending-plan
startup fails without changing the recorded old state if an expected worker cannot authorize or
activate; it retains the journal and invokes recovery instead of persisting a suspension that the
next restart could skip. The headless regression exercises both failures and a successful later
restart. Ordinary startup without a pending transaction still records unavailable workers as suspended.
The final `pnpm check` passed after this correction: 316 portable tests passed, 29 native-gated tests
were skipped, and dependency validation, typecheck, lint, formatting and all builds passed.
Evidence: `work/live-plan-check.log`. Native switch verification remains failed as recorded above.

Native follow-up investigation: a standalone actual model artifact completed its isolated-host
activation in 326 ms with synthetic page/storage/service replies (`work/model-host-diagnostic.log`).
A fresh browser fixture then timed out in `default-browser-layout`;
shutdown again stalled after all pages closed (`work/live-plan-native-switch-second.log`). A sample
at `work/live-plan-native-second-shutdown.sample.txt` shows the same main return offset after
`CefShutdown` as the previous capture. The fixture and its owned host eventually exited. Add bounded
transport phase/count diagnostics to timeout errors without logging payloads or changing deadlines
before the next native investigation. This evidence still does not verify native switching.

The diagnostic rerun (`work/live-plan-native-switch-diagnostic.log`) timed out with
`worker=unconfirmed, calls=0/0, phase=idle`. Thus no worker-start signal or plugin API call reached
the runtime before its existing five-second deadline; the evidence does not identify a layout API
deadlock or establish which transport/startup component stalled. This corrects the earlier inference
that this run had passed model activation: the configured layout is preferred first. The fixture
again exceeded its 60-second deadline while closing; it and its owned host eventually exited.
Transport diagnostics report only fixed host operations, bounded counts and lifecycle phases, not
plugin method names, code, arguments or results. Two protocol fixtures verify startup and resolve
stalls without changing production limits.

The diagnostic checkpoint passes `pnpm check`: 318 portable tests passed, 29 native-gated tests
were skipped, and dependency validation, typecheck, lint, formatting and builds passed. Evidence:
`work/plugin-timeout-diagnostics-check.log`. The native diagnostic fixture is terminal with a failed
60-second test deadline and no surviving owned processes; this is not a native acceptance pass.

Exact trusted staged-install retry is now idempotent for the same disabled, non-removing artifact
hash and grant ID, with artifact metadata revalidation. It does not change the plan revision or
restart workers. Any mismatch or enabled identity fails. This closes the install/checkpoint crash
gap for the planned bundled-default bootstrap; it does not make newly delegated MCP staging calls
with different grant IDs interchangeable.
