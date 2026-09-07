# Public plugin DOM access

## Scope

Expose `api.dom.snapshot`, `api.dom.click` and `api.dom.fill` through the existing scoped DOM
service. Reuse the browser adapter used by MCP; no raw CDP commands, document handles or backend
node identifiers become plugin parameters. Snapshot requires `pages.read`; actions require
`pages.write`. The default plugins gain no new grants.

## Lifecycle and authority

Share one browser DOM driver across application consumers, preserving per-page operation locks.
Create a finite reference namespace for each authorized plugin activation, with cleanup on stop,
revocation, replacement and scope closure. Only DOM-capable manifests allocate a session.
Every content read and action uses the service's authoritative document origin and current
owner-bound grant; recheck principal, profile and manifest capability. Plugin refs cannot be
used by another activation or MCP connection. Existing expiration, latest-snapshot, navigation,
context, frame, password, covered-element and size restrictions remain in force.

Use the existing seven scoped DOM error codes with sanitized messages through the SDK, retaining
its existing conflict/denied/stale-snapshot codes. Do not forward private engine errors.

## Verification

- SDK wire arguments/results and bounded error codes.
- Runtime denial for missing declarations, read-only authority, foreign origins, revocation and
  cross-activation references; strict argument shapes and scope cleanup.
- Installed and developer launch plumbing use the same public runtime path.
- A compiled plugin operates real Chromium using snapshot references, including navigation and
  revocation rejection; no mock test is described as Native integration.
- Document API signatures, grants, examples, lifecycle and unsupported behavior in SDK/site docs.

Implementation and verification are in progress. Production Keychain acceptance remains separate.

## Integration evidence

The installed path exposed an existing admission bug: manifest validation called origin-scoped
operation authorization before any page origin existed. Admission now authenticates the current
stored grant, verifies principal/profile, and checks declared-capability containment. Full control
does not imply `cdp.connect`. Each DOM operation still performs current origin authorization. Real
grant tests cover scoped admission, absent capabilities, revocation, wrong profiles/principals and
explicit CDP. Existing test grant fakes now carry actual capability metadata.

`work/plugin-dom-native.log` records two passing Native cases, no skips: the same SDK fixture runs
as a developer plugin and through the installed manager/composition. Both fill and submit a local
form, reject stale references after same-origin navigation without altering the new form, deny a
foreign origin, stop on revocation while retaining the page, and close with engine exit zero.
Input is synthetic at the NativeSurface boundary. Test packages and profiles are disposable; the
Keychain wrapper is confined to fixture prefixes and changes no production launch arguments.

Security review distinguishes reference/session cleanup from CEF’s internal CDP connection. The
current driver retains one CEF client per page generation. That does not prevent the existing
reversible-freeze mechanism, but it prevents Chromium discard. Guarded discard stays disabled; the
explicit release patch still needs compilation and validation. No DOM scope-cleanup claim implies
that native client is detached.

The complete local repository check passes 407 portable tests with 34 Native-gated skips, including
dependency, type, lint, format and production build checks (`work/plugin-dom-full-check.log`). The
Native DOM fixture runs its two cases separately with zero skips. Final process inspection finds
no remaining fixture host or plugin worker. The test package compiler uses the repository's exact
esbuild version and public SDK dependency; no handwritten bridge substitutes for the SDK.
