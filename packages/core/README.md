# @hitchhiker/core

Pure TypeScript domain contracts for Hitchhiker. It parses portable browser configuration, models
tabs and memory-sleep candidates, describes scoped MCP/CDP grants, validates declarative plugin
proposals, and applies a deterministic plugin resource-budget policy.

It does **not** embed Chromium, execute plugins, inspect processes, or enforce permissions. Those
operations must remain in a trusted host integration, which is pending Native/CEF verification.

```ts
import { defaultConfiguration, openTab, selectEvictions } from "@hitchhiker/core";

const configuration = { ...defaultConfiguration, sleepAfterMs: 60_000 };
const state = openTab({ tabs: [] }, { id: "docs", url: "hitchhiker.dev/docs", now: Date.now() });
if (state.ok) {
  const candidates = selectEvictions(state.value, configuration, Date.now(), 3);
}
```

`closeTab(state, id, now)` keeps a valid selected tab: when closing the active tab it wakes and
selects the next tab, or the previous tab when no next tab exists.

Use `parsePluginManifest` for the public, bounded native-component declaration shape. It is a
proposal format, not an executable plugin runtime contract.
