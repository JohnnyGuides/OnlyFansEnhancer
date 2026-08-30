# ManyVids Upload Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-confirmation ManyVids job that uploads the full video, immediately enters the edit form after ManyVids finishes processing, fills and saves the verified form, and commits the canonical ManyVids link to the catalogue without duplicate uploads.

**Architecture:** Reuse the existing upload console, file bridge, guarded DOM-adapter helpers, background coordinator, and catalogue bridge. ManyVids is one platform result but has two browser stages: the upload-page adapter assigns the full file and immediately clicks the completed card's non-delete continue/edit control; after navigation the background reinjects the bridge and runs the edit-page adapter for teaser, optional thumbnail, metadata, schedule, and Save. The browser flow derives `/Video/{id}` only after the proved success navigation; no private API replay or deletion path is introduced.

**Tech Stack:** Chrome Manifest V3 service worker and content scripts, plain browser JavaScript, Google Apps Script, Node's built-in test runner, Playwright fixtures, ESLint, TypeScript check mode, Prettier.

**Spec:** `docs/superpowers/specs/2026-08-30-manyvids-upload-automation-design.md`

## Global Constraints

- Minimum Chrome version remains `116`; add no runtime or development dependency.
- Files remain owned by the open upload-console tab and are never stored or serialized.
- ManyVids uses the real authenticated controls; do not recreate or replay a private API request.
- The completed upload card's continue/edit button is clicked immediately after processing; a generic first-button selector is forbidden because the card also contains deletion.
- Full video, shared teaser, and optional thumbnail have distinct validated roles.
- Friday is always `15:00 UTC`; display-local conversion does not alter the stored instant.
- Price is `$19.99`; no co-performer; exclude from Vid Bundle; include in Premium; select the ten configured tags by fresh exact matches.
- The final Save is clicked only after every required field and upload is verified.
- After a numeric `/Edit-vid/{id}` is captured, retry may never upload the full video again.
- The canonical result is exactly `https://www.manyvids.com/Video/{id}` and is written only after confirmed Save success.
- Catalogue writes target the existing `2026 Video Catalogue` column `L`, header `ManyVids Link`, and never overwrite a different link.
- No production or fixture action may find, click, invoke, or expose a ManyVids Delete control.
- Increment the personal extension version from `0.10.1` to `0.11.0` only when the complete vertical slice passes verification.

---

## File structure

- `creator-tools/catalogue-contract.js`: canonical platform-link validation, row scoring, and fingerprints for all three upload targets.
- `apps-script/catalogue-bridge.gs`: bounded row reads and safe column-`L` ManyVids commits.
- `upload-console.html`, `upload-console.css`, `upload-console.js`: ManyVids selection, shared teaser, optional thumbnail, one confirmation, file delivery, and status cards.
- `creator-tools/upload-file-bridge.js`: role-aware video/image validation for OnlyFans, Fansly, and ManyVids.
- `creator-tools/upload-platform-adapters.js`: guarded ManyVids upload-page and edit-page DOM operations alongside the existing OnlyFans/Fansly adapters.
- `creator-tools/upload-capability-probe.js`: read-only ManyVids login/upload-page readiness report.
- `background.js`: allow-listing, two-stage navigation coordinator, checkpoint/resume rules, canonical-link completion, and catalogue-only retries.
- `manifest.json`, `scripts/build-personal-package.ps1`: ManyVids file-bridge exposure and personal package contents.
- `creator-tools/registry.js`: locked human-readable ManyVids mode labels and Premium mode.
- `tests/upload-coordinator.test.cjs`, `tests/upload-milestone.test.cjs`, `tests/background.test.cjs`, `tests/creator-adapters.test.cjs`, `tests/creator-tools.test.cjs`, `tests/extension-load.test.cjs`: contract, browser-fixture, coordinator, packaging, and no-delete coverage.
- `README.md`, `PRIVACY.md`, `docs/AUTHENTICATED_SMOKE_TEST.md`: user-visible workflow, retained-data boundary, and safe authenticated acceptance steps.

### Task 1: Extend the catalogue contract through column L

**Files:**

- Modify: `creator-tools/catalogue-contract.js:6-130`
- Modify: `apps-script/catalogue-bridge.gs:47-285`
- Test: `tests/upload-milestone.test.cjs:115-203`
- Test: `tests/upload-milestone.test.cjs:717-894`

