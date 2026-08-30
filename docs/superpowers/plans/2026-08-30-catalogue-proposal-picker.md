# Catalogue Proposal Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single server-selected catalogue match with a deterministic local proposal and searchable picker that infers pending platform targets without uploading or writing before Yes.

**Architecture:** Apps Script returns one bounded A:L snapshot; a new pure browser module ranks rows, identifies series predecessors, infers missing targets, and consumes a strict queue-evidence contract. The upload console renders either one strong proposal or the picker fallback while retaining the existing authenticated upload and empty-only link commit paths.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript, HTML/CSS, Google Apps Script, Node test runner, Playwright, ESLint, TypeScript check mode, Prettier.

**Spec:** `docs/superpowers/specs/2026-08-30-catalogue-episode-picker-design.md`

## Global Constraints

- Do not add an LLM, embeddings, file fingerprinting, behavioral telemetry, or a new dependency.
- Keep Friday publication fixed at 15:00 UTC.
- Use native HTML controls; the numeric sheet row is the option value.
- Read at most rows 2 through 5000 and columns A:L from `2026 Video Catalogue`.
- Preserve nonempty catalogue metadata and platform links; all commits remain fingerprinted and empty-only.
- No platform tab, file transfer, site mutation, or sheet write occurs before the final Yes.
- Pornhub H participates in recommendation state but is not executable in this plan.
- Missing live queue evidence must be shown as unverified; it must not be represented as an empty queue.
- Preserve the explicit upload-only fallback and all current OnlyFans, Fansly, and ManyVids upload behavior.
- Increment both package and extension versions from `0.11.0` to `0.12.0`.
- Run `npm run check`, then merge the completed branch into local `main`; do not push unless the user asks.

## Scope Boundary

This plan produces the first independently testable subsystem: catalogue snapshot, deterministic proposal, picker fallback, inferred executable targets, sequence calculation from supplied queue evidence, and a fail-closed queue-evidence gate. A second plan will add authenticated queue readers plus ledger reconciliation after trace fixtures exist. A third plan will add Pornhub file transfer, scheduling, submission, queue reconciliation, and H-column link capture after its full trace exists.

---

### Task 1: Bounded Catalogue Snapshot Contract

**Files:**

- Modify: `apps-script/catalogue-bridge.gs`
- Modify: `creator-tools/catalogue-client.js`
- Modify: `creator-tools/catalogue-contract.js`
- Test: `tests/upload-milestone.test.cjs`

**Interfaces:**

- Produces: `CreatorCatalogueClient.getCatalogueSnapshot(options)` returning `{status: "snapshot", rows: CatalogueRow[], emptyRow: CatalogueRow}`.
- Produces: `CatalogueRow` fields `row`, `id`, `releaseDate`, `title`, `description`, `seasonArc`, `episode`, `pornhubLink`, `onlyfansLink`, `fanslyLink`, `manyvidsLink`, and `fingerprint`.
- Produces: `CreatorCatalogueContract.similarity(left, right)` and `CreatorCatalogueContract.tokens(value)` for Task 2.
- Preserves: `matchCatalogue` and `commitPlatformLink` during migration.

- [ ] **Step 1: Write failing snapshot and client-boundary tests**

Add tests that require all sequencing and link columns, a truly empty A:L row, bounded row 5000 behavior, and a body-free snapshot request:

```js
test("catalogue snapshot exposes A:L proposal fields and the first fully empty row", () => {
  const context = loadScripts("apps-script/catalogue-bridge.gs");
  const bridge = context.CreatorCatalogueBridgeTest;
  const rows = [
    {
      row: 2,
      id: "battlefield-ep02",
      releaseDate: "2026-02-20",
      title: "playin Battlefield 6 while Cumming",
      description: "Battlefield episode",
      seasonArc: "Battlefield",
      episode: "2",
      pornhubLink: "",
      onlyfansLink: "https://onlyfans.com/1/johnny_guides",
      fanslyLink: "https://fansly.com/post/2",
      manyvidsLink: "https://www.manyvids.com/Video/3",
      empty: false,
    },
    {
      row: 3,
      id: "",
      releaseDate: "",
      title: "",
      description: "",
      seasonArc: "",
      episode: "",
      pornhubLink: "",
      onlyfansLink: "",
      fanslyLink: "",
      manyvidsLink: "",
      empty: true,
    },
  ];

  const snapshot = plain(bridge.snapshot(rows));
  assert.equal(snapshot.status, "snapshot");
  assert.equal(snapshot.rows[0].seasonArc, "Battlefield");
  assert.equal(snapshot.rows[0].episode, "2");
  assert.equal(snapshot.rows[0].pornhubLink, "");
  assert.equal(snapshot.emptyRow.row, 3);
  assert.match(snapshot.rows[0].fingerprint, /^[a-f0-9]{8}$/);
});

test("catalogue client sends an empty bounded snapshot payload", async () => {
  const context = loadScripts("creator-tools/catalogue-client.js");
  const requests = [];
  const result = await context.CreatorCatalogueClient.request(
    {
      endpoint:
        "https://script.google.com/macros/s/fixture-bridge-12345678901234567890/exec",
      secret: "fixture-bridge-secret-1234567890",
    },
    "getCatalogueSnapshot",
    {},
    {
      fetchImpl: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return new Response(
          JSON.stringify({
            ok: true,
            result: { status: "snapshot", rows: [], emptyRow: { row: 2 } },
          }),
        );
      },
    },
  );

  assert.equal(result.status, "snapshot");
  assert.equal(requests[0].body.action, "getCatalogueSnapshot");
  assert.deepEqual(requests[0].body.payload, {});
});
```

- [ ] **Step 2: Run the focused tests and confirm the missing interface**

Run:

```powershell
node --test --test-name-pattern="catalogue snapshot|empty bounded snapshot" tests/upload-milestone.test.cjs
```

Expected: FAIL because `bridge.snapshot` and `getCatalogueSnapshot` are absent.

- [ ] **Step 3: Implement the minimal snapshot path**

In `apps-script/catalogue-bridge.gs`, map E, G, H, J, K, and L, preserve an internal full-row emptiness flag, and return fingerprints only for populated response rows:

```js
function creatorUploadSnapshot(rows) {
  var empty = rows.find(creatorUploadEmptyRow);
  if (!empty) throw new Error("No empty catalogue row is available.");
  return {
    status: "snapshot",
    rows: rows
      .filter(function (row) {
        return !creatorUploadEmptyRow(row);
      })
      .map(function (row) {
        return Object.assign({}, row, {
          fingerprint: creatorUploadFingerprint(row),
        });
      }),
    emptyRow: Object.assign({}, empty, {
      fingerprint: creatorUploadFingerprint(empty),
    }),
  };
}
```

Make `creatorUploadReadRows` assign `seasonArc: cells[4]`, `episode: cells[6]`, `pornhubLink: cells[7]`, and `empty: !cells.some(creatorUploadClean)`. Make the first line of `creatorUploadEmptyRow` return `row.empty` when it is boolean, while retaining the existing modeled-field fallback for unit fixtures. Add `seasonArc`, `episode`, and `pornhubLink` to `creatorUploadFingerprint`. Route `getCatalogueSnapshot` before the mutating action and export `snapshot` from `CreatorCatalogueBridgeTest`.

In `creator-tools/catalogue-client.js`, add the action and method:

```js
const ACTIONS = new Set([
  "getCatalogueSnapshot",
  "matchCatalogue",
  "commitPlatformLink",
]);

async function getCatalogueSnapshot(options) {
  return request(await loadConfig(), "getCatalogueSnapshot", {}, options);
}
```

Make `boundedPayload("getCatalogueSnapshot")` return `{}`. Export `getCatalogueSnapshot`. While touching the existing validators, accept all three currently executable platforms (`onlyfans`, `fansly`, `manyvids`) and keep Pornhub excluded from commits.

In `creator-tools/catalogue-contract.js`, include the new protected fields in `fingerprint` and export the existing `similarity` and `tokens` functions.

- [ ] **Step 4: Run snapshot, commit, and client tests**

Run:

```powershell
node --test --test-name-pattern="catalogue snapshot|catalogue bridge commit|catalogue client" tests/upload-milestone.test.cjs
```

Expected: PASS, including stale fingerprint and ManyVids commit coverage.

- [ ] **Step 5: Commit Task 1**

```powershell
git add apps-script/catalogue-bridge.gs creator-tools/catalogue-client.js creator-tools/catalogue-contract.js tests/upload-milestone.test.cjs
git commit -m "Add bounded catalogue snapshot contract"
```

---

### Task 2: Pure Deterministic Proposal Engine

**Files:**

