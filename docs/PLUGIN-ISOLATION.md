# Live plugin isolation on macOS

Investigated and exercised on macOS 26.5.2 (Apple silicon) on 2026-09-05. The
implemented helper is in `apps/plugin-host`; its native integration test uses only
a task-created fixture and loopback listener and does not read an existing user
document or browser profile.

## Implemented boundary

The macOS helper uses the system JavaScriptCore framework with one worker process
per plugin. The trusted TypeScript runtime launches one outer `plugin-host` app
binary per plugin over private stdin/stdout. That app connects to an embedded,
explicitly App-Sandboxed XPC broker, which `posix_spawn`s only its fixed embedded
worker with inherited standard streams. The worker is signed with exactly
`com.apple.security.app-sandbox` and
`com.apple.security.inherit`; the XPC service is signed with
`com.apple.security.app-sandbox` and no file or network access entitlements.

This choice is conditional on keeping the process boundary. Apple exposes script
evaluation and separate virtual machines in JavaScriptCore, but its public API does
not expose a per-VM heap ceiling or an execution interrupt callback. A hung or
over-budget plugin must therefore be killed as a process. Sharing a worker between
plugins would break attribution and recovery.

JavaScriptCore is the preferred first implementation because it is a public system
framework, adds no downloadable engine artifact, and crosses directly into a small
C/Objective-C worker. The tradeoff is an OS-dependent JavaScript version and coarse
process-level termination. QuickJS-WASM gives finer engine-level limits but adds a
WASM engine package and wrapper to the trusted worker. Either runtime still needs
the same XPC/App Sandbox and per-plugin process boundary; a language VM alone is not
an OS authority boundary.

The security boundary is:

```text
trusted TypeScript runtime (plugin identity, grants, compiled IIFE)
        |
        | private JSON lines; one outer app connection per plugin
        v
trusted plugin-host app (bounded output queue and RSS measurement)
        |
        | private XPC; PID generation never reaches plugin JavaScript
        v
App-Sandboxed XPC broker (wall watchdog, no file/network entitlements)
        |
        | inherited stdin/stdout, one child per plugin
        v
JavaScriptCore worker (compiled JS + frozen capability stubs only)
```

This is separate from CEF's renderer/GPU sandbox. The plugin service and worker
must never replace, modify, inject into, or disable Chromium's sandboxed helpers.

## Why the launch shape matters

Apple describes App Sandbox as kernel-enforced access control and says omitted
file and network capabilities are denied. It also documents that an XPC service
has its own sandbox and is the preferred privilege-separation mechanism. An XPC
service is embedded in `MyApp.app/Contents/XPCServices`, is launched and managed by
`launchd`, and is private to the containing app:

