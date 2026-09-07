# Chromium capability audit

This is an implementation inventory as of September 7, 2026, not the intended final API. The public
reference must eventually include executable examples, profile scope, grants and lifecycle behavior
for each supported capability. A private host method does not imply a public plugin API exists.

| Capability        | Current implementation                                                                            | Public plugin gap                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pages             | Plugin SDK and MCP expose list/open/navigate/close; plugins also expose a revisioned page watch.  | Page invalidation events require a fresh watch snapshot; DOM operations use a separate origin-scoped grant.                                            |
| History/loading   | Plugin SDK and MCP expose back/forward/reload/stop; page snapshots include loading/history flags. | `pages.manage` grants history controls; `pages.list` grants page snapshots and watch.                                                                  |
| DOM               | SDK and MCP snapshot/click/fill share scoped, document-bound references and origin grants.        | See the [DOM reference](PLUGIN-DOM.md); developer and installed Native fixtures pass with disposable test Keychains.                                   |
| CDP               | Private page-scoped `cdp.send`; separately authenticated raw relay with explicit `cdp.connect`.   | The manifest accepts `cdp.connect`, but the plugin dispatcher exposes no CDP operation yet.                                                            |
| Cookies/storage   | Raw CDP may expose relevant domains through the explicit relay.                                   | No typed host/plugin/MCP service.                                                                                                                      |
| Network           | Chromium and Chrome extensions retain their own networking behavior.                              | No Hitchhiker request inspection/interception API.                                                                                                     |
| Site permissions  | Chromium handles its site permissions; Hitchhiker grants protect framework APIs.                  | No site-permission query/configuration plugin service. Framework grants are not site permissions.                                                      |
| Downloads         | CEF handler and a download-active page protection signal exist.                                   | No plugin list/cancel/open/management API.                                                                                                             |
| Chrome extensions | Trusted review/staging/install/uninstall/restart replay uses Chromium's extension support.        | [SDK/MCP upload, review requests, inventory and removal](EXTENSIONS.md); approval remains native. Default management UI and change events remain open. |
| DevTools UI       | Host, SDK and MCP controls; portable and isolated real Chromium lifecycle tests pass.             | [Default toolbar startup passes; production Keychain and full application acceptance remain open](DEVTOOLS.md); docking is unavailable.                |

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

The framework's end state is a minimal trusted host plus replaceable product plugins. This includes
the default browser features. The trusted host supplies Chromium lifecycle and isolation, authority
checks, resource enforcement and Native UI primitives; plugins supply product behavior and compose
the interface through public contracts. Tab identity and lifecycle, tab presentation and pinning are
separate building blocks. Consumers must be able to replace their composition without adopting the
default tab UX. Shared design primitives and motion rules provide consistency without fixing the
browser's information architecture.

Current private features must remain labeled as extraction work. In particular, the
[extension-management surface map](EXTENSIONS.md#framework-api-availability) identifies controller
operations that are not yet available through the SDK or MCP. Upstream Chromium support alone is
not evidence of a supported Hitchhiker API.

## DevTools and security reference acceptance

DevTools must ship enabled through a default plugin. Its public building blocks must let another
plugin open, close and select an inspected page, react to its lifecycle, and compose the supported
DevTools presentation. Document separately what can customize the surrounding Native interface,
what can extend the DevTools frontend, and what requires a Chromium integration change. Merely
opening a raw CDP connection does not satisfy the default DevTools experience.

The security reference must distinguish three layers:

- Chromium site policy: permission decisions and supported per-profile or per-origin controls.
- Hitchhiker authority: manifest requirements, user-issued grants, origin scope and revocation.
- Process enforcement: the host boundary and Chromium isolation that apply even to default plugins.

For every configurable policy, document its default, supported values, scope, persistence, restart
requirements and effect on existing pages. For every privileged API, show both a successful call
and its denied or revoked behavior. Label unavailable controls explicitly; do not imply that an
arbitrary Chromium API or security override is available because an upstream primitive exists.

The reference should answer “which pieces can I use?” directly: each entry needs its public API
signature, required grant, corresponding event, a runnable plugin example and verified limitations.
Default feature plugins should link to these same entries rather than use a separate internal API.
