# Creator-tool architecture

The personal extension's creator helpers are small site adapters on one
extension-native runtime. They are deliberately separate from the Chrome Web
Store edition under `store/`.

## Safety contract

Every state-changing adapter must satisfy all of these invariants:

1. It may be available by default, but cannot autorun a mutation merely because
   a supported page opened.
2. It shows a complete local preview before a confirmation action.
3. It targets one visible, connected, enabled, semantically verified control.
4. Autocomplete and taxonomy values require one exact normalized match.
5. Missing, stale, multiple, or unverifiable targets fail closed.
6. Actions execute serially under one `AbortSignal`, action cap, duration cap,
   and single-flight runner.
7. Stop, disable, route exit, and form replacement prevent the next mutation.
8. A postcondition verifies the exact value or account state after every
   mutation.
9. Standalone helper panels leave Save, Submit, Post, and the final OnlyFans Add
   manual. The Master Uploader may perform only the final controls covered by
   its one exact confirmed plan and a durable pre-click submission checkpoint.
   Pornhub final submission remains manual.
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
  source. Schema 3 activates integrated helpers once while keeping every
  mutation manual. Profile policy is validated and bounded.
- `creator-tools/common.js` owns storage, lifecycle, abortable waits, exact DOM
  contracts, action budgets, the accessible Shadow DOM panel, and local logs.
- `creator-tools/onlyfans-list-common.js` owns stable user keys, context
  verification, scrolling, modal/rate-limit detection, and shared OnlyFans
  state semantics.
- `creator-tools/upload-trace-recorder.js` owns the bounded local observation
  panel used to gather evidence for future adapters. It is registered per site
  and does not use the mutation runtime.
- `upload-console.js` owns the editable Master Uploader draft, every `File`
  object, and the single helper Settings surface. It loads one normalized
  saved-profile snapshot, displays one exact cross-site plan, and sends it only
  after the creator confirms Yes. Changing helper settings preserves selected
  files but invalidates and rebuilds an existing confirmation.
- `creator-tools/upload-session-store.js` stores only bounded allow-listed job
  metadata in `chrome.storage.session`. Monotonic submission flags, numeric
  ManyVids IDs, and captured canonical URLs cannot be cleared by a later write.
  Per-session writes are serialized so simultaneous platform checkpoints cannot
  erase one another. Fully terminal jobs are removed; only recoverable or
  uncertain work remains for the browser session.
  It never stores files, bytes, local paths, credentials, cookies, headers, or
  request bodies.
- The Fansly, ManyVids, and Pornhub adapters export narrow inspectors and
  applicators used by both their standalone panels and the Master Uploader.
  Master runs suppress the nested helper confirmations but not their exact
  control verification or fail-closed behavior.
- Each remaining file is one platform adapter. It may know site selectors but
  must not duplicate storage, lifecycle, panel, logging, or action-budget
  logic.
- `background.js` dynamically registers only enabled adapters. Supported
  creator-site origins are declared by the personal build; Gelbooru, Realbooru,
  and the optional catalogue bridge retain optional access. It also coordinates authenticated Master Uploader tabs,
  checkpoints every stage, and refuses to repeat an uncertain final submission.

## Master Uploader boundaries

OnlyFans, Fansly, and ManyVids may use their traced file, metadata, scheduling,
and final controls after the global Yes. Immediately before a final site click,
the page adapter asks the worker to persist and read back `submitAttempted` for
that exact session, platform, and tab. No acknowledgement means no click. If the
worker later restores a session whose submit was attempted but whose link is
unknown, it requires manual link recovery instead of reposting.
On a worker restart, the console must prove the confirmed full/Pornhub filenames,
thumbnail choice, and profile signature before the restored job is displayed.
Interrupted pre-submit stages are reclassified as safe exact retries. The
console retains the original confirmed `File` objects and rejects an identity
mismatch; only a teaser missing at confirmation may be supplied later.

Pornhub is intentionally narrower. The confirmed plan chooses the optional
Pornhub video or falls back to the full video and records that effective
filename, but version 0.16.0 applies only the verified exact preset metadata.
File assignment, title/description, scheduling, final Submit, and canonical link
capture remain manual. The catalogue contract already validates canonical
`viewkey` links and column H without inventing or scraping one.

The confirmation card renders the exact saved recipe fields it authorizes. Once
Yes has validated a Pornhub plan, the console may save that exact confirmed
Season/Arc-to-preset mapping for future proposals, but it does not mutate the
profile snapshot already in flight.

## Settings lifecycle

`creatorToolkitV2` contains:

```text
schemaVersion
tools.<toolId>.enabled
tools.<toolId>.autorun
profiles.<toolId>
```

The registry sanitizes runtime data and reports invalid profile policy in
**Upload console → Settings**. Legacy `creatorToolkitV1` booleans migrate once;
schema 2 settings then activate all integrated helpers once. Schema 3 preserves
every later on/off choice. All mutating behavior remains manual outside an
exact confirmed Master Uploader plan.

`chrome.storage.onChanged` is the emergency-stop path. A mounted adapter is
aborted and disposed immediately when disabled or reconfigured. The background
worker separately updates future-page content-script registrations.

## Adding or changing an adapter

1. Add its definition and safe profile defaults to `registry.js`.
2. Add its supported origin and dynamic registration to `background.js`.
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
