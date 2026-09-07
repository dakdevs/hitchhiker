# Compact native window header

The user supplied a Codex screenshot and requested content reaching the top edge, with standard
macOS traffic lights followed by sidebar, back and forward icons. Retain system close/minimize/zoom,
resizing, fullscreen and a meaningful hidden window title.

Use the pinned CEF root window delegate's `IsFrameless`, `WithStandardWindowButtons` and
`GetTitlebarHeight` (36 points). Page child windows remain Chrome-runtime windows and request zero titlebar height. The
public UI package reserves 80 leading points for system buttons and provides accessible icon-only
buttons plus empty `drag-region` leaves. Default sidebar and main toolbar share the 36-point top row;
collapsed/sidebar/top-tab presentations retain the same page and viewport identity. Custom interfaces
use the same public controls reserve and drag building blocks.

Native measures drag leaves and subtracts button/input/viewport regions before calling CEF's
`SetDraggableRegions`. The overlaid AppKit view and local event monitor must pass those empty regions
and actual standard-button bounds to the underlying window instead of swallowing them. Measured
standard-button bounds are final drag exclusions. Approved drag presses start AppKit
`performWindowDragWithEvent:` directly; Apple documents this as an asynchronous Window Server drag. Do not draw
fake traffic lights or let drag regions intercept real controls.

Root owns host/runtime/controller integration and exclusive native builds. A separate worker owns
public UI/default-interface/canvas changes. Verify schema boundaries, preserved page bindings after
tab-list toggling, actual window geometry and native controls, resize/fullscreen, dragging and ordinary
control clicks, then repeat the native and relocated-bundle checks. Physical interaction is only
claimed after observing it in an unlocked desktop session. The header change is not fully verified; the remaining physical checks are listed below.

During desktop verification, real presses updated Native layout and emitted the correct actions but
AppKit kept drawing the first bitmap. A headless AppKit reproduction confirmed that an
`NSBitmapImageRep` wrapping externally mutated bytes caches its drawn image. The host now replaces
only that representation after nonzero damage while retaining the pixel allocation; idle ticks do
not rewrap it. `raster_bitmap_test` checks real red/blue drawing after external-buffer mutation.

Desktop evidence: sidebar collapse/expansion updates visibly after the raster fix; native minimize
hides the window, and green enters fullscreen. Drag events reach the approved region, but the
automated gesture has not demonstrated window movement. Fullscreen exit, physical dragging and
edge resizing remain manual verification items; do not describe those as tested. Temporary event
tracing used to isolate the raster issue is removed from the final build.

AppKit drag contract: https://developer.apple.com/documentation/appkit/nswindow/performdrag(with:)

Portable root checks pass. Native host builds with the pinned CEF/Native SDK. The focused native
window test checks full-window content bounds, the three visible system controls, preserved page
bindings across collapse/expand, trusted settings chrome, and final control exclusions inside custom
drag regions. All 192 native-enabled tests pass (99 runtime, 93 browser, no skips), and the Release AppKit bitmap
test passes with assertions enabled. Evidence: `work/compact-window-root-final.log`,
`work/compact-window-native-final.log`, and `work/compact-window-bitmap-{build,test}.log`.
The subsequent sidebar packet passes 200 native-enabled tests and thirteen relocated developer-bundle
checks; see [SIDEBAR-TABS-PLAN.md](SIDEBAR-TABS-PLAN.md) for the combined verification evidence.
