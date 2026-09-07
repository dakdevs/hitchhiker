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
plugins. The uploaded-package protocol below is under validation; it does not enable remote approval.

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
is refused: its public owner cancels an uploaded review with `api.extensions.installation.cancel`;
legacy local reviews use local controls. Safe mode and unavailable extension metadata
omit the adapter and MCP tools. Raw-CDP mode permits inventory but refuses removal. Uncertain
Chromium outcomes trigger the same application recovery shutdown as local management.

The [compiled example](../apps/browser/test/fixtures/extension-plugin.ts) and
[Native integration fixture](../apps/browser/test/native-extension-plugin.test.ts) exercise both
developer and installed plugins with real Chromium: an installed content script runs before removal
and does not run in a new, fully loaded document afterward. These tests use disposable mock-Keychain
profiles; they do not prove production Keychain startup, physical interaction or full extension
compatibility. Portable tests cover grants, queue-time revocation, metadata filtering and recovery.

## Public extension installation protocol

`api.extensions.installation` requires declared and current profile-wide `extensions.install`.
`browser.full-control` implies it; `cdp.connect` remains separate. Callers never provide a profile,
owner, grant ID, filesystem path, review nonce, or approval decision. Safe mode, raw-CDP, and
unavailable extension metadata omit this adapter and its MCP tools.

```ts
const manifest = new TextEncoder().encode(
  JSON.stringify({ manifest_version: 3, name: "Example", version: "1.0" }),
);
const upload = await api.extensions.installation.begin();
await api.extensions.installation.beginFile(
  upload.operationId,
  "manifest.json",
  manifest.byteLength,
);
await api.extensions.installation.append(upload.operationId, 0, manifest); // Uint8Array
await api.extensions.installation.finish(upload.operationId);
```

Upload every required resource, splitting each file into 64 KiB or smaller chunks with exact offsets.
Isolated plugins with `extensions.install` receive coalesced
`extensions.installation.changed` events through `definePlugin({ onEvent })`. Its payload is always
`{}`; call `status` or `list` after an invalidation rather than polling with a timer. MCP has no event
stream and continues to poll. Do not block a plugin event callback while awaiting review. When status
reports `awaiting_review`, call `requestReview`.

The exact SDK methods are `begin()`, `beginFile(operationId, path, size)`,
`append(operationId, offset, data: Uint8Array)`, `finish(operationId)`, `status(operationId)`,
`list()`, `requestReview(operationId)`, `cancel(operationId)`, and `pickLocal()`. The first eight
methods retain their existing names and arguments. `pickLocal()` has no arguments and asks a trusted
local host to select a package; it fails safely when that host does not provide a picker. `finish`
validates asynchronously. `requestReview` only opens trusted local Native review: a
person must approve or reject it and no SDK, MCP, or plugin call can approve it.
`pickLocal()` returns immediately with `choosing`. The local user selects one folder containing
`manifest.json`; its contents pass through the same copied-artifact validation as uploaded packages.
The path is never returned to the plugin or MCP client. After an invalidation, read status until it
reports `awaiting_review`, then call `requestReview` to request the separate permission decision.
Selecting a folder does not install it.
Only one local selection/validation operation is active at a time. The native panel closes after
five minutes, on owner shutdown or revocation, or when `cancel(operationId)` stops the operation.
An unsupported host settles the operation with a sanitized failure.

MCP uses canonical base64 `dataBase64` for `append`; the SDK encodes `Uint8Array` input.

| Tool                                      | Arguments                         | Result         |
| ----------------------------------------- | --------------------------------- | -------------- |
| `hitchhiker_extension_install_pick_local` | `{}`                              | snapshot       |
| `hitchhiker_extension_install_begin`      | `{}`                              | snapshot       |
| `hitchhiker_extension_install_begin_file` | `{operationId,path,size}`         | snapshot       |
| `hitchhiker_extension_install_append`     | `{operationId,offset,dataBase64}` | snapshot       |
| `hitchhiker_extension_install_finish`     | `{operationId}`                   | snapshot       |
| `hitchhiker_extension_install_status`     | `{operationId}`                   | snapshot       |
| `hitchhiker_extension_install_list`       | `{}`                              | snapshot array |
| `hitchhiker_extension_install_review`     | `{operationId}`                   | snapshot       |
| `hitchhiker_extension_install_cancel`     | `{operationId}`                   | snapshot       |

Operation IDs are 32 lowercase hexadecimal characters. Paths are relative UTF-8 paths up to 4,096
bytes; absolute paths, dot segments, backslashes, controls, symlinks, and special files are denied.
One session allows 10,000 entries, depth 64, 256 MiB per file, 512 MiB total, a 1 MiB manifest, and
64 KiB decoded chunks (87,384 base64 characters). Uploads expire after 10 minutes idle or 60 minutes.
Cancellation, restart, validation, review, and installation can settle asynchronously; refresh
`status` or inventory before retrying. Errors or client timeouts do not prove no durable side effect.
Receiving-upload expiry is discovered by a later `status` call and does not emit an invalidation.
Neither `status` nor `list` emits an invalidation, preventing refresh loops.
An upload belongs to its owner principal and durable grant. A disconnected plugin/MCP connection
cannot resume its ephemeral receiving upload. A persisted prepared review for the same principal and
grant can be rediscovered through the owned inventory; the coordinator bounds memory to 32 operations and evicts terminal entries when admitting new work.
The durable registry holds up to 16 installations.
Revocation does not automatically uninstall an already enabled extension. Use the owner `cancel`
operation for a public pending upload; local controls remain the fallback for legacy local reviews.
Snapshots can include the relative `upload.file.path` and native review outcome state, but exclude
host filesystem paths, Chromium errors, and approval nonces. See the
[public installation plan](EXTENSION-INSTALL-PLAN.md): an isolated real Chromium fixture covers binary
resource upload, native-button approval, content-script execution, removal and clean exit. A second isolated fixture passes actual native folder selection, separate native-button
approval, binary-resource execution and removal, plus stale-request, exact-cancel and window-close
checks. Both use disposable test Keychains. Packaged startup and compiled-plugin/MCP installation
acceptance remain open.

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
