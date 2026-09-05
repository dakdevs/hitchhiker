# Native / Chromium host experiment

This is an integration experiment, **not the Hitchhiker browser**. It mounts Native's embedded
UI in a 260-point region beside one Chrome-style CEF BrowserView. A Native button requests a
local HTML fixture; its Chromium title callback sends an event back to the Native model.

The embedded surface currently uses Native's CPU reference renderer, a 30 Hz timer, and mouse
input only. It deliberately does not establish production rendering performance, Retina/IME/
accessibility support, extension compatibility, multiple live pages, or plugin isolation.
The final host needs GPU rendering and complete input/lifecycle integration. Zig here is the
toolkit embedding experiment; product interfaces remain TypeScript/Native markup.

## Build on Apple Silicon macOS

Use Xcode, Zig 0.16.0, CMake, Node 24.19.0 and the root pnpm install. Prepare the exact dependencies:

```sh
git clone https://github.com/vercel-labs/native work/native-sdk
git -C work/native-sdk checkout 5665a355cae768dff734d79dd4c0bd9d099f83fb
pnpm exec native cef install --dir work/cef --version '144.0.6+g5f7e671+chromium-144.0.7559.59' --source official --allow-build-tools
pnpm --filter @hitchhiker/host-probe build:native
pnpm --filter @hitchhiker/host-probe dev
```

The build validates the Native revision, CEF version and Zig version. Existing checkouts can be
selected with `NATIVE_SDK_SOURCE`, `CEF_ROOT`, `ZIG`, and `CMAKE`. The experiment is an explicit
`build:native` target; portable CI does not imply the native host compiled or ran.

Sandbox support is forced on in CMake. CEF helpers follow the official sample's bundle layout.
The profile is isolated under `work/host-probe/build/profile`. No personal browser profile or
debugging port is selected. Sandbox runtime validation and signed packaging remain outstanding.

## Interactive acceptance

1. Verify a Native sidebar and blank Chromium page share the window without overlap.
2. Click **Open local fixture**. Confirm Chromium displays the fixture and stderr records
   `HITCHHIKER_NATIVE_NAVIGATE`.
3. Confirm the Native label changes to **Page loaded** and stderr records
   `HITCHHIKER_CHROMIUM_EVENT`.
4. Type into the fixture input, resize the window, and close it. Inspect for crashes.

The upstream CEF sample sources and macOS resources retain their BSD license in `LICENSE-CEF.txt`.
See `docs/ENGINE-FEASIBILITY.md` at the repository root for the remaining Chrome-style multi-page
constraint. This experiment does not bypass that constraint.
