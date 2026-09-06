# Extension artifacts

`createExtensionArtifactStore({ profileLease })` stages an explicitly selected unpacked MV3 directory at
`profileRoot/hitchhiker-extensions/artifacts/<installation-id>`. Each ID is random lower-case hex and
remains stable for that installation; updates must use a new installation later. The store copies only
bounded regular files through no-follow descriptors, records a deterministic SHA-256 tree digest, and
atomically publishes a private `0700` directory containing `0600` files. Chromium receives only the
published path, never the selected source path.

The factory requires the parent controller's kernel-held `ProfileWriteLease`; it derives the canonical
profile root from that lease. Construction runs a single lease-scoped recovery before exposing the
store. That recovery removes only abandoned private `.stage-<id>`, `.trash-<id>`, and store `.lock`
directories. It never guesses that a published artifact is unused. A second construction with the same
lease does not repeat recovery, so it cannot remove a lock held by the first store. Test code uses the
separate `createExtensionArtifactStoreForTest` seam; production code must not.

After the registry has been validated and a fresh engine is ready, the manager calls the store's one-time
`collectBeforeReplay(retainedInstallationIds, removableInstallationIds)` phase before it loads any
extension or restores pages.
It retains every prepared, installing, enabled, error, and removing artifact; a `removed` tombstone may
be omitted only after the fresh engine proves it has not auto-loaded extensions. The store removes only
unreferenced, profile-owned published ID directories through a rename-to-trash plus directory sync, and
returns their IDs so the manager can prune matching tombstones. It also returns a removable tombstone
whose artifact is already absent, covering a crash after deletion but before registry pruning. The phase
does not return IDs represented by unknown names or non-directory lookalikes. It seals as soon as
collection, staging, or trusted discard begins.

The store enforces MV3, name and Chromium extension version syntax (one to four decimal components,
each `0..65535`, and no leading zero on nonzero components), plus string-only known permission arrays. It preserves unknown manifest keys and
localized `__MSG_*__` values for Chromium to validate. It rejects invalid UTF-8 filenames, unpaired
UTF-16 strings, traversal segments, symlinks and special files; hardlinks are copied as bytes. Limits
are 1 MiB manifest, 256 MiB per file, 512 MiB total, 10,000 entries, depth 64, 4096 UTF-8 bytes per
relative path, and 16 published artifacts.

Metadata is bounded for permission review: `name` is at most 1024 UTF-8 bytes; each known
permission string is at most 2048 UTF-8 bytes; and each known permission array has at most 256
entries. Metadata returned to callers is frozen. Test code alone may pass lowered limits through the
separate test factory; production callers cannot configure these bounds.

The version rule is verified against Chromium's primary [manifest reference](https://chromium.googlesource.com/chromium/%2B/HEAD/chrome/common/extensions/docs/templates/articles/manifest.html#version), rather than the generic base `uint32` parser.

`read(id, digest)` rescans the full published tree and rejects tampering. `discardUnused(id, digest)`
is a trusted manager-only primitive: its caller must prove the path was never handed to Chromium, or
the engine is fully stopped. It never runs automatically, and uncertain load outcomes retain assets.

Every staged/read artifact includes `expectedChromiumId`, derived before loading. On macOS it follows
the pinned Chromium rule: SHA-256 of the canonical published directory's unchanged UTF-8 path (or the
decoded manifest `key` bytes), then map the first 16 hash bytes' hex nibbles to `a` through `p`.
`key` accepts Chromium 144's strict base64 form or its bounded (100 KiB) `-----BEGIN…KEY-----` PEM
envelope; malformed keys reject staging rather than falling back to a path-derived ID.
Stage, read, trusted discard, and startup recovery execute through the profile lease. Stage and trusted
discard transactions are uninterruptible until their underlying filesystem promises settle, so a
controller lease cannot be released while a mutation continues in the background.

Node does not expose `openat` traversal here. The descriptor/stat checks detect ordinary same-user
replacement or mutation before, during and immediately before publish, but they are not an atomic
snapshot guarantee against a privileged writer able to race path resolution.
