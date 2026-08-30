# Authenticated Upload and Catalogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Creator Workflow Toolkit `0.10.0` with one-confirmation,
browser-driven OnlyFans/Fansly uploads and immediate safe reconciliation to the
`2026 Video Catalogue` sheet.

**Architecture:** The upload console retains full/teaser `File` objects and
starts the independent authenticated tabs together so both full transfers can
begin immediately. A same-extension-origin iframe
bridges each large file into a guarded site adapter; a narrow final-XHR observer
returns the created post link, which an allow-listed Apps Script bridge commits
with locking, fingerprinting, and no-overwrite rules.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript/HTML/CSS,
Apps Script, `BroadcastChannel`, `postMessage`, `DataTransfer`, Node test runner,
Playwright, ESLint, TypeScript check-JS, PowerShell packaging.

**Spec:**
`docs/superpowers/specs/2026-08-22-authenticated-upload-and-catalogue-design.md`

## Global Constraints

- Personal package only; do not add upload code to `store/`.
- No new dependency or direct recreation of private platform APIs.
- OnlyFans gets the full video; Fansly gets the teaser through **Add Free
  Preview** on the full-media bundle, with the full locked using exact preset
  `defaulT`.
- Schedule Friday at `15:00 UTC`; derive the actual browser-local date/time.
- Never change OnlyFans labels.
- Never persist file bytes, paths, titles, or descriptions.
- Never overwrite a different existing catalogue link.
- One platform failure must not roll back or re-run a successful platform.

---

### Task 1: Freeze deterministic workflow and catalogue helpers

**Files:**

- Modify: `tests/upload-coordinator.test.cjs`
- Modify: `upload-console.js`
- Create: `creator-tools/catalogue-contract.js`

**Interfaces:**

- Produces `nextFridayUtc(now): { iso: string, localValue: string }`.
- Produces `normalizeDraft(draft)` with full/teaser roles and target mapping.
- Produces `CreatorCatalogueContract` helpers for normalized tokens, slug IDs,
  match scoring, fingerprints, canonical platform links, and safe commit checks.

- [ ] **Step 1: Add literal failing tests** for Thursday/Friday boundaries,
      summer/winter local display, full/teaser requirements, slug collisions,
      match ordering, link canonicalization, and conflicting existing links.
- [ ] **Step 2: Run**
      `node --test tests/upload-coordinator.test.cjs` and verify failures are
      caused by the missing new contracts.
- [ ] **Step 3: Implement the minimum pure helpers** with native `Date`,
      `Intl`, strings, and arrays only.
- [ ] **Step 4: Re-run the focused test** and verify it passes.

### Task 2: Build the session-scoped file bridge

**Files:**

- Create: `file-bridge.html`
- Create: `file-bridge.js`
- Create: `creator-tools/upload-file-bridge.js`
- Modify: `manifest.json`
- Modify: `tests/upload-coordinator.test.cjs`

**Interfaces:**

- Console sends `{ sessionId, platform, role, file }` on channel
  `creator-upload:<sessionId>`.
- The iframe forwards the structured-cloned `File` to the exact parent origin.
- The content script exposes `CreatorUploadFileBridge.attachFile(request)` and
  returns only `{ name, size, type, role }` after native assignment.

- [ ] **Step 1: Add a failing Playwright fixture** with a real `File`, iframe,
      platform input, wrong-session message, and oversized non-video rejection.
- [ ] **Step 2: Run the focused test** and verify missing bridge behavior fails.
- [ ] **Step 3: Implement the bridge** using `BroadcastChannel`, `postMessage`,
      `DataTransfer`, strict origin/session/role validation, and one-use tokens.
- [ ] **Step 4: Re-run the focused test** and verify the real input receives the
      file while invalid messages do not mutate it.

### Task 3: Implement trace-grounded platform state machines

**Files:**

- Create: `creator-tools/upload-platform-adapters.js`
- Modify: `tests/upload-coordinator.test.cjs`

**Interfaces:**

- Produces `CreatorUploadPlatformAdapters.runOnlyFans(context)`.
- Produces `CreatorUploadPlatformAdapters.runFansly(context)`.
- Context supplies `attachFile`, guarded selector queries, `observeCommit`,
  progress callback, normalized draft, and an abort signal.

- [ ] **Step 1: Add failing browser fixtures** matching the recorded OnlyFans
      TipTap/file/schedule/Save flow and Fansly Upload New/media
      lock/`defaulT`/clock-calendar/Confirm Date/Schedule/Post flow.
- [ ] **Step 2: Assert mutation boundaries**: OnlyFans labels stay byte-for-byte
      unchanged, Fansly teaser is free, full is locked, captions exclude title,
      and each final action is clicked once.
- [ ] **Step 3: Run the focused test** and verify adapter absence fails.
- [ ] **Step 4: Implement explicit state machines** with exact selectors first,
      bounded semantic fallbacks, readiness waits, and no generic first-button
      fallback.
- [ ] **Step 5: Re-run the focused tests** for successful, missing, ambiguous,
      waiting-teaser, and aborted states.

### Task 4: Capture only final post identity

**Files:**

