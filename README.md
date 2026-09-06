# Hitchhiker

A macOS-first Chromium browser framework with a considered default interface, public native
components, runtime plugins, and explicit automation permissions.

**Status: implementation and native-host integration in progress. No browser release is available.**
The development browser runs multiple live Chromium pages with a replaceable Native interface.
Isolated TypeScript plugins, MCP, authenticated CDP, profile persistence and reversible page freezing
pass real native integration tests. A local MV3 extension works across layout and lifecycle changes.
Persistent plugin installation and rollback are integrated. Full extension compatibility, release
rendering and distribution signing remain in development.
See `docs/ENGINE-FEASIBILITY.md` for measured evidence and current limits.
See [the runtime evidence](docs/RUNTIME.md) for Native composition and automation boundaries.

## Development

Use Node 24.19.0 (`.node-version`) and pnpm 11.24.0.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @hitchhiker/site dev
```

The repository uses Turborepo for package tasks, oxlint for linting and oxfmt for formatting.
Dependencies are pinned; `pnpm check:dependencies` enforces the policy.

## Repository

- `apps/site`: marketing and developer documentation website.
- `apps/browser`: development browser controller and native interface composition.
- `apps/canvas-plugin`: independently compiled example that replaces tabs with page cards and splits.
- `apps/host-probe`: explicit macOS Native/Chromium composition experiment.
- `apps/plugin-host`: sandboxed JavaScriptCore worker and XPC resource supervisor.
- `packages/core`: portable pages, viewport bindings, configuration, permission and resource policies.
- `packages/default-interface`: optional tab ordering, pinning, placement and per-interface selection.
- `packages/ui`: public Native components, Lucide names, design tokens and text editing.
- `packages/runtime`: private engine transport, Native surfaces, grants, MCP/CDP and plugin sessions.
- `packages/plugin-sdk`: public TypeScript API for isolated Hitchhiker plugins.
- `docs/PLAN.md`: approved requirements, discoveries, progress, and remaining integration work.

The browser UI is intended to be a first-party consumer of the same public APIs as custom
interfaces. The trusted core retains permission enforcement, recovery and resource scheduling.
Browser profiles are local; configuration sharing must never include cookies or credentials.

Tabs are one presentation of pages. The core has no global active tab, tab order or pinning model.
Independent interfaces can bind pages to multiple viewports, replace their layout and detach views
without destroying the underlying pages. A custom interface can use a canvas, splits, workspaces or
another organization model. The canvas example exercises these contracts against the native host;
switching back to the default interface preserves the underlying Chromium pages.
See `docs/PAGES-AND-VIEWPORTS.md` for the contract and remaining host requirements.

## Native SDK

The pinned `@native-sdk/cli` dependency provides `pnpm exec native`. Native applications use
TypeScript plus `.native` markup. Hitchhiker embeds Native in a CEF-owned window using the source
revision recorded in the plan; the published CLI's own version command records its build commit.

```sh
pnpm exec native version
```

## License

Apache-2.0. Third-party components retain their respective licenses. Chromium/CEF distribution
will require accompanying upstream notices in the packaged browser.

Run the browser, issue local grants, connect MCP/CDP, and load the TypeScript canvas example with the [development guide](docs/DEVELOPMENT.md).

Build a relocatable, ad hoc signed Apple Silicon app with [the macOS packaging guide](apps/browser/packaging/README.md).
