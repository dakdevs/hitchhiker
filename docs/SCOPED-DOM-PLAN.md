# Scoped DOM first slice

This document defines the implemented and independently verified scoped DOM slice. The first slice provides a bounded accessibility snapshot
of the top document and opaque-reference `click` and `fill` actions. Child-frame content and general
keyboard input remain unavailable until their target identity can be proved at the native boundary.

## Security boundary

The public caller supplies only a stable Hitchhiker `pageId`, an opaque reference returned by the
same connection, and bounded action data. It never supplies a selector, JavaScript, CDP method,
backend node ID, frame ID, execution context ID, filesystem path, or session ID.

The trusted browser process may use the private page-scoped `cdp.send` request. That request resolves
the stable page through `PageManager::BrowserForPage`, but it still accepts arbitrary CDP method and
parameter strings. It must remain behind a closed, typed adapter and must never be added to an MCP or
plugin facade. The raw browser CDP pipe is also excluded: it is browser-wide, separately granted,
and may be exclusively owned by the relay.

Every operation preserves these invariants:

- The current top document has a canonical HTTP(S) origin and the connection's current grant allows
  `pages.read` or `pages.write` for that exact origin. Existing `browser.full-control` semantics are
  preserved, but an opaque or non-HTTP(S) top origin is still unsupported.
- A reference identifies one stable Hitchhiker page, the top frame, one document loader, one
  browser-issued execution-context `uniqueId`, and one DOM node. It cannot be replayed on another
  connection, page, frame, or document.
- A stale node fails. There is no role/name, selector, ordinal, coordinate, or neighboring-page
  fallback. This intentionally differs from agent-browser's role/name fallback after a stale backend
  node.
- Main-world JavaScript is hostile. All helper code is a fixed source string owned by Hitchhiker and
  runs in a per-document isolated world created with universal access disabled. Values returned by
  JavaScript and every CDP response are decoded as untrusted data.
- Navigation, frame detach, context destruction, page close, cancellation, grant loss, malformed
  responses, and limit violations fail closed. A late reply cannot commit references or become the
  reply to a newer operation.
- A write protects the page from background freezing before it can mutate the document. Protection
  remains conservative until close clears it.

Chrome documents `ExecutionContextDescription.uniqueId` as system-unique across processes and
specifically recommends `uniqueContextId` to avoid evaluating in a different context after a
cross-process navigation ([Runtime domain](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)).
`Page.Frame` supplies a frame ID, loader ID, and security origin, while `Page.getFrameTree` supplies
the current hierarchy ([Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/)).
These browser-issued values, rather than the controller's eventually consistent URL, establish the
document identity and origin.

## First public API

The runtime registers these optional MCP tools only when the browser supplies a scoped DOM facade:

```text
hitchhiker_page_snapshot { pageId, interactiveOnly?, maxDepth? }
hitchhiker_page_click    { pageId, ref }
hitchhiker_page_fill     { pageId, ref, value }
```

Inputs use exact-object schemas. `pageId` and `ref` are at most 64 characters, `value` is at most
16 KiB of UTF-8, `maxDepth` is an integer from 1 through 8, and `interactiveOnly` defaults to true.
The snapshot result is structured JSON:

```ts
interface PageSnapshot {
  readonly pageId: string;
  readonly snapshotId: string; // opaque, connection-local
  readonly nodes: readonly {
    readonly parent?: number; // index into the bounded nodes array
    readonly role: string;
    readonly name?: string;
    readonly value?: string;
    readonly states?: readonly string[];
    readonly ref?: string; // present only for supported actionable DOM nodes
    readonly frameBoundary?: "child-frame";
  }[];
  readonly truncated: boolean;
}
```

No output contains an origin, URL, frame ID, loader ID, execution context, backend node ID, object ID,
or CDP error. Website-derived strings are untrusted content. Public errors use the bounded codes
`not_authorized`, `page_gone`, `stale_ref`, `covered`, `unsupported`, `limit`, and `browser_error`
with fixed messages that do not reveal a denied frame origin.

One scoped DOM session is created per MCP connection. It holds at most one current snapshot and 512
references per page, at most eight pages, and at most 4,096 references total. A new snapshot for a
page atomically replaces that page's previous references. References use 128 bits of randomness,
expire after 60 seconds, and are cleared on connection close, page close, cross-document navigation,
context destruction, or frame detach. The server stores their meaning; the token does not encode raw
browser identifiers.

