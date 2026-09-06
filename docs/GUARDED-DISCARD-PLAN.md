# Guarded native discard

This is the next engine integration plan, not an implemented API. The production scheduler still
uses reversible freezing. Evidence and the rejected asynchronous extension route are recorded in
[DISCARD-PLAN.md](DISCARD-PLAN.md).

A [pinned source draft](../apps/host-probe/cef-patches/README.md) now adds the proposed engine seam.
Its wrappers and hashes are generated, but the CEF/Chromium changes and drafted tests are uncompiled.
It is not wired into the running browser. The source verifier establishes only exact-file patch
application. A build volume with at least the documented 150 GB free remains required; the local
volume had about 58 GB free at the feasibility check.

## Decision and scope

Maintain a narrow patch against CEF `5f7e671` / Chromium
`cd1d73dd77daadf4581dc29ca73482fc241e079d`. Public CEF has no discard entrypoint or Chrome command ID.
Targeted `tabs.discard` bypasses Chromium eligibility. The ordinary proactive path also needs a
specific adaptation: every Hitchhiker page is the selected tab in its own Chrome window, so Chrome's
active-tab protection blocks even hidden Native pages.

Use Chromium's normal proactive eligibility policy with one explicit exception for that topology.
Do not turn `EXTERNAL` discard into the automatic backend. A native discarded-state query also avoids
shipping the experimental internal extension's broad debugger permission.

The relevant primary sources are
[`UserPerformanceTuningManager`](https://chromium.googlesource.com/chromium/src/+/cd1d73dd77daadf4581dc29ca73482fc241e079d/chrome/browser/performance_manager/user_tuning/user_performance_tuning_manager.cc#254),
[`DiscardEligibilityPolicy`](https://chromium.googlesource.com/chromium/src/+/cd1d73dd77daadf4581dc29ca73482fc241e079d/chrome/browser/performance_manager/policies/discard_eligibility_policy.cc#128),
[`PageDiscardingHelper`](https://chromium.googlesource.com/chromium/src/+/cd1d73dd77daadf4581dc29ca73482fc241e079d/chrome/browser/performance_manager/policies/page_discarding_helper.cc),
and [`PageDiscarder`](https://chromium.googlesource.com/chromium/src/+/cd1d73dd77daadf4581dc29ca73482fc241e079d/chrome/browser/performance_manager/mechanisms/page_discarder.cc).

## Proposed CEF seam

Add synchronous UI-thread-only `CefBrowserHost::TryDiscardPage` and `GetPageDiscardState` methods.
Their names and enum representations are proposals pending a source patch and compilation. Wrong
thread, unsupported runtime, missing browser state and unknown eligibility must fail closed.

Source preparation uncovered a required third method, `ReleaseDevToolsSession`: CEF retains its
internal protocol client after a command, and Chromium protects attached page debuggers. Observer
removal alone does not detach it. The draft explicitly releases only CEF's client; other debugger
clients remain protected because Chromium emits its detached notification only when its last session
leaves. The native integration must drain outstanding commands and clear registrations/DOM caches
before release, then run the guarded discard. Teardown loses protocol-domain state even if discard
rejects; reconcile freezing and reconnect with fresh observers. Do not bypass debugger protection.
The pinned source links and required release/reentry tests are in the patch README.

Resolve the current WebContents and primary PageNode. Call the proactive eligibility policy with a
conservative ten-minute minimum background interval. Accept normal eligibility, or a protected result
whose complete, nonempty reason list contains only `kActiveTab` while the WebContents is non-visible.
Reject every other reason and all disallowed results. Retain Chromium's attempt marker and normal
proactive mutation mechanism. An accepted result means mutation was accepted, not that renderer
teardown or memory release has completed.

Hitchhiker's pinned-page IDs remain entirely in the interface model. Pinning alone does not protect
a Hitchhiker page from sleep/discard. Chrome's independent canonical pinned-tab protection remains
part of the unmodified eligibility policy if a Chrome extension sets it.

The same-stack design is viable in this pin: CEF's
[`thread_util.h`](https://raw.githubusercontent.com/chromiumembedded/cef/5f7e671/libcef/browser/thread_util.h)
maps its UI thread to `content::BrowserThread::UI`, and Chromium's
[`performance_manager.h`](https://chromium.googlesource.com/chromium/src/+/cd1d73dd77daadf4581dc29ca73482fc241e079d/components/performance_manager/public/performance_manager.h#39)
places Performance Manager on the main thread. The policy/helper/discard calls are synchronous.
Recheck these assumptions on every upstream update.

## Hitchhiker guard and temporal contract

The native command receives a logical page ID, expected browser generation, expected URL and bounded
controller policy data. Hold the existing controller lock through the request/response so its own
configuration, viewport proposals and pending DOM-write state cannot change during that operation.
Native must independently re-resolve the browser, generation, actual URL/origin and native state.

Before entering CEF, reject closing/unavailable pages, changed identities or URLs, visible windows or
viewport bindings, uncommitted documents, unknown resources, native loading (including a direct
`IsLoading` check), audio, capture/calls, downloads and unsaved input. Also reject always-awake origins,
pending scoped DOM writes and raw-CDP launch mode. A stale controller assertion cannot override a
native condition. UI pinning is not part of this guard.

No CEF UI task, processed resource callback, viewport mutation or browser replacement can interleave
between the final native check and synchronous discard. This does not make renderer state globally
atomic: a renderer edit or audio/capture transition whose browser notification has not arrived can
still race, just as Chromium policy consumes asynchronously propagated page state. Promise protection
of current browser-observed state with unknowns rejected, not absolute renderer atomicity.

Set discard intent before the CEF call because replacement callbacks may be reentrant. Do not retain
PageRecord references across it. Positive discarded-state classification must match the current
generation. An accepted operation without a definite bounded outcome stops further automatic
attempts until reconciliation. Keep a discarded child hidden until restoration begins; explicit
reload must restore Chromium's retained navigation controller, never URL-reconstructed history.
Ordinary user extensions may still invoke Chrome's explicit-discard behavior independently.

## Delivery and verification

First prepare a pinned patch series and reproducible source-application check, including generated
CEF C/C++ wrappers and API hashes. A patch that merely applies is not a verified binary. Building the
replacement framework requires CEF's Chromium checkout and architecture-specific framework/helper
builds; no checkout or build has begun. Record actual disk/toolchain requirements before starting it.
Keep official-binary freezing available until the new host capability is verified.

Verify the native guard matrix, active-only policy exception, rejection of every other reason,
wrong-thread/unsupported cases, events queued before mutation, reentrant replacement, uncertain
outcomes and circuit breaking. Then prove repeated discard/restoration, external-extension discard,
retained history/storage, renderer memory release and relocated bundle behavior. Preserve the
generation/CDP/DOM checks in [REPLACEMENT-PLAN.md](REPLACEMENT-PLAN.md). Changes to upstream reason
enums or call ordering require review and must not silently broaden the exception.