- Create: `creator-tools/catalogue-proposal.js`
- Test: `tests/catalogue-proposal.test.cjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: `CreatorCatalogueContract.normalizedText`, `similarity`, and `tokens` from Task 1.
- Produces: `CreatorCatalogueProposal.rankRows(draft, rows)`.
- Produces: `CreatorCatalogueProposal.inferTargets(row, executablePlatforms)`.
- Produces: `CreatorCatalogueProposal.findPredecessor(row, rows)`.
- Produces: `CreatorCatalogueProposal.proposeSchedule(input)`.
- Produces: `CreatorCatalogueProposal.buildNewCandidate(draft, snapshot)` for
  the explicit `+ Add new catalogue entry` choice.
- Produces: `CreatorCatalogueProposal.build(input)` returning status `ready`, `needs-selection`, `needs-queue-evidence`, `not-executable`, or `nothing-pending`.

- [ ] **Step 1: Create failing deterministic engine tests**

Create `tests/catalogue-proposal.test.cjs` using `vm` like the existing milestone tests. Cover the approved user scenario:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = path.resolve(__dirname, "..");

function loadProposal() {
  const context = vm.createContext({ Date, Intl, URL });
  for (const relativePath of [
    "creator-tools/catalogue-contract.js",
    "creator-tools/catalogue-proposal.js",
  ]) {
    vm.runInContext(
      fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
      context,
      { filename: relativePath },
    );
  }
  return context.CreatorCatalogueProposal;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function row(overrides = {}) {
  return {
    row: 110,
    id: "battlefield-ep02",
    releaseDate: "2026-02-20",
    title: "BATTLEFIELD 6 episode 2",
    description: "Battlefield episode",
    seasonArc: "Battlefield",
    episode: "2",
    pornhubLink: "",
    onlyfansLink: "https://onlyfans.com/1/johnny_guides",
    fanslyLink: "https://fansly.com/post/2",
    manyvidsLink: "https://www.manyvids.com/Video/3",
    fingerprint: "1234abcd",
    ...overrides,
  };
}

function emptyRow(rowNumber) {
  return {
    row: rowNumber,
    id: "",
    releaseDate: "",
    title: "",
    description: "",
    seasonArc: "",
    episode: "",
    pornhubLink: "",
    onlyfansLink: "",
    fanslyLink: "",
    manyvidsLink: "",
    fingerprint: "1234abcd",
  };
}

test("strong wording infers missing Pornhub and schedules after its predecessor", () => {
  const proposal = loadProposal();
  const rows = [
    row({ row: 110, id: "battlefield-ep02", episode: "2" }),
    row({
      row: 121,
      id: "battlefield-ep03",
      title: "BATTLEFIELD 6 + Angry Sex",
      episode: "3",
    }),
  ];
  const result = plain(
    proposal.build({
      draft: {
        filename: "BATTLEFIELD 6 Angry Sex (full).mp4",
        title: "BATTLEFIELD 6 Angry Sex",
        description: "",
      },
      snapshot: { status: "snapshot", rows, emptyRow: emptyRow(136) },
      now: new Date("2026-08-30T10:00:00Z"),
      executablePlatforms: ["onlyfans", "fansly", "manyvids"],
      queueByPlatform: {
        pornhub: {
          verified: true,
          scheduled: [{ catalogueRow: 110, releaseDate: "2026-09-04" }],
          occupiedFridays: ["2026-09-04"],
        },
      },
    }),
  );

  assert.equal(result.candidate.row, 121);
  assert.deepEqual(result.targets.recommended, ["pornhub"]);
  assert.deepEqual(result.targets.executable, []);
  assert.equal(result.schedules.pornhub.releaseDate, "2026-09-11");
  assert.equal(result.status, "not-executable");
});

test("ambiguous wording opens selection instead of choosing", () => {
  const proposal = loadProposal();
  const rows = [
    row({
      row: 20,
      id: "lara-arc-ep01",
      title: "Nervous Johnny prepares for his date",
    }),
    row({
      row: 29,
      id: "lara-arc-ep02",
      title: "Nervous Johnny prepares for his date",
    }),
  ];
  const result = plain(
    proposal.build({
      draft: {
        filename: "Nervous Johnny prepares for his date.mp4",
        title: "",
        description: "",
      },
      snapshot: { status: "snapshot", rows, emptyRow: emptyRow(136) },
      now: new Date("2026-08-30T10:00:00Z"),
      executablePlatforms: ["onlyfans", "fansly", "manyvids"],
      queueByPlatform: {},
    }),
  );

  assert.equal(result.status, "needs-selection");
  assert.deepEqual(
    result.alternatives.map((item) => item.row),
    [29, 20],
  );
});

test("Add New uses the snapshot empty row and a collision-safe ID", () => {
  const proposal = loadProposal();
  const rows = [row({ row: 20, id: "episode-42", title: "Older video" })];
  const result = plain(
    proposal.buildNewCandidate(
      {
        title: "Episode 42",
        description: "New description",
        releaseDate: "2026-09-04",
      },
      {
        status: "snapshot",
        rows,
        emptyRow: emptyRow(136),
      },
    ),
  );

  assert.equal(result.row, 136);
  assert.equal(result.id, "episode-42-2");
  assert.equal(result.releaseDate, "2026-09-04");
  assert.equal(result.fingerprint, "1234abcd");
});
```