**Interfaces:**

- Consumes: catalogue rows shaped as `{ row, id, releaseDate, title, description, onlyfansLink, fanslyLink, manyvidsLink }`.
- Produces: `CreatorCatalogueContract.canonicalPostUrl("manyvids", value)` and Apps Script `commitPlatformLink` support for column `12`.

- [ ] **Step 1: Write failing canonical-link and fingerprint tests**

Add these assertions to the catalogue-contract tests:

```js
assert.equal(
  contract.canonicalPostUrl("manyvids", "7783271"),
  "https://www.manyvids.com/Video/7783271",
);
assert.equal(
  contract.canonicalPostUrl(
    "manyvids",
    "https://www.manyvids.com/Video/7783271/",
  ),
  "https://www.manyvids.com/Video/7783271",
);
assert.equal(
  contract.canonicalPostUrl(
    "manyvids",
    "https://manyvids.com/Edit-vid/7783271",
  ),
  null,
);
assert.notEqual(
  contract.fingerprint({ ...row, manyvidsLink: "" }),
  contract.fingerprint({
    ...row,
    manyvidsLink: "https://www.manyvids.com/Video/7783271",
  }),
);
```

Extend the Apps Script fixture row with `manyvidsLink: ""` and assert:

```js
const manyvids = context.creatorUploadPlanCommit(row, {
  fingerprint: context.creatorUploadFingerprint(row),
  platform: "manyvids",
  postUrl: "7783271",
  metadata,
});
assert.equal(manyvids.status, "updated");
assert.equal(
  manyvids.row.manyvidsLink,
  "https://www.manyvids.com/Video/7783271",
);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
node --test --test-name-pattern="catalogue" tests/upload-milestone.test.cjs
```

Expected: FAIL because `manyvids` is outside `PLATFORM_FIELDS`, fingerprints ignore `manyvidsLink`, and the Apps Script reads/writes only 11 columns.

- [ ] **Step 3: Implement the three-platform contract**

Use this map and exact canonical branch in `catalogue-contract.js`:

