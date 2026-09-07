# Trusted worker diagnostics

Status: implemented and verified as a private, read-only runtime facility. The browser fixture now
samples six exact activation-bound worker identities instead of matching executable names across
the system. Aggregate browser resource acceptance remains open.

## Ownership and identity

The native broker already owns each worker PID and generation. Its native client receives those
values and uses `proc_pid_rusage` for the existing footprint watchdog. Preserve that provenance:
plugins cannot supply worker identity, choose a sampling target, or receive diagnostics events.
Bind each diagnostic handle in the trusted browser launcher to the profile, plugin ID, and framework
activation generation. Native broker generation and framework activation generation are distinct.

Worker identity is `{pid, generation, startAbstime}`. Encode the process start time as a decimal
string to preserve its uint64 precision. Sample only the client's current bound identity, verify
`ri_proc_start_abstime`, and recheck the identity under the lifecycle lock after sampling. A stopped,
replaced, or mismatched identity returns a typed stale-worker result, never another process's data.
Report physical footprint separately from resident bytes; do not label one as the other.

## Private transport

Use a reserved `hostControl` envelope on the existing controller/client transport. The native client
intercepts controller diagnostic requests before ordinary plugin command forwarding. It emits
worker-started/stopped and sample replies on this private lane. The broker must reject worker output
containing the reserved envelope before forwarding it, so diagnostics cannot be forged by a worker.
Native lifecycle callbacks must be serialized and stopped identities must match PID and generation.

The runtime parses this envelope separately from plugin replies/events, validates the complete
schema, bounds pending requests and timeouts, and rejects duplicate or incoherent lifecycle changes.
The trusted handle exposes start, sample, and stop observation. It does not enter the plugin event
stream, dispatcher, SDK, MCP, manifests, grants, or public error payloads. No credentials are added.

## Verification

Portable transport tests cover reserved-frame exclusion, malformed/duplicate identities, mismatched
stops and sample replies, stale handles, request limits, and timeout/teardown cleanup. The browser test
registers all six handles by activation identity, samples each exact worker, and asserts distinct PIDs
and positive physical footprints. Remaining coverage should observe all recorded identities stopping
on scope teardown and measure idle, route changes and full restart using these handles.

For abrupt failure, terminate only a worker whose current identity is known. A raw PID signal after
sampling has a reuse race; prefer a testing-only broker operation that verifies the full identity
immediately before termination. Do not introduce a public or general-purpose production kill API.
Verify the selected optional plugin's fallback, the other five identities remaining alive, old
handle invalidation, and new identity after authorized recovery. Keep production Keychain startup,
full packaged application entrypoint, frame latency, and aggregate Chromium/GPU memory acceptance
separate from these worker measurements.

## First implementation wire contract

This first slice is read-only; abrupt termination remains a later testing-only addition.
All envelopes have exactly one top-level `hostControl` key and reject excess nested fields.
Native uint64 start time uses a nonzero canonical decimal string; other numbers are positive safe
integers except byte counts, which permit zero. Generations are local to one native client.

- Started: `{hostControl:{event:"worker.started",identity:{pid,generation,startAbstime}}}`.
- Stopped: `{hostControl:{event:"worker.stopped",identity:{pid,generation,startAbstime}}}`.
- Sample request: `{hostControl:{id,method:"worker.sample",identity:{pid,generation,startAbstime}}}`.
- Sample success: `{hostControl:{id,result:{identity:{pid,generation,startAbstime},physicalFootprintBytes,residentBytes}}}`.
- Sample failure: `{hostControl:{id,error:{code:"stale_worker"|"unavailable"}}}`.

The client emits started only after it has obtained an exact start time for the current worker.
Failure to establish diagnostic identity must fail diagnostics without silently substituting zero or
another process. Ordinary plugin execution and its watchdog remain available. Sampling checks the
current identity before and after `proc_pid_rusage`; unknown identity returns `stale_worker`.
Controller diagnostic requests never reach the worker or ordinary command queue. Worker-emitted
reserved envelopes are rejected by the broker irrespective of their payload.

Runtime host handles expose `diagnostics.started`, `diagnostics.sample(identity)`, and
`diagnostics.stopped(identity)`. Private sampling uses its own request IDs, at most eight pending
requests, and a two-second deadline. Lifecycle parsing rejects duplicate starts or mismatched stops;
transport termination resolves pending observations as failure. Diagnostic payloads never enter
`host.events`. A trusted callback option can pass this handle through `runLivePlugin` and the browser
launcher, whose closure binds profile/plugin/activation identity. No plugin API is added.

## Verified implementation checkpoint

The native protocol suite passes eight tests, including exact identity sampling and broker-confirmed
stop after an RSS watchdog termination. Nineteen portable transport tests cover live request
capacity, actual deadlines, cancellation of one of two stop observers, stale replies and wire bounds.
Identity acquisition retries at most twenty times; waiting for identity has a five-second diagnostic
deadline without preventing ordinary plugin execution.

The real six-plugin extension-management fixture passes picker, native review, installation, binary
resource execution, removal and selected-plugin disable/re-enable with clean shutdown. Each sample
asserts six distinct worker PIDs and matching native identity. Measured sums in bytes:

| Phase     | Physical footprint | Resident bytes |
| --------- | -----------------: | -------------: |
| Startup   |         31,345,808 |     66,256,896 |
| Picker    |         31,640,720 |     66,584,576 |
| Review    |         31,673,488 |     66,732,032 |
| Installed |         32,328,848 |     67,682,304 |
| Removed   |         32,361,616 |     67,633,152 |

These are worker-only measurements, excluding Chromium, brokers and GPU processes. Startup was
5.97 seconds in this fixture. Route observation used a 250 ms poll and is not a frame-latency
benchmark. All-six stop observation, abrupt selected-worker recovery, long idle measurements, full
application memory and production Keychain startup remain separate acceptance work. The fixture
uses disposable profiles and mock Keychain. No public SDK or MCP diagnostics API was added.

The [V4 management checkpoint](DEFAULT-MANAGEMENT-EXTRACTION-PLAN.md#v4-integration-checkpoint)
adds eight-worker samples and exact stop observation across ten activation generations. Cooperative
shutdown now stops dispatch before the worker and waits for broker confirmation; a two-second
deadline retains forced cleanup for unresponsive workers. This extends worker lifecycle evidence,
while aggregate browser memory, abrupt crash recovery and long-idle performance remain open.
