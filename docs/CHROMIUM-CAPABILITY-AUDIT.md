# Chromium capability audit

This is an implementation inventory as of September 6, 2026, not the intended final API. The public
reference must eventually include executable examples, profile scope, grants and lifecycle behavior
for each supported capability. A private host method does not imply a public plugin API exists.

| Capability        | Current implementation                                                                          | Public plugin gap                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Pages             | Plugin SDK and MCP expose list/open/navigate/close.                                             | Navigation history controls remain private controller/host actions.                               |
| History/loading   | Host exposes back/forward/reload/stop and loading/history flags.                                | No typed plugin or MCP history controls.                                                          |
| DOM               | Scoped MCP snapshot/click/fill use opaque document-bound references and origin grants.          | No plugin DOM API.                                                                                |
| CDP               | Private page-scoped `cdp.send`; separately authenticated raw relay with explicit `cdp.connect`. | The manifest accepts `cdp.connect`, but the plugin dispatcher exposes no CDP operation yet.       |
| Cookies/storage   | Raw CDP may expose relevant domains through the explicit relay.                                 | No typed host/plugin/MCP service.                                                                 |
| Network           | Chromium and Chrome extensions retain their own networking behavior.                            | No Hitchhiker request inspection/interception API.                                                |
| Site permissions  | Chromium handles its site permissions; Hitchhiker grants protect framework APIs.                | No site-permission query/configuration plugin service. Framework grants are not site permissions. |
| Downloads         | CEF handler and a download-active page protection signal exist.                                 | No plugin list/cancel/open/management API.                                                        |
| Chrome extensions | Trusted review/staging/install/uninstall/restart replay uses Chromium's extension support.      | No plugin management API; Hitchhiker-plugin MCP tools do not manage Chrome extensions.            |
| DevTools UI       | Pinned CEF provides `ShowDevTools`, `CloseDevTools`, `HasDevTools`.                             | No host adapter or default DevTools plugin yet; docking/customization is unimplemented.           |

## Source map

- [Public plugin API](../packages/plugin-sdk/src/index.ts)
- [Plugin dispatcher and capability checks](../packages/runtime/src/plugin-dispatch.ts)
- [MCP tools](../packages/runtime/src/mcp.ts)
- [Engine connection and raw relay boundary](../packages/runtime/src/engine.ts)
- [Private native method dispatcher](../apps/host-probe/src/engine_bridge.cc)
- [CEF handlers](../apps/host-probe/src/simple_handler.h)
- [Browser startup and relay wiring](../apps/browser/src/main.ts)

## Required documentation contract

For each API, distinguish typed plugin operations, MCP operations, explicitly granted CDP, and
private implementation details. Document event ordering, cancellation, navigation/replacement,
profile isolation, resource limits and errors. Explain security configuration precisely rather than
using “full control” as an undefined promise. Unsupported CEF/Chromium operations must be labeled
as such. Examples must run against the packaged app and exercise public APIs.

The target architecture and default-plugin requirements are in
[PLUGIN-FIRST-PLAN.md](PLUGIN-FIRST-PLAN.md). This audit does not mark any missing capability done.
