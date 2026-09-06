# Portable customization recipes

Deliver a versioned JSON recipe containing validated browser configuration, default-interface tab
placement and Hitchhiker plugin requirements. This complements the older configuration-only format.
It is not a profile backup and does not include pages, titles, history, cookies, credentials, grants,
plugin storage, executable code or Chrome extension packages. Always-awake origins are intentional
configuration and may reveal preferred sites; documentation must make that visible.

## Boundary

The runtime owns a strict bounded schema reusing the live plugin manifest definition. A recipe has
`version: 1`, `configuration`, `interface: { tabPlacement }` and `plugins`, each containing a manifest,
exact SHA-256 artifact hash and desired enabled state. Reject unknown fields at every boundary,
duplicate plugin IDs, unsupported versions and oversized input. Canonicalize configuration and plugin
ordering. Export explicitly projects permitted fields; it never serializes a registry object.

The controller reads and applies configuration plus tab placement under its existing lock, using one
persisted browser-state snapshot. A recipe cannot change the active plugin's UI or page/viewport model.
Import validates the complete recipe before any mutation. Plugin entries are requirements returned
to the caller; import never installs, grants, enables, disables or rolls back plugins, even when the
same artifact is already present. Existing explicit plugin management remains the only activation path.

MCP exposes export/import using `configuration.write` for settings and `plugins.install` when plugin
metadata is requested or supplied. Every call checks current grants. Export can omit plugins so a
settings-only connection remains useful. Plugin metadata is descriptive untrusted text. Imported
requirements are returned with the applied settings, without implying that plugins were installed.

## Verification

Exercise strict schema/size/version rejection, stable round trips, explicit secret-field exclusion,
duplicate identities and capability validation. Test the real controller's combined persistence and
restart behavior, preserving pages and plugin surfaces. MCP tests must verify both grant boundaries,
revocation and that invalid or unauthorized recipes leave settings unchanged and never call plugin
mutation methods. Run root checks, native MCP coverage and relocated app verification before claiming
this is delivered. Profile selection UI, plugin-specific configuration, Chrome extension portability
and an optional sync provider remain separate work.

The first full native run exposed a pre-existing timing error in the freeze fixture: it compared
the frozen timer to a value read before sending the freeze command. A tick may legitimately run in
that interval. The fixture now captures its baseline after Chromium acknowledges freezing, then
asserts no advancement during the frozen interval and resumption after activation. No production
freeze behavior changed. Final verification follows this correction and expanded metadata-projection
regressions; the original failed run remains in `work/customization-native-check.log`.
