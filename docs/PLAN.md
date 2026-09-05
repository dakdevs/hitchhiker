# Hitchhiker implementation plan

## Purpose and authority

The user approved implementation after a one-question-at-a-time design interview on 2026-09-05.
Build an open-source macOS-first Chromium browser framework using vercel-labs/native, in a
Turborepo at `/Users/dak/projects/hitchhiker`, with a default browser and marketing/docs site.
This living plan is warranted by unknown native engine composition, runtime plugins, multiple
toolchains, and security-sensitive browser automation. `AGENTS.md` is the planning contract.

## Accepted decisions

- OpenAI-inspired design, Lucide icons, shared accessible motion; sidebar/pinned tabs by default,
  top tabs optional. The default interface uses only public framework APIs.
- Existing Chrome extensions and live-installable Hitchhiker TypeScript plugins. Plugins compose
  native components, may replace the interface, and may use isolated web panels.
- Protected core owns permissions, recovery, Chromium security, and performance scheduling.
- Configuration/UI changes apply live; enable, disable, rollback without rebuilding the browser.
- MCP has persistent scoped grants and explicit full-control option. Raw CDP is opt-in per profile,
  local by default and revocable.
- Inactive/pinned tabs may sleep; protect calls, audio, downloads and unsaved input, with per-site
  always-awake exceptions. Warn, throttle and suspend sustained plugin resource offenders.
- Local profiles and configuration/plugin export/import without browsing secrets. Optional sync
  provider API; no required account. Framework and default browser are open source.
- Docs cover configuration, plugins, native UI, automation, performance, and custom distributions.

## Current state and context

This repository began empty. The Native source is being inspected at
`/Users/dak/Documents/Codex/2026-09-05/usi/work/native`, commit
`5665a355cae768dff734d79dd4c0bd9d099f83fb`. Its browser example uses layered WebViews;
macOS Chromium embedding uses CEF (Chromium Embedded Framework). TypeScript cores compile
ahead of time, so arbitrary live plugin JavaScript requires a separate runtime and native adapter.
The host has Apple Silicon, Xcode, Node 22.23.2 and pnpm 11.24.0; no global Native or Zig command.

## Milestones and behavioral acceptance

1. **Engine evidence:** install pinned Native tooling, run a minimal Chromium integration,
   verify native controls can coexist with live Chromium content, and test representative Chrome
   extension loading and CDP. Capture limitations before designing against unsupported APIs.
   Promote the integration only when actual web navigation and control are demonstrated.
2. **Framework and default browser:** introduce public state/configuration/component contracts,
   isolated runtime plugin loading, persistent profiles, tab navigation and tab lifecycle. Verify
   the default interface and an independently loaded alternate interface use the same API.
3. **Automation and boundaries:** exercise MCP navigation/configuration/plugins and explicit CDP
   profile grants against the real host. Verify denied access, revocation, and plugin recovery.
4. **Website and docs:** implement a locally runnable responsive site at `apps/site`, with navigable
   and searchable documentation, real examples, and honest availability labels.
5. **Integration validation:** root typecheck/lint/format/test/build; native interactive smoke,
   representative extension compatibility, plugin live reload/recovery, resource measurements,
   and packaging. Record actual measurements; do not replace behavioral proof with schema tests.

## Execution and recovery

Run pnpm commands from the repository root. `pnpm install` creates the exact-version lockfile;
CI must use `pnpm install --frozen-lockfile`. Root `pnpm check` composes toolchain checks.
Native commands and package scripts will be recorded after inspecting CLI help and actual build
outputs. Keep downloaded toolchains in ignored work/cache directories, not source control.
All browser testing uses a dedicated Hitchhiker profile; do not read existing personal browser data.
Retry builds without deleting unrelated user files. Runtime plugins must retain a known-good
version for rollback and expose a trusted recovery interface independent of the chosen UI.

## Progress

- [x] 2026-09-05: Product interview complete and implementation authorized.
- [x] 2026-09-05: Created project directory and root Turborepo/tooling manifests.
- [x] 2026-09-05: Installed Native 0.10.1; minimal TypeScript/native app check and ReleaseFast build passed (18/18 steps).
- [ ] Chromium/native composition and extension proof blocked on engine architecture decision.
- [x] 2026-09-05: Implemented pure public core policies for configuration, tabs, scoped grants,
      bounded declarative plugin proposals and budget state; eight regression tests pass after review.
- [ ] Implement native default interface, runtime plugins and actual host enforcement.
- [ ] Implement MCP/CDP and security/resource enforcement.
- [x] 2026-09-05: Implemented website and nine docs routes; checked desktop/mobile navigation,
      search, table-of-contents route preservation, and console output.
- [ ] Replace runtime API proposals with verified host documentation after engine integration.
- [ ] Complete end-to-end verification and packaging.
- [ ] Register folder in Codex sidebar (tool limitation).

## Surprises and discoveries

- Codex project tools list saved projects but expose no registration operation. CUA denies access
  to the Codex app itself. Manual Add Project is required; the directory exists independently.
- Native has a CEF integration; original assumption that an embedding must start from scratch was
  corrected during the interview. Native-rendered composition and extension parity remain unproven.
- Exact CEF 144 source confirms parent-view embedding forces Alloy, whose Chrome-extension APIs
  were removed in M128. See `ENGINE-FEASIBILITY.md` for sources and the bounded fork acceptance.
- Independent pure-core review found export leakage, NaN expiry bypass, missing active-tab
  successor, and invalid resource sample handling. All four are fixed and passed independent
  re-review. Configuration export now returns `Result<string>` and serializes only allowed fields.

## Decision log

- 2026-09-05, user: approved all accepted decisions above and implementation start.
- 2026-09-05, agent: keep a living plan because real CEF/native/plugin compatibility must be proven.
- 2026-09-05, agent: research engine integration independently while building the website; neither
  workstream may invent host APIs or compatibility claims.
- 2026-09-05, agent: request user choice between a downstream engine fork preserving both native UI
  and Chrome extensions, or deferring extension support. Browser host work awaits that choice;
  portable core and site verification continue independently.

## Outcomes and retrospective

Implementation is incomplete pending the engine choice. A temporary Native toolchain smoke app
compiled successfully. The website and pure-domain core pass root `pnpm check`: exact dependencies,
typecheck, oxlint, oxfmt, eight behavioral tests, and production builds. Frozen-lockfile install
passes. Review fixes were re-reviewed; mobile docs search was corrected and manually rechecked.
No Hitchhiker browser executable, extension compatibility, resource benchmark, or CDP/MCP
integration has been verified. The live website can be started with
`pnpm --filter @hitchhiker/site dev --host 127.0.0.1 --port 4173`.

Next action: obtain the pending engine decision, then execute the corresponding first native
composition proof described in `ENGINE-FEASIBILITY.md`. Do not infer approval from time elapsed.

## Revision notes

- 2026-09-05: Initial plan grounded in checked environment and Native source.
- 2026-09-05: Added exact engine incompatibility evidence, successful native toolchain build,
  and pending fork choice. Continued only independent core/site work.
- 2026-09-05: Recorded reviewed portable implementation and website verification; kept all native
  runtime, Chrome-extension and automation milestones explicitly unfinished.
