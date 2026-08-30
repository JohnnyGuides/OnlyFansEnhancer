# Creator-tool architecture

The personal extension's creator helpers are small site adapters on one
extension-native runtime. They are deliberately separate from the Chrome Web
Store edition under `store/`.

## Safety contract

Every state-changing adapter must satisfy all of these invariants:

1. It defaults disabled and cannot autorun.
2. It shows a complete local preview before a confirmation action.
3. It targets one visible, connected, enabled, semantically verified control.
4. Autocomplete and taxonomy values require one exact normalized match.
5. Missing, stale, multiple, or unverifiable targets fail closed.
6. Actions execute serially under one `AbortSignal`, action cap, duration cap,
   and single-flight runner.
7. Stop, disable, route exit, and form replacement prevent the next mutation.
8. A postcondition verifies the exact value or account state after every
   mutation.
9. Save, Submit, Post, and the final OnlyFans Add remain manual.
10. A concise structured result is shown and stored only in the local action
    log.

Doing nothing is a valid failure mode. Guessing is not.

The upload trace recorder is read-only and follows a separate observation
contract: it never starts automatically, never changes platform state, never
captures form values or request content, and stops at 45 minutes or 800 events.
The shared runtime emits optional provenance markers for panel actions, control
mutations, and run outcomes. These calls are failure-isolated: recorder absence
or failure can never block an adapter.

## Files

- `creator-tools/registry.js` is the only settings/profile schema and migration
  source. Mutating defaults are false. Profile policy is validated and
  bounded.
- `creator-tools/common.js` owns storage, lifecycle, abortable waits, exact DOM
  contracts, action budgets, the accessible Shadow DOM panel, and local logs.
- `creator-tools/onlyfans-list-common.js` owns stable user keys, context
  verification, scrolling, modal/rate-limit detection, and shared OnlyFans
  state semantics.
- `creator-tools/upload-trace-recorder.js` owns the bounded local observation
  panel used to gather evidence for future adapters. It is registered per site
  and does not use the mutation runtime.
- Each remaining file is one platform adapter. It may know site selectors but
  must not duplicate storage, lifecycle, panel, logging, or action-budget
  logic.
- `background.js` dynamically registers only enabled adapters. Creator origins
  are optional permissions; OnlyFans remains a required origin for the
  identity-mask product.

## Settings lifecycle

`creatorToolkitV2` contains:

```text
schemaVersion
tools.<toolId>.enabled
tools.<toolId>.autorun
profiles.<toolId>
```

The registry sanitizes runtime data and reports invalid profile policy to the
options page. Legacy `creatorToolkitV1` booleans migrate once. Existing enabled
tools remain enabled after migration, but all rewritten mutating behavior is
still manual.

`chrome.storage.onChanged` is the emergency-stop path. A mounted adapter is
aborted and disposed immediately when disabled or reconfigured. The background
worker separately updates future-page content-script registrations.

## Adding or changing an adapter

1. Add its definition and safe profile defaults to `registry.js`.
2. Add its optional origin and dynamic registration to `background.js`.
3. Use `CreatorToolkit.mountTool`; return a complete disposer.
4. Use `createToolPanel` and `createActionRunner`.
5. Implement a read-only inspector that builds a preview and signature.
6. Recheck the signature immediately before applying.
7. Apply one exact step at a time and verify each postcondition.
8. Export narrow pure/test hooks through `CreatorToolkitAdapters`.
9. Add fixtures for disabled state, delayed DOM, missing and duplicate targets,
   preexisting values, Stop, stale preview, partial failure, and route/setting
   disposal.
10. Run `npm run check` and inspect the validated personal ZIP.

Before a personal release, also complete
`docs/AUTHENTICATED_SMOKE_TEST.md` against the current authenticated site
versions. Live testing supplements the fixtures; it never relaxes an exact
selector or postcondition.

Do not add random sleeps, fuzzy matching, synthetic “human” typing, global
overlay closing, page-world library dependencies, or generic first-button
fallbacks.
