# DevTools plugin API

This API passes portable contract tests and real Chromium lifecycle tests with a disposable
mock-Keychain profile. A compiled plugin also passes against the actual plugin host and Native
surface with synthetic toolbar events. The V2 default bundle passes a real Native startup fixture
with five active plugins, inspector open/close and grant-revocation cleanup. These fixtures use a
disposable mock-Keychain profile; full application-entrypoint and physical UI acceptance remain
outstanding. Normal macOS Keychain startup is still unresolved. See [the integration plan](DEVTOOLS-PLAN.md) for outstanding
acceptance work.

## Authority

Declare `devtools.manage` in the plugin manifest and obtain a current grant for the active profile.
`browser.full-control` implies this capability. `cdp.connect` remains a separate grant.
DevTools authority is **profile-wide**: the full frontend can evaluate scripts, inspect frames and
navigate pages. An origins list does not narrow it. This grant neither disables Chromium's process
isolation nor grants arbitrary access to the native host bridge.

## Operations

| Plugin SDK                              | MCP tool                     | Result                                                  |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| `api.devtools.status(pageId)`           | `hitchhiker_devtools_status` | Current inspector status                                |
| `api.devtools.show(pageId, inspectAt?)` | `hitchhiker_devtools_show`   | Open or focus the inspector; optionally inspect a point |
| `api.devtools.close(pageId)`            | `hitchhiker_devtools_close`  | Request inspector closure                               |

SDK calls return promises. MCP takes an object containing `pageId` and, for show only, optional
`inspectAt: { x, y }`. Coordinates are integers from 0 through 32768 in the target view.
Every call checks the manifest, current grant and principal. Missing authority, malformed arguments,
a missing target, unsupported host integration and exhausted inspector capacity reject the call.

All three return `{ pageId, generation, instance, state }`. State is `closed`, `opening`, `open`
or `closing`. Generation identifies the page incarnation; instance increases for each inspector
creation. A successful show/close request does not imply the asynchronous transition has completed.
Use status or `devtools.changed` events to observe it. Consumers must tolerate events becoming stale
while queued and refresh status before making decisions about a current inspector.

## Lifecycle and resources

The native implementation hosts a standalone Chromium DevTools window. Inspector windows do not
become ordinary Hitchhiker pages or tab entries. At most four inspectors may be opening, open or
closing at once. Opening wakes a sleeping target; inspection protects it from automatic freezing
until closure. Pins are independent of this protection.

Each plugin activation or MCP connection owns the windows it opens. Showing an existing inspector
transfers cleanup responsibility to the caller. Stopping a former owner must not close its successor's
inspector. Owner shutdown and grant revocation trigger cleanup; the host checks private ownership
leases and page/inspector identities before acting. Those private fields are not SDK arguments.
Explicit `close` is intentionally profile-wide and can close an inspector opened by another caller.

## Default bundle

Fresh eligible profiles use bundle format 3. It installs seven artifacts: the tab model, pins,
layout, both alternate presenters, `default-devtools`, and `default-extension-management`. A selected
presentation activates the model, pins, layout, one presenter, the DevTools toolbar, and extension
management: six isolated workers. The toolbar is
a second contribution in the presenter's toolbar slot, after the presenter contribution. It reads
the selected page from the model service, refreshes inspector status after model or layout changes,
and uses `configuration.read` only to match the interface color scheme. It does not own page state
or call page APIs.

The model service provider has `pages.list`, `pages.manage`, and `storage.local`. The current
service-authority containment rule requires a consumer's authority to contain its provider's
authority, so `default-devtools` declares and receives those three capabilities in addition to
`ui.compose`, profile-wide `devtools.manage`, and `configuration.read`. The extra page and storage
capabilities permit the service binding; they do not expand the toolbar's module API use.

Published V1 and V2 bootstrap journals retain their frozen artifact cohorts and grants. V1 never
acquires `default-devtools` or `devtools.manage` automatically, and neither predecessor receives
extension-management authority automatically. Completed, abandoned, removed, and custom
plans likewise remain unchanged unless an explicit future migration authorizes a change.

## Build a replacement

The [standalone workbench](../apps/devtools-plugin/src/index.ts) (`devtools-workbench`) uses only the
public SDK and shared UI components. Its manifest declares `pages.list`, `devtools.manage` and
`ui.compose`: page discovery, inspection and Native presentation are separate capabilities. Build
it from the repository root:

```sh
pnpm install
pnpm exec turbo run build --filter=@hitchhiker/devtools-plugin
pnpm --filter @hitchhiker/devtools-plugin test
```

Inside a plugin with the declared and granted capabilities:

```ts
const result = await api.devtools.show(selectedPageId, { x: 12, y: 24 });
// "opening" is valid: creation completes asynchronously.
const current = await api.devtools.status(result.pageId);
await api.devtools.close(current.pageId);
```

Replacing these Native controls does not replace the Chromium DevTools frontend. Docking the frontend
inside a Native region, custom DevTools panels/extensions, arbitrary protocol calls through this SDK,
and browser security-policy administration are not exposed by these methods. Each needs a separately
documented and verified bridge. The [Chromium inventory](CHROMIUM-CAPABILITY-AUDIT.md) lists those gaps.
