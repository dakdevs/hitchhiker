# @hitchhiker/default-interface

First-party sidebar/top-tab presentation state. It owns pins, ordering, and per-instance selection
by stable core page IDs. It has no authority to navigate pages or control Chromium.

Create one instance per interface with `createDefaultInterface(profileId)`. `selectPage`,
`setPagePinned` and `reorderPage` receive public core `BrowserState`, validate profile/lifecycle,
and return `Result<DefaultInterfaceState>`. Each instance can select a different page.

Call `reconcileInterface(browser, state)` on page lifecycle events to remove closed references
and select a remaining page. Sleeping pages remain presentable. Replacement interfaces can
ignore this package and use the public core pages and viewports directly.

`renderDefaultSurface` accepts `tabsVisible` for transient tab-list presentation. Hiding tabs
keeps the selected page and its viewport binding intact; dispatch `interface.tabs.toggle` through
the host broker to change that presentation state. The surface reserves the native window controls
with `windowControls` and marks only its empty `dragRegion` as draggable, so hosts retain their
own standard window controls rather than drawing replacements.

The sidebar presents pinned pages as bounded site-initial tiles and keeps regular pages in a
separate list. The selected pinned page gains a full-title detail row with its unpin and close
actions; a selected regular row exposes pin and close icon actions. Both presentations keep the
same page IDs, action strings, pagination limit, and viewport binding contract.