```js
const PLATFORM_FIELDS = Object.freeze({
  onlyfans: "onlyfansLink",
  fansly: "fanslyLink",
  manyvids: "manyvidsLink",
});

if (platform === "manyvids" && /^\d+$/.test(raw)) {
  return `https://www.manyvids.com/Video/${raw}`;
}
// inside the URL branch
if (platform === "manyvids") {
  const match = url.pathname.match(/^\/Video\/(\d+)\/?$/i);
  return url.origin === "https://www.manyvids.com" && match
    ? `https://www.manyvids.com/Video/${match[1]}`
    : null;
}
```

Include `manyvidsLink` in fingerprint serialization. In the Apps Script, read 12 columns, map `cells[11]`, allow at most three targets, canonicalize `/Video/{id}`, map `manyvids` to `manyvidsLink`, and select the write column through an explicit object:

```js
var creatorUploadLinkColumns = {
  onlyfans: 10,
  fansly: 11,
  manyvids: 12,
};
var column = creatorUploadLinkColumns[payload.platform];
if (!column) throw new Error("Invalid platform post link.");
sheet.getRange(rowNumber, column).setValue(plan.row[field]);
```

- [ ] **Step 4: Run the catalogue tests and verify they pass**

Run the Step 2 command.

Expected: PASS, including safe conflict and idempotency behavior for column L.

- [ ] **Step 5: Commit the catalogue slice**

```powershell
git add creator-tools/catalogue-contract.js apps-script/catalogue-bridge.gs tests/upload-milestone.test.cjs
git commit -m "feat: support ManyVids catalogue links"
```

### Task 2: Add ManyVids inputs to the one-confirmation console

**Files:**

- Modify: `upload-console.html:14-171`
- Modify: `upload-console.css`
- Modify: `upload-console.js:5-759`
- Test: `tests/upload-coordinator.test.cjs:31-103`
- Test: `tests/upload-milestone.test.cjs:951-1248`

**Interfaces:**

- Consumes: full `File`, shared teaser `File`, optional thumbnail `File`, catalogue candidate with `manyvidsLink`, and target set.
- Produces: `PREPARE_CREATOR_UPLOAD` with target `manyvids`, catalogue `manyvidsLink`, and file responses for roles `full`, `teaser`, and `thumbnail`.

- [ ] **Step 1: Write failing console-model tests**

Extend the coordinator tests with:

```js
const thumbnail = { name: "episode-thumb.png", type: "image/png", size: 1234 };
const result = validateDraft({
  fullFile: validFile,
  teaserFile: { name: "episode-teaser.mp4", type: "video/mp4", size: 42 },
  thumbnailFile: thumbnail,
  title: "Episode 42",
  description: "Description",
  releaseDate: "2026-08-28",
  selectedTargets: ["manyvids"],
});
assert.deepEqual(result.media.manyvids, {
  full: validFile.name,
  teaser: "episode-teaser.mp4",
  thumbnail: "episode-thumb.png",
});
assert.throws(
  () =>
    validateDraft({
      fullFile: validFile,
      teaserFile: null,
      thumbnailFile: null,
      title: "Episode 42",
      releaseDate: "2026-08-28",
      selectedTargets: ["manyvids"],
    }),
  /ManyVids teaser/,
);
```

In the Playwright console fixture, check ManyVids, attach a teaser, leave the thumbnail empty, click **Yes, upload now**, and assert one mutation message whose targets contain `manyvids` and whose catalogue candidate contains `manyvidsLink: ""`.

- [ ] **Step 2: Run the console tests and verify they fail**

```powershell
node --test tests/upload-coordinator.test.cjs
node --test --test-name-pattern="upload console" tests/upload-milestone.test.cjs
```

Expected: FAIL because the target allow-list has two entries and no thumbnail/file-role mapping exists.

- [ ] **Step 3: Implement the minimal UI and data model**

Change the teaser label to **Shared teaser (Fansly + ManyVids)**, add an optional image picker, and add this target beside the existing platform choices:

```html
<label for="uploadManyvidsThumbnail">ManyVids thumbnail (optional)</label>
<input
  id="uploadManyvidsThumbnail"
  type="file"
  accept="image/jpeg,image/png,.jpg,.jpeg,.png"
  aria-describedby="manyvidsThumbnailSummary draftErrors"
/>

<label class="target-option">
  <input id="targetManyvids" type="checkbox" value="manyvids" />
  <span
    ><strong>ManyVids</strong
    ><small>Full · teaser preview · $19.99 · Friday 15:00 UTC</small></span
  >
</label>
```

Use `new Set(["onlyfans", "fansly", "manyvids"])`. Require the shared teaser whenever Fansly or ManyVids is selected; validate a supplied thumbnail as PNG or JPEG. Add `manyvidsLink` wherever catalogue links are read, summarized, or copied into the request. File delivery resolves roles exactly:

```js
const filesByRole = {
  full: fullVideo.files[0],
  teaser: teaser.files[0],
  thumbnail: manyvidsThumbnail.files[0],
};
const file = filesByRole[request.role];
```

Request `https://www.manyvids.com/*` optional permission together with Fansly when selected. Update confirmation copy to name all selected platforms and show the optional thumbnail as `site-generated` when absent.

- [ ] **Step 4: Run the console tests and verify they pass**

Run the Step 2 commands.

Expected: PASS; no platform message occurs before the single Yes click.

- [ ] **Step 5: Commit the console slice**

```powershell
git add upload-console.html upload-console.css upload-console.js tests/upload-coordinator.test.cjs tests/upload-milestone.test.cjs
git commit -m "feat: add ManyVids upload plan to console"
```

### Task 3: Implement guarded ManyVids page adapters

**Files:**

- Modify: `creator-tools/upload-platform-adapters.js:1-519`
- Modify: `creator-tools/upload-file-bridge.js:1-172`
- Modify: `creator-tools/registry.js:350-371`
- Modify: `creator-tools/registry.js:583-629`
- Test: `tests/creator-adapters.test.cjs`
- Test: `tests/upload-milestone.test.cjs`

**Interfaces:**

- Consumes: `{ draft, attachFile(role, selector), progress(status), now() }` and the existing bridge session.
- Produces: `runManyVidsUpload(context) -> { status: "edit-requested" }`, `runManyVidsEdit(context) -> { status: "save-clicked", manyvidsId }`, and role-aware bridge validation.

