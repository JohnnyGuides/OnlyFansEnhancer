# Upload Coordinator Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a personal-extension upload console that keeps one selected video
in memory, opens or reuses authenticated OnlyFans and Fansly tabs, and reports
read-only composer capabilities without uploading or posting.

**Architecture:** A root extension page owns the in-memory draft. The service
worker serially coordinates allow-listed platform tabs and injects one
read-only semantic probe. The probe returns bounded capability reports and
never reads values or mutates the platform page.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript, HTML/CSS,
Node's built-in test runner, Playwright, ESLint, TypeScript check-JS, PowerShell
package validation.

**Spec:**
`docs/superpowers/specs/2026-08-22-upload-coordinator-vertical-slice-design.md`

## Global Constraints

- Personal package only; do not change files under `store/`.
- No new runtime or development dependencies.
- Do not write file bytes, base64 data, local paths, titles, descriptions, or
  captions to `chrome.storage`.
- Probes are read-only and may not read control values, cookies, local storage,
  request bodies, headers, or responses.
- OnlyFans and Fansly run serially and fail independently.
- Multiple matching site tabs or tied semantic controls fail closed.
- No upload, post, schedule, save, edit, or delete action exists in this slice.

---

### Task 1: Stabilize the existing unpacked-extension baseline

**Files:**

- Modify: `tests/extension-load.test.cjs`

**Interfaces:**

- Consumes: existing options workflow and `syncCreatorToolRegistrations()`.
- Produces: deterministic unpacked-extension coverage that does not wait for
  Chromium's inaccessible browser-level optional-host permission bubble.

- [x] **Step 1: Reproduce the failing baseline**

Run:

```powershell
node --test tests/extension-load.test.cjs
```

Expected: FAIL after 60 seconds while waiting for `#workflowStatus` because
`chrome.permissions.request()` remains pending.

- [x] **Step 2: Isolate the test from browser chrome**

Uncheck `#toolUploadTraceRecorder` before saving the OnlyFans-only workflow.
After the save assertion, enable the recorder directly in the test service
worker and call:

```js
await syncCreatorToolRegistrations(result.creatorToolkitV2);
```

Keep the full-extension recorder exercise on OnlyFans, whose origin is already
required. Remove the redundant optional-origin loop; per-origin registration is
already covered by `tests/background.test.cjs`.

- [x] **Step 3: Verify the isolated integration test**

Run:

```powershell
node --test tests/extension-load.test.cjs
```

Expected: PASS with the recorder and unpacked-extension messages.

---

### Task 2: Define the console draft behavior test-first

**Files:**

- Create: `upload-console.html`
- Create: `upload-console.css`
- Create: `upload-console.js`
- Create: `tests/upload-coordinator.test.cjs`

**Interfaces:**

- Produces:
  - `CreatorUploadConsole.nextFridayLocalValue(now: Date): string`
  - `CreatorUploadConsole.validateDraft(draft): { valid: boolean, errors: string[] }`
  - the `PROBE_CREATOR_UPLOAD_TARGETS` message with `{ targets: string[] }` only.
- The background coordinator in Task 4 consumes the message. No draft text or
  file object crosses the message boundary.

- [x] **Step 1: Write failing pure-behavior tests**

Add literal cases proving:

```js
assert.equal(
  hooks.nextFridayLocalValue(new Date(2026, 7, 20, 9, 0)),
  "2026-08-21T12:00",
);
assert.equal(
  hooks.nextFridayLocalValue(new Date(2026, 7, 21, 12, 0)),
  "2026-08-28T12:00",
);
assert.deepEqual(
  hooks.validateDraft({
    file: { name: "episode.mp4", type: "video/mp4", size: 100 },
    title: "Episode 42",
    description: "",
    scheduledAt: "2026-08-28T12:00",
    targets: ["onlyfans", "fansly"],
  }),
  { valid: true, errors: [] },
);
```

Also prove missing files, non-video MIME types, blank titles, invalid dates,
and empty target lists produce specific errors.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test tests/upload-coordinator.test.cjs
```

Expected: FAIL because `upload-console.js` and its hooks do not exist.

- [x] **Step 3: Implement the minimum console**

Use native controls only. Keep the selected `File` in a module variable. The
check handler constructs only:

```js
const response = await sendMessage({
  type: "PROBE_CREATOR_UPLOAD_TARGETS",
  targets: selectedTargets,
});
```

Request `https://fansly.com/*` only when Fansly is selected. Render one bounded
status card per result. Do not use `FileReader`, `chrome.storage`, or base64.

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node --test tests/upload-coordinator.test.cjs
```

Expected: pure console tests PASS.

---

### Task 3: Build the read-only semantic probe test-first

**Files:**

- Create: `creator-tools/upload-capability-probe.js`
- Modify: `tests/upload-coordinator.test.cjs`

**Interfaces:**

- Produces:
  - `CreatorUploadCapabilityProbe.probe(): CapabilityReport`
  - `CreatorUploadCapabilityProbe.inspect(document, location): CapabilityReport`
- `CapabilityReport.status` is one of `composer-detected`, `page-detected`,
  `login-required`, or `ambiguous`.
- Task 4 injects the file and calls `probe()` in the isolated world.

- [x] **Step 1: Write failing fixture tests**

Create Playwright pages for:

```html
<input type="file" name="media" accept="video/*" hidden />
<textarea aria-label="Post caption"></textarea>
<button aria-label="Schedule post">Calendar</button>
<button type="submit">Post</button>
```

Assert `composer-detected`, all four capabilities, and unchanged `outerHTML`.
Add separate pages proving a password input returns `login-required`, missing
controls return `page-detected`, and two equally scored post buttons return
`ambiguous`. Put private text in the textarea and assert it is absent from the
serialized report.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test tests/upload-coordinator.test.cjs
```

