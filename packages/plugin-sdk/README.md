# @hitchhiker/plugin-sdk

Public TypeScript helpers for isolated Hitchhiker plugins. Use `definePlugin({ activate, onEvent })`
and bundle an entry point as an IIFE. The SDK turns typed `pages`, `dom`, `devtools`, `configuration`, and `ui` calls
into capability-checked broker requests; it grants no ambient filesystem, network, or Node access.

## UI publishing

`ui.publish(surface)` is the legacy whole-window API. It accepts a Native component tree and page
bindings from `@hitchhiker/ui`; the host supplies the installed identity, measures viewport geometry,
enforces limits, and routes input only to the current owner. In a composed profile,
`ui.publish` aliases `ui.publishLayout`: only the configured layout owner may use it. Contributors
cannot bypass their assigned role. Prefer `ui.publishLayout` for new layout plugins.

Composed plugins use the `ui.compose` capability and publish only their declared role. They do not
select an identity, slot, provider, or other plugin:

```ts
import { definePlugin } from "@hitchhiker/plugin-sdk";
import { column, text } from "@hitchhiker/ui";

definePlugin({
  async activate(browser) {
    await browser.ui.publishContribution("page", {
      root: column("panel", [text("label", "Ready")], { flex: 1 }),
      bindings: [],
    });
  },
});
```

`ui.publishLayout(surface)` publishes the configured layout. `ui.publishContribution(id, surface)`
publishes one configured contribution, and `ui.withdrawContribution(id)` removes it. Each publishing
call resolves to `{ revision }` after the host commits it. `ui.release()` remains reusable: it returns
to the trusted default UI in legacy mode and releases the caller's UI contributions in composition
mode, so the same activation can publish again later.

A slot can declare `route: { fallback: { pluginId, id } }`. It then renders only the selected
contribution, or its required fallback. Publish your contribution before calling `ui.showRoute(id)`.
Call `ui.hideRoute(id)` to restore the fallback if your exact activation still owns the selection.
Both return `{ revision }` and require `ui.compose`; they accept no plugin ID, generation, profile
or slot. A stale hide cannot dismiss another route. Withdrawal or activation replacement clears
selection. Hidden contributions keep their latest publication but contribute no nodes, actions or
viewport bindings. Slots without `route` retain ordered composition.

Mark an entry `optional: true` when its absence should not block composition readiness. The fallback
must name a required entry in that same slot. Omitted `optional` remains required. Native commit
failure preserves the previous surface and input routing. These generic APIs do not implement browser
navigation history or the planned default extension-management screen.

Composition belongs to the manager's active Version 2 plan in `hitchhiker-plugins/plugins.json`.
Use `hitchhiker_plugin_stage` to install each new identity disabled, read `hitchhiker_plugin_plan`,
then pass its revision and the complete enabled/composition/serviceBindings candidate to
`hitchhiker_plugin_apply_plan`. The plan only arranges installed, granted artifacts; it does not
install code or issue grants. Legacy `composition.json` is read only during Version 1 migration. The host still runs at
most five workers, and `--safe-mode` ignores the recipe. During migration, native emergency recovery
can restore the legacy plugin-management interface. A missing or disabled layout also keeps that
management interface visible until a valid layout is published. Each activation has its own bounded
input inbox; early actions are retained, and overflowing one inbox stops only that worker.

See [the runnable composition example](../../apps/composition-example/README.md),
[the canvas example](../../apps/canvas-plugin/src/index.ts), and
[development instructions](../../docs/DEVELOPMENT.md). The built-in tabs/controller migration
is still pending; do not assume every Chromium API or default-browser feature
is exposed by this SDK.

## Plugin services

The SDK includes `services.publish(service, value)`, `get(dependency)`, `subscribe(dependency)` and
`call(dependency, method, params)`. Installed plugins receive an identity-bound adapter when their
manifest declares provided services or dependencies. The active plan's `serviceBindings` selects
providers independently of UI composition. Legacy `hitchhiker-plugins/services.json` is read only
while migrating a Version 1 registry. Changing that file does not alter a Version 2 plan.
The [installed native fixture](../runtime/test/native-installed-services.test.ts) exercises real SDK
artifacts through MCP installation, provider replacement and fresh-process restore.

A provider declares `provides` in its manifest and registers handlers through
`definePlugin({ services: { serviceId: handler }, activate })`. A consumer declares `requires`.
Each declaration identifies a contract by exact `{ name, version, digest }`; a trusted profile
binding selects the provider for each dependency alias. The digest identifies an agreed contract,
not host validation of arbitrary feature schemas. Plugins validate their own command and state data.

Handlers receive `(method, params, caller)` and return JSON. Caller identity is supplied by the host;
it does not transfer the caller's credentials. The provider retains its own authority. Service
cooperation requires the consumer's effective host authority to contain the provider's authority,
including origins and separately granted CDP access. Publishing private provider data is deliberate
sharing with those consumers.

`subscribe` returns the current snapshot. Later `service.state` events announce a revision; use
`get` to read the latest snapshot. A missing optional provider yields `{ available: false }`.
Feature schemas, including any future tab model, remain outside the host.

