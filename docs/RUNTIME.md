# Native runtime and browser control

The runtime connects a TypeScript broker to one dedicated Chromium process per profile. The
Native surface and Chromium content are real integrations; this is still a development build.

## Verified behavior

The opt-in native test starts two actual Chromium profiles against a local fixture. It verifies:

- Private host requests create and navigate a page.
- A public Native component tree commits, reports measured viewport bounds and binds a page.
- An invalid binding is rejected.
- The browser-root CDP pipe answers `Browser.getVersion`.
- Playwright 1.63.0 connects through the authenticated WebSocket relay, discovers the existing page,
  reads its title/input and changes the input.
- Revoking the persisted `cdp.connect` grant disconnects Playwright.
- Cookies and local storage remain separate between profiles; the original input survives.
- Both Chromium processes close with exit code zero.

Build the native host using [its build instructions](../apps/host-probe/README.md), then run:

```sh
HITCHHIKER_NATIVE_BINARY="$PWD/work/host-probe/build/Release/hitchhiker-probe.app/Contents/MacOS/hitchhiker-probe" \
  pnpm --filter @hitchhiker/runtime test
```

Without that environment variable, portable tests explicitly skip the Chromium integration. A green
portable check alone does not prove native behavior. The separate host regression continues to test
100 single/split layout transitions, twelve page lifecycles and local MV3 extension messaging/storage.

## Process boundary

`EngineConnection` starts a dedicated executable with fixed security-owned switches. It does not
accept arbitrary Chromium arguments. The host protocol uses newline-delimited JSON over inherited
stdin/stdout; browser-root CDP uses NUL-delimited JSON on inherited descriptors 3 and 4. The engine
opens no TCP debugging port. Web pages receive neither channel.

Input frames, outstanding requests and queues are bounded. Malformed data, a critical pipe ending or
engine exit rejects new operations and fails pending requests immediately. Host stdout drains through
a FIFO queue before its event stream ends. Logical `engine.exit` waits for child exit, host EOF,
queued delivery and active direct consumer scopes. Its default five-second drain deadline is
configurable with `eventDrainTimeoutMs` (50–60,000 ms); an unfinished drain fails explicitly.

Keep shutdown-critical persistence in a direct sequential `engine.events` consumer. Work after an
asynchronous `merge` or buffering handoff, and detached fibers, is outside the upstream consumer-scope
guarantee. A direct handler that fails or is interrupted after shutdown begins prevents successful
logical exit. Scope teardown closes child resources. Keep this unrestricted service inside the trusted
broker. See [the shutdown contract and verification plan](ENGINE-DRAIN-PLAN.md).

## Browser replacement

A logical page survives Chromium replacing its browser object. The private host assigns each browser
attachment a generation, preserves display metadata and viewport ownership, and retires old CDP
requests/observers before reporting replacement. A temporary gap is unavailable, not a logical close.
The controller requires the `pageBrowserGeneration` host capability and ignores stale generations.
Resource state is unknown until the new main document commits; incomplete or generationless signals
cannot make a page eligible to freeze. Scoped automation drops old document handles on replacement.

Replacement alone does not establish that a page was discarded. This path preserves identity and
supports explicit Reload; automatic restoration waits for a positive discarded-state check. See
[the replacement contract](REPLACEMENT-PLAN.md) for callback ordering and verification work.

## Page resource protection

Native resource snapshots report audio, capture, downloads and conservative unsaved-input protection.
A native editable-key mutation protects the page until a new main document commits. Same-document
fragment/history changes and subframe loads retain that flag; the main-frame `OnLoadStart` callback
clears only unsaved input, preserving the other signals. This does not infer application save state.
The native regression verifies a real Backspace edit, retention through those navigation cases and
clearance on a replacement main document. Automatic resource policy currently freezes inactive
pages. The controller excludes unknown/loading browser generations and activates a frozen page when
its current generation reports navigation. These event-based protections do not make a cross-process
mutation atomic. Targeted extension discard bypasses Chromium eligibility and remains experimental;
see [DISCARD-PLAN.md](DISCARD-PLAN.md) for the required native guard and inspection evidence.

## Native composition

`@hitchhiker/ui` provides serializable row, column, stack, scroll, text, button, input, icon, spacer
and viewport components. Native compiles once; TypeScript supplies trees at runtime. The adapter
validates unique keys, node/depth/child counts, string/style limits and increasing revisions before
replacing the previous tree. Invalid commits retain the existing tree.

`NativeSurface` separates trees from bindings of logical viewport IDs to page IDs. Native measures
the rectangles; the broker rounds their edges inward and applies them to Chromium. It ignores the
initial zero-sized semantics snapshot. Updating an unchanged page binding preserves its placement.
Pages remain alive when the interface changes. The controller retains at most 32 closed-page
records; opening and closing pages cannot accumulate an unbounded in-memory history.

Press events are revision fenced. Queued text edits can survive updates of the same input in the
same interface identity; removing the field or changing the identity invalidates them. A plugin host
must derive `Surface.identity` from the installed plugin, rather than trusting a proposed identity.

