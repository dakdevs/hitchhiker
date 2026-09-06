# Automation direction

The user requested inspiration from [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser).
Its current interface combines accessibility snapshots with element references, semantic selectors,
and explicit CDP attachment. Its persistent Rust daemon separates command parsing from browser work,
and its streaming path handles input independently of slower output. These are useful design references,
not dependencies or a claim that Hitchhiker has implemented every agent-browser command.

Hitchhiker already separates bounded engine replies, events, and raw CDP traffic. Its local MCP tools
control pages, configuration, installed plugins, and top-document snapshot/click/fill. A separate revocable CDP grant can expose a
browser-level WebSocket endpoint. Playwright attachment is verified; agent-browser attachment still
needs its own integration test. The UI uses [Vercel Native](https://github.com/vercel-labs/native)
inside a CEF-owned window and is not a Chromium-rendered browser toolbar.

## Scoped DOM boundary

The development browser supplies three scoped tools, described in
[the scoped DOM contract](SCOPED-DOM-PLAN.md):

- `hitchhiker_page_snapshot` produces a bounded accessibility tree and opaque element references tied to a
  specific page, frame, and document generation.
- Read and action commands verify the current `pages.read` or `pages.write` origin grant and reject
  references invalidated by navigation. Page output remains untrusted data.
- Semantic click/fill use the checked reference and verify document identity at execution. Navigation,
  overlays, and detached elements must fail without retargeting an unrelated page or element.
- Snapshot output has an explicit size limit, including the MCP envelope. References expire and are
  local to the connection. Password values and child-document content are excluded.
- These scoped operations do not silently expose raw CDP. Raw attachment remains separately granted.

General keyboard input, screenshots and child-frame actions require further native identity and
authorization work. The present tools do not accept selectors, JavaScript or raw CDP parameters.
Hosted ChatGPT access additionally requires a remote MCP
transport and its own connection authorization; local stdio alone does not provide it.
