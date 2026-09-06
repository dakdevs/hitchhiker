# Plugin execution-budget correction

Investigated and implemented on macOS 26.5.2 (Apple silicon) on 2026-09-05.
`work/plugin-budget-final.log` records the Node 24.19.0 native integration run:
seven tests passed, including the separate cold-start, startup-hang, CPU-slice,
hostile-Promise, async-wait, total-wall, and RSS cases. The integration suite
rebuilt the normal production bundle after its test-only builds; strict nested
signature verification passed and the final worker contains neither test marker.
The production helper also passed the real runtime plugin lifecycle test in
`work/plugin-budget-runtime.log` and the two real CEF/MCP managed-plugin cases in
`work/plugin-budget-management.log`.

## Pre-correction finding

The previous 500 ms limit was elapsed time from receipt by the XPC broker, not
plugin execution time. The broker added every command with
`now_ms() + COMMAND_LIMIT_MS` before writing it to the worker. For the first
`activate`, that interval included `posix_spawn`, launchd and pipe scheduling,
JavaScriptCore context creation, and evaluation of the fixed bridge wrapper. The
worker did not emit `plugin.started` until that trusted setup was complete.

This explains the load-sensitive failure. `work/runtime-serial.log` records all
60 runtime tests passing. The concurrent diagnostic run in
`work/runtime-plugin-diag-1.log` records the real managed plugin failing activation
with `plugin.resource reason=wall commandLimitMs=500`. An ignored signed-XPC spike
in `work/plugin-budget-spike` observed 371-823 ms before `plugin.started` even though
the test worker had not yet run submitted code.

The async bookkeeping also conflated two clocks. `command.wait` set the original
command deadline to zero permanently. A `resolve` request got a fresh 500 ms wall
deadline and called the saved Promise resolver, which can execute the plugin
continuation. This caught some continuation loops by accident, but charged
scheduler delay and left an original command with no native lifetime bound after
its first wait.

## Required invariants

- The 500 ms value measures CPU consumed by one synchronous entry into plugin
  JavaScript. Worker startup, process scheduling, pipe blocking, and a capability
  operation awaited in the trusted host do not consume it.
- Every entry is covered: bundle evaluation plus `activate`, every `onEvent`, and
  every Promise continuation entered by `resolve`. A continuation that makes
  another host call yields; its later `resolve` starts a new slice.
- One top-level `activate` or `event` retains a finite elapsed-time deadline across
  all waits. This catches an endless sequence of individually cheap host calls.
- Trusted worker initialization has its own deadline ending only at the fixed
  worker's `plugin.started` message. Submitted code cannot emit that message
  because the worker sends it before reading the activation frame.
- Enforcement remains outside plugin JavaScript and a violation terminates the
  worker process. The broker remains the PID-generation authority and process-group
  killer. The outer client remains the 150 MiB physical-footprint supervisor.
- Worker exit, stale generation, malformed control data, and timer setup failure
  all fail closed and release every tracked command exactly once.

## Implemented boundary

Use Darwin's process CPU interval timer inside the fixed, sandboxed worker. Arm a
one-shot `setitimer(ITIMER_PROF, ...)` immediately before a validated request enters
JavaScriptCore and disarm it immediately after the native call returns. Apple
documents that `ITIMER_PROF` decrements in process virtual time and while the
kernel runs on behalf of the process, then delivers `SIGPROF`; it does not decrement
while the process is merely descheduled or blocked. See Apple's
[`setitimer(2)` manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setitimer.2.html).

This is preferable to sampling CPU from the broker. The signed sandbox experiment
already established that the App-Sandboxed broker cannot call
`proc_pid_rusage` for its child. The outer client can call it and currently uses
`ri_phys_footprint` every 10 ms (`apps/plugin-host/src/client.m`, lines 107-130),
but an external sampler cannot know the exact start of a JavaScript slice without
an acknowledgement protocol and request queue. `ITIMER_PROF` needs neither private
Mach task access nor a cross-process baseline. The local macOS 26.5 SDK declares
`setitimer` and `ITIMER_PROF` in `usr/include/sys/time.h`; the repository targets
macOS 14 or newer.

