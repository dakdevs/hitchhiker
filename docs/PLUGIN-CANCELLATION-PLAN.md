# Plugin mutation cancellation

GitHub Check `34057245706` on docs-only commit `a560870` exposed a pre-existing update cancellation
bug: the candidate revision remained persisted instead of the previous known-good revision. The
manager stopped the old process and persisted the candidate before installing its activation recovery
handler. Its cancellable filesystem promise could also continue a rename after cancellation released
the mutation lock. Downstream runtime tests were cancelled when Turbo stopped the failed run.

## Implemented boundary

Install and rollback now register recovery before the first stop or candidate write. Enable shares
that recovery boundary. Normal startup/readiness remains interruptible; cancellation stops the
candidate and restores the previous revision, or disables an interrupted initial installation/enable.
A prior disabled revision stays disabled. Rollback recovery retains the original revision chain.

Each registry write awaits its actual write, fsync, close, rename and directory fsync before
cancellation can finish or recovery can write again. Failed writes clean up only temporary files
created by that operation. Stopping removes ownership and awaits actual worker termination as one
uninterruptible operation. Disable completes stop plus disabled-state persistence before delivering
cancellation; cancellation does not promise that an already-started disable had no effect.

The directory mutation lock remains held through write settlement and recovery. If recovery cannot
persist a coherent state, or disable/crash/startup restoration persistence fails, the manager rejects
further mutations until restart. Read-only inspection remains available. Ordinary validation/permission
rejections do not poison the manager, and this condition does not close the whole browser. Restart
still follows durable activation markers and requires valid artifact grants.

## Verification

The startup-cancellation regression now waits for candidate startup rather than sleeping 40 ms. A
second regression interrupts while the previous worker's finalizer is deliberately held. Dedicated
filesystem tests pause an actual registry rename, request cancellation and verify that a second manager
cannot acquire the write lock until the first write and recovery settle. They cover initial install,
update, rollback, enable and disable. Separate failures exercise recovery poisoning/restart, disable
persistence and post-promotion crash persistence.

The tests run with Node 24.19.0 in isolated test processes. They synchronize the built-in filesystem
binding and restore it in `finally`; macOS temporary paths are canonicalized before matching the
manager's canonical registry path. Gates release on assertion failure. No production test hook is
introduced. An isolated copy of the pre-fix implementation supplies the negative regression baseline.
Final root/native/bundle evidence is recorded in [PLAN.md](PLAN.md).