The complete encoded public result, including envelope overhead, must be at most 256 KiB. The
builder accounts for UTF-8 bytes as it appends nodes, limits nodes to 512 and each website string to
4 KiB, and returns `truncated: true` before crossing the limit. It does not first construct an
unbounded result and rely on the 4 MiB native CDP reply or MCP transport limit.

## Pinned native spike

Run one preimplementation spike against the repository's pinned CEF
`144.0.6+g5f7e671+chromium-144.0.7559.59`, using the packaged
`HITCHHIKER_NATIVE_BINARY`; tip-of-tree protocol documentation alone is not evidence that this
build behaves as required. Put the gated probe in `apps/browser/test/native-dom.test.ts` and use
only loopback fixtures.

The spike passes only if a request pinned to one stable `pageId` can subscribe before
`Runtime.enable`, observe the existing default context, create a non-universal isolated world for
the top frame, correlate the returned numeric context ID with exactly one
`executionContextCreated` event, and obtain a nonempty browser-issued `uniqueId`. A fixed
`Runtime.evaluate` addressed by that `uniqueContextId` must report the expected top-frame origin.
After a cross-document navigation, the old `uniqueContextId` must fail, the old document marker
must be absent, and resolving/calling the old backend node must leave a sentinel in the replacement
document unchanged. A second stable Hitchhiker page must remain untouched throughout, proving the
private request did not retarget.

The same probe must show that main-world overrides of the helper DOM methods do not affect calls
made through isolated-world intrinsics, and that a timed-out/cancelled command cannot be confused
with a later reply. If any identity correlation, event ordering, isolated-world separation, or
page pinning assertion fails on this CEF build, stop the production slice and adjust the native
trusted protocol; do not fall back to numeric context IDs, cached controller URLs, the selected
tab, or raw browser CDP.

### Spike evidence

The spike passed on September 5, 2026 against the pinned packaged host with:

```sh
HITCHHIKER_NATIVE_BINARY=/absolute/path/to/hitchhiker-probe \
  fnm exec --using=24.19.0 node --test --experimental-strip-types \
  apps/browser/test/native-dom.test.ts
```

The host returned each `cdp.send` result as the selected CDP method's result object, without a CDP
request ID in the private reply, and delivered notifications separately as `cdp.event` with the
stable Hitchhiker page ID and CDP method. `Runtime.enable` replayed default contexts for the top
document and its child frames; the first default event was not necessarily the top frame. The
authoritative correlation must therefore filter `auxData.isDefault` and the exact top `frameId`,
not take the first default context.

On a top document with same-origin and cross-origin child frames, `Page.getFrameTree` reported two
children. `Accessibility.getFullAXTree({ frameId: topFrameId, depth: 8 })` returned 15 top-tree
nodes: 12 had backend DOM IDs, only the root had an explicit frame ID, and actionable button and
textbox nodes had backend IDs but no per-node frame ID. Neither child document's sentinel text was
present. The scoped builder must bind the entire response to the requested top frame, reject any
explicit mismatching frame ID, and must not require every actionable node to repeat the frame ID.

The isolated context event matched the world name, returned numeric context ID and top frame ID,
and carried a nonempty system-unique ID. Its `location.origin` matched `Page.Frame.securityOrigin`.
Calls through isolated-world `Document`, `HTMLElement`, and `HTMLInputElement` intrinsics succeeded
while hostile main-world overrides remained uncalled. After `pages.navigate`, both the old
`uniqueContextId` evaluation and old object call were rejected by CDP; neither the replacement
document nor a second stable page was modified. This proves the top-frame semantic click/fill
foundation on the pinned host. It does not prove OOPIF traversal or page-global input safety.

## Snapshot algorithm

The browser adapter serializes scoped DOM work per page while allowing different pages to progress.
For a snapshot it:

1. Confirms the stable page exists through page-scoped CDP. It subscribes synchronously to the page's
   CDP events before enabling `Page`, `Runtime`, and `DOM`, so context creation or destruction cannot
   be missed between setup calls.