- [Configuring the macOS App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox)
- [XPC framework overview](https://developer.apple.com/documentation/xpc)
- [Creating XPC services](https://developer.apple.com/documentation/xpc/creating-xpc-services)
- [Archived XPC service bundle and lifecycle details](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingXPCServices.html)

For a directly launched command-line child, Apple requires sandbox inheritance.
The child must have exactly the sandbox and inherit entitlements, receives only
the parent's static sandbox rights, and does not receive later PowerBox file
extensions. Apple explicitly prefers XPC when the helper needs a different
privilege set:

- [Embedding a command-line tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
- [Enabling App Sandbox inheritance](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html)

Consequently, spawning an inherited helper from the unsandboxed browser host is
not a plugin sandbox. Spawning it from the restricted XPC broker is. The production
bundle must sign nested code from the inside out with the same Developer ID team,
enable Hardened Runtime, and pass normal bundle verification and notarization.
The ad hoc signatures below establish local launch behavior only.

Do not rely on an XPC service being sufficiently restricted merely because it is
an XPC service. Apple's archived guide describes a minimal default environment,
but the hand-built service in this experiment could read the fixture, connect to
loopback, and spawn a process until the explicit App Sandbox entitlement was added.

An App-Sandboxed service also is not proof that the kernel forbids all process
creation: the experiment's service successfully spawned its embedded inherited
worker. The supported guarantee is that the child retains the parent's static
sandbox restrictions. Hitchhiker must expose no process API to JavaScript, keep
the worker bundle free of general-purpose helper programs, kill the worker process
group on violation, and treat native-runtime compromise as bounded by App Sandbox
rather than claim that process creation is impossible.

## Runtime and capability invariants

Create a fresh JavaScriptCore global context in each worker. A default context
evaluates JavaScript and has no Node `process`, `require`, or filesystem API; do not
add them, and do not add `fetch`, sockets, Objective-C objects, or a generic native
bridge. Apple's API explicitly makes native objects available only when the host
inserts them. Inject only a frozen capability-call function that accepts a bounded
data value and request ID:

- [JavaScriptCore overview](https://developer.apple.com/documentation/javascriptcore)
- [`JSContext`](https://developer.apple.com/documentation/javascriptcore/jscontext)
- [`JSVirtualMachine`](https://developer.apple.com/documentation/javascriptcore/jsvirtualmachine)

The native protocol has no plugin identity field. The trusted TypeScript runtime
assigns identity from the outer process connection and must check every
`plugin.call` method and payload against the current grant at receipt time so
revocation applies without restarting the browser. Capability calls carry only
documented methods and JSON values, never paths, file descriptors, URLs to fetch,
native pointers, selectors, CDP handles, or executable source.

The native helper enforces 1 MiB input/output lines, 512 KiB activation code, 32
unresolved plugin calls, 64 in-flight worker commands, and an 8 MiB outer output
queue. It validates the request envelope independently in the outer app, broker,
and worker. Schema-specific depth, collection, string, event-rate, and reply-time
bounds belong to the trusted TypeScript capability decoder and remain outside this
native slice.

Keep permission review, known-good plugin versions, rollback metadata, crash
counts, and recovery UI in the trusted host. The service container must contain no
browsing secrets or authority tokens. The host sends the compiled bundle as bytes;
the worker does not open the plugin package.

## TypeScript compilation

TypeScript/esbuild compilation is not implemented in this package. The native
protocol accepts only a single compiled IIFE of at most 512 KiB. That IIFE must set
`globalThis.HitchhikerPlugin` with `activate(hitchhiker)` and optional
`onEvent(event, payload)` functions. Public `@hitchhiker/ui` builders are expected
to compile into that bundle. Compiler process isolation, package resolution, and
source-tree validation remain a separate implementation and must not be inferred
from the working runtime host.

## Resource enforcement

The XPC broker owns the worker PID and 500 ms synchronous-command watchdog; the
plugin cannot stop or reset either. Live testing found that the App-Sandboxed
broker cannot obtain worker resource usage with `proc_pid_rusage`. The trusted
outer app therefore samples the worker's physical footprint, while the broker
keeps the authoritative PID generation. On crossing 150 MiB, the outer app sends a
private generation-bound XPC control message. The broker rejects stale generations,
emits `plugin.resource`, and sends `SIGKILL` to the worker process group. PID and
kill controls are never forwarded to plugin JavaScript.

The broker survives the worker exit, emits `plugin.crash`, fails outstanding
commands, and starts a fresh worker on the next `activate`. Crash-loop backoff,
rolling CPU budgets, warning bands, and known-good rollback policy remain the
trusted TypeScript runtime's responsibility.

`plugin.started` reports only that a fresh worker process is connected. The
`activate` reply and `plugin.ready` event are withheld until the value returned by
`activate(hitchhiker)` resolves successfully. A synchronous exception or rejected
activation Promise fails the request and terminates the worker, so the trusted
runtime can keep the previous known-good revision active. Promise suspension does
not count toward the 500 ms synchronous slice; each request or Promise continuation
that runs JavaScript receives its own externally enforced slice. The trusted
runtime must still impose its end-to-end activation and capability-call deadlines.

RSS polling is a watchdog, not a strict allocation ceiling: a worker can overshoot
between samples, and JavaScriptCore exposes no public heap limit. The 150 MiB
threshold still needs release-build tuning across supported hardware and OS
versions.

If measurements show unacceptable overshoot or per-plugin overhead, use
QuickJS-WASM 0.32 in the same OS process boundary; its heap limit and interrupt
handler are useful additional controls, but they do not replace App Sandbox or the
external watchdog. The package's own
[`QuickJSRuntime` documentation](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten/classes/QuickJSRuntime.md)
documents `setMemoryLimit`, `setMaxStackSize`, and `setInterruptHandler`.

## Executed evidence

`pnpm --filter @hitchhiker/plugin-host test:native` builds the complete ad hoc
signed app bundle and runs the public source in `apps/plugin-host`. The test passed:

- Bidirectional `plugin.call`/`resolve` and event delivery, including an activation
  Promise that makes two nested host calls before the ready handshake, across
  private JSON lines.
- Two simultaneous outer clients with independent worker globals and call IDs.
- Absence of `process`, `require`, `fetch`, timers, and the deleted private native
  callback from plugin JavaScript; the injected API is frozen and contains only
  `call`.
- `EPERM` for a task-created file and a live loopback listener from both inherited
  workers. The probe is compiled only into the integration-test build and is absent
  from the normal bundle.
- A 500 ms synchronous infinite loop kill and a JavaScript allocation exceeding
  the 150 MiB physical-footprint threshold, with `plugin.resource`, `plugin.crash`,
  and successful fresh activation after each kill.
- Rejection of malformed JSON and a frame larger than 1 MiB, followed by successful
  activation on the same outer connection.

The native build also passes strict nested code-signature verification. Its normal
output contains one fixed inherited worker and accepts no runtime path, environment,
or command-line switch selecting another executable. The production build rejects
the output if the integration-test fixture marker appears in the worker binary;
the final verified bundle was rebuilt without `PLUGIN_HOST_TESTING` after the
denial suite.

The gated `packages/runtime/test/native-plugin.test.ts` test also passed against
that production bundle with Node 24.19.0. It uses the durable grant store and real
runtime transport to prove two identities receive their own trusted browser data,
an activation Promise completes two nested capability calls before readiness,
revoking an idle UI grant ends its session and releases its UI lease, a resource
kill also releases the UI lease, and scope exit leaves no outer `plugin-host`
process.

The earlier ignored experiment established the launch shape before it was promoted.
The ignored experiment contains:

- `jsc_helper.m`: reads JavaScript from stdin, evaluates it with the system
  JavaScriptCore framework, writes the result to stdout, and probes file, loopback,
  and process access.
- `xpc_service.m` and `xpc_client.c`: an embedded XPC round trip plus a broker-spawned
  inherited worker.
- `watchdog.c`: out-of-process wall/RSS sampling and process-group termination.
- `standalone.entitlements`, `inherit.entitlements`, and `jsc-deny.sb`: the tested
  signatures and test-only Seatbelt profile.

Observed results:

```text
embedded XPC service (ad hoc signed, explicit App Sandbox):
  js_result=42
  open_errno=1
  connect_errno=1
  spawn_errno=0

inherited worker launched by that service over stdin/stdout:
  worker_status=0
  js_result=42
  open=denied errno=1 (Operation not permitted)
  connect=denied errno=1 (Operation not permitted)

external watchdog:
  infinite loop: killed for wall time at 509 ms
  allocation loop: killed for RSS at 113,345,160 bytes after 26 ms
  configured RSS threshold: 80 MiB
```

The loopback denial was tested while a task-created HTTP server was listening on
`127.0.0.1:38991`; the same unsandboxed helper connected successfully. The file was
created under `work/plugin-isolation/fixtures` and the unsandboxed helper could read
it. This distinguishes sandbox denial from a missing file or closed port.

A directly executed ad hoc helper carrying `com.apple.security.app-sandbox` failed
with exit status 133 (`SIGTRAP`); AMFI logged that its signing chain was unknown.
The same ad hoc-signed App-Sandboxed executable worked when packaged as an embedded
XPC service. A separately ad hoc-signed helper under the test-only `sandbox-exec`
profile also evaluated JavaScript and denied the fixture read, live loopback
connection, and `/usr/bin/true` spawn. `sandbox-exec` and custom Seatbelt profiles
are not the production design.

## Remaining release acceptance

The runtime host is implemented and behaviorally tested, but release integration
still requires:

- Build and sign the complete app, XPC service, and inherited worker with the
  distribution identity; verify all entitlements with `codesign`, notarize the
  containing browser, and confirm sandbox status in Activity Monitor.
- Repeat live file and listening-loopback denial through the installed/notarized
  app.
- Fuzz nested and adversarial JSON beyond the current malformed/oversized cases and
  prove that plugin-supplied identity, paths, and capability names cannot cross the
  TypeScript authorization boundary.
- Integrate grant, denial, live revocation, disable, and known-good rollback with
  the trusted TypeScript runtime, then repeat the tested crash, timeout, memory,
  and restart cases through that end-to-end path.
- Measure idle and active per-worker footprint, watchdog overshoot, callback latency,
  and 100 crash/restart cycles on the oldest supported macOS release.
- Re-run CEF renderer/GPU sandbox checks and extension/CDP tests to prove the plugin
  service did not change Chromium helper launch flags or authority.

Remaining limitations are explicit: the promoted package has been tested with ad
hoc signatures rather than Developer ID/notarization; it does not integrate
esbuild or the TypeScript permission broker; RSS enforcement is sampled rather
than a hard heap cap; and it proves only the tested macOS 26.5.2 behavior.
JavaScriptCore language behavior is tied to the installed OS, so the plugin SDK
must publish and test a conservative syntax/runtime baseline across all supported
macOS versions.
