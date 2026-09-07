# Composition example

This workspace builds three independent UI plugin artifacts:

- `split-layout` publishes the window layout and its `content` slot.
- `split-left` publishes the first available page into `content` as contribution `page`.
- `split-right` publishes the second available page into the same slot and contribution name.

The shared names are deliberate. The host namespaces keys, bindings, and viewport IDs by the configured
plugin contribution. [composition.json](./composition.json) fixes their order: `split-layout`, then
`split-left` and `split-right` in the `content` slot.

Build the artifacts after the repository dependencies have been built:

```sh
pnpm --filter @hitchhiker/composition-example build
```

Install each manifest and its matching `dist/layout.js`, `dist/left.js`, or `dist/right.js` separately
through `hitchhiker_plugin_install`, then grant each installed identity the capabilities it requests.
Copy `composition.json` to the profile-local path
`hitchhiker-plugins/composition.json` before startup. The recipe only arranges independently installed
and granted artifacts; copying it does not install code or grant a capability.

Composition still shares the existing maximum of four plugin workers. `--safe-mode` ignores the recipe.
A missing layout keeps the legacy plugin manager visible so it can be repaired without MCP.
Native emergency recovery can also restore that interface while this migration is in
progress. The default tabs/controller migration and generic plugin service dependencies are still
pending, so this example is a focused UI composition sample rather than a complete plugin browser.