2. Reads `Page.getFrameTree` and captures the top frame's `frameId`, `loaderId`, and `securityOrigin`.
   It rejects an opaque or non-HTTP(S) security origin.
3. Reuses one cached isolated world for the stable page/document, or calls
   `Page.createIsolatedWorld` with one random driver-owned world name and
   `grantUniveralAccess: false` when that document has no world. The 128-entry document cache is
   bounded by the native host's page limit and clears entries on authoritative context, frame, and
   page destruction. It accepts only the `Runtime.executionContextCreated` event whose
   numeric ID equals the command result, name equals the random name, and `auxData.frameId` equals
   the captured top frame. The event's browser-issued `uniqueId` is the authoritative context
   identity. Missing, duplicate, or contradictory events fail.
4. Installs a random document marker in that isolated global by evaluating a fixed expression with
   `uniqueContextId`. It reads `location.origin` there and requires it to equal the canonical
   HTTP(S) `Page.Frame.securityOrigin`. It then calls the grant store with `pages.read`, the current
   profile, and that exact origin. The bearer remains connection state and is never a tool input.
5. Enables Accessibility only for the capture. `Accessibility.enable` makes AX node IDs consistent
   while enabled but has a documented performance cost, so it is disabled in an uninterruptible
   finalizer ([Accessibility domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)).
   `Accessibility.getFullAXTree` is requested for only the top `frameId`, with depth capped at eight.
6. Builds structure from AX `nodeId`, `parentId`, and `childIds`, with cycle, duplicate, node-count,
   string, and byte guards. It preserves virtual AX nodes that lack a DOM node. It creates action
   references only for supported interactive roles with a `backendDOMNodeId`. The complete response
   is bound to the requested top frame because actionable nodes do not reliably repeat `frameId`;
   any node that does carry a different frame ID is rejected. AX nodes from a child document are
   omitted. At most one inert `frameBoundary` placeholder is retained for each visible child-frame
   owner, without its name, URL, origin, descendants, or reference.
7. Reads `Page.getFrameTree` again, evaluates the document marker and origin through the captured
   `uniqueContextId`, checks that no relevant destruction/navigation event advanced the internal
   generation, and reauthorizes `pages.read`. Only then does it atomically replace the page's ref
   table and publish the bounded result. A document change returns `stale_ref`/`browser_error`
   without partial output; callers may request a fresh snapshot.

