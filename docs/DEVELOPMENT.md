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

The local grants command issues credentials deliberately. MCP plugin installation can delegate
only permissions already held by its connection; plugin code cannot silently grant itself authority. `issue` prints JSON containing the one-time bearer token and grant ID.
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
With `HITCHHIKER_PLUGIN_HOST` configured, five additional tools list, install/update, enable, disable,
and roll back plugins. They check durable grants on every call. DOM automation and remote MCP
transport for hosted clients remain additional work. Local stdio support does not by
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
plugin loading on startup and prevent enabling plugins for that launch. See
[the isolation evidence](PLUGIN-ISOLATION.md) for exact resource limits.

## Persistent installation through MCP

Issue the MCP connection a grant that includes `plugins.install` and the capabilities the plugin
will need. For the canvas example, use
`--capabilities=plugins.install,pages.list,pages.manage,ui.compose`. Set `HITCHHIKER_PLUGIN_HOST` as
shown above and launch the stdio server. The bundled developer app supplies the host path itself.
Persistent plugin tools are unavailable in `--safe-mode` or with the `--plugin` developer override.
Safe mode skips opening the plugin store entirely, including invalid directories or registry data.

Call `hitchhiker_plugin_install` with `manifest` containing the package manifest and `code` containing
the compiled JavaScript IIFE. Reinstalling the same plugin ID with a new version is an update. The
server accepts uploaded data; it never reads a caller-selected local path, runs npm scripts, resolves
imports, or accepts a caller-selected grant ID. Stdio frames are bounded at 256 KiB, so keep the entire
JSON request below that limit, including escaping and multibyte text. The direct artifact store has a
512 KiB compiled-code limit.

The connection delegates a child grant with only the plugin's declared capabilities. It inherits the
parent's profile, allowed origins, and expiry. Revoking the connection grant also revokes access for
its installed descendants. Delegation never includes raw CDP. The private plugin registry stores
artifact hashes and grant IDs, not bearer tokens, and is separate from portable configuration.

`hitchhiker_plugins_list` returns installation and running status. Use `hitchhiker_plugin_enable`,
`hitchhiker_plugin_disable`, or `hitchhiker_plugin_rollback` with an `id`. The default interface's
Plugins screen exposes the same enable/disable/rollback controls. Permission grants are still issued
through the trusted CLI; a graphical permission editor remains unfinished.

Each update starts a fresh isolated worker, waits for activation and a short health interval, and
retains the previous revision for rollback. Replacement briefly returns to the trusted interface.
Rollback restores the plugin revision and interface; page creation, navigation, or configuration
changes a plugin already performed are not transactional and are not undone. The manager allows
sixteen installations, four concurrent workers, and one enabled interface owner. Background plugins
can run alongside it. Artifact storage is bounded; package garbage collection and a catalog remain
future work.

Command–Shift–Escape is reserved by the native host to disable plugins and open trusted plugin
controls, independent of the plugin's interface. `--safe-mode` is the startup recovery path. The
shortcut's interactive keyboard routing still needs verification in an unlocked macOS session.

## Verification and remaining release work

`pnpm check` verifies portable code. Native tests require the two executable environment variables;
without them their cases are explicitly skipped. The original host regression also exercises MV3
content scripts, service workers, storage, multiple pages, and repeated layout changes.

After building the workspace and native helpers, use `pnpm test:native` with
`HITCHHIKER_NATIVE_BINARY` and `HITCHHIKER_PLUGIN_HOST` set to absolute executable paths. This command
requires both helpers and runs the runtime and browser suites one file at a time. Avoid competing
native test runs: plugin wall-clock watchdogs intentionally remain active, and simultaneous Chromium
startups can exhaust a fixture's 500 ms command window. The window currently includes cold worker
startup; separating startup from execution accounting remains a performance refinement.

The development build still needs interactive macOS focus/IME/accessibility verification, complete
Chrome extension installation and same-window tab compatibility, a Metal presenter, remote MCP, profile management/export/sync integration, and distribution signing,
notarization, and updates. Reversible freezing reduces inactive CPU work; it is not tab discard or
proof of lower renderer memory use.

The plugin registry uses a private mutation lock. If a broker is killed during a registry write, stop
all profile writers before removing a stale `hitchhiker-plugins/.plugin-write-lock` directory.
Safe mode bypasses plugin restoration; corrupted metadata cannot take down the default browser.
