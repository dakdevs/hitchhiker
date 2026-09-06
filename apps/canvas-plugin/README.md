# Canvas example

A real TypeScript plugin that replaces the default browser interface using only the public SDK and
Native components. Page cards select up to two independent viewports, demonstrating that the core
does not require a tab strip or sidebar. Selecting a card again removes its viewport.

Build with `pnpm --filter @hitchhiker/canvas-plugin... build` from the repository root. Follow the
[plugin launch instructions](../../docs/DEVELOPMENT.md). The required grant principal is
`canvas-example`; permissions are `pages.list`, `pages.manage`, and `ui.compose`.
