# Master Uploader Shared Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release Creator Workflow Toolkit `0.13.0` with one resumable Master Uploader that shares saved Fansly, ManyVids, and Pornhub recipe logic and preserves one-confirmation/no-repost safeguards.

**Architecture:** Existing site helper files become the canonical owners of their metadata inspection and application operations; their manual panels and the authenticated upload adapter call those same exports. Upload job metadata is checkpointed in `chrome.storage.session`, while the open console remains the only owner of `File` objects. Pornhub is a first-class trace-gated preparation target and must stop before unverified file assignment or submission.

**Tech Stack:** Manifest V3, plain JavaScript IIFEs and browser DOM APIs, Chrome `storage`/`tabs`/`scripting` APIs, BroadcastChannel/DataTransfer file bridge, Node test runner, Playwright, Apps Script, ESLint, TypeScript checkJs, Prettier.

**Spec:** `docs/superpowers/specs/2026-08-30-master-uploader-shared-recipes-design.md`

## Global Constraints

- Personal extension version is exactly `0.13.0`; no runtime dependency is added.
- OnlyFans, Fansly, and ManyVids retain the one-Yes traced final-submit workflows.
- Pornhub may apply only the existing verified orientation/tag/category preset and must return `manual-submit-required`; no file control or final submit click is allowed.
- The effective Pornhub file is the optional Pornhub file, otherwise the full file; a teaser is never a fallback.
- Saved profiles come from normalized `creatorToolkitV2`, not direct reads of `DEFAULT_PROFILES` during a confirmed run.
- Each final site click is preceded by a durable `submitAttempted` checkpoint; it is never repeated after uncertainty.
- `chrome.storage.session` may contain the bounded confirmed textual draft and filenames, but never `File`, Blob, paths, bytes, credentials, cookies, headers, or request bodies.
- Existing `dist/` artifacts are user-owned and remain untracked until the release build intentionally replaces/adds versioned packages.
- No real post, Save, Schedule, or Submit is exercised by automated or authenticated readiness tests.

---

### Task 1: Normalize master profile snapshots and Pornhub series mappings

**Files:**

- Modify: `creator-tools/registry.js`
- Modify: `tests/creator-tools.test.cjs`

**Interfaces:**

- Produces: `profiles.phUploader.seriesPresets: Record<string, string>` with at most 100 bounded entries whose values name an existing preset.
- Consumes later: `GET_CREATOR_SETTINGS` returns the normalized profiles exactly as used in confirmation signatures.

- [ ] **Step 1: Write the failing registry tests**

Add assertions that valid exact mappings survive normalization, unknown preset values are removed with an error, keys are trimmed/bounded, and more than 100 entries are truncated:

```js
const normalized = registry.normalizeSettings({
  profiles: {
    phUploader: {
      presets: registry.DEFAULT_PROFILES.phUploader.presets,
      seriesPresets: {
        "GameSync Season Two": "Bisexual Male",
        Unknown: "Not A Preset",
      },
    },
  },
});
assert.equal(
  normalized.value.profiles.phUploader.seriesPresets["GameSync Season Two"],
  "Bisexual Male",
);
assert.equal(
  Object.hasOwn(normalized.value.profiles.phUploader.seriesPresets, "Unknown"),
  false,
);
assert.match(normalized.errors.join(" "), /unknown Pornhub preset/i);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/creator-tools.test.cjs`

Expected: FAIL because `seriesPresets` is not part of the normalized profile.

- [ ] **Step 3: Add the bounded mapping to defaults and normalization**

Add `seriesPresets: Object.freeze({})` beside `phUploader.presets`. In `mergeProfiles`, copy at most 100 nonempty keys of at most 200 characters only when the value exactly names a normalized preset. Push `Pornhub series mapping “${key}” names an unknown Pornhub preset.` for invalid values.

- [ ] **Step 4: Run focused tests and formatting**

Run:

```powershell
node --test tests/creator-tools.test.cjs
node .\node_modules\prettier\bin\prettier.cjs --check creator-tools/registry.js tests/creator-tools.test.cjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add creator-tools/registry.js tests/creator-tools.test.cjs
git commit -m "Add Pornhub series preset mappings"
```

### Task 2: Make Fansly metadata one shared recipe

