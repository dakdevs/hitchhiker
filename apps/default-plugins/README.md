# Default feature plugins

These are real isolated Hitchhiker SDK plugins under construction. They are not yet bootstrapped
as the browser's default interface. Existing profiles continue to use the current interface until
live plan switching, management-screen routing, and profile migration are implemented.

Build with `pnpm --filter @hitchhiker/default-plugins build`. Each directory under `dist/default-*`
contains `hitchhiker.plugin.json` and `plugin.js`, the same package format accepted by public MCP
installation. `dist/sidebar` and `dist/top` contain composition and service recipes. Select one
presenter per recipe; the layout, tab model, optional pins, and presenter use four workers.

- `default-tab-model` owns selection, page ordering, and tab creation/closure.
- `default-tab-pins` independently owns pin state.
- `default-browser-layout` owns slot geometry.
- `default-sidebar-tabs` and `default-top-tabs` are separate presentation artifacts.

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

The presenters temporarily include navigation and address input while those features are being
extracted. Management screens and live switching between presenter packages remain cutover gates.
The existing public configuration read currently requires `configuration.write`; layout and
presenter manifests declare that requirement explicitly. This permission granularity remains a
framework limitation to address before default-profile bootstrap.
