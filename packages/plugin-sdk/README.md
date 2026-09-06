# @hitchhiker/plugin-sdk

Public TypeScript helpers for isolated Hitchhiker plugins. Use `definePlugin({ activate, onEvent })`
and bundle your entry point as an IIFE. The SDK turns typed `pages`, `configuration`, and `ui` calls
into capability-checked broker requests; it grants no ambient filesystem, network, or Node access.

`ui.publish` accepts the Native component tree and page bindings from `@hitchhiker/ui`. It can replace
the whole interface. The host supplies the installed identity, measures viewport geometry, enforces
limits, and routes input only to the current owner.

See [the runnable canvas example](../../apps/canvas-plugin/src/index.ts) and
[development instructions](../../docs/DEVELOPMENT.md). API coverage and package management are still
under development; do not assume every Chromium API is exposed by this initial SDK.
