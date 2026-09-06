# Chromium browser replacement

## Scope and evidence

Implement generic browser replacement independently of automatic discard/restoration. The native
proof in `DISCARD-PLAN.md` observes create-new-before-destroy-old during Chrome `tabs.discard`, with
stable Hitchhiker pages but new CEF/CDP/extension identities. Also support destroy-old-before-create-new.
A new browser with no document is not proof of discard. This packet never automatically reloads it.
Explicit Reload remains available and Chromium retains the actual navigation controller/history.

## Private host contract

Use an unsigned 32-bit browser generation per logical page (zero before first attachment). All
page-scoped host events carry `generation`; browser-derived events use a positive generation.
Window-wide events are unchanged. `host.ready` advertises `pageBrowserGeneration: true`; the browser
controller requires this capability before restoring or creating pages. Transport version stays 1.

- `pages.created {pageId,generation}` occurs once for the first browser attachment.
- `pages.browserUnavailable {pageId,generation}` retires the current browser without closing the page.
- `pages.replaced {pageId,generation,previousGeneration}` attaches the next distinct browser;
  generation is exactly previousGeneration + 1. Cause remains unknown.
- `pages.documentCommitted {pageId,generation}` reports each current main-frame post-commit load.
- `pages.resourcesChanged {pageId,generation,known:true,audio,call,download,unsavedInput}` is a complete
  snapshot. No generationless or partial snapshot establishes eligibility for resource management.
- Existing title/navigation/close/cdp events carry generation and otherwise retain their payloads.
- `pages.list` returns cached `{id,generation,browserAvailable,mainDocumentCommitted,resourcesKnown,
url,title,loading,canGoBack,canGoForward}`. Do not reconstruct Chromium history from this display cache.

On attachment reset protection flags and mark resource knowledge false. Pre-commit callbacks update
individual flags but emit no partial resource snapshot. Main-frame commit establishes known state,
clears unsaved input, retains other observed signals, emits documentCommitted then complete resources.
Keep cached URL/title/back-forward through pre-commit empty replacement callbacks; a committed current
empty title is legitimate. Old-browser callbacks cannot change the current record.

Immediately retire matching CDP registrations, observers and pending requests before publishing
unavailable/replaced. Each carries logical page and generation; callback acceptance additionally
requires current CefBrowser identity. Requests in the gap fail temporarily unavailable. New requests
attach to the current generation. CEF identifiers are never Chrome extension tab IDs.

The controller privately tracks generation/availability/commit, accepts only matching generation
updates and exact successor replacement, invalidates resource knowledge and document references,
retains logical page/interface/viewport/persistence state, and prevents freezing until resources are
known again. A previously sleeping page is no longer known-frozen after replacement. Do not add a tab
or replacement lifecycle to the public framework page model. Scoped DOM invalidates on unavailable
or replaced even when Chromium emits no context-destruction event.

A logical page finalizes only after its owned window is destroyed and no current browser remains.
Stale destruction never clears a newer browser/view. Closing during an unavailable gap closes the
owned window; late attachment after finalization closes immediately. Window close delegates resolve
the manager's current browser rather than retain the initial one. Generation exhaustion fails safely.

## Verification

Test both callback orders, duplicate create, stale destruction across multiple replacements,
close-in-gap and both final window/browser destruction orders using a native generation helper used
by production. A real disposable extension test must exercise repeated discard/explicit reload,
one logical creation, generation increments, retained metadata/history, no false logical closure,
and old pending CDP failure followed by successful new-generation CDP. Portable controller tests
cover stale generations, UI/persistence retention and unknown-resource protection; DOM tests reject
old references after replacement without context events. Run root checks and serial native tests.

Automatic restore needs a separate positive discarded-state/generation proof. The measured exact
mapping requires the broader debugger permission; this packet introduces no trusted resource worker.

## Integration evidence

The production generation helper now owns current attachment identity and finalization eligibility.
Its non-GUI test uses always-on checks in Release builds, covering duplicate creation, create-first
and destroy-first ordering, stale destruction across multiple generations, window/browser close
ordering, closing during a gap and generation exhaustion. An earlier `assert`-based prototype was
invalid under Release `NDEBUG` and was replaced before accepting this evidence. CEF's native browser
identifier supplies the opaque identity; pointer addresses and Chrome extension tab IDs do not.

The real native test passes three discard/explicit-reload cycles, exact target-to-tab mapping with
duplicate URLs, generation increments, retained cached metadata and real navigation history, prompt
failure of old pending CDP, and one logical close. Portable controller tests cover stale generations,
no automatic reload, retained pinning/order/persistence and failed initial generation-zero closure.
DOM tests retain the same simulated Chromium IDs/marker while invalidating the cached handle solely
from the native unavailable/replaced event; writes fail stale before node mutation.

Root `pnpm check` passes. The finalized native suite passes all 160 tests (91 runtime, 69 browser,
no skips), and the non-GUI helper test passes. The rebuilt developer app passes strict signature/import
verification after relocation outside the checkout, plus all ten relocated integration/contract
checks. Evidence is in ignored `work/replacement-root-check.log`, `work/replacement-generation-test.log`,
`work/replacement-native-verified.log`, and `work/replacement-bundle-{build,verify,native}.log`.
The initial full run failed only because an existing resource-event assertion omitted the new
`generation`/`known` fields; that assertion now verifies the new contract. Independent final review
found no blocking issue. Root then corrected CDP error classification so a closed/unknown page retains
its distinct error rather than being reported as temporarily unavailable. The expanded native fixture
passes individual closure after replacement plus closed/unknown-page error checks
(`work/replacement-native-final-focused.log`); final root checks pass in `work/replacement-root-final.log`.
The developer app was rebuilt again with that correction, relocated, and all ten checks passed with
strict signature/import verification (`work/replacement-bundle-final-{build,verify,native}.log`).
Automatic discard/restoration and interactive macOS validation remain separate work.
