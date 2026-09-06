# Native and Chromium integration evidence

Investigated 2026-09-05 against Native commit
`5665a355cae768dff734d79dd4c0bd9d099f83fb` and its pinned CEF
`144.0.6+g5f7e671+chromium-144.0.7559.59`.

## Finding

The existing Native CEF host cannot satisfy both native-rendered browser controls and existing
Chrome extensions. That does **not** establish that a full Chromium fork is required. The user
clarified the intended separation: Chromium renders page content; Native renders the surrounding
browser interface; an event/command bridge connects Chromium, the trusted core and plugins.
OS window ownership is an implementation detail, not a requirement that Native own the NSWindow.

Native's macOS `cef_host.mm` embeds page views using `CefWindowInfo::SetAsChild`.
The [pinned CEF macOS header](https://raw.githubusercontent.com/chromiumembedded/cef/5f7e671/include/internal/cef_types_mac.h)
specifies that a supplied `parent_view` forces Alloy runtime style. CEF's
[M128 migration record](https://github.com/chromiumembedded/cef/issues/3685) records the removal
of Alloy extension APIs; Chrome extensions require Chrome-style windows. The
[pinned request-context header](https://raw.githubusercontent.com/chromiumembedded/cef/5f7e671/include/cef_request_context.h)
does not have the older `LoadExtension` API. Examples based on CEF 119 are not applicable.

Native also explicitly lacks native child-view and GPU-surface composition in its CEF backend.
Its [web-engine documentation](https://native-sdk.dev/docs/web-engines) records this limitation.
Porting its AppKit/Metal rendering to the CEF host would enable native UI composition, but would
not restore Chrome extensions in Alloy mode.

## Additional host work

- The current host sets `CefSettings.no_sandbox = true` and launches subprocesses through the main
  executable. The browser needs properly initialized sandboxed helper applications and bundle
  layout following [CEF's macOS application guidance](https://chromiumembedded.github.io/cef/general_usage.html).
- The current cache is shared at `Application Support/native-sdk/CEF/Default`. Hitchhiker needs
  its own root and explicit isolated profile contexts.
- The host has no implemented CDP configuration or permission broker. Merely writing a token next
  to a raw debugging port would not authenticate CDP. Access must actually pass through an
  authenticated grant broker, with its scope enforced against the debug targets.
- Live plugins require an isolated runtime and bounded public native-component protocol; Native
  TypeScript cores and release markup compile ahead of time.

## Alternate host composition to prove

The previous fork-or-defer-extensions question was premature. First test a Chrome-style CEF-owned
window with Native rendering in a reserved sidebar/topbar region. Both product requirements remain.

CEF exposes [CefWindow::GetWindowHandle](https://raw.githubusercontent.com/chromiumembedded/cef/5f7e671/include/views/cef_window.h),
whose macOS type is NSView*. Its [own sample](https://raw.githubusercontent.com/chromiumembedded/cef/5f7e671/tests/cefclient/browser/views_window_mac.mm)
uses that view to access the NSWindow. Chrome-style BrowserView can omit the standard toolbar via
`CEF_CTT_NONE`. Native's `EmbeddedApp` and `UiAppHost` support a host-owned event loop and render/input
boundary, providing a candidate integration path that does not use `SetAsChild`.

This is a plausible prototype, not verified production support. A Native NSView lies outside CEF's
Views layout/focus management; [CEF's Views design discussion](https://github.com/chromiumembedded/cef/issues/1749)
identifies native-widget integration risks. Keep page and Native regions disjoint for the first test.

The [pinned runtime contract](https://raw.githubusercontent.com/chromiumembedded/cef/5f7e671/include/internal/cef_types_runtime.h)
also limits a Chrome-style window to one Chrome-style BrowserView. Multiple live tabs therefore
still need a browser-host/tab-model adapter, potentially a maintained CEF patch. Do not simulate
tab support by silently destroying inactive pages or discarding their state. Scope any engine
changes from prototype evidence rather than assuming a whole Chromium fork upfront.

## First host acceptance

1. One window contains a Native-rendered sidebar and Chromium page with correct overlay hit
   testing, text input, accessibility, resizing, fullscreen, and extension popups.
2. Renderer/GPU helpers use Chromium sandboxing; no disabling switch is present.
3. Two profiles isolate cookies, storage, extensions and automation targets.
4. An unpacked Manifest V3 test extension proves content scripts, service worker, storage,
   declarative network rules, action popup and restart persistence.
5. A standard CDP client connects through the grant broker; a second profile remains inaccessible.
6. Repeated create/hide/destroy cycles show no unbounded renderer or surface allocation growth.

The Turborepo owns the framework, Native interface, SDK, automation, docs and host build. Pin
upstream dependencies. If a CEF patch is necessary, maintain a narrow reviewed patch series and
record its upstream update cost; a full Chromium checkout is not yet selected or approved.

## Toolchain evidence

- Installed `@native-sdk/cli@0.10.1`, reported commit `064ca98`, protocol `0x51f7889bbe3305e7`.
- Node 24.19.0 and pnpm 11.24.0 selected explicitly for validation.
- `native init work/native-probe` generated a temporary TypeScript + Native markup app.
- `native check work/native-probe` passed the subset and structural markup checks.
- `native build work/native-probe --yes` completed 18/18 build steps and produced a ReleaseFast
  executable. This proves the local toolchain, not Chromium embedding or a working browser.
- No existing personal browser profiles were opened or imported during the investigation.
- Follow-up: Native's prepared CEF 144 archive returned HTTP 404. The official pinned 252 MB CEF
  distribution downloaded and extracted into ignored `work/cef`. Installed CMake 4.4.3 into an
  ignored local Python environment (`work/build-tools`); the official CEF wrapper and macOS
  `cefsimple.app`, including its helper bundles, compiled successfully with `USE_SANDBOX=ON`,
  `PROJECT_ARCH=arm64` and `CMAKE_BUILD_TYPE=Release`. This proves build capability, not runtime
  sandbox operation, Native composition, extensions or multi-page behavior.

## Saved integration experiment

`apps/host-probe` contains the pinned CEF sample adaptation, Native `UiAppHost` surface, and
repeatable build script. The explicit `build:native` command completed successfully and produced
`work/host-probe/build/Release/hitchhiker-probe.app`. Startup printed `HITCHHIKER_NATIVE_MOUNT`;
renderer and GPU helper processes used the dedicated probe profile and seatbelt launch arguments.
Those arguments do not by themselves establish complete runtime sandbox validation.

The initial single-page experiment passed desktop verification: Native button input navigated
Chromium to a local fixture, the title event updated Native, typed text survived window zoom and
restore, and closing the window exited cleanly. The check found and corrected bitmap inversion and
Native mouse-event routing through the CEF-owned window.

### Multiple live pages

The current adapter reserves the root for Native UI and creates one frameless CEF-owned child window
per page, using `CefWindowDelegate::GetParentWindow`. Each child owns one Chrome BrowserView and shares
the dedicated probe request context. The host maps stable page IDs to validated, nonoverlapping
rectangles; omitted pages are hidden without destroying their documents. Sidebar selection and a
split are presentations over the same page identities.

The [pinned CEF window implementation](https://raw.githubusercontent.com/chromiumembedded/cef/5f7e671/libcef/browser/views/window_view.cc)
and [Chromium macOS window bridge](https://chromium.googlesource.com/chromium/src/+/refs/tags/144.0.7559.59/components/remote_cocoa/app_shim/native_widget_ns_window_bridge.mm)
provide this public parent-child window path. It avoids Native's Alloy-only `SetAsChild` integration.
It does not remove CEF's one-BrowserView-per-Chrome-window limit: extensions see a distinct Chrome
window for each Hitchhiker page. Full same-window Chrome tab/group semantics remain unresolved.

The in-process DevTools test passed 100 alternating single/split viewport changes. Both pages retained
distinct document nonces, input text and counters, including after 12 temporary-page create/close
cycles that waited for both browser and window teardown. A dedicated unpacked MV3 extension on both local
fixtures exchanged messages with its service worker and accessed extension storage. Shutdown drained
both pages, a requested local popup and the shell, returning exit code zero. This proves those tested extension APIs only;
action popups, declarative network rules, restart persistence and third-party compatibility remain open.

Multi-page visual layout, first-click focus and fullscreen behavior still require desktop verification;
the Mac locked again before those checks. The probe uses a 30 Hz CPU reference renderer with mouse
input only. GPU composition, complete input/accessibility, production sandbox validation, multiple
profiles, authenticated MCP/CDP, plugin enforcement and performance measurements remain open.
Startup reported unavailable password encryption; no credentials or personal profile were used.

Build follow-up: parallel Make waited after linking while its stack was blocked in `read`.
Building the wrapper in parallel and the final macOS resource/bundle target serially completed
without that wait. The script now uses this split; final native compilation and bundle validation
passed after the source review fixes.
