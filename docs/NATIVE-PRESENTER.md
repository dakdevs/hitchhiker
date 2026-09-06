# Native presentation and developer packaging

This document records a future implementation boundary. Metal presentation is intentionally not
implemented in the current checkpoint. The evidence below was checked against Native commit
`5665a355cae768dff734d79dd4c0bd9d099f83fb`; Native paths are relative to that checkout.

## Current presentation

Hitchhiker currently drives Native through the mobile embed ABI. `apps/host-probe/src/native_sidebar.mm`
calls `native_sdk_app_frame` from a 30 Hz timer, asks `native_sdk_app_render_pixels_damage` for the
retained CPU buffer, and uploads changed pixels through `NSBitmapImageRep`. It uses the actual macOS
backing scale, reuses bounded storage, skips unchanged revisions, and preserves the required ordering:

1. update the viewport;
2. run `native_sdk_app_frame`;
3. call `hitchhiker_after_frame`;
4. drain commands, events, viewport projections, and text state.

The third step releases the prior parsed interface tree only after Native completes its retained-widget
arena swap. `apps/host-probe/native/src/runtime_surface.zig` rejects a second overlapping commit until
that release. A future presenter must preserve this lifetime rule.

Native's existing macOS presenter is Metal-backed but is not generally a GPU-only renderer.
`src/platform/macos/appkit_host.m` creates `NativeSdkMetalSurfaceView` with a `CAMetalLayer`, Metal
device, queue, and retained texture. The default packet path decodes and rasterizes commands into a
retained CPU bitmap, uploads the full or damaged region to a shared Metal texture, and uses Metal for
the final drawable presentation. `NATIVE_SDK_GPU_COMPOSITE=1` selects an experimental command
compositor only on unified-memory devices. Therefore the narrow future milestone is **Metal-backed
presentation with Native's existing CPU packet rasterizer**. Zero-copy or zero-CPU-raster rendering is
a separate renderer project and must not be claimed by this milestone.

## Why the desktop platform cannot be embedded directly

The embed host creates a `NullPlatform`, enables GPU surfaces, disables packet delivery, and installs a
pixel-capture bridge in `src/embed/ui_host.zig` and `src/embed/host.zig`. Native's desktop macOS service
table in `src/platform/macos/root.zig` already exposes frame requests, input notification, pixel and
packet presentation, image upload, font registration, accessibility, and scroll drivers. Its C entries
are declared in `src/platform/macos/appkit_host.h`.

Those C entries locate a view by `(window_id, label)` inside `NativeSdkAppKitHost`. Constructing the
desktop `MacPlatform` would also create Native-owned windows and participate in the application event
loop. CEF already owns Hitchhiker's window and helper lifecycle, so that is the wrong ownership
boundary. `adoptViewSurface` solves the reverse problem: it adopts an app-owned view into a
Native-owned container.

## Minimal future SDK seam

Add one generic embed service and one macOS presenter object. Do not copy the packet protocol into
Hitchhiker.

1. Add an extern `MobileGpuSurfaceService` callback table in `src/embed/types.zig`. It should carry a
   copied table plus a borrowed context and callbacks for request-frame, note-input, pixel presentation
   with damage, JSON packet presentation, binary packet presentation, image upload/removal, and font
   registration/unregistration with the ownership token.
2. Export `native_sdk_app_set_gpu_surface_service` from `src/embed/c_api.zig` and
   `build/app.zig::mobile_export_symbol_names`. Store and bridge it in `src/embed/host.zig`, following
   the existing audio-service pattern. Registration is valid before `native_sdk_app_start`; the table
   and context remain alive through app destruction.
3. Extend `installPresentCapture` instead of bypassing it. Preserve the NullPlatform diagnostic
   recorders, call the external presenter first, and advance diagnostics only after presentation is
   accepted. A refusal must not advance either retained baseline.
