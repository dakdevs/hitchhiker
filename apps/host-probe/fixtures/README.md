# Host probe fixtures

Run `fnm exec --using=24.19.0 -- node apps/host-probe/scripts/serve-fixtures.mjs` from the repository root.
The server only binds `127.0.0.1:4319` and serves exactly `/one`, `/two`, and `/fixture.js`.

Each fixture page exposes an editable input, counter button, and an instance nonce generated once
per document load. A hide/rebind/split operation that preserves a document must preserve all three.

`extension/` is an unpacked Manifest V3 **test-only** extension. It runs only on the two exact
localhost URLs and shows its service-worker storage counter plus the sender's tab/window IDs. It
uses `storage` and `tabs`; it does not prove extension API compatibility beyond content-script,
service-worker messaging, storage, and sender metadata. Load it only in the dedicated probe profile.
