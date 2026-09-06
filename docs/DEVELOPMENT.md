# Run the development browser

Hitchhiker is public source under active development, not a signed release. Run commands from the
repository root with Node 24.19.0 and pnpm 11.24.0. Start with `pnpm install --frozen-lockfile`,
`pnpm build`, and the [native host build](../apps/host-probe/README.md).

```sh
export HITCHHIKER_NATIVE_BINARY="$PWD/work/host-probe/build/Release/hitchhiker-probe.app/Contents/MacOS/hitchhiker-probe"
pnpm --filter @hitchhiker/browser dev
```

The default profile lives at `~/Library/Application Support/Hitchhiker/profiles/default`. Use an
absolute `--profile-root=/path/to/test-profile` for experiments. Chromium owns its cookies, storage,
and extensions; Hitchhiker stores browser configuration, page order, pins, and selection separately.
The current launcher operates one profile per process. Profile-picker UI remains unfinished.

## Local grants

The local grants command issues credentials deliberately; MCP and plugin calls cannot silently
issue their own permissions. `issue` prints JSON containing the one-time bearer token and grant ID.
`list` prints metadata without tokens. `revoke` changes durable state read by existing connections.

```sh
pnpm --filter @hitchhiker/browser grants issue \
  --principal=my-agent --capabilities=pages.list,pages.manage,configuration.write
pnpm --filter @hitchhiker/browser grants list
pnpm --filter @hitchhiker/browser grants revoke GRANT_ID
```

Pass the same `--profile-root` to these commands when using a nondefault directory. Grants persist
unless `--expires-in=SECONDS` is supplied. A separate `cdp.connect` permission is required even when
a credential has `browser.full-control`. Never include credentials in portable configuration or a
plugin manifest.

## MCP

Set `HITCHHIKER_MCP_TOKEN` to the issued credential, then launch the browser with `--mcp` from an
MCP client that supports local stdio servers. Point it at Node and `apps/browser/src/main.ts`; include
`--experimental-strip-types`, `--mcp`, and any profile-root argument. Build workspace packages first.
Standard output is exclusively JSON-RPC. This launcher starts the browser process; it does not attach
to another running instance using the same profile.

The current tools list/open/navigate/close pages, get/set configuration, and select sidebar/top tabs.
They check durable grants on every call. DOM automation, live plugin installation through MCP, and
remote MCP transport for hosted clients remain additional work. Local stdio support does not by
itself establish a hosted ChatGPT connection.

## CDP

Issue a dedicated credential with `--capabilities=cdp.connect`, put it in `HITCHHIKER_CDP_TOKEN`,
and add `--cdp` to the browser launch. The launcher writes a private discovery URL to stderr. Pass
that URL to Playwright's `chromium.connectOverCDP`. The listener is loopback-only and permits one
client. Revocation or disconnect closes the lease; restart the browser to establish another lease.
Automatic page freezing is disabled for the entire launch when raw CDP is requested, including after
revocation or disconnect: raw CDP may have changed unsaved page state outside Hitchhiker's edit
signals. Restart without `--cdp` to restore automatic freezing.

## TypeScript plugins

The checked-in canvas example replaces tab presentation with page cards and a two-page workspace.
It uses the same public Native components as the default browser interface.

```sh
pnpm --filter @hitchhiker/plugin-host build:native
pnpm --filter @hitchhiker/canvas-plugin... build
pnpm --filter @hitchhiker/browser grants issue \
  --principal=canvas-example --capabilities=pages.list,pages.manage,ui.compose
export HITCHHIKER_PLUGIN_TOKEN="TOKEN_FROM_ISSUE"
export HITCHHIKER_PLUGIN_HOST="$PWD/work/plugin-host/build/PluginHost.app/Contents/MacOS/plugin-host"
pnpm --filter @hitchhiker/browser dev --plugin="$PWD/apps/canvas-plugin"
```

A developer package has `hitchhiker.plugin.json` and a compiled `dist/plugin.js`. The launcher reads
only these fixed bounded regular files and rejects symlink escapes. Build the package locally;
the runtime never runs npm scripts, resolves arbitrary imports, or executes the plugin in Node.
Package compilation is currently a developer build step, not an isolated runtime compiler.

Import `definePlugin` from `@hitchhiker/plugin-sdk` and components from `@hitchhiker/ui`, then bundle
as an IIFE. The manifest declares an ID, name, semantic version, and capabilities. Its ID must match
the grant's principal. Declarations and grants are independently checked on each call and forwarded
event. A plugin cannot choose another plugin's identity or receive another owner's UI input.

Activation may return a Promise. It is ready only after that Promise resolves; total activation has
a host deadline. Each revision runs in its own App-Sandboxed JavaScriptCore process. A failed or
revoked UI plugin releases its surface back to the trusted interface. If bounded recovery retries
cannot restore trusted controls, the launcher closes the failed browser session. Add `--safe-mode` to skip
plugin loading on startup. Persistent installation/update UI and known-good revision rollback are
not yet implemented. See [the isolation evidence](PLUGIN-ISOLATION.md) for exact resource limits.

## Verification and remaining release work

`pnpm check` verifies portable code. Native tests require the two executable environment variables;
without them their cases are explicitly skipped. The original host regression also exercises MV3
content scripts, service workers, storage, multiple pages, and repeated layout changes.

The development build still needs interactive macOS focus/IME/accessibility verification, complete
Chrome extension installation and same-window tab compatibility, a Metal presenter, live package
management, remote MCP, profile management/export/sync integration, and distribution signing,
notarization, and updates. Reversible freezing reduces inactive CPU work; it is not tab discard or
proof of lower renderer memory use.
