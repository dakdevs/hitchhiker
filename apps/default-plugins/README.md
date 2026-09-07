# Default feature plugins

These are real isolated Hitchhiker SDK plugins. Fresh eligible profiles use the format 4 bundle;
the real Native startup seam passes with composed DevTools and extension controls and revocation cleanup using
a disposable mock-Keychain profile. Full application-entrypoint and physical UI acceptance remain
open. Existing V1/V2/V3 bootstrap journals and
customized profiles retain their existing plans and grants rather than receiving an automatic
cohort upgrade.

Build with `pnpm --filter @hitchhiker/default-plugins build`. Each directory under `dist/default-*`
contains `hitchhiker.plugin.json` and `plugin.js`, the same package format accepted by public MCP
installation. `dist/sidebar` and `dist/top` contain composition and service recipes. Select one
presenter per recipe; the layout, tab model, pins, presenter, DevTools toolbar, extension manager,
Settings and Plugins use eight workers. Nine artifacts are indexed because the other presenter is
installed disabled.

- `default-tab-model` owns selection, page ordering, and tab creation/closure.
- `default-tab-pins` independently owns pin state.
- `default-browser-layout` owns slot geometry.
- `default-sidebar-tabs` and `default-top-tabs` are separate presentation artifacts.
- `default-devtools` is a compact second toolbar contribution for the selected page's inspector.
- `default-extension-management` owns the Chrome extension installation and inventory route.

`default-settings` and `default-plugin-management` use public configuration and lifecycle APIs, own `main` and
`launcher` contributions, and refresh from `configuration.changed` and `plugins.changed` without
polling. Add their launchers to an ordinary slot and their main contributions to a route slot with
a required page fallback. Both contributions may be optional so disabling a plugin removes its UI.
Settings declares `ui.compose`, `configuration.read`, `configuration.write`, `plugins.read`, and
`plugins.manage`; Plugins omits `configuration.write`. Neither requires a default tab service.
They offer presenter switching only when a running default presenter has an installed, disabled
counterpart. Switching uses `plugins.replace`, then reopens the originating plugin's own route.
Fresh V4 profiles enable both; completed and pending older cohorts retain their original artifacts
and grants. The global installed-plugin admission bound is eight workers, including third-party plugins.

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

The presenters include navigation and address input. They publish only tabs, toolbar and page
content, with `configuration.read` for appearance. Settings and Plugins are independently removable
route owners. Settings updates color scheme and inactive-page sleep time; Plugins exposes bounded
lifecycle summaries and enable, disable, rollback, removal and presenter replacement. Back returns
to the selected live page. The new presenters have no configuration-write or plugin-management grant.
The host contains no Settings or Plugins feature policy. Further feature extraction remains open.

`default-devtools` requires the model and layout contracts. It uses `configuration.read` for theme,
`ui.compose` for its toolbar fragment, and profile-wide `devtools.manage` for the inspector. The
current service broker also requires a consumer to contain its provider's authority. Because the
model provider declares `pages.list`, `pages.manage`, and `storage.local`, the DevTools manifest and
grant include those capabilities solely to admit the model binding. The module does not call pages
or storage APIs and does not own page state.

The independently installable whole-surface example remains
[`devtools-workbench`](../devtools-plugin/README.md). It is distinct from the bundled compact
toolbar and keeps its own public manifest and grant.