The ignored signed-XPC spike provides direct feasibility evidence under the same
service and worker entitlements. A 100 ms timer terminated a tight loop with
`SIGPROF` (signal 27). When the same worker slept for one second before looping, it
survived the sleep and terminated about 100 ms of CPU later. A second spike wrapped
the current JavaScriptCore dispatch: an activation awaited a host call, then its
`resolve` continuation looped forever and died by `SIGPROF`. The continuation was
terminated 194 ms after `resolve` was sent despite 823 ms of prior cold startup.
The spike uses a deliberately small timer and is evidence only; it is ignored by
git and must not ship.

### Worker implementation

In `apps/plugin-host/src/worker.m`:

1. After fixed JavaScriptCore bootstrap and before `plugin.started`, restore the
   default `SIGPROF` disposition and unblock it. This removes dependence on an
   inherited signal mask or disposition. Plugin JavaScript has no signal API.
2. Add a small fail-closed timer helper. Arming sets a non-repeating 500 ms
   `ITIMER_PROF`; disarming sets `it_value` to zero. A failed arm or disarm exits
   with a reserved worker status so the broker reports `cpu-accounting`, rather
   than silently falling back to no limit.
3. Arm once around each complete JavaScript-bearing physical request, not around
   each individual C API call. `activate` therefore includes submitted source
   evaluation, the exported activation function, Promise settlement work, and
   native bridge CPU in one slice. `event` is one slice. `resolve` is one slice and
   covers all synchronous Promise/microtask continuation work before the resolver
   call returns. `stop` and rejected protocol frames do not need a plugin CPU timer.
4. Disarm only after the JavaScript entry returns. If it returns a pending Promise,
   the existing `command.wait` follows and the worker blocks in its input loop with
   no CPU timer armed. Do not install a reporting signal handler: arbitrary
   Objective-C/JSON work is not async-signal-safe. Default `SIGPROF` termination is
   the reliable enforcement action.

The timer is process-wide, which is appropriate because there is one plugin and
one request-dispatch thread per worker. JavaScriptCore helper-thread CPU can also be
charged to the process; that is conservative and prevents a plugin from moving
cost outside the main thread. The tradeoff is the platform timer's approximately
10 ms resolution and process-level termination rather than a catchable JavaScript
exception.

### Broker implementation

In `apps/plugin-host/src/broker.m`:

1. Split the constants and diagnostics: `COMMAND_CPU_LIMIT_MS = 500`,
   `WORKER_STARTUP_LIMIT_MS = 4_000`, and
   `COMMAND_TOTAL_WALL_LIMIT_MS = 5_000`. Keep `commandLimitMs: 500` for protocol
   compatibility and add explicit CPU/startup/wall fields when useful.
2. On spawn, record a generation-bound startup deadline and `ready = NO`. Clear it
   only when the current worker emits the structurally valid `plugin.started`
   event; reject a duplicate. The activation frame may remain queued in the pipe:
   the fixed worker emits readiness before reading it, and its CPU timer begins only
   at JavaScript dispatch. Before readiness, accept only the single activation that
   caused the spawn; reject other commands as `starting` so pipe input cannot become
   an untracked startup queue.
3. Give each accepted top-level `activate` or `event` a 5 s total wall deadline at
   broker receipt. `command.wait` changes its state to waiting but does **not** erase
   this deadline. Each `resolve` remains a separately tracked physical request with
   its own bounded wall deadline; it also gets the worker's fresh CPU slice. The
   existing trusted runtime has a 5 s request timeout and a 4 s capability-call
   timeout (`packages/runtime/src/plugin.ts`, lines 87-139), so these values preserve
   the current public bound. If later tuning separates those host deadlines, keep
   the native total bound no longer than the caller's effective request lifetime or
   tear down the host when the caller times out.
4. Retain a generous wall fallback for a runnable request. It may include scheduler
   delay by design and must never be presented as the 500 ms execution budget. It
   covers a worker blocked in native code, broken timer setup, or output backpressure.
5. In `read_worker`, classify
   `WIFSIGNALED(status) && WTERMSIG(status) == SIGPROF` as a CPU resource violation.
   Inspect the exit with `waitid(..., WNOWAIT)`, send `SIGKILL` to the process group
   while the leader remains an unreaped zombie and its PID/group ID cannot be
   reused, then reap it with `waitpid`. Emit
   `plugin.resource { reason: "cpu", commandLimitMs: 500 }` before failing
   outstanding requests and before `plugin.crash`. Preserve an already-recorded
   RSS or broker wall kill so a later exit signal cannot overwrite the first cause.
   Keep all generation checks around reporting and process-group termination.