**Files:**

- Modify: `creator-tools/fansly-prefill.js`
- Modify: `tests/creator-adapters.test.cjs`

**Interfaces:**

- Produces: `composeMasterCaption(description, message) -> string`.
- Produces: exported `inspectComposer(composer, profile, { desiredText, forceWrite, finalAction })` and `applyPlan(plan, profile, signal, budget)`.
- Consumes later: `upload-platform-adapters.js` calls these exports after media/access setup.

- [ ] **Step 1: Write failing recipe tests**

Extend the Fansly browser test with:

```js
assert.equal(
  await page.evaluate(() =>
    CreatorToolkitAdapters.fanslyPrefill.composeMasterCaption(
      "Episode description",
      "#one #two",
    ),
  ),
  "Episode description\n\n#one #two",
);
assert.equal(
  await page.evaluate(() =>
    CreatorToolkitAdapters.fanslyPrefill.composeMasterCaption(
      "Episode description\n\n#one #two",
      "#one #two",
    ),
  ),
  "Episode description\n\n#one #two",
);
assert.equal(
  await page.evaluate(
    () => typeof CreatorToolkitAdapters.fanslyPrefill.applyPlan,
  ),
  "function",
);
```

Also inspect with `{ desiredText: "Master caption", forceWrite: true, finalAction: "Master confirmation owns Post." }`, apply once, and assert the exact caption and toggle states.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test --test-name-pattern="Fansly" tests/creator-adapters.test.cjs`

Expected: FAIL because the composition function and `applyPlan` export do not exist.

- [ ] **Step 3: Implement the minimal shared exports**

Implement caption composition as trimmed strings and exact trailing-block de-duplication. Preserve current standalone defaults when no options are passed. Include `desiredText`, `forceWrite`, and `finalAction` in the plan signature/items so a master preview cannot reuse a standalone signature. Export `applyPlan` without changing the panel's manual Post boundary.

- [ ] **Step 4: Run focused tests**

Run: `node --test --test-name-pattern="Fansly" tests/creator-adapters.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add creator-tools/fansly-prefill.js tests/creator-adapters.test.cjs
git commit -m "Share Fansly metadata recipe"
```

### Task 3: Make ManyVids form metadata one shared recipe

**Files:**

- Modify: `creator-tools/manyvids-autofill.js`
- Modify: `creator-tools/upload-platform-adapters.js`
- Modify: `tests/creator-adapters.test.cjs`
- Modify: `tests/upload-milestone.test.cjs`

**Interfaces:**

- Produces: exported `applyPlan(plan, signal, budget)` and `failedResult(outcomes)`.
- Consumes: existing `inspectForm(form, profile)` with the normalized confirmed profile.
- Produces later: `runManyVidsEdit(context)` delegates price/mode/tag application to the shared recipe, then retains title/description/media/date/Premium/final Save orchestration that is outside the standalone helper.

- [ ] **Step 1: Write failing delegation tests**

Assert the shared export exists. In the upload adapter fixture, install a spy wrapper before `runManyVidsEdit`:

```js
const original = CreatorToolkitAdapters.manyvidsAutofill.applyPlan;
let calls = 0;
CreatorToolkitAdapters.manyvidsAutofill.applyPlan = async (...args) => {
  calls += 1;
  return original(...args);
};
```

Pass a `context.manyvidsRecipe` dependency in the adapter fixture and assert it
receives the same `draft.manyvids` object shown in the plan. The production
context supplies `CreatorToolkitAdapters.manyvidsAutofill`. The fixture must
still prove exactly one final Save click and ten exact tags.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
node --test --test-name-pattern="Pornhub and ManyVids|ManyVids edit adapter" tests/creator-adapters.test.cjs tests/upload-milestone.test.cjs
```

Expected: FAIL because `applyPlan` is not exported and the upload adapter owns a duplicate tag/mode implementation.

- [ ] **Step 3: Export and delegate the metadata subset**

Export `applyPlan` and `failedResult`. Extend `inspectForm/applyPlan` to own the
configured Premium mode as well as co-performer, price, launch mode/time,
membership, and tags. Load `registry.js`, `common.js`, and
`manyvids-autofill.js` before `upload-platform-adapters.js` in the ManyVids edit
injection. Pass a bounded action budget and confirmed profile. Remove the
duplicated profile-driven operations from `runManyVidsEdit`; retain only
media/title/description/date and final Save orchestration.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2. Expected: PASS with one recipe invocation and one Save.

