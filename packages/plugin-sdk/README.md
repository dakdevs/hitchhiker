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

Composition belongs to the manager's active Version 2 plan in `hitchhiker-plugins/plugins.json`.
Use `hitchhiker_plugin_stage` to install each new identity disabled, read `hitchhiker_plugin_plan`,
then pass its revision and the complete enabled/composition/serviceBindings candidate to
`hitchhiker_plugin_apply_plan`. The plan only arranges installed, granted artifacts; it does not
install code or issue grants. Legacy `composition.json` is read only during Version 1 migration. The host still runs at
most four workers, and `--safe-mode` ignores the recipe. During migration, native emergency recovery
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
UI composition live. A configured UI owner must be removed through a complete replacement plan;
disabling it alone is rejected. Failed switching restores the old plan, and failed rollback retains
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
`begin`, `beginFile`, `append`, `finish`, `status`, `list`, `requestReview`, and `cancel`.
`append` accepts a `Uint8Array`; callers never provide an owner, grant, or host path. Requesting a
review asks the trusted local surface to review permissions and never approves an installation.
`finish` validates asynchronously; poll `status(operationId)`. The eight methods are `begin`,
`beginFile`, `append`, `finish`, `status`, `list`, `requestReview`, and `cancel`. Uploads allow 64 KiB
chunks, 256 MiB files, 512 MiB total, 10,000 entries, depth 64, and 4,096-byte relative paths. Native
approval is under end-to-end validation and this adapter is omitted in safe/raw-CDP or degraded mode.
Read the [extension API reference](../../docs/EXTENSIONS.md#public-inventory-and-removal) for MCP
equivalents, raw-CDP restrictions, revocation and recovery semantics, and the compiled Native fixture.
