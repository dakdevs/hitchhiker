# Sidebar tabs

The September 6 Dia reference adds a compact pinned-tile grid above quiet, single-line tab rows,
with a rounded selected-row highlight and New Tab below. Keep the previously requested compact
macOS header. The default sidebar is 280 points wide; a surface renders at most thirty page
controls per slice, with six pinned tiles per row. Pinned pages are not duplicated in the ordinary
list. Selected pinned pages expose their full title and Unpin/Close controls; selected ordinary
pages expose icon-only Pin/Close controls. Other rows stay quiet.

The public UI package adds `listItem`, optional button `accessibilityLabel`, and ghost/secondary
variants. Native renders real list-item widgets with left alignment and ellipsis. List rows join
buttons and inputs as drag exclusions. Pinned tiles use hostname initials as a fallback; Chromium
favicon acquisition and image delivery are separate unfinished work. This packet does not add
favicon fetching or change Chromium permissions. Pinning remains presentation state and does not
protect a page from sleep.

A populated eleven-page preview exposed existing restore bugs. Pending pages were omitted from
persistence and the first created page could end restore prematurely. The restore loop also held
the model semaphore while awaiting host replies, starving lifecycle delivery until its bounded queue
overflowed. The controller now stages all metadata, preserves pending pages in persistence, defers
restore writes/redraws, and issues sequential host requests outside the model lock. Queue limits are
unchanged. A capacity-one portable event queue checks liveness; a real thirty-page native session
checks restored titles, selected page, pins and durable shutdown. Closing lifecycle events no longer
redraw an exiting host. The focused native fixture passes in
`work/sidebar-session-native-verified.log`.

Desktop inspection found that Native scroll children overlap unless their layout is explicit. The
sidebar now wraps its content in a column. The populated eleven-page preview visibly shows six
pinned tiles, compact rows, the selected white pill and New Tab. Each pinned tile uses a single
fallback initial so the compact native button does not truncate it. Full suite and relocated-bundle
evidence follows below.

Closing during restore can reject a pending open before an unload prompt cancels the close. The
host now returns dedicated `-32003` for that no-page-created case. Restore waits for a later close
cancellation and retries the same ID, or ends when the host exits cleanly. Other errors stay fatal.
Portable regressions cover cancellation/retry, ordinary failures and clean exit. Native page-open
and close operations share CEF's UI thread, preserving the closing guard's ordering.

Root owns native/runtime integration, preview, documentation and final verification. A worker owns
default UI composition and then the bounded controller restore fix. The earlier compact-header
baseline passed root checks, 192 native-enabled tests and the AppKit bitmap test; new sidebar and
restore evidence must be recorded separately. Physical dragging, fullscreen exit and edge resizing
are still not claimed verified.

The combined source passes root checks and all 200 native-enabled tests (100 runtime, 100 browser,
zero skips), including the thirty-page fixture and compact-window geometry. The AppKit bitmap
regression also passes. Evidence: `work/sidebar-verified-check.log`,
`work/sidebar-complete-native.log`, and `work/sidebar-complete-bitmap-test.log`. An older restore
fixture now waits for the document to load before checking its title; creating the logical tab does
not imply that Chromium finished navigation. The developer app was rebuilt and passes strict
signature/import verification after relocation to a temporary directory containing spaces.
All thirteen relocated developer-bundle checks pass without skips, including MCP plugin management,
extensions, navigation, native window geometry and the thirty-page restore. Evidence:
`work/sidebar-complete-bundle-{build,verify,native}.log`. This remains an ad hoc signed arm64
developer artifact; production signing/notarization and the remaining physical window checks are
separate unfinished work.
The final single-initial visual adjustment passes the default-interface suite and was inspected in
the populated native preview; the developer bundle was refreshed after that adjustment.