- [ ] **Step 5: Commit**

```powershell
git add creator-tools/manyvids-autofill.js creator-tools/upload-platform-adapters.js tests/creator-adapters.test.cjs tests/upload-milestone.test.cjs
git commit -m "Share ManyVids form recipe"
```

### Task 4: Export the Pornhub preset recipe and deterministic preset resolver

**Files:**

- Modify: `creator-tools/ph-uploader.js`
- Modify: `tests/creator-adapters.test.cjs`

**Interfaces:**

- Produces: `resolvePreset(profile, seasonArc, explicitName) -> { name, preset, source } | null`.
- Produces: exported `applyPreset(plan, signal, budget)` and `failedResult(outcomes)`.
- Resolution order: exact explicit preset, exact normalized Season/Arc mapping, otherwise `null`; no content inference.

- [ ] **Step 1: Write failing resolution/export tests**

```js
const resolved = await page.evaluate(() =>
  CreatorToolkitAdapters.phUploader.resolvePreset(
    {
      presets: {
        Straight: { orientation: "Straight", tags: [], categories: [] },
      },
      seriesPresets: { "Resident Evil": "Straight" },
    },
    "Resident Evil",
    "",
  ),
);
assert.equal(resolved.name, "Straight");
assert.equal(resolved.source, "series");
assert.equal(
  await page.evaluate(() =>
    CreatorToolkitAdapters.phUploader.resolvePreset(
      { presets: { Straight: {} }, seriesPresets: {} },
      "Unknown",
      "",
    ),
  ),
  null,
);
```

Assert `applyPreset` is exported and continues to append only fresh exact values.

- [ ] **Step 2: Run and verify failure**

Run: `node --test --test-name-pattern="Pornhub" tests/creator-adapters.test.cjs`

Expected: FAIL because resolver/apply exports do not exist.

- [ ] **Step 3: Implement resolver and exports**

Use `toolkit.normalizeText` only for exact normalized Season/Arc key equality. Do not compare title, description, filename, or preset contents. Export the existing apply/failure functions; keep the standalone panel's Save/Submit manual text.

- [ ] **Step 4: Run focused tests**

Run Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add creator-tools/ph-uploader.js tests/creator-adapters.test.cjs
git commit -m "Share Pornhub preset recipe"
```

### Task 5: Extend the console plan with Pornhub media, preset, and saved profiles

**Files:**

- Modify: `upload-console.html`
- Modify: `upload-console.js`
- Modify: `upload-console.css`
- Modify: `tests/upload-milestone.test.cjs`
- Modify: `tests/upload-coordinator.test.cjs`

**Interfaces:**

- Produces in `normalizeDraft`: `media.pornhub = { file, source }` and `contentPreset`.
- Produces in prepared request: `profiles: { fanslyPrefill, manyvidsAutofill, phUploader }` and `profileSignature`.
- Consumes: `GET_CREATOR_SETTINGS` normalized profiles and catalogue candidate `seasonArc`.

- [ ] **Step 1: Add failing draft and UI tests**

Test optional Pornhub file preference and full fallback:

```js
assert.deepEqual(
  normalizeDraft({
    fullFile,
    pornhubFile: limitedFile,
    title: "Episode",
    scheduledIso: "2026-09-04T15:00:00.000Z",
    targets: ["pornhub"],
    contentPreset: "Straight",
  }).media.pornhub,
  { file: limitedFile.name, source: "pornhub" },
);
```

Add browser assertions for a Pornhub checkbox, optional file input, content preset select, exact final Fansly caption, saved ManyVids price/tags, and a confirmation summary that says Pornhub file assignment/final submit remain manual. Unknown preset must disable Yes.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
node --test tests/upload-coordinator.test.cjs
node --test --test-name-pattern="upload console|catalogue proposal" tests/upload-milestone.test.cjs
```

Expected: FAIL because Pornhub is not an executable plan target and profiles are not loaded.

- [ ] **Step 3: Implement the console plan**

