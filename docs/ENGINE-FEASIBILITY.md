# Native and Chromium integration evidence

Investigated 2026-09-05 against Native commit
`5665a355cae768dff734d79dd4c0bd9d099f83fb` and its pinned CEF
`144.0.6+g5f7e671+chromium-144.0.7559.59`.

## Finding

The stock integration cannot satisfy both native-rendered browser controls and existing Chrome
extensions. This is an engine architecture constraint, not a missing TypeScript wrapper.

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

## Decision requiring user input

Preserve both native UI and Chrome extensions through a downstream Chromium/CEF fork, or defer
Chrome-extension compatibility. The recommendation is a fork to preserve the accepted brief.
The user was asked this question; approval is pending. Do not silently substitute a web-rendered
shell, WKWebView, an old CEF build, or an unsandboxed browser.

## First fork acceptance, if selected

1. One window contains a Native-rendered sidebar and Chromium page with correct overlay hit
   testing, text input, accessibility, resizing, fullscreen, and extension popups.
2. Renderer/GPU helpers use Chromium sandboxing; no disabling switch is present.
3. Two profiles isolate cookies, storage, extensions and automation targets.
4. An unpacked Manifest V3 test extension proves content scripts, service worker, storage,
   declarative network rules, action popup and restart persistence.
5. A standard CDP client connects through the grant broker; a second profile remains inaccessible.
6. Repeated create/hide/destroy cycles show no unbounded renderer or surface allocation growth.

Keep an immutable external Chromium checkout and reviewed patch series; the Turborepo owns the
framework, interface, SDK, automation, docs, and build orchestration. This is substantial engine
work with ongoing upstream security-update maintenance.

## Toolchain evidence

- Installed `@native-sdk/cli@0.10.1`, reported commit `064ca98`, protocol `0x51f7889bbe3305e7`.
- Node 24.19.0 and pnpm 11.24.0 selected explicitly for validation.
- `native init work/native-probe` generated a temporary TypeScript + Native markup app.
- `native check work/native-probe` passed the subset and structural markup checks.
- `native build work/native-probe --yes` completed 18/18 build steps and produced a ReleaseFast
  executable. This proves the local toolchain, not Chromium embedding or a working browser.
- No existing personal browser profiles were opened or imported during the investigation.