4. Expose an opaque, main-thread-only macOS presenter in a small public header and Objective-C
   implementation. It creates a presentation-only child `NSView` in a caller-owned superview and
   reuses `NativeSdkMetalSurfaceView`'s packet decoder, retained generations, image store, font
   resolver, dirty texture uploads, Retina sizing, occlusion handling, and frame scheduler. Replace
   the renderer's hard dependency on `NativeSdkAppKitHost` with a narrow frame-ready/resize/image sink;
   do not create an `NSWindow` or run `NSApp`.
5. Register this presenter before starting the Hitchhiker app, then remove the bitmap, raster buffer,
   `drawRect`, and repeating timer. Keep Hitchhiker's current input, IME, and accessibility routing for
   this first presentation-only change.

Callback payloads are borrowed only for the synchronous call. The presenter must decode or copy them
before returning success; Metal completion may remain asynchronous. Packet results retain the desktop
contract: `1` accepted, `0` refused/`UnsupportedService`, and `-1` missing view. A refused patch causes
the runtime to send a keyed full packet in the same frame; a refused full binary packet negotiates to
JSON and then a full pixel fallback. Raw pixels, size/scale changes, and presenter replacement
invalidate packet-retained state. Never report success for partially adopted state.

The presenter's coalesced scheduler must be the only frame channel. Runtime requests, commits, input,
resize, de-occlusion, and GPU completion arm one asynchronous main-queue tick. They never re-enter the
runtime synchronously and never create separate completion and request loops. Idle content has no
timer. Occluded content uses the existing logical heartbeat and avoids `nextDrawable` after the first
present. The first-present exception under a locked or fully covered session still needs measured
stall testing.

Teardown cancels queued ticks and input monitoring, stops the app, destroys it while the callback
context and font service are still alive, and only then removes the presenter. Use the embed ABI's
destruction status: if Native reports an abandoned callback, preserve every reachable callback object
for process lifetime as required by its existing safety contract.

The pinned-source guard in `apps/host-probe/scripts/build.mjs` rejects a dirty Native checkout. A
future patch must be a reviewed, clean, pinned Native fork commit, with the expected SHA updated, or be
applied to an isolated copied checkout before validation. Do not make the documented pinned checkout
silently dirty.

## Presenter acceptance

- Unit tests cover table copying, registration timing, borrowed-buffer lifetime, teardown callbacks,
  and no callback after a safe destroy.
- Force binary patch refusal and observe same-frame full retry. Force full-binary refusal and observe
  JSON, then pixel fallback. A raw-pixel fallback makes the next packet full.
- Compare packet and CPU-reference output at 1x and 2x for text, icons, alpha, scrolling, resizing,
  and scale changes. Run `NATIVE_SDK_GPU_VERIFY_INCREMENTAL=1`; use
  `NATIVE_SDK_GPU_COMPARE=1` only for the experimental compositor.
- Normal diagnostics identify the Metal backend and packet path. A small edit reaches patch mode with
  no ordinary fallback; retained state resynchronizes after resize or presenter recreation.
- Idle CPU shows no 30 Hz wakeups. Animated delivery does not exceed display refresh and does not
  approach the previously measured roughly 240 Hz dual-producer loop.
- Repeat app/presenter creation and destruction, 250 changing Native commits, the 100 layout swaps,
  12-page lifecycle cycle, fullscreen/display changes, occlusion, and locked-session launch under
  Metal validation and memory diagnostics.
- Re-run pointer, scroll, focus, keyboard, Unicode/IME, accessibility, CEF composition, and clean-close
  checks because adding a child view changes AppKit hit testing and responder topology.

## Standalone macOS developer bundle

`pnpm bundle:macos` now produces an unsigned/developer Apple Silicon bundle at
`work/package/Hitchhiker Developer/Hitchhiker.app`:

```text
Hitchhiker.app/Contents/
  MacOS/Hitchhiker                         native launcher and CFBundleExecutable
  MacOS/hitchhiker-probe                   CEF engine
  Frameworks/                              CEF framework and five helper apps
  Helpers/PluginHost.app/                  client, PluginBroker.xpc, and worker
  Helpers/node                             official Node 24.19.0 arm64 executable
  Resources/controller/                    compiled browser and production graph
  Resources/licenses/                      Node, CEF, Native, and project notices
  Resources/build-manifest.json            pinned build inputs and source state
```

The CEF engine must live in the outer application bundle. Embedding the complete CEF main app below
`Contents/Helpers` passed static signature checks but trapped in `cef_initialize` during bundle
lookup. The same payload ran when copied out as a standalone app. The implemented layout makes the
outer Hitchhiker app own CEF's standard `Frameworks` and `Resources` directories and places the native
launcher and engine beside each other in `Contents/MacOS`. The launcher's paths remain relative to its
own bundle, and it sets absolute `HITCHHIKER_NATIVE_BINARY` and `HITCHHIKER_PLUGIN_HOST` values before
executing the bundled controller with bundled Node.

`apps/browser/packaging/bundle-macos.mjs` downloads and verifies the official Node 24.19.0 archive,
requires Native commit `5665a355cae768dff734d79dd4c0bd9d099f83fb` from a clean checkout, checks CEF
`144.0.6+g5f7e671+chromium-144.0.7559.59` and its sandbox-enabled CMake configuration, and builds the
native helpers. It copies the workspace into `work/package-staging`, performs the frozen production
install, TypeScript build, and pnpm deployment there, then rejects any controller symlink that escapes
the staged package. This isolation is required: running pnpm production deployment against the
working checkout changes `.pnpm-workspace-state-v1.json` to production mode and can break later
development commands. The final build preserved that file's SHA-256 and modification time.

Repeated CEF post-build copies can accumulate self-referential framework links. Packaging reconstructs
the versioned framework from the pinned release, rewrites helper bundle identities, signs CEF Mach-O
files and nested bundles from the inside out, preserves the existing PluginHost/XPC signature, preserves
the official Node signature and V8 entitlements, signs the launcher, and signs the outer app last.
Verification checks strict signatures, Node's version, the pinned input manifest, controller module
loading, launcher help, and bundle-contained symlinks. A sibling `Hitchhiker.app.manifest.json` records
final file hashes and symlink targets.

Build and verify from the repository root:

```sh
NATIVE_SDK_SOURCE=/absolute/path/to/native-at-5665a355 \
  pnpm bundle:macos

node apps/browser/packaging/bundle-macos.mjs --verify-only \
  --output="$PWD/work/package/Hitchhiker Developer/Hitchhiker.app"
```

The final checkpoint was copied to `/tmp/Hitchhiker Final Bundle.Sgb47d/Hitchhiker.app`. This exact
relocated copy passed strict verification and `--help`; `packages/runtime/test/native-plugin-management.test.ts`
then passed 2/2 through its bundled launcher, covering install, update, rollback, disable/enable,
restart with preserved pages, grant revocation, and corrupt-store safe-mode recovery. Commands and
complete output are recorded in:

- `work/publish-macos-bundle-verify.log`
- `work/publish-macos-bundle-management.log`

The management command set `HITCHHIKER_BROWSER_LAUNCHER` to the relocated launcher. Its source-tree
native and PluginHost variables only satisfy the test's native gate; the launcher overwrites both with
paths from the copied app.

This 490 MiB result is an ad hoc signed developer artifact for arm64 macOS 14 or later. The CEF sandbox
remains enabled. It is not Developer-ID signed, notarized, stapled, universal, update-enabled, or proven
on a clean network-disabled Mac. Finder launch, locked-session launch, and a full dependency audit on a
second machine remain release acceptance work. Distribution signing must determine and test the minimum
Node/V8 entitlements instead of copying the upstream development entitlements unchanged.
