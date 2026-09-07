# Chrome extensions

Hitchhiker's developer build manages local unpacked Manifest V3 extensions. Chrome extensions run in
Chromium; Hitchhiker plugins compose the surrounding Native interface. They have separate permission
systems and installation controls.

## Install a local extension in the legacy developer interface

These controls currently exist only in the legacy controller interface used by developer `--plugin`
launches. The normal composed default interface does not expose installation yet. Safe mode also
uses the legacy interface but deliberately omits extension management. See
[development modes](DEVELOPMENT.md) and the [public installation plan](EXTENSION-INSTALL-PLAN.md).

1. Open **Settings → Chrome extensions** in the legacy developer interface.
2. Enter the absolute path to an unpacked extension directory containing `manifest.json`.
3. Choose **Review extension**. Hitchhiker copies the package into private profile storage and shows
   its name, version, Chromium ID, SHA-256 digest, required permissions and site access, and optional
   permissions and site access. Review every permissions page before choosing **Install extension**.
4. Reload an already-open page to run the newly installed content script. New documents receive the
   extension's declared content scripts according to Chrome's matching rules.

The reviewed copy is the package Chromium loads. Changing or removing the original directory does
not change the installation. A pending review can be resumed after restart; cancelling it discards
the unsubmitted package. A failed installation can be reviewed again before an explicit retry.

**Remove** asks Chromium to uninstall the extension. This can remove its extension data; it is not a
temporary disable switch. Files remain until the next safe startup, when the previous engine and
controller have exited. Startup cleanup also recovers abandoned staging copies. Interrupted removal
remains visible and never causes automatic reinstallation.
If the process dies before Chromium finishes uninstalling, the next clean launch removes Hitchhiker's
installation record and package without reloading it. Chromium may retain some extension data from
that interrupted uninstall; package cleanup is not a claim that those bytes were erased.

## Startup, control and recovery

Enabled extensions reload from the same stable profile path before saved browser pages open. This
preserves their Chromium identity and storage. Profiles use separate artifact and registry directories.
The controller holds a kernel file lock until its asynchronous writes finish; the native engine holds
its own profile lock. Do not manually delete either lock file while an application is running.

`--safe-mode` skips extension registry and artifact setup and omits Chromium's unsafe extension-debugging
switch. Use it if damaged metadata prevents normal startup. Normal per-extension validation failures
are shown in the controls; an uncertain Chromium command outcome closes the application rather than
continuing to modify unclear installation state. An approved interrupted installation gets at most
one automatic recovery attempt, then requires local review.

When launched with `--cdp`, startup restoration completes before the separately authorized raw CDP
relay opens. Extension controls are read-only for that launch. The relay cannot load a package from
an arbitrary filesystem path or uninstall a managed extension. Raw CDP still intentionally grants
broad browser, page JavaScript and storage access. It is not included in `browser.full-control`.

Local source paths and native permission-review actions are not exposed through MCP or Hitchhiker
plugins. Remote extension installation needs a separate capability and uploaded-package design.

## Framework API availability

The following describes the current implementation, not the final plugin architecture. Extension
installation still uses trusted controller UI; extracting the complete feature onto public plugin APIs
remains unfinished. Hitchhiker plugins can list and remove managed Chrome extensions. Installation
and change events are not exposed yet.
The MCP tools for installing Hitchhiker plugins do not install Chrome extensions.

| Operation                             | Available surface             | Authority and behavior                                                                                                           |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| List managed installations            | Local controls, SDK and MCP   | Reads the profile registry; this is not enumeration of every extension Chromium may know about.                                  |
| Stage an unpacked directory           | Local extension controls      | Copies bounded regular files into private profile storage; the source path is not a public plugin parameter.                     |
| Review and install                    | Local extension controls      | Review is bound to the staged installation ID and digest. Required and optional permission groups are shown before confirmation. |
| Remove                                | Local controls, SDK and MCP   | Uninstalls rather than temporarily disabling; recovery and possible data retention are described above.                          |
| Restore after restart                 | Trusted startup service       | Reloads enabled installations before saved pages; safe mode skips this service.                                                  |
| Observe installation changes          | No public plugin or MCP event | Do not depend on the registry file format or private native bridge as an API.                                                    |
| Enable, disable, update or import CRX | Unavailable                   | Removing and reinstalling is not a supported equivalent for preserving all extension state.                                      |

Chrome manifest permissions govern a Chrome extension's access inside Chromium. Hitchhiker manifest
capabilities and user grants govern the Native framework. Neither permission system substitutes for
the other. The public management adapter preserves profile isolation, recovery and the raw-CDP mutation boundary.
Installation review remains a separate trusted operation.

Implementation references for contributors:

- [Trusted control surface](../apps/browser/src/extension-controls.ts)
- [Installation state and restart recovery](../apps/browser/src/extension-manager.ts)
- [Package staging and integrity](../apps/browser/src/extension-artifacts.ts)

For the wider API boundary, see the [Chromium capability inventory](CHROMIUM-CAPABILITY-AUDIT.md),
[public DevTools controls](DEVTOOLS.md) and [scoped page-content operations](PLUGIN-DOM.md).

