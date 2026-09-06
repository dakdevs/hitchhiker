# Chrome extension management plan

Implementation is in progress against CEF
`144.0.6+g5f7e671+chromium-144.0.7559.59`. The acceptance checks below remain required before
claiming integrated extension management.

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
enabled. `packages/runtime/src/engine.ts` owns the browser-level CDP pipe on fd 3/4 and now provides
typed, bounded `loadUnpacked` and `uninstall` operations with reserved IDs and timeouts. Do not send
these methods through
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
of the browser pipe to request a load from any readable absolute path. The runtime now makes extension
mutations and raw relay ownership mutually exclusive, and rejects `Extensions.loadUnpacked`,
`Extensions.uninstall`, reserved request IDs and legacy `Target.sendMessageToTarget` frames from the
relay. Perform startup replay before opening the relay; while a relay is active, management can remain
read-only for the MVP.

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

## Current implementation packet

The artifact store owns descriptor-based bounded copying, content integrity and stable installation
paths; it never executes an extension. The engine owns typed load/uninstall commands and an
irreversible browser-pipe handoff to the raw CDP relay. The manager owns the desired-state registry,
permission-review preview, install/removal intent, startup replay and recovery. Native controls are
trusted local entrypoints; no source directory or unsafe extension command is exposed through MCP or
Hitchhiker plugins. Generic browser-pipe sending moves behind a claimed raw connection rather than
remaining on the engine service beside managed mutations.

The engine packet is implemented. `EngineOptions.extensionManagement` is explicit and controls the
unsafe Chromium switch. Management requests validate canonical profile-owned artifact paths, reserve
their own browser-pipe IDs, subscribe before sending, require exact result shapes and drain late
reserved replies. Timeout, cancellation or malformed replies after possible submission return
`extension-uncertain` and permanently refuse raw handoff until engine restart. `claimRawCdp` is an
irreversible transition and rejects pending management work. Both the relay and the claimed raw
sender block the two extension mutation methods and legacy nested forwarding; standard flattened
CDP sessions remain available.

Portable Node 24 tests pass 22/22 for the engine and relay boundary. The real pinned CEF test passes
1/1 and proves exact expected-ID parity for a keyless artifact whose canonical path contains spaces
and Unicode, a manifest-key (`AQID`) artifact, live load/uninstall, blocked relay mutation, continued
Playwright page access, revocation, profile isolation and persistence. Evidence is in
`work/extension-control-native.log`. The manager/registry integration and the broader acceptance list
above remain separate work.

Explicit first-packet artifact limits are 1 MiB manifest, 256 MiB per file, 512 MiB total, 10,000
entries, depth 64, 4,096 UTF-8 bytes per relative path and 16 published artifacts. Preserve valid
Unicode, spaces, `_locales` and other representable filenames; Chromium validates resource use.
Filesystem publication is atomic, but copying a caller-owned tree is not a privileged filesystem
snapshot. Descriptor identity, metadata and repeated tree checks detect ordinary concurrent mutation.
The store never follows symlinks or copies special files.

A store deletion primitive is trusted-only: the manager must prove an artifact was never submitted
to Chromium, or that its engine has fully stopped. Uncertain load/uninstall outcomes retain files.
Do not collect before engine startup without an exclusive profile lease, since another instance may
still be reading the same profile. Review of the durable state machine precedes integration.

## Integrated developer support

The native Settings screen now stages an unpacked directory, paginates all declared permissions,
binds confirmation to the staged installation ID/digest, and exposes review retry and removal.
Plugin-owned surfaces cannot dispatch these trusted actions, and MCP receives no local-path API.
The registry records review, submission and removal intent before side effects. Definite rejection
retains a visible retryable error; an uncertain outcome closes the app and prevents raw-pipe handoff.
Startup replay precedes page restoration. Fresh-engine recovery converges interrupted removal and
collects removed packages and orphan publications; malformed registry data cannot authorize collection.

The controller now retains a parent-owned BSD file lock through filesystem-write completion, using
an inherited descriptor and a short-lived native lock helper. Artifact scratch recovery is once per
lease. Native and portable tests cover cancelled writes, descriptor retention after helper exit,
controller death, symlink/hardlink refusal, bounded copies and crash cuts in registry transitions.

The real managed-extension test passes across four app sessions, including profile paths with spaces
and Unicode. It verifies permission preview before submission, injection into two documents, stable
extension identity/storage after deleting the source directory and restarting, separate-profile
isolation, raw-session read-only controls, removal, restart without replay, and package collection.
The two pages retain distinct Chromium window IDs, explicitly confirming the compatibility limit.
Evidence: `work/managed-extensions-native.log` and `work/extensions-native-final.log`.

This test exposed a separate session bug: the native close command bypassed the shell's managed close
transaction, and child closure erased persisted tabs. The command now routes through the coordinator,
emits window-closing/cancellation events, and preserves each page's close reason. The controller saves
the closing session while reconciling actual page teardown; cancellation resumes persistence from
surviving pages. The native bridge allows a bounded output flush at shutdown. The current integration
passes all 79 runtime and 64 browser native tests without skips. Interactive before-unload dialog
routing still requires an unlocked desktop.

A transport follow-up remains: runtime queue shutdown can drop buffered tail events under adverse
scheduling. The successful normal-shutdown test does not prove a lossless event-drain contract.
Implement ordered terminal delivery and explicit bounded drain failure before release; do not replace
that contract with a fixed sleep in the browser controller.