- [ ] **Step 1: Write failing upload-page adapter tests**

Create an upload-page fixture containing the real hidden Uppy control and a completed file card with both remove and edit buttons:

```html
<input
  class="uppy-Dashboard-input"
  hidden
  type="file"
  name="files[]"
  multiple
  accept=".mp4, .m4v, .mov"
/>
<input
  class="uppy-Dashboard-input"
  hidden
  webkitdirectory
  type="file"
  name="files[]"
  multiple
/>
<article class="uppy-Dashboard-Item" data-state="upload-complete">
  <span class="uppy-Dashboard-Item-name">episode-full.mp4</span>
  <button
    class="uppy-Dashboard-Item-action--remove"
    aria-label="Remove file"
  ></button>
  <button class="edit-upload" onclick="window.editClicks += 1"></button>
</article>
```

Assert that `runManyVidsUpload` assigns only the non-directory input, waits for the expected filename's completed card, clicks `edit-upload` once, and never clicks the remove control. Add a second fixture with two non-remove buttons and assert it fails as ambiguous.

- [ ] **Step 2: Write failing edit-page adapter tests**

Build the fixture from the recorded controls: `#Title[name=video_title]`, `#video_description`, custom preview `input.noborder[name=file]`, thumbnail `#fileUploader[name=image]` and `#save_thumb`, tag autocomplete, `#appendedPrependedInput[name=video_cost]`, `#launchCustom`, `#available_time`, `#membership3`, `#premium2`, and `#saveVideo` labelled `Save`.

Assert:

```js
assert.equal(result.status, "save-clicked");
assert.equal(result.manyvidsId, "7783271");
assert.equal(state.title, "Episode 42");
assert.equal(state.description, "Description");
assert.equal(state.price, "19.99");
assert.equal(state.membership, "membership3");
assert.equal(state.premium, "premium2");
assert.equal(state.saveClicks, 1);
assert.equal(state.deleteClicks, 0);
assert.deepEqual(state.files, ["teaser", "thumbnail"]);
assert.equal(state.tags.length, 10);
```

Add failures for wrong visible mode labels, an eleventh tag, ambiguous Save controls, and a missing teaser acknowledgment.

- [ ] **Step 3: Run the adapter tests and verify they fail**

```powershell
node --test --test-name-pattern="ManyVids upload" tests/creator-adapters.test.cjs tests/upload-milestone.test.cjs
```

Expected: FAIL because no ManyVids upload adapter or image bridge role exists.

- [ ] **Step 4: Add role-aware bridge validation**

Replace the platform-only video assumption with a role declaration supplied at install time:

```js
const ROLE_KINDS = new Set(["video", "image"]);
function accepts(file, kind) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "");
  return kind === "image"
    ? type.startsWith("image/") || /\.(?:jpe?g|png)$/i.test(name)
    : type.startsWith("video/") ||
        /\.(?:mp4|m4v|mov|webm|avi|mkv)$/i.test(name);
}
```

Allow `manyvids`, require each role to specify `kind`, and reject a file before assigning it when `accepts(file, role.kind)` is false.

- [ ] **Step 5: Implement the upload-page guard and immediate continue/edit click**

Use the proved selector:

```js
const MANYVIDS_FULL_INPUT =
  "input.uppy-Dashboard-input[type='file']:not([webkitdirectory])";
```

After `attachFile("full", MANYVIDS_FULL_INPUT)`, locate exactly one completed Uppy card whose normalized displayed basename equals the selected full filename. Within that card, exclude `.uppy-Dashboard-Item-action--remove`, `[aria-label*='remove' i]`, and `[title*='delete' i]`; require exactly one remaining enabled button. Record `uploadReadyAt`, call `progress("upload-ready")`, and click it immediately. Return `edit-requested`; do not wait on the soon-to-be-destroyed document.

- [ ] **Step 6: Implement the edit form and exact commercial modes**

Add the locked registry defaults:

```js
priceModeExpectedLabel: "Set Your Price",
membershipExpectedLabel: "This vid is not included in your Vid Bundle",
premiumSelector: "#premium2",
premiumExpectedLabel: "Include this Vid to Premium",
```

