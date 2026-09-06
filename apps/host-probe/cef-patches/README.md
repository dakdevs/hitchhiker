# Guarded discard source draft

**Uncompiled. Not used by the developer app or its build script.** The working browser retains the
official CEF binary and reversible freezing. These two patches are a reviewable source draft for
CEF `5f7e6711711e0e4bb213e311458f60a6a2e8e3cc` and Chromium
`cd1d73dd77daadf4581dc29ca73482fc241e079d` (144.0.7559.59).

The CEF patch adds next-version, synchronous UI-thread `TryDiscardPage` and
`GetPageDiscardState` methods, plus explicit `ReleaseDevToolsSession` for CEF's own connection.
The Chromium patch keeps proactive eligibility with a ten-minute
background minimum. It permits a non-visible native embedder's selected tab only when active-tab
status is its sole protection. Other protection reasons still reject discard. Chromium's discard
attempt marker and normal mutation mechanism remain in use. Accepted discard is not proof that
renderer teardown or memory release has completed. The state query does not start a renderer.

This is only the engine seam. Hitchhiker's native generation/URL/resource/viewport guard, controller
policy lock, positive restoration classification, circuit breaker and automatic scheduler remain
unimplemented. See [the integration plan](../../../docs/GUARDED-DISCARD-PLAN.md). Never enable this
draft through the current browser's raw extension/CDP discard experiment.

CEF's in-process CDP client stays attached after its first command, including reversible freezing.
Chromium's
[live-state helper](https://chromium.googlesource.com/chromium/src/+/cd1d73dd77daadf4581dc29ca73482fc241e079d/chrome/browser/performance_manager/decorators/helpers/page_live_state_decorator_helper.cc#362)
marks an attached page debugger as protected. Removing a CEF message observer alone does not detach
the client. `ReleaseDevToolsSession` explicitly retires that manager and its client, preserving
external debugger clients. Chromium
[notifies detachment only after the last session leaves](https://chromium.googlesource.com/chromium/src/+/cd1d73dd77daadf4581dc29ca73482fc241e079d/content/browser/devtools/devtools_agent_host_impl.cc#367),
so remaining clients keep normal debugger protection. The integration must first drain pending
CDP calls, clear registrations and cached DOM/protocol references, then release and check discard
eligibility. Teardown loses enabled domains even if discard later fails; reconcile the controller's
freeze state and reconnect with fresh observers on every outcome. Do not add a debugger exception
to Chromium's eligibility policy.

## Check the source

`manifest.json` records SHA-256 values before/after the patch and the generated next/experimental API
hashes. `verify.mjs` is read-only and works with full checkouts or exact-file source fixtures:

```sh
node apps/host-probe/cef-patches/verify.mjs \
  --cef=/absolute/cef-144/chromium/src/cef \
  --chromium=/absolute/cef-144/chromium/src --stage=before
```

Apply the CEF patch in `src/cef`. Register `chromium-guarded-discard.patch` as
`patch/patches/hitchhiker_guarded_discard.patch` with a matching `name` in `patch/patch.cfg`, following
[CEF's patch instructions](https://github.com/chromiumembedded/cef/blob/5f7e6711711e0e4bb213e311458f60a6a2e8e3cc/patch/README.txt).
CEF project generation then applies that registered Chromium patch. For an isolated source-application
check, applying the Chromium patch directly in `src` is sufficient. Run the verifier with
`--stage=after` to check the resulting files and reverse applicability.

Generate wrappers and API hashes with the pinned tools from `src/cef`:

```sh
python3 tools/version_manager.py -u --fast-check
python3 tools/version_manager.py -c
```

Do not hand edit generated C API headers, C/C++ wrappers or API hashes. Compare the `linux`, `mac`
and `windows` values in `cef_api_untracked.json` to the manifest; date comments are informational.
The build must regenerate `gen/cef/include/cef_api_versions.h` and its companion implementation.

## Evidence and outstanding gates

The patches apply to all nine exact pinned files, reverse cleanly, and match their recorded hashes.
CEF's translator generated its wrappers; all 18 existing versioned hashes and both new untracked
hashes pass its check. Preparation used clang-format 21.1.8 with Chromium's pinned `.clang-format`
and Xcode 26.6's Apple clang for header preprocessing. Matching API hashes verify that preprocessing
result; they do not establish compatibility with Chromium's compiler or build.

Five Chromium test cases are drafted for normal eligibility, the active-only exception, other live
protections, visibility/background age, missing state and failed-attempt retention. They have **not
been compiled or run**. CEF thread/state/replacement and session-release integration tests also remain
outstanding, including pending-call drainage, callback reentry, retained external debugger protection,
fresh observer registration, cache invalidation and rejected-discard recovery.

Compilation needs a full pinned source checkout. The local APFS volume had about 58 GB free on
2026-09-06; CEF's [macOS ARM64 guide](https://chromiumembedded.github.io/cef/master_build_quick_start.html)
requires 150 GB free for a Debug build. Hardware is Apple Silicon with 32 GiB RAM; Xcode 26.6/SDK 26.5
still need validation against this Chromium pin. Do not start the full checkout on the current volume.
After suitable storage is available, compile `unit_tests` and `ceftests` in Debug, run the discard
cases, build the Release framework/helpers, integrate the native guards, and verify repeated
discard/restoration plus a relocated signed developer bundle before enabling automatic discard.

The patches modify BSD-licensed CEF/Chromium sources; retain their upstream copyright and license
notices when distributing modified source or binaries.
