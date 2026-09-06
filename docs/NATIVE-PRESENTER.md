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

The current components can be staged into a developer bundle without implementing Metal:

```text
Hitchhiker.app/Contents/
  MacOS/Hitchhiker                         small native launcher
  Helpers/Hitchhiker Engine.app/           complete CEF host and its five helper apps
  Helpers/PluginHost.app/                  client plus PluginBroker.xpc and worker
  Helpers/node                             Node 24.19.0 arm64 executable
  Resources/controller/                    compiled browser and production module graph
  Resources/licenses/                      Node, CEF, Native, and project notices
```

The launcher resolves paths relative to its own bundle, sets absolute
`HITCHHIKER_NATIVE_BINARY` and `HITCHHIKER_PLUGIN_HOST` values, and starts bundled Node with the
compiled `apps/browser/dist/main.js`. It forwards arguments and termination and returns the controller
exit status. Profile data remains outside the signed bundle under Application Support. A script as
`CFBundleExecutable` is unsuitable for the signed path; use a small Mach-O launcher.

Build all TypeScript packages from a clean checkout with the exact lockfile before staging. The
compiled browser still imports `@hitchhiker/*`, `effect`, `@effect/platform-node`, and `ws`; copying
only `dist/main.js` cannot work. Produce a pnpm 11.24.0 production deployment from the workspace
lockfile, or deliberately bundle the controller, then allowlist the resulting files. The present
workspace's generated `apps/browser/dist/main.js` predates current MCP/plugin source and is not a
packaging input until rebuilt. No compiler, pnpm store, tests, TypeScript sources, or developer-only
packages should be required at runtime.

Use the official `node-v24.19.0-darwin-arm64.tar.xz`, SHA-256
`3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94`, from the
[Node 24.19.0 release directory](https://nodejs.org/download/release/v24.19.0/). Inspection confirmed
`v24.19.0`, an arm64 Mach-O, and only system CoreFoundation, Security, libc++, and libSystem dynamic
dependencies. Runtime staging needs the approximately 116 MiB `bin/node` and Node `LICENSE`, not the
archive's headers, npm tree, or development libraries.

The upstream Node binary is Developer-ID signed with hardened runtime and several V8/development
entitlements, including JIT, unsigned executable memory, disabled library validation, dyld environment
variables, and `get-task-allow`. Preserve its signature for the first local developer bundle. A later
distribution signing pass must determine and test the minimum V8 entitlements; blindly re-signing it
without JIT allowances can break Node, while carrying the upstream development entitlements into a
notarized release is not an accepted policy.

Keep both nested app structures intact. The CEF artifact already contains the framework, resource
packs, libraries, and five helper apps. The PluginHost build correctly signs worker, XPC service, and
outer app in deepest-first order and passes strict verification. Its effective deployment floor makes
the current combined bundle Apple Silicon macOS 14 or later.

The current CEF app is only linker/ad-hoc signed; `codesign --verify --deep --strict` fails because its
resources are unsealed. A packaging step must give the engine and helpers stable Hitchhiker bundle IDs,
then explicitly sign nested dylibs/frameworks, helper executables/apps, the engine, PluginHost nested
code, the launcher, and the outer app from deepest to outermost. Do not use `codesign --deep` as the
signing algorithm; retain it only as one verification check. Developer packaging may use an ad-hoc
identity without a timestamp. Developer-ID signing, notarization, stapling, update signing, universal
binaries, and byte-for-byte reproducibility of timestamped signatures remain separate release work and
require the owner's identity.

## Developer-bundle acceptance

- A clean, network-disabled machine launches the copied `.app` without repository, pnpm, Zig, CMake,
  Xcode, or a system Node installation.
- The staged Node reports exactly 24.19.0 and every non-system Mach-O dependency resolves inside its
  owning bundle. A manifest records source revisions, archive checksums, lockfile hash, file hashes,
  architectures, deployment targets, and signing mode.
- Strict verification passes for PluginHost, CEF helpers/framework/app, launcher, and outer bundle.
  `spctl`/notarization are not claimed for an ad-hoc developer artifact.
- Finder launch and CLI launch both create the controller, one CEF engine, expected CEF helpers, and
  on demand one PluginHost broker/worker; shutdown leaves none behind.
- Default browsing, profile persistence, Native interface commits, MCP stdio, authenticated CDP,
  plugin activation/recovery, sandbox denial, and the existing native regression suites pass using
  only paths inside the staged bundle and a disposable Application Support profile.
- Moving the app to a different directory does not break launch. Altering any sealed runtime file
  fails verification, and application data never writes inside the bundle.