## Public inventory and removal

```ts
api.extensions.list(): Promise<ExtensionManagementSnapshot>
api.extensions.remove(installationId: string): Promise<ExtensionManagementSnapshot>
```

`list` requires declared and granted `extensions.read`; `remove` requires `extensions.manage`.
Both are profile-wide: an origin list does not restrict them to extensions matching particular sites.
`browser.full-control` includes both, but still excludes `cdp.connect`. These capabilities are not
automatically added to existing default plugin grants. The MCP equivalents are
`hitchhiker_extensions_list` with `{}` and `hitchhiker_extension_remove` with `{installationId}`.
MCP uses the connection's current grant; plugins additionally need matching manifest declarations.
Neither surface accepts a profile selector, credential, local path or caller identity in arguments.

The snapshot is `{readOnly, extensions}`. `readOnly` indicates the raw-CDP launch restriction.
Each entry contains `installationId`, `digest`, `expectedChromiumId`, optional `chromiumId`, `name`,
`version`, `permissions`, `hostPermissions`, `optionalPermissions`, `optionalHostPermissions`, `state`
and optional `errorIntent`. State is `prepared`, `installing`, `enabled`, `removing`, `removed` or
`error`; error intent is `install` or `remove`. Permission arrays describe the reviewed manifest,
not a query of Chromium's current permission decisions. Raw engine diagnostics and artifact paths
are omitted. Names and permission text originate in extension packages and should be treated as
untrusted display data.

At most 16 entries are returned, including pending reviews and removal tombstones. Installation IDs
are 32 lowercase hexadecimal characters; use the returned ID rather than a Chromium ID. The digest
is 64 lowercase hexadecimal characters. Names allow 1,024 characters, versions 64; each of the four
permission arrays allows 256 strings of at most 2,048 characters. The underlying registry is bounded
to 128 KiB. There is no public change event or revision yet; refresh on user demand or after a
management action instead of continuously polling.

```ts
import { PluginApiError } from "@hitchhiker/plugin-sdk";

// Declare extensions.read and extensions.manage and obtain a grant for this profile.
const inventory = await api.extensions.list();
// Render inventory with Native design primitives. On the user's Remove action:
async function removeExtension(installationId: string) {
  if (inventory.readOnly) return;
  try {
    const updated = await api.extensions.remove(installationId);
    return updated.extensions;
  } catch (error) {
    if (error instanceof PluginApiError && error.code === "denied") {
      // Refresh controls; the grant, extension state or browser availability may have changed.
      return undefined;
    }
    throw error;
  }
}
```

Removal returns the profile inventory using `extensions.manage`; it does not require a separate
read grant for that response. It records durable intent before calling Chromium. The current owner
grant is rechecked after waiting for the manager lock, before recording that intent, and before
returning data. Revocation while queued prevents removal. Once admitted, a removal can finish even
if its caller times out, stops or loses authority; an error response does not prove no side effect
occurred. MCP has a 15-second operation deadline, but transaction cleanup may delay delivery of a
timeout. Inspect the next available inventory before retrying. Revoked plugins may stop before an
error handler can run.

Missing declarations, denied or revoked grants, malformed arguments, missing adapters and backend
failures produce a sanitized `PluginApiError` with code `denied`. MCP reports sanitized tool errors;
protocol validation can reject malformed arguments before the handler. Removal of a prepared review
is refused: cancel it using the local review controls. Safe mode and unavailable extension metadata
omit the adapter and MCP tools. Raw-CDP mode permits inventory but refuses removal. Uncertain
Chromium outcomes trigger the same application recovery shutdown as local management.

The [compiled example](../apps/browser/test/fixtures/extension-plugin.ts) and
[Native integration fixture](../apps/browser/test/native-extension-plugin.test.ts) exercise both
developer and installed plugins with real Chromium: an installed content script runs before removal
and does not run in a new, fully loaded document afterward. These tests use disposable mock-Keychain
profiles; they do not prove production Keychain startup, physical interaction or full extension
compatibility. Portable tests cover grants, queue-time revocation, metadata filtering and recovery.

## Compatibility and limits

The current engine is CEF 144 / Chromium 144. Content scripts, service workers and extension storage
are exercised against real Chromium. Hitchhiker pages currently have distinct Chromium window IDs;
this is not shared-window Chrome tab compatibility. Chrome Web Store/CRX installation, updates,
toolbar action popups, tab groups and complete third-party extension compatibility remain unfinished.

The profile supports 16 stored installations. Packages are limited to a 1 MiB manifest, 256 MiB per
file, 512 MiB total, 10,000 entries, depth 64 and 4,096 UTF-8 bytes per relative path. Symlinks and
special files are rejected. Valid Unicode names, spaces, localized resources and manifest keys are
preserved. Chromium performs its own manifest and resource validation after Hitchhiker's review.

See [the implementation evidence and acceptance plan](EXTENSIONS-PLAN.md) and
[artifact integrity and recovery](EXTENSION-ARTIFACTS.md).
