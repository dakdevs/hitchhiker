# Automation direction

The user requested inspiration from [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser).
Its current interface combines accessibility snapshots with element references, semantic selectors,
and explicit CDP attachment. Its persistent Rust daemon separates command parsing from browser work,
and its streaming path handles input independently of slower output. These are useful design references,
not dependencies or a claim that Hitchhiker has implemented every agent-browser command.

Hitchhiker already separates bounded engine replies, events, and raw CDP traffic. Its local MCP tools
control pages, configuration, and installed plugins. A separate revocable CDP grant can expose a
browser-level WebSocket endpoint. Playwright attachment is verified; agent-browser attachment still
needs its own integration test. The UI uses [Vercel Native](https://github.com/vercel-labs/native)
inside a CEF-owned window and is not a Chromium-rendered browser toolbar.

## Next implementation boundary

The following is Hitchhiker's proposed scoped DOM API, not shipped functionality:

- `pages.snapshot` produces a bounded accessibility tree and opaque element references tied to a
  specific page, frame, and document generation.
- Read and action commands verify the current `pages.read` or `pages.write` origin grant and reject
  references invalidated by navigation. Page output remains untrusted data.
- Click/fill/press use the checked reference and verify frame identity at execution. Frame navigation,
  overlays, and detached elements must fail without retargeting an unrelated page or element.
- Screenshot and text output have explicit size limits. Backpressure on output cannot block input
  cancellation, grant revocation, or engine shutdown.
- These scoped operations do not silently expose raw CDP. Raw attachment remains separately granted.

Before claiming completion, test real same-origin and cross-origin frames, navigation races, stale
references, obscured controls, cancellation, output limits, and revocation with both an official MCP
client and an independent CDP client. Hosted ChatGPT access additionally requires a remote MCP
transport and its own connection authorization; local stdio alone does not provide it.