Add native file/select controls. Load `registry.js`, `common.js`,
`fansly-prefill.js`, and `ph-uploader.js` before `upload-console.js`, then load
normalized settings with `GET_CREATOR_SETTINGS`. Build an immutable plain
profile snapshot and stable JSON signature. Compose the Fansly caption with
the shared recipe helper. Preselect Pornhub only from an explicit value or
exact confirmed Season/Arc mapping. Include profiles/preset/file source in
`proposalSignature`, summary, validation, and prepared request.

Pornhub is a selected preparation target, but label it `Trace-gated · metadata only · file and final Submit manual` in both target card and confirmation.

- [ ] **Step 4: Run focused tests and formatting**

Run Step 2 commands and:

```powershell
node .\node_modules\prettier\bin\prettier.cjs --check upload-console.html upload-console.js upload-console.css tests/upload-coordinator.test.cjs tests/upload-milestone.test.cjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add upload-console.html upload-console.js upload-console.css tests/upload-coordinator.test.cjs tests/upload-milestone.test.cjs
git commit -m "Add Pornhub to Master Uploader plans"
```

### Task 6: Add strict Pornhub catalogue contract support

**Files:**

- Modify: `creator-tools/catalogue-contract.js`
- Modify: `apps-script/catalogue-bridge.gs`
- Modify: `tests/upload-milestone.test.cjs`
- Modify: `tests/catalogue-proposal.test.cjs`

**Interfaces:**

- Produces: `canonicalPostUrl("pornhub", value)` accepting only
  `https://www.pornhub.com/view_video.php?viewkey={viewkey}` with a bounded
  `viewkey` token and stripping other query/hash data.
- Produces: Apps Script `pornhub -> pornhubLink -> column 8` commit support.

- [ ] **Step 1: Write failing canonicalization and commit tests**

```js
assert.equal(
  contract.canonicalPostUrl(
    "pornhub",
    "https://www.pornhub.com/view_video.php?viewkey=phabc123&utm_source=x#y",
  ),
  "https://www.pornhub.com/view_video.php?viewkey=phabc123",
);
assert.equal(
  contract.canonicalPostUrl("pornhub", "https://evil.example/?viewkey=x"),
  null,
);
```

Add bridge tests that a blank H cell updates, an identical link is idempotent, and a different H link conflicts.

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
node --test --test-name-pattern="Pornhub|catalogue bridge commit" tests/upload-milestone.test.cjs tests/catalogue-proposal.test.cjs
```

Expected: FAIL because Pornhub is absent from platform fields/commit columns.

- [ ] **Step 3: Implement the strict contract**

Add Pornhub to both allowlists and use `URL`, exact HTTPS origin, exact `/view_video.php`, one `viewkey`, and `/^[A-Za-z0-9_-]{1,100}$/`. Rebuild the canonical URL from the accepted token. Add Apps Script column `8`; preserve the existing lock/fingerprint/conflict logic.

- [ ] **Step 4: Run focused tests**

Run Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add creator-tools/catalogue-contract.js apps-script/catalogue-bridge.gs tests/upload-milestone.test.cjs tests/catalogue-proposal.test.cjs
git commit -m "Support safe Pornhub catalogue links"
```

### Task 7: Persist monotonic upload jobs in session storage

**Files:**

- Create: `creator-tools/upload-session-store.js`
- Create: `tests/upload-session-store.test.cjs`
- Modify: `background.js`
- Modify: `scripts/build-personal-package.ps1`
- Modify: `tests/background.test.cjs`
- Modify: `tests/extension-load.test.cjs`
- Modify: `package.json`

**Interfaces:**

- Produces global `CreatorUploadSessionStore` with `sanitize(record)`, `save(record)`, `load(id)`, `remove(id)`, `list()`.
- Serialized platform shape includes `platform`, `tabId`, `stage`, `status`, timestamps, `manyvidsId`, `commitArmed`, `submitAttempted`, and `postUrl`.
- Monotonic rule: persisted `submitAttempted: true` and nonempty IDs/URLs cannot be cleared by a later write.

- [ ] **Step 1: Write the failing store tests**

Mock `chrome.storage.session` and assert round-trip, bounds, forbidden key removal, and monotonic merge:

```js
await store.save({
  id,
  draft: { title: "Episode", description: "Caption", fullFilename: "x.mp4" },
  platforms: { onlyfans: { submitAttempted: true, status: "submitted" } },
  cookie: "forbidden",
});
await store.save({
  id,
  platforms: { onlyfans: { submitAttempted: false, status: "prepared" } },
});
const restored = await store.load(id);
assert.equal(restored.platforms.onlyfans.submitAttempted, true);
assert.equal(Object.hasOwn(restored, "cookie"), false);
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/upload-session-store.test.cjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal storage module**

Use one key prefix and `chrome.storage.session`; no IndexedDB, alarms, keepalive, or dependency. Accept only explicit allowlisted fields and bounded plain values. Convert Maps to plain objects at the background boundary. Import the module before upload coordinator code and add it to the personal package allowlist and personal test script.

- [ ] **Step 4: Rehydrate on demand in background**

Replace direct `creatorUploadSessions.get(id)` at message/retry entry points with `getCreatorUploadSession(id)`, which reads memory first then the store. Checkpoint after prepare, every stage transition, ManyVids ID capture, pre-submit handshake, post URL capture, and terminal result. Remove only after terminal state and successful/irrecoverable reconciliation; retain recoverable failures for the browser session.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node --test tests/upload-session-store.test.cjs tests/background.test.cjs tests/extension-load.test.cjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add creator-tools/upload-session-store.js tests/upload-session-store.test.cjs background.js scripts/build-personal-package.ps1 tests/background.test.cjs tests/extension-load.test.cjs package.json
git commit -m "Persist resumable upload sessions"
```

### Task 8: Integrate traced adapters, checkpoints, and Pornhub preparation

**Files:**

- Modify: `background.js`
- Modify: `creator-tools/upload-platform-adapters.js`
- Modify: `creator-tools/upload-capability-probe.js`
- Modify: `upload-console.js`
- Modify: `tests/background.test.cjs`
- Modify: `tests/upload-milestone.test.cjs`
- Modify: `tests/upload-coordinator.test.cjs`

**Interfaces:**

- Produces background message `CHECKPOINT_CREATOR_UPLOAD_COMMIT` returning `{ armed: true }` only after session storage confirms `submitAttempted`.
- Produces Pornhub platform result `{ platform: "pornhub", status: "manual-submit-required", effectiveFilename, preset }`.
- Consumes shared Fansly/ManyVids/Pornhub recipe exports and confirmed profile snapshots.

- [ ] **Step 1: Write failing checkpoint/restart/partial-failure tests**

Add tests for:

```js
// Final click cannot occur before durable checkpoint acknowledgement.
assert.equal(
  events.indexOf("checkpoint:onlyfans") < events.indexOf("click:save"),
  true,
);

// A restored uncertain job cannot click again.
restored.platforms.onlyfans.submitAttempted = true;
await assert.rejects(
  () => retryPlatform(restored, "onlyfans"),
  /manual link recovery/i,
);
assert.equal(saveClicks, 0);

// Pornhub preparation applies preset metadata but no file or submit control.
assert.deepEqual(phResult.status, "manual-submit-required");
assert.equal(fileAssignments, 0);
assert.equal(submitClicks, 0);
```