Normalize the two Premium keys with the existing expected-label loop. In the adapter, verify every radio by selector plus normalized associated label; set title, description, price, Friday/time, exact tag matches, membership, and Premium. For the optional thumbnail, click exact text `Upload`, assign `#fileUploader[name='image']`, and click `#save_thumb[name='upload_thumbnail_btn']` once after its preview is ready. Click only `#saveVideo` whose exact visible text is `Save`, then return `save-clicked` immediately.

- [ ] **Step 7: Run the adapter tests and verify they pass**

Run the Step 3 command.

Expected: PASS with exactly one edit-card click, one final Save click, and zero delete actions.

- [ ] **Step 8: Commit the guarded adapters**

```powershell
git add creator-tools/upload-platform-adapters.js creator-tools/upload-file-bridge.js creator-tools/registry.js tests/creator-adapters.test.cjs tests/upload-milestone.test.cjs
git commit -m "feat: drive verified ManyVids upload controls"
```

### Task 4: Coordinate the two navigation stages and safe retries

**Files:**

- Modify: `background.js:2162-2915`
- Modify: `background.js:3033-3097`
- Modify: `creator-tools/upload-capability-probe.js`
- Modify: `manifest.json:16-61`
- Modify: `file-bridge.html`
- Modify: `file-bridge.js`
- Test: `tests/background.test.cjs:500-832`
- Test: `tests/background.test.cjs:847-1028`
- Test: `tests/upload-milestone.test.cjs`

**Interfaces:**

- Consumes: `manyvids` upload request, open console port, ManyVids origin permission, and adapter stage results.
- Produces: one ManyVids platform card with checkpoints `uploading-full`, `upload-ready`, `edit-requested`, `configuring`, `save-clicked`, `link-captured`, and `catalogue-updated` or a fail-closed recovery state.

- [ ] **Step 1: Write failing coordinator tests**

Add `manyvids` to the validated request fixture and assert the platform definition:

```js
assert.deepEqual(CREATOR_UPLOAD_TARGETS.manyvids, {
  match: "https://www.manyvids.com/*",
  landingUrl: "https://www.manyvids.com/upload-video",
  origin: "https://www.manyvids.com",
});
```

Model these events in order: prepared upload page, `edit-requested`, tab update to `/Edit-vid/7783271`, edit bridge preparation, `save-clicked`, tab update to `/upload-video`. Assert the result:

```js
assert.deepEqual(result, {
  platform: "manyvids",
  status: "catalogue-updated",
  postUrl: "https://www.manyvids.com/Video/7783271",
});
assert.deepEqual(fileRoles, ["full", "teaser"]);
assert.equal(fullUploadCount, 1);
```

Add restart/resume fixtures where the checkpoint already contains `manyvidsId: "7783271"`; assert no Stage-1 preparation or full-file request occurs. Add a 45-minute fake-clock case that returns `failed` with a manual-recovery message and still reports `fullUploadCount === 1`.

- [ ] **Step 2: Run coordinator tests and verify they fail**

```powershell
node --test --test-name-pattern="creator upload|ManyVids" tests/background.test.cjs tests/upload-milestone.test.cjs
```

Expected: FAIL because the background allow-list, navigation stages, progress states, and canonical completion branch support only OnlyFans/Fansly.

- [ ] **Step 3: Add the ManyVids target and bridge roles**

Define:

```js
manyvids: Object.freeze({
  match: "https://www.manyvids.com/*",
  landingUrl: "https://www.manyvids.com/upload-video",
  origin: "https://www.manyvids.com",
}),
```

Prepare Stage 1 with one full-video token and selector. After `/Edit-vid/{id}`, reinstall the bridge with teaser and optional thumbnail role descriptors. Add `https://www.manyvids.com/*` to the web-accessible file bridge matches. The capability probe reports only authentication, upload surface, and expected semantic controls; it does not read values or click anything.

- [ ] **Step 4: Implement bounded navigation waiting**

Add one shared helper that first reads the current tab, then listens for the expected URL and load completion:

```js
async function waitForCreatorTabRoute(tabId, predicate, timeoutMs) {
  const current = await chrome.tabs.get(tabId);
  if (predicate(current.url || "") && current.status === "complete")
    return current;
  return new Promise((resolve, reject) => {
    // one onUpdated listener; remove it and the timer on every exit
  });
}
```