- [ ] **Step 2: Run the new tests and confirm the module is absent**

Run:

```powershell
node --test tests/catalogue-proposal.test.cjs
```

Expected: FAIL because `creator-tools/catalogue-proposal.js` does not exist.

- [ ] **Step 3: Implement ranking, targets, predecessor, and Friday calculation**

Create an IIFE module exporting this frozen interface:

```js
globalThis.CreatorCatalogueProposal = Object.freeze({
  build,
  buildNewCandidate,
  findPredecessor,
  inferTargets,
  proposeSchedule,
  rankRows,
});
```

Use Dice similarity already supplied by the contract. For every row calculate the maximum similarity across draft filename/title against row title/ID; calculate description similarity separately; add five points for an exact numeric episode hint and five for an exact normalized Season/Arc phrase; cap the composite at 100. A single automatic candidate requires composite `>= 75`, best text similarity `>= 0.75`, and a lead `>= 0.15` over the runner-up.

Use this exact link map and keep execution capability separate from recommendation:

```js
const LINK_FIELDS = Object.freeze({
  pornhub: "pornhubLink",
  onlyfans: "onlyfansLink",
  fansly: "fanslyLink",
  manyvids: "manyvidsLink",
});
```

`findPredecessor` must require equal normalized nonempty `seasonArc`, a positive integer current episode, and the greatest lower positive episode. `proposeSchedule` must start at the next Friday 15:00 UTC, apply a future catalogue date as a floor, apply predecessor scheduled date plus seven days, then advance seven days through verified `occupiedFridays`. Return `{verified, releaseDate, scheduledIso, evidence}`; never convert absent evidence into `verified: true`.

`build` accepts optional `selectedRow` as a numeric row or `"new"`. A numeric
selection bypasses the automatic threshold but not target, queue, or duplicate
guards. `"new"` uses `buildNewCandidate`. With no selection, only the strong
unique threshold may choose a candidate. It must return:

```js
{
  status,
  candidate,
  alternatives,
  reasons,
  predecessor,
  targets: { executable, recommended, alreadyLinked },
  schedules,
}
```

`buildNewCandidate` must use `snapshot.emptyRow`, derive its ID through the
existing `slugify` rules plus the first unused numeric suffix, copy the draft
release date/title/description, preserve the empty-row fingerprint, and leave
all platform links empty. The picker passes this candidate through the same
target and schedule validation as an existing row.

Add `tests/catalogue-proposal.test.cjs` to `test:personal` immediately after `tests/upload-milestone.test.cjs`.

- [ ] **Step 4: Run deterministic edge cases**

Add and run tests for exact ID, `(full)`/`(limited)` noise, duplicate titles, nonnumeric Episode, fully linked rows, unverified queue evidence, a future catalogue-date floor, occupied Friday walking, and stable row-number tie-breaking:

```powershell
node --test tests/catalogue-proposal.test.cjs
```

Expected: PASS with no network, browser, or Sheet dependency.

- [ ] **Step 5: Commit Task 2**

```powershell
git add creator-tools/catalogue-proposal.js tests/catalogue-proposal.test.cjs package.json
git commit -m "Add deterministic catalogue proposal engine"
```

---

### Task 3: One-Proposal UI and Searchable Picker Fallback

**Files:**

- Modify: `upload-console.html`
- Modify: `upload-console.css`
- Modify: `upload-console.js`
- Test: `tests/upload-milestone.test.cjs`
- Test: `tests/extension-load.test.cjs`

**Interfaces:**