Also assert a Fansly failure does not prevent OnlyFans/ManyVids/Pornhub sibling results.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
node --test tests/background.test.cjs tests/upload-coordinator.test.cjs
node --test --test-name-pattern="adapter|restart|Pornhub|partial" tests/upload-milestone.test.cjs
```

Expected: FAIL because checkpoints, restored retry guards, and Pornhub target execution are absent.

- [ ] **Step 3: Add Pornhub target preparation**

Add the existing optional origin and uploader landing route to `CREATOR_UPLOAD_TARGETS`. Inject `registry.js`, `common.js`, and `ph-uploader.js`. Probe only semantic metadata readiness. Apply the exact confirmed preset when the form is present and return `manual-submit-required`; never install a Pornhub file role and never query or click a final control.

- [ ] **Step 4: Make final clicks handshake with durable state**

Add `context.beforeCommit()` in page adapters. Immediately before OnlyFans Save, Fansly Schedule/Post confirmation, and ManyVids Save, await the background checkpoint. The checkpoint validates tab/platform/session, writes `commitArmed` and `submitAttempted`, reads it back, then acknowledges. No acknowledgement means no click.

- [ ] **Step 5: Reconcile restored sessions conservatively**

On console bind/retry, load the serialized job. If `postUrl` exists, run only catalogue commit. If `submitAttempted` is true without URL, return `posted-link-unresolved`. If ManyVids ID exists, reopen only `/Edit-vid/{id}`. Otherwise resume only an exact pre-submit stage with a matching console plan signature and available file role.

- [ ] **Step 6: Delegate metadata to shared recipes**

Fansly composes the exact confirmed caption and uses `inspectComposer/applyPlan`; ManyVids uses `inspectForm/applyPlan`; Pornhub uses `inspectPreset/applyPreset`. Treat any `failed`/`partial` recipe result as a stopped platform before final commit. Keep the single global Yes as authorization; do not display helper-panel confirmations inside master runs.

- [ ] **Step 7: Run focused tests**

Run Step 2 commands. Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add background.js creator-tools/upload-platform-adapters.js creator-tools/upload-capability-probe.js upload-console.js tests/background.test.cjs tests/upload-milestone.test.cjs tests/upload-coordinator.test.cjs
git commit -m "Integrate resumable Master Uploader recipes"
```

### Task 9: Release documentation, version, full verification, and local merge

**Files:**

- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/AUTHENTICATED_SMOKE_TEST.md`
- Modify: `docs/CREATOR_TOOLS_ARCHITECTURE.md`
- Modify: package/test expectations that assert the version or personal file list

**Interfaces:**

- Produces: unpacked personal extension and ZIP identified as `0.13.0`.

- [ ] **Step 1: Update documentation and version assertions**

Set both manifest and package versions to `0.13.0`. Document saved-profile sharing, effective Pornhub media, manual Pornhub boundary, session recovery, and the fact that authenticated smoke tests must not submit.

- [ ] **Step 2: Run formatting without touching unrelated files**

Run:

```powershell
node .\node_modules\prettier\bin\prettier.cjs --write creator-tools/registry.js creator-tools/fansly-prefill.js creator-tools/manyvids-autofill.js creator-tools/ph-uploader.js creator-tools/upload-platform-adapters.js creator-tools/upload-session-store.js creator-tools/catalogue-contract.js upload-console.js tests/creator-tools.test.cjs tests/creator-adapters.test.cjs tests/upload-session-store.test.cjs tests/upload-coordinator.test.cjs tests/upload-milestone.test.cjs tests/background.test.cjs tests/catalogue-proposal.test.cjs README.md docs/AUTHENTICATED_SMOKE_TEST.md docs/CREATOR_TOOLS_ARCHITECTURE.md manifest.json package.json
```

- [ ] **Step 3: Run the complete release gate**

Run: `npm run check`

Expected: lint, typecheck, format check, all personal/store tests, unpacked extension verification, and both package builds pass. No real site submission occurs.

- [ ] **Step 4: Inspect release artifacts and source boundaries**

Run:

```powershell
git status --short
git diff --check
rg -n "click.*(Delete|Remove)|submitAttempted\s*=\s*false|DEFAULT_PROFILES\.manyvidsAutofill" creator-tools background.js upload-console.js
Get-ChildItem dist\creator-workflow-toolkit-personal-v0.13.0.zip,dist\fan-identity-mask-store-v0.7.0.zip | Select-Object Name,Length,LastWriteTime
```

Expected: no Delete automation, no reset of `submitAttempted`, no master runtime read of ManyVids defaults, both expected ZIPs exist, and only intentional source plus existing `dist/` artifacts are untracked/modified.

- [ ] **Step 5: Commit the release**

```powershell
git add manifest.json package.json README.md docs/AUTHENTICATED_SMOKE_TEST.md docs/CREATOR_TOOLS_ARCHITECTURE.md tests/creator-tools.test.cjs
git commit -m "Release Master Uploader v0.13.0"
```

- [ ] **Step 6: Review and merge locally**

Run a correctness review against the spec, fix and re-run `npm run check`, then merge the feature branch into local `main` with a non-interactive merge. Do not push. Confirm:

```powershell
git status --short
git log --oneline -8
```

Expected: `main` contains the design, implementation, tests, and release commits; only intentional `dist/` artifacts remain untracked.
