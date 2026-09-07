# @hitchhiker/plugin-sdk

Public TypeScript helpers for isolated Hitchhiker plugins. Use `definePlugin({ activate, onEvent })`
and bundle an entry point as an IIFE. The SDK turns typed `pages`, `configuration`, and `ui` calls
into capability-checked broker requests; it grants no ambient filesystem, network, or Node access.

## UI publishing

`ui.publish(surface)` is the legacy whole-window API. It accepts a Native component tree and page
bindings from `@hitchhiker/ui`; the host supplies the installed identity, measures viewport geometry,
enforces limits, and routes input only to the current owner. A profile that enables UI composition
rejects `ui.publish` so a worker cannot bypass the configured window layout.

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

Composition is enabled by the profile-local recipe at
`hitchhiker-plugins/composition.json`, loaded at startup. The recipe only arranges already installed
and granted plugin artifacts; copying it does not install code or issue grants. The host still runs at
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
manifest declares provided services or dependencies. Profile-local `hitchhiker-plugins/services.json`
binds dependencies independently of UI composition. It is read at startup and ignored in safe mode.
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
runnable cohort is admitted. Live recipe editing is not supported yet.

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
