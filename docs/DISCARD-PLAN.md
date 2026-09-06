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

This is a hypothesis, not an implemented or verified Hitchhiker capability. `chrome.tabs` working in
the extension fixture does not prove these CEF page windows have discardable tab lifecycle units.
WebContents replacement may invalidate the CEF browser/view and our page identity mapping.

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
