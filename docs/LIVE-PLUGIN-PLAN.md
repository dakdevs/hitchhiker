# Live installed plugin plans

This document defines the next plugin-first prerequisite. It is an implementation plan, not a claim
that live plan switching or the default-interface cutover is complete.

At the start of this migration, the application reads `composition.json` and `services.json` once in
[`apps/browser/src/main.ts`](../apps/browser/src/main.ts), constructs a fixed composition in
[`apps/browser/src/composition.ts`](../apps/browser/src/composition.ts), and gives the manager fixed
`compositionOwners` and `serviceBindings` options. The service broker can already reconfigure a
validated graph, but [`packages/runtime/src/composition-session.ts`](../packages/runtime/src/composition-session.ts)
previously captured one recipe for its entire lifetime. Dynamic composition is now implemented,
but fixed manager configuration still prevents a sidebar-to-top switch from being one live,
recoverable operation.

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
current composition must fail unless the caller supplies a complete replacement plan. Newly
installed identities should be registered disabled; a caller stages and installs every artifact,
then admits the intended cohort with one `applyPlan` call. Updating or rolling back the artifact for
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
combined order: service providers before consumers and the layout before its contributors. Every
new or replacement process receives a fresh process-global generation from the existing allocator.
An identity with the same artifact, grant, required bindings, and compatible composition role keeps
its worker and generation. Chromium pages belong to the controller and plugin storage belongs to the
profile, so neither is recreated or deleted by a plan switch.

## Dynamic composition prerequisite

The first cohesive implementation slice is composition reconfiguration. Its source and focused
checks are implemented; final evidence is recorded in [PLUGIN-FIRST-PLAN.md](PLUGIN-FIRST-PLAN.md).
The durable manager transaction remains unimplemented.

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

1. Add a pure `apps/browser/src/installed-plugin-plan.ts` preparer and diff policy with focused tests.
2. Add Registry V2 migration, `plan`, `applyPlan`, journaling, forward reconciliation, and rollback to
   [`apps/browser/src/plugin-manager.ts`](../apps/browser/src/plugin-manager.ts).
3. Make [`apps/browser/src/plugin.ts`](../apps/browser/src/plugin.ts) use the stable dynamic composition
   coordinator and update [`apps/browser/src/main.ts`](../apps/browser/src/main.ts) to restore the
   manager-owned active plan.
4. Keep [`apps/browser/src/composition-recipe.ts`](../apps/browser/src/composition-recipe.ts) and
   [`apps/browser/src/service-recipe.ts`](../apps/browser/src/service-recipe.ts) only as bounded legacy
   migration readers. On a Version 1 profile, construct the initial plan from its enabled flags and
   legacy files, validate it, and persist Version 2. Invalid legacy input stays repairable through safe
   mode and must not be overwritten as though migration succeeded.

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
