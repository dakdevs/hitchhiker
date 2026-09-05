# @hitchhiker/core

Pure TypeScript domain contracts for Hitchhiker. It parses portable browser configuration, models
pages and viewports with memory-sleep candidates, describes scoped MCP/CDP grants, validates declarative plugin
proposals, and applies a deterministic plugin resource-budget policy.

It does **not** embed Chromium, execute plugins, inspect processes, or enforce permissions. Those
operations must remain in a trusted host integration, which is pending Native/CEF verification.

```ts
import { defaultConfiguration, openPage, selectPageEvictions } from "@hitchhiker/core";

const configuration = { ...defaultConfiguration, sleepAfterMs: 60_000 };
const state = openPage(
  { pages: [], viewports: [] },
  { id: "docs", profileId: "main", url: "hitchhiker.dev/docs", now: Date.now() },
);
if (state.ok) {
  const candidates = selectPageEvictions(state.value, configuration, Date.now(), 3);
}
```

Viewports bind a profile's pages independently. Detaching or replacing a viewport never destroys
or navigates its page; only an explicit page close removes its viewport bindings.

Use `parsePluginManifest` for the public, bounded native-component declaration shape. It is a
proposal format, not an executable plugin runtime contract.

`pages.list` and `pages.manage` cover metadata and lifecycle. `pages.read` and `pages.write`
cover page content and require an origin in the grant; `cdp.connect` remains a separate profile grant.
