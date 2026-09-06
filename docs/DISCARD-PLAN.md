# Renderer discard experiment

Current resource policy uses `Page.setWebLifecycleState` freezing. It stops inactive JavaScript work
but retains the document and does not establish lower renderer memory use. True discard remains a
required performance milestone.

## Candidate mechanism

The host explicitly uses `CEF_RUNTIME_STYLE_CHROME`, including each child page window. The pinned
public CEF 144 `CefBrowserHost` header has no discard entrypoint. Chromium's extension API is a
candidate: [`tabs.discard`](https://chromium.googlesource.com/chromium/src/+/cd1d73dd77daadf4581dc29ca73482fc241e079d/chrome/browser/extensions/api/tabs/tabs_api_non_android.cc)
delegates an explicit target to
[`TabManager::DiscardTabByExtension`](https://chromium.googlesource.com/chromium/src/+/cd1d73dd77daadf4581dc29ca73482fc241e079d/chrome/browser/resource_coordinator/tab_manager.cc).
Pinned Chromium's
[`TabLifecycleUnit`](https://chromium.googlesource.com/chromium/src/+/cd1d73dd77daadf4581dc29ca73482fc241e079d/chrome/browser/resource_coordinator/tab_lifecycle_unit.cc)
either discards the existing WebContents or replaces it with a renderer-free WebContents after copying
the navigation controller, depending on the `WebContentsDiscard` feature.

A disposable native experiment now verifies this route can discard a hidden Hitchhiker page. It is
not integrated into the resource scheduler. WebContents replacement changes Chromium identities and
requires explicit restoration work in the host and controller.

## Bounded native proof

Extend a disposable MV3 fixture to discard an explicitly selected fixture tab from its worker. Open
two real Chrome-style Hitchhiker page windows; hide the target and keep the other active. Record tab,
CEF browser, target, renderer process and logical page identities before and after the request.

Verify `tabs.get` reports discarded state, the document's renderer is released or its measured memory
falls, and selecting the logical page restores it. Verify back/forward history, title, cookies and
extension storage. Repeat with the target focused to discover rejection or immediate reload behavior.
Measure renderer/process memory separately from browser and GPU overhead, with repeated samples and
an unchanged fixture. Do not claim RAM reduction from a frozen timer or a disappearing CDP target.

Only after that proof select the host integration. Preserve all current protections: audio, calls,
downloads, unsaved input, visible viewports, active navigation, missing resource signals and raw-CDP
launch mode. A failed discard must retain the working page and interface. Do not automatically replace
Chromium discard with close-and-reopen: that loses the exact navigation/session state and requires an
explicitly documented product decision.

## Native evidence (2026-09-06)

Three corrected runs against a snapshot of the compiled `6385f23` runtime/browser artifacts used the
actual CEF host, a disposable profile, two pages and a local MV3 fixture. The target allocated a
64 MiB array with nonzero page touches. The test created real navigations to `initial`, `first` and
`second`, and set a cookie externally; the served document never constructed history or cookies.
This replaces an earlier exploratory fixture whose reload behavior could recreate that evidence.

In every run, `tabs.discard(oldId)` returned a different tab ID with `discarded: true`. Querying the new
ID reported `status: "unloaded"`; the old tab ID no longer existed. The Hitchhiker logical page ID
survived, while the CDP target changed. One renderer process disappeared. Summed renderer RSS from
`SystemInfo.getProcessInfo` and `ps`, restricted to that browser's renderer PIDs, changed as follows:

| Run | Before (KiB) | Discarded (KiB) | Reduction (KiB) |
| --- | -----------: | --------------: | --------------: |
| 1   |      642,080 |         312,640 |         329,440 |
| 2   |      642,096 |         312,608 |         329,488 |
| 3   |      642,064 |         312,592 |         329,472 |

These are immediate samples from one synthetic workload, not a general browser memory benchmark.
They exclude browser/GPU overhead. The reduction includes Chromium's document/process allocations,
not only the array.

Selection alone left the discarded page blank after one second. The host temporarily reported an
empty URL and no back history. Explicit `pages.reload` restored the same logical page and the new
Chromium tab identity. CDP navigation history retained the three exact URLs and current index;
entry IDs and transition metadata changed. Back navigation reached the actual `first` URL. The
externally set cookie and extension storage nonce survived. This proves the tested URL history and
storage behavior, not preservation of every possible navigation entry, POST body, or document state.

Root checked the three logs against those identities, history URLs/index, cookie and storage nonce.
Reproduction and logs are in ignored `work/native-discard-probe.ts`,
`work/native-discard-probe-round{1,2,3}.log`, and `work/native-discard-probe-snapshot.sha256`.
The experiment's page-message fixture is test plumbing; it must not become the production authority
channel. Focused-page discard, navigation races, repeated discard/restore in one session and all
resource protections remain unverified by this experiment.

## Integration work

Detect replacement without treating it as a new logical page. Preserve displayed URL/title and
navigation metadata while discarded; replace stale CEF/CDP identities and invalidate document-scoped
automation references. Restore the existing Chromium navigation controller on selection before
claiming the page is loaded. The trusted scheduler must enforce all existing protections before any
discard request and fail safely if identity or resource signals are uncertain. Select the authority
channel after mapping the host lifecycle; do not expose a privileged page-message bridge.

## Accepted packet order

First, prove callback ordering and a private worker channel in a disposable instrumented host. Record
CEF create/destroy/navigation/resource callbacks and browser identifiers through repeated discard and
reload in one process. Separately load a fixed-key MV3 worker with only the `tabs` permission and no
content scripts, host permissions, external messaging or web-accessible resources. Attach through the
private browser CDP pipe to the exact extension worker URL and invoke a fixed function with a bounded
integer tab identifier. Verify target identity checks and reattachment after worker suspension. This
proof must precede adopting the worker as a production resource-management channel.

Then fix externally initiated browser replacement independently of automatic discard. The native page
record needs a browser generation; replacing its browser must preserve the logical page, owning view
and window, rather than emit a second creation or a logical close. Fence old page CDP requests and
observers before emitting a replacement event. Subsequent CDP calls attach to the current browser.
The controller retains URL/title/interface state, clears stale resource knowledge, and restores the
Chromium navigation controller before binding a discarded page to any default or plugin viewport.
DOM references must invalidate on replacement. Test both callback orderings even if the native proof
only observes one, and keep failure recovery conservative.

Only after that correctness packet add automatic discard through a trusted bundled worker and typed
internal commands. Resolve logical page and expected generation to the current CEF identifier (which
CEF documents as the Chrome extension tab ID). Treat missing/ambiguous workers, identity changes and
sent requests without a definite outcome as uncertainty; stop new discards until reconciled. Never
substitute URL-only recreation. Recheck protection signals, current generation, active navigation and
visible bindings immediately before a request. Keep pinning in the interface model.

Do not load the internal worker in raw-CDP launches. Those launches continue to disable automatic
resource intervention. Ordinary user Chrome extensions can still replace/discard a page, so the
replacement correctness path must remain active independently of the internal worker. The worker
must not introduce any bridge accessible from web-page scripts.
