# Developer tools plugin

This is a standalone, whole-surface developer interface built only with the public Hitchhiker plugin SDK. It lists up to 128 live pages, keeps a selected page in a Native viewport, and can show, close, and refresh that page’s Chromium DevTools frontend. It does not expose raw CDP or browser-native APIs.

Build it from the repository root:

```sh
pnpm exec turbo run build --filter=@hitchhiker/devtools-plugin
```

Start the browser with the normal plugin-host environment from `docs/DEVELOPMENT.md`, then install `dist/plugin.js` with `hitchhiker.plugin.json`. Its grant must name principal `default-devtools` and include `pages.list`, `devtools.manage`, and `ui.compose` for the target profile.

The plugin is intended as a default feature, but it is **not yet included** in the frozen default-plugin distribution. Its default-bundle integration and the fifth isolated worker remain pending.
