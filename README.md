# Hitchhiker

A macOS-first Chromium browser framework with a considered default interface, public native
components, runtime plugins, and explicit automation permissions.

**Status: implementation and native-host integration in progress. No browser release is available.**
Native's existing CEF backend does not yet support the native-rendered composition this project
requires. Chrome-extension support, runtime native plugins, sandboxed browsing and MCP/CDP control
must be proven in the host before they can be advertised as available.

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
- `apps/host-probe`: explicit macOS Native/Chromium composition experiment.
- `packages/core`: portable pages, viewport bindings, configuration, permission and resource policies.
- `packages/default-interface`: optional tab ordering, pinning, placement and per-interface selection.
- `docs/PLAN.md`: approved requirements, discoveries, progress, and remaining integration work.

The browser UI is intended to be a first-party consumer of the same public APIs as custom
interfaces. The trusted core retains permission enforcement, recovery and resource scheduling.
Browser profiles are local; configuration sharing must never include cookies or credentials.

Tabs are one presentation of pages. The core has no global active tab, tab order or pinning model.
Independent interfaces can bind pages to multiple viewports, replace their layout and detach views
without destroying the underlying pages. A custom interface can use a canvas, splits, workspaces or
another organization model. These are portable state contracts; the native host must still implement
and verify the corresponding rendering and lifecycle behavior.
See `docs/PAGES-AND-VIEWPORTS.md` for the contract and remaining host requirements.

## Native SDK

The pinned `@native-sdk/cli` dependency provides `pnpm exec native`. Native applications use
TypeScript plus `.native` markup. The CEF composition gap is being investigated against the source
revision recorded in the plan; the published CLI's own version command records its build commit.

```sh
pnpm exec native version
```

## License

Apache-2.0. Third-party components retain their respective licenses. Chromium/CEF distribution
will require accompanying upstream notices in the packaged browser.