The default interface uses these public components for sidebar or horizontal top tabs, pinning,
navigation and a native welcome view. Its tab state is separate from the core page model. The 23
embedded icons are actual `lucide-static@1.41.0` assets with their upstream license.

AppKit forwards pointer, scroll, keyboard, text and IME input. The current renderer remains the
Native CPU reference path on a 30 Hz timer, using the actual Retina backing scale, reused bounded
pixel storage, damage rendering, and idle revision gating. A stress run accepted 250 changing trees
without a crash; 29 of 282 timer ticks skipped raster work. Metal presentation, full native
accessibility and interactive input verification are not complete.

## Grants and CDP relay

### Trusted managed sessions

`EngineConnection.openCdpSession(targetId)` is an internal, scoped API for trusted browser code.
It returns `request(method, params?)`, a single-consumer `events` stream of `{ method, params }`,
and an awaited `close` effect. It never returns protocol request or session IDs. The caller must
derive the Chromium target from authoritative page state; do not expose this connection or accept
untrusted target IDs. A public plugin CDP API is not implemented yet.

The lane supports eight active/opening sessions, 32 normal pending protocol requests and eight
reserved cleanup slots. Each session buffers at most 32 events of at most 256 KiB each. Initial
events have the same bounds, including events received before the attach response. Overflow fails
the opening operation before adoption, or the event stream after adoption, and starts detach rather
than blocking extension reply delivery. Commands use the
engine request deadline (15 seconds by default) and the existing 32 MiB CDP frame limit. Scope
release awaits cleanup. A failed detach remains closed and prevents raw takeover until detachment is
confirmed; an unknown attach
requires engine restart. Closing another session cannot clear that uncertainty.

The transport denies `Target.*` and `Extensions.*` in session requests and injects owned session
IDs itself. Typed extension installation/removal retains its reserved request-ID range and remains
available during managed sessions. Raw relay ownership stays exclusive. This transport boundary
does not implement plugin authorization, origin isolation or a public method policy. See the
[DevTools plan](DEVTOOLS-PLAN.md#engine-session-lane-implementation) for verification and remaining work.

### Durable grants and raw relay

The grant store generates a 32-byte random bearer credential and persists only its SHA-256 hash.
The containing directory is mode 0700 and the atomically replaced grant file is mode 0600. The store
limits file size and grant count. Authorization rereads durable state under its mutation permit and
checks profile, capability, origin, expiry and revocation. A principal is a bearer-grant label, not a
separately authenticated identity. Mutations use an atomic directory lock across processes. A stale
lock after a crash fails closed; stop all writers before removing it manually.

`browser.full-control` does not grant raw CDP. A separate `cdp.connect` grant is required. Raw CDP
confers control of its entire Chromium profile; page-level origin restrictions cannot constrain it.

The relay binds an ephemeral port on `127.0.0.1`, requires an unguessable capability URL or bearer
header, validates Host, denies supplied Origins unless explicitly allowed, and permits one client.
It checks authorization on discovery, upgrade, every message and an idle timer. Revocation hints can
close it immediately; repeated durable authorization remains authoritative. Disconnect or backend
failure closes the relay. A new principal must not inherit an old client's retained CDP sessions;
the application-level lease/restart policy remains to be integrated.

The local MCP launcher and isolated plugin runtime are described in [DEVELOPMENT.md](DEVELOPMENT.md).
Persistent compiled plugin installation, updates, rollback, removal and restart restoration are integrated.
`hitchhiker_plugin_uninstall` requires `plugins.install`, stops the worker, revokes the current and
rollback revision grants, and removes its registry entry. Removal retains pages and cached artifacts.
The native Plugins screen exposes the same operation as **Remove**. See
[PLUGIN-REMOVAL-PLAN.md](PLUGIN-REMOVAL-PLAN.md) for partial-failure and cancellation behavior.
The optional plugin MCP tools delegate authority from the connection grant and cannot grant raw CDP.
Portable customization recipes combine engine settings, default tab placement and optional plugin
requirements. `hitchhiker_customization_export` takes optional `includePlugins` (default false) and
returns `result.recipe`, a JSON string. `hitchhiker_customization_import` takes that string as `recipe`,
applies settings and returns `pluginRequirements` with `pluginsChanged: false`. Both require
`configuration.write`; including or importing plugin metadata additionally requires `plugins.install`.
Import never installs or activates plugins or grants authority, including for matching installed
artifacts. Recipes exclude browsing sessions, credentials, source code and plugin storage; configured
always-awake origins are included and can reveal preferred sites. See [CUSTOMIZATION-PLAN.md](CUSTOMIZATION-PLAN.md)
for the strict version, size and persistence boundaries. The older configuration-only helpers remain available.
Scoped top-document snapshots and semantic click/fill use connection-local refs and repeated origin
authorization. Child frames and general keyboard input remain unsupported; see
[the scoped DOM contract](SCOPED-DOM-PLAN.md).
Remote MCP, full extension installation/compatibility and release packaging remain unfinished. The
relocatable developer app passes native plugin lifecycle tests; it is not a notarized release. Do not expose the
private engine channel as a public MCP transport or describe this build as a production browser.
