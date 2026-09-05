# @hitchhiker/default-interface

First-party sidebar/top-tab presentation state. It owns pins, ordering, and per-instance selection
by stable core page IDs. It has no authority to navigate pages or control Chromium.

Create one instance per interface with `createDefaultInterface(profileId)`. `selectPage`,
`setPagePinned` and `reorderPage` receive public core `BrowserState`, validate profile/lifecycle,
and return `Result<DefaultInterfaceState>`. Each instance can select a different page.

Call `reconcileInterface(browser, state)` on page lifecycle events to remove closed references
and select a remaining page. Sleeping pages remain presentable. Replacement interfaces can
ignore this package and use the public core pages and viewports directly.