- Consumes: `CreatorCatalogueClient.getCatalogueSnapshot` from Task 1.
- Consumes: `CreatorCatalogueProposal.build` and `rankRows` from Task 2.
- Consumes: optional `CreatorUploadQueueEvidence.snapshot()` returning the
  `queueByPlatform` object defined by Task 2 tests; absence means unverified.
- Produces: picker option values `row:<number>` and `new`.
- Preserves: `PREPARE_CREATOR_UPLOAD` and `START_CREATOR_UPLOAD` only after `#confirmUpload`.

- [ ] **Step 1: Write failing Playwright tests for proposal, No, and picker selection**

Add a fixture client with two catalogue rows and an empty row. Assert that a strong unique result preselects only empty executable targets, a linked platform is unchecked, Pornhub is labelled recommended but unavailable, and No opens the picker without sending runtime messages:

```js
assert.match(
  await page.locator("#matchQuestion").textContent(),
  /Likely episode/i,
);
assert.equal(await page.locator("#targetOnlyfans").isChecked(), false);
assert.equal(await page.locator("#targetManyvids").isChecked(), true);
assert.match(
  await page.locator("#pornhubRecommendation").textContent(),
  /recommended.*not yet executable/i,
);
assert.deepEqual(await page.evaluate(() => globalThis.consoleMessages), []);

await page.locator("#rejectMatch").click();
await page.locator("#cataloguePicker").waitFor();
await page.locator("#catalogueSearch").fill("battlefield");
await page.locator("#catalogueRow").selectOption("row:121");
assert.match(
  await page.locator("#selectedCatalogueReason").textContent(),
  /Episode 3/i,
);
assert.deepEqual(await page.evaluate(() => globalThis.consoleMessages), []);
```

The strong-proposal fixture must install a deterministic queue seam before
loading `upload-console.js`:

```js
globalThis.CreatorUploadQueueEvidence = {
  snapshot() {
    return {
      manyvids: {
        verified: true,
        scheduled: [],
        occupiedFridays: [],
      },
    };
  },
};
```

Add another fixture in which the top two rows are ambiguous; assert the picker opens directly and `#confirmUpload` remains disabled until an explicit option is selected.

Add a stale-preflight fixture that changes the selected row fingerprint on the
second snapshot call. Click Yes and assert that neither upload message is sent
and the UI requests a catalogue refresh.

- [ ] **Step 2: Run focused UI tests and confirm missing controls**

Run:

```powershell
node --test --test-name-pattern="proposal picker|strong catalogue proposal|ambiguous catalogue proposal" tests/upload-milestone.test.cjs tests/extension-load.test.cjs
```

Expected: FAIL because the snapshot workflow and picker controls are absent.

- [ ] **Step 3: Add native picker markup and minimal styling**

Load scripts in dependency order:

```html
<script src="creator-tools/catalogue-contract.js"></script>
<script src="creator-tools/catalogue-proposal.js"></script>
<script src="creator-tools/catalogue-client.js"></script>
<script src="upload-console.js"></script>
```

Add a hidden `#cataloguePicker` section containing `#catalogueSearch` (`type="search"`), `#catalogueRow` (`select`), `#showAllCatalogue` (`checkbox`), `#refreshCatalogue` (`button`), and `#selectedCatalogueReason` (`role="status"`). Add `#pornhubRecommendation` beside the target controls. Reuse existing card, hint, status, focus, and button styles; add only grid spacing and visually distinct unavailable-target copy.

- [ ] **Step 4: Replace server match calls with one cached snapshot and local reranking**

In `upload-console.js`, replace the debounced `matchCatalogue` request with:

```js
async function loadCatalogueSnapshot({ refresh = false } = {}) {
  if (refresh) snapshotPromise = null;
  snapshotPromise ||= globalThis.CreatorCatalogueClient.getCatalogueSnapshot();
  return snapshotPromise;
}
```

Build a catalogue draft from filename, current title, description, and release date before target validation. Call `CreatorCatalogueProposal.build` locally after the snapshot resolves and on later edits. Keep the snapshot cached until `#refreshCatalogue` is clicked.

Read queue evidence through one fail-closed seam:

```js
function currentQueueEvidence() {
  return globalThis.CreatorUploadQueueEvidence?.snapshot?.() || {};
}
```

When a proposal has executable pending targets, set the three existing target checkboxes to exactly those targets before running `normalizeDraft`. Never check Pornhub. Fill title and description only when the selected row provides nonempty values; preserve a draft value where the corresponding sheet value is empty.

