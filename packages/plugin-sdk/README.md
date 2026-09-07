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
[development instructions](../../docs/DEVELOPMENT.md). The built-in tabs/controller migration and
generic plugin services are still pending; do not assume every Chromium API or default-browser feature
is exposed by this SDK.
