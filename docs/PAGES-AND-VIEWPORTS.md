# Pages, viewports and replaceable interfaces

The browser core does not prescribe tabs. A `BrowserPage` identifies a page and its profile,
URL, title, lifecycle and activity protections. A `BrowserViewport` binds a loaded page to a
presentation surface in the same profile. There is no global selected page or exclusive visible
page. Several viewports can bind different pages simultaneously.

`replaceViewportPage` changes a binding without navigating or replacing either page.
`detachViewport` removes the binding and retains the page. `closePage` is a separate lifecycle
operation and removes bindings to that page. Closed pages cannot be revived by a sleep request.
An interface must explicitly wake a sleeping page with `markPageUsed` before binding it.

These functions currently describe immutable state transitions. The trusted native host must
apply the corresponding engine operations and publish their outcomes. A successful pure state
transition does not establish that Chromium has loaded, resumed or rendered a page.

## The optional default interface

`@hitchhiker/default-interface` imports the public core types. Each interface instance owns its
profile, page order, pinned page IDs and selection. Sidebar/top placement is its own configuration.
Selection, pinning and reordering reject pages from another profile, closed pages and unknown IDs.
`reconcileInterface` removes stale references after page lifecycle events and chooses a remaining
page when the selected page closes. Sleeping pages remain in the interface.

Multiple interface instances can make different selections. A plugin can use these helpers, or
skip this package entirely and organize core pages as a canvas, graph, workspaces, splits, a
command interface, or a new model. Page identity and profile boundaries survive that choice.

## Host requirements that remain

- Keep page ownership separate from viewport ownership in the CEF adapter. Moving or detaching a
  viewport must not destroy the page's WebContents, navigation history or in-page state.
- Expose host commands and events through permission-checked public APIs used by Native UI,
  plugins and MCP. Raw CDP remains a separate grant.
- Protect every visible page from sleeping, as well as calls, audio, downloads, unsaved input and
  configured always-awake origins. Pinning alone is a presentation preference.
- Prove simultaneous live pages with Chrome extensions. The CEF Chrome-style BrowserView limit
  is unresolved; see `ENGINE-FEASIBILITY.md`. Core tests cannot validate that engine integration.
