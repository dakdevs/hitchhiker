# Engine shutdown delivery

The extension checkpoint `6385f23` passes all 143 native tests and the relocated developer bundle.
Review found a separate scheduling gap in the runtime: `EngineConnection.stop` clears its buffered
event queue and shuts down the event PubSub when a pipe or child process exits. Parsed terminal
events can be dropped while an existing subscriber is busy with a controller lock or filesystem write.
The usual four-session native restoration test passes; it does not establish lossless shutdown.

## Required contract

Preserve the current bounded transport, typed request errors, profile lease and child-process cleanup.
When the engine exits normally, deliver all parsed host events in order and allow already subscribed
handlers to finish before `engine.exit` reports success. Distinguish publishing into a PubSub from a
consumer completing its handler. A stuck consumer must produce an explicit bounded drain error;
do not keep the application alive indefinitely or treat a fixed delay as completion evidence.

Late subscriptions must terminate immediately after the stream becomes terminal. Raw-CDP pipe EOF
must not destroy buffered host events before host stdout finishes. Malformed frames, capacity errors,
scope interruption and abnormal child exit must retain bounded cleanup and must not leak helper
processes or return success. The following design review is accepted; implementation and behavioral
verification are in progress.

## Accepted implementation direction

Keep immediate operation failure separate from event-stream termination. Operation shutdown rejects
new requests and fails pending requests/CDP work without destroying host-event queues. The stdout
reader alone ends the delivery queue after parsing its final frame; a terminal stream marker follows
the queued events in FIFO order. Child exit records its result and closes registration for new
subscriptions, while allowing the reader to finish.

Track streams registered before termination. Their stream scopes unregister only after releasing
their PubSub subscription, so a departing subscriber cannot keep a publisher blocked. Successful early
completion is valid; failure or interruption after termination begins becomes an explicit consumer
failure. Streams opened after termination complete immediately. The completion guarantee covers an active direct sequential consumer, including effects awaited by
its `runForEach` handler. It does not cover work beyond an asynchronous stream handoff: `merge` and
buffering may close an upstream branch after transferring its last item while a downstream handler
is still running. Detached work is also excluded. Shutdown-critical controller persistence stays in
a direct engine-event consumer. Plugin events currently merge with UI events; final delivery into the
plugin host is outside this guarantee.

Expose logical exit only after child exit, host EOF, terminal delivery and registered-handler
completion. Use one configurable drain deadline for the whole sequence (five seconds by default),
with an explicit timeout error. Forced scope cleanup interrupts/closes resources directly and must
never wait for a coordinator that an enclosing scope has already interrupted. Existing public service
members remain compatible; the timeout option is additive.

## Acceptance

- Establish subscribers before a fixture emits a burst and exits. A temporarily busy subscriber
  eventually receives all events in order and finishes its final side effect before `exit` succeeds.
- An intentionally stuck subscriber receives a bounded, explicit failure, with all transport and
  process resources cleaned up. No arbitrary observer sleep is needed in the test.
- Verify no-subscriber, early-completing and late-subscribing streams, concurrent stop signals,
  host-stdout/CDP EOF ordering, malformed output, request cancellation and finalizer interruption.
- Preserve the existing request/backpressure and exclusive raw-CDP management tests.
- Rerun actual native page restoration, extension restart/removal, MCP/plugin lifecycle and relocated
  bundle checks. Keep interactive before-unload cancellation separately marked until tested on an
  unlocked desktop.

## Review findings during implementation

Effect's merged channels each have a separate scope, so an unrelated open branch does not hold the
engine branch registered. An upstream `Channel.onExit` hook is insufficient for consumer tracking;
it can report source completion before downstream effects finish. Register the tracking finalizer in
the consuming scope before subscribing, and keep it as the sole participant-release path.

The regression must observe actual child exit before releasing a blocked handler. Merely observing
its first event is too early: a handler failure can legitimately happen before shutdown begins.
Likewise, checking the final consumer result before `engine.exit` does not prove exit waited for it;
the test must inspect pending exit while the final awaited side effect remains gated.

## Implementation and portable verification

The runtime now separates operation rejection from FIFO event-stream termination. Registration is
checked before and after acquiring the PubSub subscription, then recorded without a yielding boundary.
Only participants that actually registered can report a shutdown consumer failure. The stream-scope
finalizer releases the subscriber before accounting for its completion.

One deadline covers child observation, host EOF, event delivery and participant completion. A forced
drain shuts transport queues and uses the owned child-process handle to send SIGTERM, escalating to
SIGKILL after 100 ms if needed. It does not signal a raw PID retained after process exit. Enclosing
scope teardown also settles a captured logical exit with `closed`; successful prior exit remains
unchanged. Consumer fibers beyond the engine boundary remain owned by their enclosing scopes.

Independent re-review accepted the implementation. Root `pnpm check` passes, including 21 engine
regressions. The final-event gate verifies exact FIFO order and that the last awaited side effect
finishes before logical exit is observed. Tests also cover direct failure/interruption, a permanently
blocked consumer, merged branch completion, late subscription after layer closure, CDP EOF before
host events, abnormal/incomplete output and a child that closes stdout but ignores SIGTERM. The last
case keeps the caller scope open and observes the child disappear before leaving it. Native and
relocated-bundle verification follow below.

The serial native lane passes all 89 runtime and 64 browser tests (153 total, no skips). This includes
actual Chromium extension replay/removal and page restoration, scoped MCP operations, isolated plugin
lifecycle and recovery, profile isolation and descriptor leases. Evidence is in
`work/engine-drain-root-final.log` and `work/engine-drain-native-final.log`.

The developer app was rebuilt from the finalized runtime and relocated outside the checkout to a path
with spaces. Strict signature/import verification passes. All four integration cases pass using the
relocated engine or bundled launcher: managed extension restart/removal, official MCP DOM control,
persistent plugin lifecycle, and safe mode with invalid plugin and extension stores. Logs are
`work/engine-drain-bundle-build.log`, `work/engine-drain-bundle-verify.log` and
`work/engine-drain-bundle-native.log`. It remains an ad hoc signed arm64 developer app; interactive
macOS verification, release signing/notarization and updates remain outstanding.
