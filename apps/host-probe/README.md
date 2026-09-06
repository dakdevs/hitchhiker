# Native / Chromium host experiment

This is an integration experiment, **not the Hitchhiker browser**. A CEF-owned root window
contains a Native sidebar. Independent Chrome-style Chromium child windows display pages in
host-assigned viewports. Native buttons switch between page one, page two and a split; changing
layout retains each document. Chromium title events update the Native model.

`PageManager` knows stable page IDs, lifecycle and rectangles. Sidebar buttons are one consumer;
it imposes no tab order, pinning or selection model. This C++ experiment is not yet connected to
the portable TypeScript core or a live plugin runtime.

Each child contains one Chrome-style BrowserView, respecting stock CEF's limit. Chrome extensions
see **one Chromium window per page**, so same-window tab/group behavior is not equivalent to Chrome.
The local Manifest V3 fixture tests content scripts, worker messaging and storage only.

The surface uses Native's CPU reference renderer, a 30 Hz timer and mouse input only. GPU rendering,
Retina, keyboard/IME and accessibility integration remain prerequisites for a production shell.
Zig here is the toolkit embedding experiment; product interfaces remain TypeScript/Native markup.

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

## Automated acceptance

```sh
pnpm --filter @hitchhiker/host-probe test:native
```

The launcher starts the loopback-only fixture server and loads the test extension into the dedicated
profile. The in-process DevTools test waits for both fixtures and extension workers, sets distinct
input/counter state, and switches single/split layouts 100 times. It verifies unchanged document
nonces and state, then creates and fully drains a temporary page 12 times before checking the
original documents again. It requests a local popup immediately before shutdown to exercise
pending-popup draining. The test prints `HITCHHIKER_SMOKE_PASS` or `HITCHHIKER_SMOKE_FAIL`, closes the shell,
and returns a corresponding exit code. A 30-second launcher timeout bounds startup/shutdown failures.
No external debugging port is opened. This is CDP engine evidence, not an authenticated CDP broker.

## Interactive acceptance

1. Run `pnpm --filter @hitchhiker/host-probe dev`; verify the Native sidebar and page one.
2. Type distinct text into each page using **Page one** and **Page two**. Increment their counters.
3. Choose **Split pages**; verify both documents retain state and either input accepts focus.
4. Switch layouts, resize/move/fullscreen the window, and verify children stay within content bounds.
5. Close the shell; verify all child browsers close and the process exits without a crash.

The earlier single-page integration passed Native click → Chromium navigation → Native title event,
Chromium typing, window zoom/restore with input preservation, and clean close. The multi-page
DevTools persistence, 12 page lifecycle cycles and extension checks passed. Multi-page desktop interaction remains pending
while the Mac is locked; automated engine checks do not establish visual/focus correctness.

The upstream CEF sample sources and macOS resources retain their BSD license in `LICENSE-CEF.txt`.
See the repository's `docs/ENGINE-FEASIBILITY.md` for evidence and compatibility limits.