The concrete predicates are exact-origin checks plus `/^\/Edit-vid\/(\d+)\/?$/` for the first navigation and exact `/upload-video` for Save success. The upload-page wait uses `45 * 60_000`; edit-page loading and Save navigation use existing bounded readiness timeouts.

- [ ] **Step 5: Implement `runCreatorManyVidsUpload`**

Branch before the response-observer path:

```js
if (platform === "manyvids") {
  return runCreatorManyVidsUpload(session, target);
}
```

The function runs Stage 1 once, captures the numeric ID from the proved route, stores it on `target.manyvidsId`, prepares the edit bridge, runs Stage 2, waits for exact success navigation, canonicalizes the ID through `CreatorCatalogueContract`, and calls the existing `commitCreatorUploadResult`. An adapter exception before ID capture is retryable; after ID capture, retry reopens only `/Edit-vid/{id}`; after `postUrl` exists, retry remains catalogue-only.

- [ ] **Step 6: Add service-worker restart checkpoints without storing content**

Persist only this shape in `chrome.storage.session`:

```js
{
  sessionId,
  platform: "manyvids",
  tabId,
  stage,
  manyvidsId,
  fullRequested,
  saveAttempted,
  uploadStartedAt,
  uploadReadyAt,
  editPageEnteredAt,
}
```

On upload-console port reconnection, the console resends its still-in-memory validated request with `RESUME_CREATOR_UPLOAD`; background combines it with the checkpoint and current tab route. If the console lost its files, return manual recovery and never create a duplicate Stage 1 job.

- [ ] **Step 7: Run coordinator tests and verify they pass**

Run the Step 2 command.

Expected: PASS across navigation, restart, timeout, catalogue-only retry, and no-duplicate cases.

- [ ] **Step 8: Commit the coordinator slice**

```powershell
git add background.js creator-tools/upload-capability-probe.js manifest.json file-bridge.html file-bridge.js tests/background.test.cjs tests/upload-milestone.test.cjs
git commit -m "feat: coordinate ManyVids upload across navigation"
```

### Task 5: Prove timing, validation recovery, and the deletion boundary

**Files:**

- Modify: `tests/upload-milestone.test.cjs`
- Modify: `tests/creator-adapters.test.cjs`
- Modify: `tests/extension-load.test.cjs`
- Modify: `docs/AUTHENTICATED_SMOKE_TEST.md`

**Interfaces:**

- Consumes: the complete ManyVids adapter/coordinator slice.
- Produces: regression evidence for immediate continuation, at most one deterministic corrective Save, package loadability, and zero Delete capability.

- [ ] **Step 1: Add a fake-clock immediate-continuation test**

In the upload-page fixture, expose the completed card at `clock = 10_000`, advance no time inside the adapter, and assert:

```js
assert.equal(state.uploadReadyAt, 10_000);
assert.equal(state.editClickedAt, 10_000);
assert.equal(state.editClicks, 1);
```

Also hold the card incomplete until `44 * 60_000`, then mark it complete and assert the edit click happens at that same tick. At `45 * 60_000`, assert an urgent fail-closed result and no retry upload.

- [ ] **Step 2: Add deterministic validation-recovery tests**

Make the first Save expose one exact missing-tag validation message, have the adapter add that one exact tag, and assert `saveClicks === 2`. For an unknown validation message, assert `saveClicks === 1`, `status === "failed"`, and no automatic second click.

- [ ] **Step 3: Add a no-delete source and behavior gate**

Scan only the ManyVids production adapter/coordinator execution functions and assert they contain neither a delete selector nor a Delete action label. Separately keep a remove button in the browser fixture and assert its click counter remains zero through success and every failure case. Do not scan documentation or the trace recorder, where the word is legitimate.

- [ ] **Step 4: Run the milestone and load tests**

```powershell
node --test tests/creator-adapters.test.cjs tests/upload-milestone.test.cjs tests/extension-load.test.cjs
```

Expected: PASS with immediate timing, bounded correction, no-delete, and extension-load coverage.

- [ ] **Step 5: Document the authenticated non-posting and posting checks**

