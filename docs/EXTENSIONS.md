# Chrome extensions

Hitchhiker's developer build manages local unpacked Manifest V3 extensions. Chrome extensions run in
Chromium; Hitchhiker plugins compose the surrounding Native interface. They have separate permission
systems and installation controls.

## Install a local extension

1. Open **Settings → Chrome extensions** in the default interface.
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
management still uses trusted controller UI; extracting that feature onto public plugin APIs remains
unfinished. A Hitchhiker plugin cannot currently list, install, remove or observe Chrome extensions.
The MCP tools for installing Hitchhiker plugins do not install Chrome extensions.

| Operation                             | Available surface             | Authority and behavior                                                                                                           |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| List managed installations            | Local extension controls      | Reads the profile registry; this is not enumeration of every extension Chromium may know about.                                  |
| Stage an unpacked directory           | Local extension controls      | Copies bounded regular files into private profile storage; the source path is not a public plugin parameter.                     |
| Review and install                    | Local extension controls      | Review is bound to the staged installation ID and digest. Required and optional permission groups are shown before confirmation. |
| Remove                                | Local extension controls      | Uninstalls rather than temporarily disabling; recovery and possible data retention are described above.                          |
| Restore after restart                 | Trusted startup service       | Reloads enabled installations before saved pages; safe mode skips this service.                                                  |
| Observe installation changes          | No public plugin or MCP event | Do not depend on the registry file format or private native bridge as an API.                                                    |
| Enable, disable, update or import CRX | Unavailable                   | Removing and reinstalling is not a supported equivalent for preserving all extension state.                                      |

Chrome manifest permissions govern a Chrome extension's access inside Chromium. Hitchhiker manifest
capabilities and user grants govern the Native framework. Neither permission system substitutes for
the other. A future public extension-management API must preserve profile isolation, artifact review,
recovery and the raw-CDP mutation boundary described above.

Implementation references for contributors:

- [Trusted control surface](../apps/browser/src/extension-controls.ts)
- [Installation state and restart recovery](../apps/browser/src/extension-manager.ts)
- [Package staging and integrity](../apps/browser/src/extension-artifacts.ts)

For the wider API boundary, see the [Chromium capability inventory](CHROMIUM-CAPABILITY-AUDIT.md),
[public DevTools controls](DEVTOOLS.md) and [scoped page-content operations](PLUGIN-DOM.md).

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
