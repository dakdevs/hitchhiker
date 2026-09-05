# Hitchhiker

Read `docs/PLAN.md` for approved product decisions, integration evidence, and current work.
Use exact dependency versions, pnpm, Turborepo, oxlint, and oxfmt. Native app logic
defaults to TypeScript and native markup; toolkit extensions may need Zig/Objective-C++.

The browser interface is a consumer of public framework APIs. Keep permission enforcement,
profile isolation, recovery, and resource scheduling in the trusted core. Never expose the
native bridge to arbitrary web pages. Do not describe mock or unverified integrations as working.

For cross-component or uncertain changes, update the living plan before and during execution.
Keep checked progress grounded in behavioral verification, with unresolved work explicit.