Add a ManyVids section that first runs a read-only readiness check, then states that the only real mutation test requires the console's explicit Yes. The acceptance evidence must record: full file begins, completed card enters edit immediately, teaser and optional thumbnail are correct, Friday/time and modes are correct, Save occurs, `/Video/{id}` is shown, column L is filled, and no second full upload exists. State that deletion is never part of acceptance.

- [ ] **Step 6: Commit the reliability gates**

```powershell
git add tests/creator-adapters.test.cjs tests/upload-milestone.test.cjs tests/extension-load.test.cjs docs/AUTHENTICATED_SMOKE_TEST.md
git commit -m "test: lock ManyVids upload reliability boundaries"
```

### Task 6: Version, document, build, and verify the 0.11.0 milestone

**Files:**

- Modify: `manifest.json:4`
- Modify: `package.json:2`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `PRIVACY.md`
- Modify: `scripts/build-personal-package.ps1`
- Verify generated: `dist/creator-workflow-toolkit-personal-v0.11.0/`

**Interfaces:**

- Consumes: all passing implementation and regression tasks.
- Produces: a loadable personal extension package with visible version `0.11.0`.

- [ ] **Step 1: Update user-facing documentation**

Document the actual workflow: full video plus shared teaser, optional ManyVids thumbnail, one Yes, immediate continue/edit click after upload processing, automatic verified Save, canonical link capture, and safe column-L commit. State that files remain in the console tab and that only non-sensitive checkpoint metadata may use session storage.

- [ ] **Step 2: Bump all personal-version sources to 0.11.0**

Set both `manifest.json` and `package.json` to `0.11.0`, update the lockfile with the repository's installed npm, and ensure the personal build copies every modified runtime file. Do not change the separate store-edition product identity or permissions.

- [ ] **Step 3: Run focused tests first**

```powershell
node --test tests/upload-coordinator.test.cjs tests/upload-milestone.test.cjs tests/background.test.cjs tests/creator-adapters.test.cjs tests/extension-load.test.cjs
```

Expected: all tests PASS.

- [ ] **Step 4: Run the complete verification gate**

```powershell
npm run check
```

Expected: lint, typecheck, formatting check, personal tests, store tests, personal build, and store build all PASS.

- [ ] **Step 5: Verify the built extension version and package contents**

```powershell
$manifest = Get-Content -LiteralPath '.\dist\creator-workflow-toolkit-personal-v0.11.0\manifest.json' -Raw | ConvertFrom-Json
if ($manifest.version -ne '0.11.0') { throw "Unexpected personal extension version $($manifest.version)" }
$required = @(
  'upload-console.html',
  'upload-console.js',
  'creator-tools\upload-platform-adapters.js',
  'creator-tools\upload-file-bridge.js',
  'creator-tools\catalogue-contract.js',
  'apps-script\catalogue-bridge.gs'
)
foreach ($relative in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path '.\dist\creator-workflow-toolkit-personal-v0.11.0' $relative))) {
    throw "Missing built file: $relative"
  }
}
```

Expected: no output and exit code `0`.

- [ ] **Step 6: Review only this milestone's diff**

```powershell
git diff --check
git diff --stat -- manifest.json package.json package-lock.json background.js upload-console.html upload-console.css upload-console.js file-bridge.html file-bridge.js creator-tools/catalogue-contract.js creator-tools/upload-capability-probe.js creator-tools/upload-file-bridge.js creator-tools/upload-platform-adapters.js creator-tools/registry.js apps-script/catalogue-bridge.gs tests README.md PRIVACY.md docs/AUTHENTICATED_SMOKE_TEST.md docs/superpowers/specs/2026-08-30-manyvids-upload-automation-design.md docs/superpowers/plans/2026-08-30-manyvids-upload-automation.md
```

Expected: `git diff --check` is clean and the stat contains no unrelated path.

- [ ] **Step 7: Commit the milestone metadata and docs**

```powershell
git add manifest.json package.json package-lock.json README.md PRIVACY.md scripts/build-personal-package.ps1 docs/AUTHENTICATED_SMOKE_TEST.md docs/superpowers/specs/2026-08-30-manyvids-upload-automation-design.md docs/superpowers/plans/2026-08-30-manyvids-upload-automation.md
git commit -m "release: prepare creator toolkit 0.11.0"
```