CDP's AX nodes optionally carry both `backendDOMNodeId` and `frameId`, and DOM can describe or resolve
a backend node for automation ([Accessibility domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/),
[DOM domain](https://chromedevtools.github.io/devtools-protocol/tot/DOM/)). The implementation must
retain the AX graph as the structural source rather than assuming every AX ancestor has a backend DOM
ID.

This first slice does not traverse same-origin or cross-origin child documents. A frame boundary is
not an action reference. This ensures a top-origin grant cannot leak child-frame content. Authorized
cross-origin traversal is a later slice, gated on a real CEF proof that every OOPIF has a separately
addressable target session. CEF's current `ExecuteDevToolsMethod` wrapper has no session argument;
adding caller-controlled `sessionId` to `cdp.send` is not an acceptable shortcut. Future traversal
must resolve each frame's isolated `uniqueId`, independently authorize that frame's exact origin,
and preserve the same fail-closed document binding.

## Click and fill

Both actions look up the random reference in the calling connection's current page snapshot, acquire
the page lock, confirm the page/frame/loader generation is current, re-evaluate the marker and origin
using `uniqueContextId`, and authorize `pages.write` immediately before the mutating call. They use
`DOM.resolveNode` only with the captured backend node and isolated numeric execution-context ID.
Because numeric context IDs can be reused, the single fixed `Runtime.callFunctionOn` action also
checks the random marker in its own isolated global. A resolution into any replacement context lacks
that marker and fails before mutation. Every temporary object belongs to an operation-specific
object group released in a finalizer.

`click` accepts only a snapshot-created reference. Its single fixed isolated-world function scrolls
the exact element to the viewport center, then checks that the node is connected, enabled, rendered with a nonempty box, in the captured top document, and
still under the center-point hit result through the composed parent/host chain. A covering node
returns `covered`; the code never sends coordinates to a replacement document. It invokes the
isolated realm's captured `HTMLElement.prototype.click` on that exact object in the same JavaScript
task. This is semantic DOM activation rather than physical pointer synthesis and should be described
that way. It avoids the unresolved final-check-to-`Input.dispatchMouseEvent` navigation race.

`fill` initially supports only connected, enabled, non-readonly, non-password `HTMLInputElement`
types that accept text and `HTMLTextAreaElement`. Password fill returns `unsupported`. Snapshot
values from password controls are always redacted even if AX or DOM reports a value. The single
fixed function uses isolated-realm intrinsic value setters, focuses the exact object, sets the
bounded value, and dispatches bubbling `input` and `change` events. It does not support file inputs,
selectors, contenteditable, arbitrary attributes, HTML injection, or page-supplied functions.

Before either fixed function runs, the controller records a bounded internal pending-write lease for
the page and activates it if necessary. The freeze selector treats that lease as protected in
addition to native `audio`, `call`, `download`, and `unsavedInput` snapshots. A lease that reached the
mutating call is cleared only by page close, cross-document navigation, or a complete native resource
snapshot observed after the action. The first implementation conservatively retains that boolean
until page close because the current native resource event has no causal sequence proving that a
queued snapshot was produced after the mutation. It must not be cleared on timeout merely because
the reply was lost.

After the call, the adapter checks the captured generation and authorization again before returning
website-derived details. A navigation or revocation during the request suppresses the result and
invalidates the ref table. Cancellation removes the operation from its bounded pending map; a late
CDP reply is ignored by operation ID and cannot settle another request.

## Why general `press` is excluded

CDP defines `Input.dispatchKeyEvent` as dispatching to the page, without a frame, node, loader, or
execution-context precondition. `Input.dispatchMouseEvent` similarly uses coordinates relative to
the main-frame viewport ([Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/)).
Focusing a checked object and then issuing a page-level key command leaves a navigation window in
which the key can reach a replacement origin. Synthetic `KeyboardEvent` from an isolated-world
function is not an equivalent substitute because it does not perform browser default actions such
as form submission or tab focus traversal.

Therefore the first slice does not register `hitchhiker_page_press`. The future tool must wait for a
native compound primitive that accepts only `{pageId, frameId, documentIdentity, backendNodeId,
keyEnum, modifiersEnum}`, performs the identity/focus/input sequence internally, and has a real race
test proving a key cannot reach a replacement document. Failure to prove that property keeps the tool
unavailable. It must never fall back to a page-global focused key press.

Agent-browser is useful behavioral evidence: it maps refs to backend node and frame data, scrolls and
checks interception before coordinate clicks, fills by focusing then using page-level
`Input.insertText`, and sends presses to the page session ([element source](https://github.com/vercel-labs/agent-browser/blob/4726eceeb3274eef34ab082ee04d7288c54dec70/cli/src/native/element.rs),
[interaction source](https://github.com/vercel-labs/agent-browser/blob/4726eceeb3274eef34ab082ee04d7288c54dec70/cli/src/native/interaction.rs)).
Its documented workflow refreshes refs after page changes and reports covered clicks
([command reference](https://github.com/vercel-labs/agent-browser/blob/4726eceeb3274eef34ab082ee04d7288c54dec70/skill-data/core/references/commands.md)).
Hitchhiker should keep those useful behaviors while declining its stale-node retargeting and
page-global key boundary.

## Implementation files

The first implementation packet is contained in these files:

- `packages/runtime/src/scoped-dom.ts` (new): exact schemas, limits, public result types,
  connection-local opaque-ref store, generation state, fixed CDP allowlist adapter interface, and
  snapshot/click/fill orchestration.
- `packages/runtime/src/index.ts`: export only the scoped types and factory, never the raw adapter.
- `packages/runtime/src/mcp.ts`: add the three tools when `McpOptions.dom` is supplied. Create the
  session in the MCP scope and pass an origin authorizer that calls `GrantStoreApi.authorize` with
  the connection bearer for every start/final check.
- `packages/runtime/src/mcp-stdio.ts`: bound echoed JSON-RPC string IDs to 64 UTF-8 bytes and number
  IDs to safe integers, so an incoming ID cannot amplify a bounded snapshot response.
- `apps/browser/src/dom.ts` (new): app-scoped adapter over `EngineConnection.request("cdp.send", ...)`
  containing only literal, fixed CDP methods and helper sources. It consumes page-specific CDP
  events, owns per-page locks/context generations, and exposes no generic send method.
- `apps/browser/src/controller.ts`: expose trusted page existence/activation and pending-write lease
  operations under the existing controller semaphore; merge leases into freeze eligibility.
- `apps/browser/src/main.ts`: construct the adapter and supply it to MCP
  without exposing it to plugins or raw CDP clients.

No native source is required for the top-document semantic click/fill slice if the probe below
confirms isolated-world events and fixed methods work through current page-scoped `cdp.send`. Native
changes for OOPIF routing or trusted key input are separate packets after their protocol is proven.

## Verification evidence and remaining limits

- `packages/runtime/test/scoped-dom.test.ts` verifies connection-local 128-bit refs, password subtree
  redaction, parent-before-child graph ordering, virtual parents, frame-boundary filtering, duplicate/
  cyclic/orphaned identity rejection, invalid backend IDs, TTL, page/ref capacity, conservative full
  MCP-envelope sizing, eager invalidation, an invalidation in the final-check window, atomic failed
  replacement, and interruption before a late capture can commit.
- `packages/runtime/test/mcp-dom.test.ts` uses the official MCP SDK and a real persisted grant store.
  It verifies optional tool registration, exact-object rejection of selector/backend/script inputs,
  normal read/write and full-control grants, durable revocation at the action boundary, session-local
  refs, password redaction, and an actual near-limit response. A raw request with a 64-byte maximally
  escaped string ID remains within 256 KiB; 65-byte and unsafe-number IDs fail before dispatch in
  `packages/runtime/test/mcp.test.ts`.
- `apps/browser/test/dom.test.ts` proves an execution-context event published before the create-world
  reply is observed by the synchronous subscription, a document reuses one world, a loader change
  creates one replacement, transient invalid page IDs do not retain lock entries, non-HTTP origins
  fail before AX capture, 513 ambiguous text controls fail before description or output, write
  authorization brackets controller protection, and AX disable follows both cancellation and an
  enable failure after dispatch.
- `apps/browser/test/controller.test.ts` proves the write lease protects exactly its stable page from
  freezing and leaves another eligible page freezable.
- `packages/runtime/test/native-mcp.test.ts` runs the official MCP SDK through the real browser main
  process and pinned CEF host. It verifies top-frame snapshot/click/fill, offscreen semantic scrolling,
  disabled-fieldset and password rejection, password inputs with an alternate ARIA role, durable
  revocation, 513-password fail-closed behavior, and stale refs across a 127.0.0.1 to localhost
  cross-site navigation.
- `apps/browser/test/native-dom.test.ts` proves page pinning, same/cross-origin child content absence,
  isolated intrinsics under hostile main-world prototype overrides, marker invisibility from the main
  world, and old unique-context/object rejection after navigation while a second page stays untouched.

Focused verification on Node 24.19.0 passed 18 runtime unit/MCP tests and 8 browser
controller/adapter tests. The real official-MCP native integration and pinned native isolation probe
passed before the final race-hardening changes; a current-source native rerun remains an acceptance
step. Child-frame
traversal, physical pointer input, general keyboard input, contenteditable, file inputs, screenshots,
and arbitrary selectors/JavaScript/CDP remain unavailable.

Root `pnpm check` and the complete serial native lane pass after the review fixes: 74 runtime tests
and 31 browser tests, with no native skips. The native log is `work/scoped-dom-native-final.log`.
The rebuilt developer app also passes the official MCP DOM test after relocation outside the checkout
to a path with spaces, alongside plugin lifecycle and safe-mode tests (3/3). Strict bundle verification
passes. See `work/scoped-dom-bundle-native.log` and `work/scoped-dom-bundle-verify.log`.

Acceptance requires unit/type/lint checks, the official MCP client suite, and the real native test on
the packaged host. A test that proves only same-process iframes is insufficient evidence for
cross-origin support. General `press`, arbitrary selectors/evaluation, screenshots, uploads,
contenteditable, child-frame actions, and raw CDP are outside this first slice and must remain absent
from the registered tools.