Expected: FAIL because the probe global is unavailable.

- [x] **Step 3: Implement semantic candidate scoring**

Inspect only element tag/type/role/name/id/ARIA/placeholder/test-ID tokens.
Never inspect `.value` or class names. Choose the top candidate only when its
score is positive and strictly greater than the runner-up. File inputs may be
hidden; editor, schedule, and final controls must be visible and enabled.

Return compact signatures shaped as:

```js
{
  tag: "button",
  type: "submit",
  role: "",
  tokens: ["post"],
}
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node --test tests/upload-coordinator.test.cjs
```

Expected: all draft and probe tests PASS.

---

### Task 4: Coordinate authenticated tabs serially test-first

**Files:**

- Modify: `background.js`
- Modify: `tests/background.test.cjs`
- Modify: `tests/upload-coordinator.test.cjs`

**Interfaces:**

- Consumes: `PROBE_CREATOR_UPLOAD_TARGETS` with allow-listed target IDs.
- Produces: `{ results: CapabilityResult[] }`, preserving requested order.
- Handles `OPEN_UPLOAD_CONSOLE` and returns the focused/created console tab ID.

- [x] **Step 1: Extend the background fake and write failing coordination tests**

Add `chrome.tabs.query/create/update/get/onUpdated` and
`chrome.scripting.executeScript` fakes. Prove:

```js
const response = await send({
  type: "PROBE_CREATOR_UPLOAD_TARGETS",
  targets: ["onlyfans", "fansly"],
});
assert.deepEqual(
  response.results.map((result) => result.platform),
  ["onlyfans", "fansly"],
);
```

Also prove one matching tab is reused, zero tabs creates the allow-listed
landing URL, multiple tabs return `ambiguous-tabs`, unknown IDs return
`unsupported`, and the second target begins only after the first completes.

- [x] **Step 2: Run the focused background test and verify RED**

Run:

```powershell
node --test tests/background.test.cjs
```

Expected: FAIL because the two message types are unhandled.

- [x] **Step 3: Implement the allow-listed coordinator**

Add fixed definitions:

```js
const CREATOR_UPLOAD_TARGETS = Object.freeze({
  onlyfans: Object.freeze({
    match: "https://onlyfans.com/*",
    landingUrl: "https://onlyfans.com/",
  }),
  fansly: Object.freeze({
    match: "https://fansly.com/*",
    landingUrl: "https://fansly.com/",
  }),
});
```

Use a `for...of` loop, never `Promise.all`. Wait at most 20 seconds for a
created tab. Inject `creator-tools/upload-capability-probe.js` once and use the
file's final expression as the serialized report. Validate the tab origin
before and after that single execution, and validate the report's platform and
route before accepting it. Normalize thrown errors into per-platform
`probe-failed` results.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/background.test.cjs tests/upload-coordinator.test.cjs
```

Expected: coordinator and probe tests PASS.

---

### Task 5: Wire personal-package entry points and verify the extension

**Files:**

- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `popup.css`
- Modify: `scripts/build-personal-package.ps1`
- Modify: `tests/creator-tools.test.cjs`
- Modify: `tests/extension-load.test.cjs`
- Modify: `tests/store-edition.test.cjs`
- Modify: `README.md`
- Modify: `PRIVACY.md`

**Interfaces:**

- Popup sends `OPEN_UPLOAD_CONSOLE`.
- The personal ZIP includes the three console files and probe.
- The store ZIP contains none of them.

- [x] **Step 1: Write failing package and unpacked-extension assertions**

Assert the personal files exist, the store source does not reference
`upload-console` or `upload-capability-probe`, and clicking the popup button
opens exactly one extension console tab containing `#uploadVideo` and
`#checkSites`.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test tests/creator-tools.test.cjs tests/store-edition.test.cjs tests/extension-load.test.cjs
```

Expected: FAIL on missing entry point or package assertions.

- [x] **Step 3: Add the popup, package, and privacy wiring**

Add the root files to `$relativeFiles` and `$requiredArchiveEntries` in the
personal build script. Document that the file and metadata remain only in the
open console and that probes are read-only. Do not change `store/`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/creator-tools.test.cjs tests/store-edition.test.cjs tests/extension-load.test.cjs
```

Expected: focused integration tests PASS.

- [x] **Step 5: Run full verification**

Run:

```powershell
npm run check
```

Expected: lint, typecheck, formatting, all tests, and both package builds exit
zero. Inspect the personal ZIP entries and SHA-256 reported by the build.

- [x] **Step 6: Inspect the rendered console without posting**

Load the unpacked extension fixture, open the console from the popup, select a
small synthetic local video fixture, and inspect the layout and states. If an
authenticated browser session is available, run only **Check selected sites**;
do not select any platform upload control or click Post/Schedule.

---

### Task 6: Close adversarial review gaps

- [x] Reject inherited object keys such as `__proto__` and `constructor` from
      the platform allow-list.
- [x] Require video/upload, caption/post, and publish/post semantics inside one
      correlated composer boundary; reject profile forms, disabled ancestors,
      invisible ancestors, and separated sibling forms.
- [x] Coalesce concurrent opens and retain the created console tab ID so an
      immediate sequential request cannot race Chrome context registration.
- [x] Register load listeners before rechecking tab status, clean them up after
      timeout, use one probe injection, and fail closed on navigation or report
      origin mismatch.
- [x] Make title validation reachable and native, reject explicit non-video MIME
      types even when filenames use video extensions, and declare Chrome 116 as
      the minimum supported version.
- [x] Reproduce these cases in unit fixtures and the actual unpacked-Chromium
      integration test before running the full package check.