Render strong unique matches into the existing confirmation card. Render `needs-selection` directly into the picker. No hides confirmation, shows the picker, and focuses search. Search filters normalized title, ID, Season/Arc, and Episode locally. `Show all` includes fully linked rows with link-state labels. Always include `+ Add new catalogue entry`.

Selecting `new` must call `buildNewCandidate`, show the exact empty row and A:D
write in the final summary, and retain the current rule that A:D is written only
with the first successful platform-link commit.

Keep proposal state separate from the existing catalogue payload status:

```js
const catalogueStatus = selectedRow === "new" ? "new" : "matched";
```

Only `matched`, `new`, or the existing explicit `upload-only` value may reach
`PREPARE_CREATOR_UPLOAD`; proposal statuses such as `ready` never cross the
background trust boundary.

For `needs-queue-evidence`, show the inferred row and targets but identify the exact unverified platforms and keep smart-confirmation disabled. Preserve the existing explicit upload-only path so current uploads do not regress while authenticated queue readers remain a separate plan.

At the start of `startUpload`, fetch a fresh snapshot instead of reusing
`snapshotPromise`, compare the chosen row or empty-row fingerprint, call
`currentQueueEvidence()` again, and rebuild the proposal. Continue only when
the candidate, inferred targets, and verified schedules still match the visible
confirmation. This preflight is read-only and occurs before permissions, tab
creation, file transfer, or either runtime upload message.

- [ ] **Step 5: Run UI safety and accessibility tests**

Run:

```powershell
node --test --test-name-pattern="proposal|picker|single Yes|without sheet" tests/upload-milestone.test.cjs tests/extension-load.test.cjs
```

Expected: PASS; no mutation message exists before Yes, duplicate titles have distinct numeric-row values, and keyboard selection works through native controls.

- [ ] **Step 6: Commit Task 3**

```powershell
git add upload-console.html upload-console.css upload-console.js tests/upload-milestone.test.cjs tests/extension-load.test.cjs
git commit -m "Add catalogue proposal and picker UI"
```

---

### Task 4: Historical Catalogue Dates and Safe Upload Payloads

**Files:**

- Modify: `background.js`
- Modify: `upload-console.js`
- Test: `tests/background.test.cjs`
- Test: `tests/upload-milestone.test.cjs`

**Interfaces:**

- Consumes: chosen catalogue row and per-platform schedule from Task 3.
- Produces: an existing matched row whose historical `catalogue.releaseDate` may differ from `draft.releaseDate`.
- Preserves: new-row equality between catalogue date and upload date.

- [ ] **Step 1: Write failing historical-date and stale-row tests**

Add a background validation test where a matched row retains `2026-05-08` while the selected upload date is `2026-09-11`; require acceptance. Add the corresponding new-row test and require rejection:

```js
const historical = structuredClone(validUploadRequest);
historical.draft.releaseDate = "2026-09-11";
historical.draft.scheduledIso = "2026-09-11T15:00:00.000Z";
historical.catalogue.status = "matched";
historical.catalogue.releaseDate = "2026-05-08";
assert.equal(
  validateCreatorUploadRequest(historical).catalogue.releaseDate,
  "2026-05-08",
);

const invalidNew = structuredClone(historical);
invalidNew.catalogue.status = "new";
assert.throws(
  () => validateCreatorUploadRequest(invalidNew),
  /catalogue upload preview/i,
);
```

Add a console test requiring the outbound matched payload to keep the historical catalogue date while the draft uses the proposed Friday.

- [ ] **Step 2: Run validation tests and confirm the current equality guard fails**

Run:

```powershell
node --test --test-name-pattern="historical catalogue|new catalogue date" tests/background.test.cjs tests/upload-milestone.test.cjs
```

Expected: FAIL at the current unconditional `catalogue.releaseDate !== draft.releaseDate` guard.

- [ ] **Step 3: Make date equality conditional on new rows**

In `background.js`, validate the catalogue status before the date condition and apply:

```js
const catalogueDateConflicts =
  catalogue.status === "new" && catalogue.releaseDate !== draft.releaseDate;
```

Use `catalogueDateConflicts` in the invalid-preview condition. Keep Friday/15:00 UTC validation on the actual draft schedule. Do not write the new platform date into B for a matched historical row.

