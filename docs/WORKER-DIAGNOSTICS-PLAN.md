# Trusted worker diagnostics

Status: design accepted for implementation; no diagnostics API is implemented by this document.
The six-worker lifecycle fixtures pass, but current memory samples match executable names across
the system. Replace that provisional collection before making a resource acceptance claim.

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
stops and sample replies, stale handles, request limits, and timeout/teardown cleanup. Native tests
register all six handles by activation identity, sample each exact worker, and assert distinct PIDs,
positive physical footprints, and all recorded identities stopping on scope teardown. Measure
startup, idle, route changes, picker/review/install, removal, and full restart using these handles.

For abrupt failure, terminate only a worker whose current identity is known. A raw PID signal after
sampling has a reuse race; prefer a testing-only broker operation that verifies the full identity
immediately before termination. Do not introduce a public or general-purpose production kill API.
Verify the selected optional plugin's fallback, the other five identities remaining alive, old
handle invalidation, and new identity after authorized recovery. Keep production Keychain startup,
full packaged application entrypoint, frame latency, and aggregate Chromium/GPU memory acceptance
separate from these worker measurements.