No client-side resource redesign is needed. In particular, retain the current
external `proc_pid_rusage(... RUSAGE_INFO_V4 ...)` RSS sampler, 150 MiB threshold,
generation-bound kill request, sandbox entitlements, fixed worker path, and
deep-first signing.

## Failure modes and limits

- A top-level command can consume nearly 500 ms in each of several continuations.
  The continuing 5 s wall deadline bounds this deliberate yield strategy. If
  telemetry later calls for a cumulative CPU allowance, add it in the external
  supervisor; it is not needed to correct the present false positive.
- CPU time can exceed 500 ms by timer resolution and signal-delivery latency.
  The elapsed wall fallback remains the recovery ceiling. Tests should assert the
  signal/cause and bounded recovery, not a sub-millisecond wall duration.
- `SIGPROF` is process-global. Do not add another profiler or library that owns this
  signal without replacing this mechanism. Verify the signal disposition after
  JavaScriptCore bootstrap.
- A 5 s wall deadline intentionally includes host waits. The host operation is
  already limited to 4 s. Long-running capabilities require a protocol redesign
  with cancellation, not removal of the native lifetime bound.
- RSS polling remains an approximate ceiling and can overshoot between 10 ms
  samples. This proposal does not alter that accepted limitation.

## Acceptance and regression tests

`apps/plugin-host/test/integration.test.mjs` now uses test-only worker builds for
the startup cases. `work/plugin-budget-final.log` records these implemented cases
passing 7/7 with Node 24.19.0:

- Delay fixed worker startup beyond 500 ms, then prove a normal activation succeeds;
  separately hang before `plugin.started`, prove the startup deadline kills it, and
  prove a fresh activation starts a new generation on the same outer host.
- The initial tight loop reports `reason: "cpu"`; nested Promise/microtask
  continuation work after two host calls is independently rearmed and reports the
  same cause.
- Return a thenable whose `then` getter loops and reject with a value whose
  `toString` loops; Promise assimilation and rejection formatting must remain in
  the same CPU slice and report `reason: "cpu"`.
- Await a host result for 700 ms and complete successfully, proving that suspended
  host time does not consume the 500 ms CPU slice.
- Run an endless chain of short host calls; each slice stays below 500 ms, but the
  original command's total wall deadline terminates the worker with `reason: "wall"`.
- Re-run malformed-frame recovery and the allocation test unchanged; the latter
  reports `reason: "rss"`, exceeds 150 MiB, and restarts cleanly.
- Verify ad hoc nested signatures and entitlements are unchanged and rebuild the
  production worker last with no test markers. Source inspection confirms the
  unchanged outer client still owns RSS sampling.

The CPU cases exercise the `waitid(..., WNOWAIT)` classification path. Because the
worker remains an unreaped zombie until after `kill(-pid, SIGKILL)`, Darwin cannot
reuse its PID, which is also its process-group ID, during descendant cleanup. The
tests do not create a worker descendant because the sandboxed JavaScript surface
exposes no process-spawn operation.

The following proposed acceptance cases have not been executed as durable tests:

- Run a legitimate activation while separate CPU-bound processes compete, require
  no false CPU violation, and avoid equating 500 ms of CPU with 500 ms of wall time.
- Force native/output backpressure and require the 5 s wall fallback to recover the
  worker.
- Inject malformed and duplicate `plugin.started` frames and require a protocol
  kill without accepting readiness.
- Force CPU-timer setup and disarm failures and require the reserved
  `cpu-accounting` classification.
- Exercise a self-perpetuating Promise microtask chain that never returns to native
  code and require one CPU-slice kill.

The recorded Node 24.19 runs cover the plugin-host suite, real runtime plugin
lifecycle, and real CEF/MCP managed-plugin test. The final native-enabled runtime
suite also passes under its original concurrency: 74 passed, no skips, in 11.4
seconds (`work/plugin-budget-concurrent-final.log`). No startup `wall` violation
occurred. The separate native worker suite preserves the intentional CPU, wall,
startup, and RSS violation/recovery cases. This concurrent integration workload is
not a synthetic CPU-saturation benchmark.