In `upload-console.js`, send the chosen row's unchanged A:D values under `catalogue` and the proposed platform Friday under `draft`. Include `seasonArc`, `episode`, and `pornhubLink` only as read-only proposal context; do not add a Pornhub commit target. Extend the background's catalogue parsing to bound `seasonArc` to 500 characters, `episode` to 40 characters, and `pornhubLink` to 500 characters so the fields remain explicit rather than silently discarded.

- [ ] **Step 4: Run safety regressions**

Run:

```powershell
node --test tests/background.test.cjs tests/catalogue-proposal.test.cjs tests/upload-milestone.test.cjs
```

Expected: PASS for historical rows, new rows, stale fingerprints, already-linked targets, and no mutation before Yes.

- [ ] **Step 5: Commit Task 4**

```powershell
git add background.js upload-console.js tests/background.test.cjs tests/upload-milestone.test.cjs
git commit -m "Preserve historical catalogue release dates"
```

---

### Task 5: Versioned Integration and Full Verification

**Files:**

- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Test: `tests/creator-tools.test.cjs`
- Test: `tests/extension-load.test.cjs`
- Test: `tests/store-edition.test.cjs`

**Interfaces:**

- Produces: unpacked personal extension version `0.12.0` with the proposal module loaded only by the personal upload console.
- Preserves: store-safe edition exclusion of upload-console, catalogue, file-bridge, and platform automation code.

- [ ] **Step 1: Write failing packaging assertions**

Require the personal manifest version and proposal file, and require the store package to exclude the proposal module:

```js
const manifest = JSON.parse(read("manifest.json"));
assert.equal(manifest.version, "0.12.0");
assert.equal(
  fs.existsSync(path.join(toolsRoot, "catalogue-proposal.js")),
  true,
);
```

Extend the existing store-source exclusion assertion:

```js
assert.doesNotMatch(
  searchable,
  /upload-console|upload-capability-probe|file-bridge|catalogue-bridge|catalogue-proposal|upload-platform-adapters/i,
);
```

- [ ] **Step 2: Run packaging tests and confirm the version failure**

Run:

```powershell
node --test tests/creator-tools.test.cjs tests/store-edition.test.cjs tests/extension-load.test.cjs
```

Expected: FAIL because the version remains `0.11.0` and packaging assertions are not yet satisfied.

- [ ] **Step 3: Bump version and document the actual boundary**

Set `version` to `0.12.0` in `manifest.json`, `package.json`, and the root package entry in `package-lock.json`. Add a concise README section stating:

```markdown
### Catalogue proposal picker

The personal upload console can rank the connected Video Catalogue locally,
infer empty OnlyFans, Fansly, and ManyVids link targets, and fall back to an
explicit row picker. Pornhub may be recommended from column H but remains
non-executable until its queue and full-submit trace are implemented.
```

- [ ] **Step 4: Run formatting, focused tests, and the complete release check**

Run:

```powershell
node node_modules/prettier/bin/prettier.cjs --write creator-tools/catalogue-proposal.js tests/catalogue-proposal.test.cjs apps-script/catalogue-bridge.gs creator-tools/catalogue-client.js creator-tools/catalogue-contract.js upload-console.js upload-console.html upload-console.css background.js tests/upload-milestone.test.cjs tests/background.test.cjs tests/extension-load.test.cjs tests/creator-tools.test.cjs README.md manifest.json package.json
npm run check
```

Expected: lint, typecheck, format check, personal tests, store tests, personal build, store build, and unpacked Chrome load all PASS with version `0.12.0`.

- [ ] **Step 5: Inspect the built extension without posting**

Load the generated personal package in the test browser and verify:

```text
Creator Workflow Toolkit 0.12.0
Strong unique fixture -> one proposal
Ambiguous fixture -> searchable picker
Pornhub-only missing -> recommended but not executable
No PREPARE_CREATOR_UPLOAD or START_CREATOR_UPLOAD message before Yes
```

Do not open or submit a real platform composer in this verification step.

- [ ] **Step 6: Commit Task 5**

```powershell
git add manifest.json package.json package-lock.json README.md tests/creator-tools.test.cjs tests/extension-load.test.cjs tests/store-edition.test.cjs
git commit -m "Release catalogue proposal picker 0.12.0"
```

- [ ] **Step 7: Merge locally after the final clean verification**

Use the finishing-development-branch workflow, confirm only the pre-existing untracked `dist/` remains, merge into local `main`, and rerun `npm run check` on the merged tree. Do not push.