The manager starts providers before consumers. Disabling or uninstalling a required provider stops
its consumers while preserving their enabled preferences; restoring the provider resumes them.
Optional consumers keep running and receive availability changes. A compatible provider update
restarts required consumers after joining their old workers. Incompatible contracts or grants reject
the update before stopping the current cohort. A changed grant restarts the worker even when its
artifact hash is unchanged. Recipes may retain bindings for future or disabled plugins; only the
runnable cohort is admitted. Apply a complete plan with the current revision to change bindings or
UI composition live. Required UI owners must remain enabled and runnable. An owner whose contributions
are all optional can be disabled or removed while its declaration remains in the recipe; enabling
it again rechecks its grants and service dependencies. Failed switching restores the old plan, and failed rollback retains
a recovery journal requiring restart. Native switching verification is still in progress.

Providers may publish initial state during `activate`. Consumers must use the returned subscription
snapshot during activation: event forwarding begins after activation resolves, so waiting for a later
event inside `activate` would prevent startup. Service handlers may call dependencies that have already
become ready. A command timeout does not prove the provider stopped executing it; consumers must not
automatically retry commands with side effects.

The broker limits each JSON value to 128 KiB, depth 32, 4,096 nodes and 64 KiB of
combined string/key bytes. Published state shares a 1 MiB budget across the broker. Calls have a
three-second response deadline and limits of 16 per consumer, 32 per provider and 128 overall.
Notifications retain only the latest revision for each subscribed dependency. These are resource
ceilings; they do not establish performance of the eventual default plugin set.

## DevTools

`devtools.status(pageId)`, `devtools.show(pageId, inspectAt?)` and `devtools.close(pageId)` require
`devtools.manage`, a profile-wide permission. All return `{ pageId, generation, instance, state }`;
opening and closing are asynchronous. `devtools.changed` reports lifecycle transitions. Showing an
existing inspector transfers cleanup ownership to the caller; scope exit or revocation closes its
owned windows. Explicit close can manage any inspector in the granted profile.

Read the [complete DevTools reference](../../docs/DEVTOOLS.md) for exact coordinates, limits, grants,
MCP equivalents, examples and verification boundaries. The [standalone plugin](../../apps/devtools-plugin/README.md)
uses this public API. Fresh V2 profiles bundle a separate default DevTools plugin. Docking and
frontend extensions remain open.

## Page content

`api.dom.snapshot`, `api.dom.click` and `api.dom.fill` expose bounded, origin-authorized content access.
Declare `pages.read` for snapshots and `pages.write` for actions. References belong to one activation
and expire or become stale after navigation; grant revocation is checked during operations. See the
[DOM API reference](../../docs/PLUGIN-DOM.md) for signatures, examples, errors and limits.

## Chrome-extension management

`api.extensions.list()` requires `extensions.read`; `api.extensions.remove(installationId)` requires
`extensions.manage`. Both return a bounded profile inventory containing reviewed manifest metadata
and installation state. Permission approval remains on the trusted Native surface.
`api.extensions.installation` requires `extensions.install` and supports bounded upload operations:
`begin`, `beginFile`, `append`, `finish`, `status`, `list`, `requestReview`, `cancel`, and
`pickLocal`.
`append` accepts a `Uint8Array`; callers never provide an owner, grant, or host path. Requesting a
review asks the trusted local surface to review permissions and never approves an installation.
`finish` validates asynchronously. Plugins with a declared and current `extensions.install` grant
receive a coalesced `extensions.installation.changed` `onEvent` callback with payload `{}`; call
`status` or `list` from that callback instead of polling with a timer. MCP has no event stream and
polls. `status` and `list` never emit this event, and receiving-upload expiry is reported only by a
later `status` call. The first eight methods retain their existing arguments. `pickLocal()` has no
arguments and asks a trusted local host to choose a package;
it fails safely when that picker is unavailable. Uploads allow 64 KiB chunks, 256 MiB files, 512 MiB
total, 10,000 entries, depth 64, and 4,096-byte relative paths. Real Native fixtures pass uploaded and locally selected packages through separate native approval,
binary-resource execution and removal using disposable profiles. Packaged application acceptance
remains open. This adapter is omitted in safe/raw-CDP or degraded mode.
Read the [extension API reference](../../docs/EXTENSIONS.md#public-inventory-and-removal) for MCP
equivalents, raw-CDP restrictions, revocation and recovery semantics, and the compiled Native fixture.

Configuration readers receive `onEvent("configuration.changed", {})` after durable configuration
changes in their profile, including changes made through MCP or settings import. An initial
invalidation covers changes during activation. Declare `configuration.read` and retain its live grant
(or use a granted `browser.full-control`); the legacy write-only read compatibility does not subscribe
to notifications. Read `api.configuration.get()` for the current value. Notifications carry no snapshot,
may coalesce, and do not require polling. Rendering failure after a durable write does not undo the
configuration change.

An independent management plugin can call
`api.plugins.replace(sourceId, targetId, expectedRevision)` with a live `plugins.manage` grant.
Read `api.plugins.snapshot()` under `plugins.read` to obtain the current revision. The source must
be enabled and running; the target must be distinct, installed and disabled. Replacement rewrites
composition ownership, route fallback and service bindings in one validated plan transaction,
retaining unrelated activations. A failed candidate restores the prior plan. Existing target grants
must already authorize its manifest; replacement does not issue grants. A stale revision requires
a fresh snapshot before retrying. `replaceSelf` retains its existing caller-bound behavior.
These methods are available to installed plugins, not developer directory launches.
