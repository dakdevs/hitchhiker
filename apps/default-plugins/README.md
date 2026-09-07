# Default feature plugins

These are real isolated Hitchhiker SDK plugins. Fresh eligible profiles use the format 2 bundle;
the real Native startup seam passes with composed DevTools controls and revocation cleanup using
a disposable mock-Keychain profile. Full application-entrypoint and physical UI acceptance remain
open. Existing V1 bootstrap journals and
customized profiles retain their existing plans and grants rather than receiving an automatic
DevTools upgrade.

Build with `pnpm --filter @hitchhiker/default-plugins build`. Each directory under `dist/default-*`
contains `hitchhiker.plugin.json` and `plugin.js`, the same package format accepted by public MCP
installation. `dist/sidebar` and `dist/top` contain composition and service recipes. Select one
presenter per recipe; the layout, tab model, pins, presenter, and DevTools toolbar use five workers.

- `default-tab-model` owns selection, page ordering, and tab creation/closure.
- `default-tab-pins` independently owns pin state.
- `default-browser-layout` owns slot geometry.
- `default-sidebar-tabs` and `default-top-tabs` are separate presentation artifacts.
- `default-devtools` is a compact second toolbar contribution for the selected page's inspector.

Service contracts live in `contracts/`. The build checks them against executable schemas and hashes
the exact published bytes into provider and consumer manifests. Replacement plugins can implement
those same contracts. The host validates identity and bounds without knowing tab schemas.

At build time `compile-schemas.mjs` converts the trusted Effect schemas used by the isolated
plugins into standalone `@exodus/schemasafe` validators. The browser bundles therefore do not
ship Effect or evaluate schemas at runtime. Every distributed plugin directory includes
`SCHEMASAFE-LICENSE`, and `plugin.js` retains a short MIT notice for that generated validator code.

The model and pins use public `pages.watch`, service state, and owner-bound `storage.local` APIs.
Page snapshots restart at most three times on `stale-snapshot`; storage retries only on `conflict`.
These defaults support at most 128 open pages, independently of alternate plugins' policies.

The presenters include navigation, address input, and Native Settings and Plugins route
contributions. These routes replace the content contribution without binding a page viewport; Back
returns to the selected page. Settings reads and updates color scheme and inactive-page sleep time.
Plugins shows bounded public lifecycle summaries and can enable, disable, roll back, remove, or
switch to the alternate presenter through the owner-bound management API. The layout declares only
`configuration.read`; presenters retain `configuration.write` for Settings and also declare
`configuration.read`, `plugins.read`, and `plugins.manage`.

These management screens are shared presenter modules, not separately installed route plugins.
The host contains no Settings or Plugins route policy. Normal startup cutover, remaining feature
extraction and Native public-action switching/shutdown verification are still outstanding.

`default-devtools` requires the model and layout contracts. It uses `configuration.read` for theme,
`ui.compose` for its toolbar fragment, and profile-wide `devtools.manage` for the inspector. The
current service broker also requires a consumer to contain its provider's authority. Because the
model provider declares `pages.list`, `pages.manage`, and `storage.local`, the DevTools manifest and
grant include those capabilities solely to admit the model binding. The module does not call pages
or storage APIs and does not own page state.

The independently installable whole-surface example remains
[`devtools-workbench`](../devtools-plugin/README.md). It is distinct from the bundled compact
toolbar and keeps its own public manifest and grant.
