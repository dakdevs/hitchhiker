# Chrome extension management plan

This is a read-only design for the next implementation slice. It was checked against CEF
`144.0.6+g5f7e671+chromium-144.0.7559.59`. No extension manager is implemented by this document.

## Verified routes and limits

The pinned `work/cef/include/cef_request_context.h` has no `LoadExtension`, `GetExtensions`, or
`CefExtension` API. Those Alloy-era examples do not apply to this build. Hitchhiker already uses the
supported Chrome-runtime route: `apps/host-probe/scripts/run.mjs` passes the unpacked fixture through
`--load-extension`, while `apps/host-probe/src/simple_app.cc` creates Chrome-style windows. The fixture
in `apps/host-probe/fixtures/extension` and `apps/host-probe/src/host_smoke_test.cc` proves MV3 content
scripts, a service worker, `chrome.storage`, and tab/window sender metadata across two live pages.

The pinned Chromium [Extensions protocol](https://chromium.googlesource.com/chromium/src/+/refs/tags/144.0.7559.59/third_party/blink/public/devtools_protocol/domains/Extensions.pdl)
contains browser-target `Extensions.loadUnpacked` and `Extensions.uninstall`. Both require the raw
remote-debugging pipe and `--enable-unsafe-extension-debugging`. It does **not** contain
`Extensions.getExtensions`; that method appears in newer tip-of-tree protocol and must not be used for
CEF 144. The pinned [handler](https://chromium.googlesource.com/chromium/src/+/refs/tags/144.0.7559.59/chrome/browser/devtools/protocol/extensions_handler.cc)
loads through Chromium's `UnpackedInstaller`, returns the extension ID, and restricts uninstall to an
unpacked extension. The [session wiring](https://chromium.googlesource.com/chromium/src/+/refs/tags/144.0.7559.59/chrome/browser/devtools/chrome_devtools_session.cc)
enables mutation only for a browser target when the unsafe switch and pipe authorization are both
present.

An ad hoc diagnostic against the built pinned host confirmed the boundary:

- browser-pipe `Extensions.loadUnpacked` returned fixture ID
  `jkjphpmbigmlgbbhpgnmcneplmdgofap`;
- `Extensions.getExtensions` returned CDP `-32601`;
- `Extensions.uninstall` returned success;
- neither CDP installation nor `--load-extension` restored the extension after a restart by itself;
- replaying the same stable unpacked path restored the same extension storage (`worker count` advanced
  from 1 to 2).

The manager must therefore own the durable desired-state registry and replay enabled paths on every
launch. Chromium remains the authority for whether a particular load or uninstall succeeds.

## Recommended MVP

Implement a profile-scoped manager for explicitly selected **unpacked MV3 directories**. Defer CRX,
Chrome Web Store, automatic updates, enterprise policy, sync, and arbitrary third-party compatibility.

Stage each selection below `profileRoot/hitchhiker-extensions/artifacts/<installation-id>` before
giving a path to Chromium. Copy bounded regular files into a private staging directory, reject
symlinks and special files, require a valid manifest, record content hashes, then atomically rename.
Never pass the caller's original path to CDP. Store an atomic private registry containing the
Hitchhiker installation ID, stable artifact path, manifest name/version/declared permissions, returned
Chromium ID, desired enabled state, and last load error. Apply owner-only permissions and the same
single-writer, no-follow rules used by the plugin store.

Start the engine with `--enable-unsafe-extension-debugging` only when the local extension manager is
enabled. `packages/runtime/src/engine.ts` already owns the browser-level CDP pipe on fd 3/4; add one
bounded request/response helper with reserved IDs and timeouts. Do not send these methods through
`apps/host-probe/src/engine_bridge.cc::cdp.send`, because that attaches to a page target. Restore all
registry entries through `Extensions.loadUnpacked` after `host.ready` and before
`apps/browser/src/controller.ts` opens persisted pages. Require the returned ID to match the stored ID
on later launches; quarantine a mismatch or failed load while allowing the default browser to start.

`install` copies and records the artifact, calls `Extensions.loadUnpacked`, and commits the returned ID
only after success. `list` reports **Hitchhiker-managed** entries from this registry plus this session's
load result; it must not claim to enumerate every Chromium extension. `remove` first persists a
pending-removal state that prevents startup replay, then calls `Extensions.uninstall` and records
completion. A failure retains the pending-removal state for retry rather than silently reinstalling
the extension on restart. Artifact deletion waits until the engine
has stopped or the next clean launch. This avoids deleting resources while an extension worker or page
may still read them. A returned uninstall success is insufficient by itself: the diagnostic emitted a
service-worker unregister warning, so restart verification is required.

Installation requires an explicit local user action and a permission review. Do not expose a local
filesystem path through MCP in this slice. If remote management is added later, introduce a separate
`extensions.install` grant and bounded uploaded package format rather than accepting an arbitrary host
path.

## CDP and recovery boundary

The unsafe extension switch does not disable Chromium's renderer/GPU sandbox, but it allows the holder
of the browser pipe to request a load from any readable absolute path. Hitchhiker's authenticated raw
CDP relay currently forwards browser messages unchanged. Before enabling the switch in production,
make extension mutations and raw relay ownership mutually exclusive, and reject
`Extensions.loadUnpacked` and `Extensions.uninstall` from relayed client frames. Perform startup replay
before opening the relay; while a relay is active, management can remain read-only for the MVP. Test
reserved-ID collisions and nested/forwarded CDP messages before relaxing that rule.

`--safe-mode` must skip registry construction, omit the unsafe switch, and start without extensions,
even when the artifact directory or registry is malformed. A normal load failure disables only that
entry and records a bounded diagnostic. Profile isolation follows the existing canonical
`root_cache_path` and `cache_path` in `apps/host-probe/src/cefsimple_mac.mm`; never load one profile's
artifact into another profile.

## Compatibility statement

This MVP does not provide same-window Chrome tab semantics. `apps/host-probe/src/page_manager.cc`
creates one Chrome-style BrowserView in one child Chrome window per Hitchhiker page, as required by the
pinned CEF runtime. The fixture already observes distinct Chromium `windowId` values for the two pages.
Content scripts, workers, storage, and some `tabs` calls can work, while tab groups, toolbar/action UI,
window-scoped queries, action popups, install prompts, and extensions that assume every Hitchhiker page
is a tab in one Chrome window remain unproven or incompatible. The UI must label this as unpacked
developer extension support rather than Chrome extension parity.

## Acceptance

- Unit tests cover bounded staging, symlink/special-file rejection, atomic recovery, ID mismatch,
  registry corruption, CDP timeout/error mapping, relay method rejection, and teardown with requests in
  flight.
- A real CEF test installs the checked-in fixture live, observes it on two existing pages, lists the
  managed metadata, restarts the same profile, replays before page restore, and observes preserved
  extension storage.
- Removal unloads the worker, prevents injection into a newly opened page, survives restart without a
  replay, and leaves no manager artifact or active extension target. Forced crashes between recording
  removal intent, uninstall, and garbage collection converge safely on restart.
- Two profiles never share registry entries, paths, extension storage, or workers. Paths with spaces
  work; malformed UTF-8/UTF-16 names, traversal, excessive file count/bytes, and changed files after
  hashing are rejected.
- A `cdp.connect` client cannot invoke either unsafe Extensions mutation. Safe mode starts with a
  corrupt registry and no extension access.
- Renderer and GPU helpers retain seatbelt sandbox arguments, extension resources resolve only from
  the staged copy, shutdown drains extension workers, and the existing Native, page lifecycle, MCP,
  CDP, and packaging suites remain green.
- The test report records distinct extension `windowId` values across Hitchhiker pages so passing
  content-script tests cannot be presented as same-window compatibility.
