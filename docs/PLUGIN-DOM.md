# Page content from plugins

Plugins use the same scoped DOM service as MCP. These operations inspect the current top document
through Chromium's accessibility tree and act on opaque references. They expose neither arbitrary
JavaScript evaluation nor raw CDP. Compiled developer and installed plugins pass real Chromium lifecycle tests using disposable
mock-Keychain profiles. Production Keychain startup remains unresolved. Verification is recorded in
[the integration plan](PLUGIN-DOM-PLAN.md).

## API and grants

| Plugin method                                               | MCP counterpart            | Required capability |
| ----------------------------------------------------------- | -------------------------- | ------------------- |
| `api.dom.snapshot({ pageId, maxDepth?, interactiveOnly? })` | `hitchhiker_page_snapshot` | `pages.read`        |
| `api.dom.click({ pageId, ref })`                            | `hitchhiker_page_click`    | `pages.write`       |
| `api.dom.fill({ pageId, ref, value })`                      | `hitchhiker_page_fill`     | `pages.write`       |

All calls return promises. Declare the capability in the plugin manifest and obtain a matching
grant for its principal, active profile and permitted origins. `pages.list` is separate: it discovers
page IDs but grants no content access. `browser.full-control` implies the content capabilities;
`cdp.connect` is separate and unnecessary for these methods. Default plugins receive no additional
permissions from this API. To discover and then use action references, a plugin declares both
`pages.read` and `pages.write`; references cannot be imported from another caller.

The host identifies the current document origin before reading content. It rechecks current grants,
principal, profile and origin during operations. A stored URL or a previous successful snapshot is
not authority to read a page after navigation. Installed and developer plugins use this same path.

## Results and references

Snapshot returns `{ pageId, snapshotId, nodes, truncated }`. Each node contains `role` and may include
`parent` (an index into `nodes`), `name`, `value`, `states`, `ref`, or `frameBoundary: "child-frame"`.
Website labels and values are untrusted content. Child frames are boundaries; these calls do not
traverse their documents. Password values and descendant accessibility content are excluded. Password references cannot
be filled; they may still be clicked or focused with `pages.write`.

References belong to one plugin activation. Another plugin, a replacement activation or an MCP
connection cannot reuse them. A newer snapshot replaces that page's references. References expire
after 60 seconds and become unusable after document or execution-context changes, page closure,
scope cleanup, or loss of authority. Refresh the snapshot before retrying a stale action.

Click returns `{ clicked: true }`; it semantically activates a supported element rather than sending
an unrestricted coordinate click. Fill returns `{ filled: true }` and supports eligible non-password
text controls. Covered, detached or unsupported elements may reject an action. Writes use the
browser's existing page-protection mechanism.

Snapshot depth is 1–8 (default 8). Results contain at most 512 nodes; labels and values are truncated
to 4 KiB each, and output has an additional bounded serialized size. A session retains references
for at most eight pages and 4,096 references total. Fill values must fit within 16 KiB of UTF-8.
Snapshot truncation and reference expiry are normal conditions that plugins must handle.

## Example

Inside an activated plugin, given a page ID from the public pages API or a bound service:

```ts
import { PluginApiError, type PluginApi } from "@hitchhiker/plugin-sdk";

export async function fillName(api: PluginApi, pageId: string, value: string) {
  const snapshot = await api.dom.snapshot({ pageId, interactiveOnly: true });
  const field = snapshot.nodes.find(
    (node) => node.role === "textbox" && node.name === "Name" && node.ref,
  );
  if (!field?.ref) return;
  try {
    await api.dom.fill({ pageId, ref: field.ref, value });
  } catch (error) {
    if (error instanceof PluginApiError && error.code === "stale_ref") return;
    throw error;
  }
}
```

The [compiled fixture plugin](../apps/browser/test/fixtures/dom-plugin.ts) demonstrates snapshot,
fill and click against a local test form. Its [Native test](../apps/browser/test/native-dom-plugin.test.ts)
also exercises stale references, foreign-origin denial and grant revocation. This is test code,
not a default feature or an installed workbench.

## Errors and limits

`PluginApiError.code` exposes fixed, sanitized error categories: `not_authorized`, `page_gone`,
`stale_ref`, `covered`, `unsupported`, `limit` and `browser_error`. Missing capability declarations,
an unavailable adapter or malformed wire arguments may return the existing `denied` code.
Revocation may terminate the plugin before a rejected call can reach its JavaScript handler.
Errors do not expose private browser handles or arbitrary engine exception messages.

This API does not provide selectors, script evaluation, screenshots, request interception,
cross-frame DOM traversal, password reading/filling or browser security-policy configuration. Those are
separate capabilities in the [Chromium inventory](CHROMIUM-CAPABILITY-AUDIT.md).

Plugin scope cleanup releases reference tables and subscriptions, not CEF’s internal CDP client.
The current CEF adapter retains that client per page generation; reversible freezing remains
available, but Chromium debugger protection prevents true discard. Guarded discard remains disabled
until the explicit CEF release patch is compiled and verified. This API does not establish total-browser
RAM or discard acceptance.