- Create: `creator-tools/upload-response-observer.js`
- Modify: `tests/upload-coordinator.test.cjs`

**Interfaces:**

- Produces `CreatorUploadResponseObserver.install(config)` in MAIN world.
- Emits `{ sessionId, platform, status, postUrl }` only for an unambiguous
  successful expected XHR.
- Pure hook `extractPostUrl(platform, payload)` returns a canonical URL or null.

- [ ] **Step 1: Add failing literal response fixtures** for direct URLs, nested
      IDs, malformed JSON, failure status, unrelated uploads, multiple IDs, and
      unknown shapes.
- [ ] **Step 2: Run the focused test** and verify the missing observer fails.
- [ ] **Step 3: Implement the narrow XHR wrapper** without reading request
      headers, bodies, cookies, or unrelated responses.
- [ ] **Step 4: Re-run focused tests** and verify ambiguous payloads fail closed.

### Task 5: Add the allow-listed Apps Script catalogue bridge

**Files:**

- Create: `apps-script/catalogue-bridge.gs`
- Create: `creator-tools/catalogue-client.js`
- Modify: `options.html`
- Modify: `options.js`
- Modify: `options.css`
- Modify: `tests/upload-coordinator.test.cjs`
- Modify: `tests/creator-tools.test.cjs`

**Interfaces:**

- `matchCatalogue({ title, description, filename, releaseDate, targets })`
  returns a matched-row or proposed-row preview plus fingerprint.
- `commitPlatformLink({ row, fingerprint, platform, postUrl, metadata })`
  returns `updated`, `idempotent`, `conflict`, or `stale`.
- Endpoint and secret live in `chrome.storage.local`; draft metadata does not.

- [ ] **Step 1: Add failing tests** against an in-memory sheet adapter for best
      match, new row, concurrent fingerprint change, ID collision,
      idempotence, and J/K conflict.
- [ ] **Step 2: Run focused tests** and verify missing client/contract failures.
- [ ] **Step 3: Implement the Apps Script** with fixed spreadsheet/sheet/ranges,
      input bounds, Script Property secret, `LockService`, and minimal JSON.
- [ ] **Step 4: Implement the extension client/settings** with HTTPS endpoint
      validation, bounded payloads, timeout, and redacted errors.
- [ ] **Step 5: Re-run focused tests** and verify only intended cells change.

### Task 6: Turn the console into the one-confirmation coordinator

**Files:**

- Modify: `upload-console.html`
- Modify: `upload-console.css`
- Modify: `upload-console.js`
- Modify: `background.js`
- Modify: `tests/background.test.cjs`
- Modify: `tests/upload-coordinator.test.cjs`

**Interfaces:**

- `PREPARE_CREATOR_UPLOAD` opens/reuses tabs and installs the bridge/adapters.
- `START_CREATOR_UPLOAD` runs selected platforms independently and streams
  bounded progress to the console.
- `RETRY_CREATOR_UPLOAD_PLATFORM` reruns only a specified pre-submission
  failure. If a canonical post URL is already known, it retries only the sheet
  commit; unresolved submissions cannot repost automatically.

- [ ] **Step 1: Add failing integration tests** for preview-before-mutation,
      one confirmation, immediate full transfer, waiting teaser, partial
      success commit, failed-platform-only retry, and closed-console cleanup.
- [ ] **Step 2: Run focused tests** and verify the old probe-only UI fails them.
- [ ] **Step 3: Implement the console workflow** with full/teaser inputs,
      catalogue preview, exact summary, Yes/No gate, progress cards, late teaser
      delivery, and retry buttons.
- [ ] **Step 4: Implement background session coordination** with random session
      IDs, exact tab binding, sequential platform mutation, cancellation,
      progress routing, and session cleanup.
- [ ] **Step 5: Re-run focused tests** and verify no mutation occurs before Yes.

### Task 7: Package and verify `0.10.0`

**Files:**

- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/build-personal-package.ps1`
- Modify: `README.md`
- Modify: `PRIVACY.md`
- Modify: `docs/AUTHENTICATED_SMOKE_TEST.md`
- Modify: `tests/creator-tools.test.cjs`
- Modify: `tests/store-edition.test.cjs`
- Modify: `tests/extension-load.test.cjs`

**Interfaces:**

- Personal unpacked extension and ZIP report `0.10.0` and contain the new
  bridge/adapters/client/script documentation.
- Store source and ZIP contain none of the uploader milestone.

- [ ] **Step 1: Add failing package/load assertions** for version, required
      files, web-accessible bridge scope, settings, and store exclusion.
- [ ] **Step 2: Run focused packaging tests** and verify the old package fails.
- [ ] **Step 3: Bump all version sources to `0.10.0`**, update packaging and
      human documentation, then build the personal ZIP.
- [ ] **Step 4: Run simulated end-to-end Playwright fixtures** without accessing
      or posting to live platform accounts.
- [ ] **Step 5: Run `npm run check`** and inspect exit code, test totals, ZIP
      entries, Chrome unpacked-extension version, and SHA-256.
- [ ] **Step 6: Perform a scoped independent review**, address material findings
      test-first, and re-run the full verification.
