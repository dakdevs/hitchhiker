# macOS developer bundle

Build the current Apple Silicon developer bundle from the repository root:

```sh
NATIVE_SDK_SOURCE=/absolute/path/to/native-at-5665a355 \
  pnpm bundle:macos
```

The command downloads and verifies the official Node 24.19.0 arm64 archive, uses that Node and
Corepack's pinned pnpm 11.24.0 to install, build, and deploy the TypeScript controller from a copied
workspace under `work/package-staging` without changing the development install. It builds the
existing CEF and PluginHost inputs, stages a relocatable app under
`work/package/Hitchhiker Developer/Hitchhiker.app`, applies developer-only ad hoc signatures from
the deepest CEF components outward, and verifies the result. `work/` is ignored.

Reuse already built native inputs with `--skip-build`:

```sh
NATIVE_SDK_SOURCE=/absolute/path/to/native-at-5665a355 \
  node apps/browser/packaging/bundle-macos.mjs --skip-build
```

Verify an existing artifact without rebuilding:

```sh
node apps/browser/packaging/bundle-macos.mjs --verify-only \
  --output="$PWD/work/package/Hitchhiker Developer/Hitchhiker.app"
```

The bundle also carries the grant CLI and its runtime dependencies. Issue a credential without a
workspace checkout or system Node installation, then point a local stdio MCP client at the native
launcher with `--mcp`:

```sh
HITCHHIKER_APP="$PWD/work/package/Hitchhiker Developer/Hitchhiker.app"
"$HITCHHIKER_APP/Contents/Helpers/node" \
  "$HITCHHIKER_APP/Contents/Resources/controller/dist/grants.js" issue \
  --principal=my-agent \
  --capabilities=pages.list,pages.manage,configuration.write

HITCHHIKER_MCP_TOKEN=TOKEN_FROM_ISSUE \
  "$HITCHHIKER_APP/Contents/MacOS/Hitchhiker" --mcp
```

Pass the same absolute `--profile-root` to both commands when using a nondefault profile. See
[the development guide](../../../docs/DEVELOPMENT.md#local-grants) for grant handling and
[its MCP section](../../../docs/DEVELOPMENT.md#mcp) for client configuration and available tools.

The app contains a small native launcher, the CEF engine and helpers, the complete PluginHost/XPC
bundle, the Node executable, the deployed production module graph, licenses, an input manifest, and
a sibling final-file hash manifest. The launcher and CEF engine are sibling executables in the outer
app's `Contents/MacOS`; the outer bundle owns CEF's standard `Frameworks` and `Resources` paths. The
launcher's paths are relative to its own bundle, so spaces and relocation do not require environment
setup. Packaging reconstructs the CEF versioned framework from the pinned release input; this removes
self-referential links that repeated upstream post-build copies can accumulate before the
deepest-first signing pass.

This is an ad hoc signed developer artifact. It is not Developer-ID signed, notarized, stapled,
universal, or update-enabled. The CEF sandbox remains enabled. PluginHost retains its App Sandbox
entitlements. The official Node signature and V8 entitlements are preserved instead of being replaced
with an untested local signature.
