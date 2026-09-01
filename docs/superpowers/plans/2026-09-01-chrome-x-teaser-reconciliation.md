# Chrome X Teaser Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Chrome personal extension with an X teaser recorder and a locked-down Windows native host that reconcile one explicitly paired teaser with the Work catalogue, local audit, and Done folder without reposting or an LLM.

**Architecture:** The existing Chrome MV3 service worker gains one focused X orchestration path and reuses the catalogue client/contract. A dedicated recorder page freezes file/row identity and holds local frames in memory; Apps Script appends column O; a .NET native host performs only configured-root audit writes and the final source move.

**Tech Stack:** Plain JavaScript IIFEs, Chrome WebExtensions MV3, Apps Script, Node test runner, Playwright Chromium, .NET 8/C#, PowerShell packaging.

**Spec:** `docs/superpowers/specs/2026-09-01-chrome-x-teaser-reconciliation-design.md`

## Global Constraints

- No LLM or cloud-AI dependency.
- Catalogue row choice is explicit; filename similarity is advisory only.
- Do not post a real X status, mutate the live Work Sheet, register a native host, write the registry, or move a real file under `D:\MEDIA` during development.
- Persist no file bytes, raw paths, credentials, cookies, headers, or request bodies in extension storage.
- A captured status ID is irreversible and can never cause a repost.
- Audit must be durable before Sheet append; Sheet append must be durable before move.
- Never overwrite a Sheet link, audit entry, frame, or Done file.
- Preserve Chrome personal/store behavior and packages; the store edition remains unchanged.

---

### Task 1: X teaser contract and explicit pairing

**Files:**

- Create: `creator-tools/x-teaser-contract.js`
- Create: `tests/x-teaser-contract.test.cjs`
- Modify: `creator-tools/catalogue-contract.js`

**Interfaces:**

- Consumes: catalogue rows and bounded browser `File` identity metadata.
- Produces: `CreatorXTeaserContract.canonicalStatusUrl(value)`, `rankCatalogueRows(fileProof, rows)`, `freezePairing(fileProof, row)`, and `validateCapture(value)`.

- [ ] Write tests requiring numeric canonical status URLs, explicit row selection, bounded file proofs, ranked-but-unselected suggestions, and fail-closed capture semantics.
- [ ] Run `node --test tests/x-teaser-contract.test.cjs` and verify RED because the module is absent.
- [ ] Implement the minimal pure contract using existing normalized-token similarity only for ordering.
- [ ] Run `node --test tests/x-teaser-contract.test.cjs tests/catalogue-proposal.test.cjs` and verify GREEN.
- [ ] Commit `Add explicit X teaser pairing contract`.

### Task 2: Restart-safe X session store

**Files:**

- Create: `creator-tools/x-teaser-session-store.js`
- Create: `tests/x-teaser-session-store.test.cjs`

**Interfaces:**

- Consumes: frozen pairing and validated capture; `chrome.storage.local`.
- Produces: `save`, `load`, `list`, and `remove` with serialized writes, monotonic stages, and status-ID uniqueness.

- [ ] Write tests for allow-listed storage, irreversible capture, duplicate status rejection, concurrent writes, and recovery after every partial stage.
- [ ] Run `node --test tests/x-teaser-session-store.test.cjs` and verify RED.
- [ ] Implement minimal metadata-only storage; reject frames, bytes, paths, cookies, and request bodies.
- [ ] Run `node --test tests/x-teaser-session-store.test.cjs tests/upload-session-store.test.cjs` and verify GREEN.
- [ ] Commit `Persist restart-safe X teaser sessions`.

### Task 3: Safe column-O Sheet append

**Files:**

- Modify: `creator-tools/catalogue-contract.js`
- Modify: `creator-tools/catalogue-client.js`
- Modify: `apps-script/catalogue-bridge.gs`
- Modify: `tests/catalogue-proposal.test.cjs`
- Modify: `tests/upload-milestone.test.cjs`

**Interfaces:**

- Consumes: row, A:O fingerprint, catalogue ID, and canonical X status URL.
- Produces: `CreatorCatalogueClient.appendTwitterTeaser(payload)` and Apps Script action `appendTwitterTeaser` with `updated`, `idempotent`, `stale`, or `conflict`.

- [ ] Write tests for A:O reads, column-O fingerprinting, row/ID recheck, newline append, duplicate idempotence, drift rejection, and no column-N write.
- [ ] Run the matching test-name pattern and verify RED because the field/action is absent.
- [ ] Extend the existing locked bridge and client with the bounded action.
- [ ] Run catalogue, milestone, and background suites and verify GREEN.
- [ ] Commit `Append canonical X teasers to catalogue`.

### Task 4: Native audit and move host

**Files:**

- Create: `native-host/CreatorTeaserNativeHost/CreatorTeaserNativeHost.csproj`
- Create: `native-host/CreatorTeaserNativeHost/Program.cs`
- Create: `native-host/config.example.json`
- Create: `native-host/install-current-user.ps1`
- Create: `tests/x-teaser-native-host.test.cjs`

**Interfaces:**

- Consumes: configured roots and native `audit` or `move` requests containing basename/stable identity, status, catalogue, and three bounded JPEG frames.
- Produces: bounded JSON results over native-messaging framing; `--request <config> <request-file>` is the fixture-only CLI.

- [ ] Write temporary-tree tests for traversal/root/reparse escape, missing/multiple source, identity mismatch, malformed frames, destination collision, move-before-audit, partial recovery, and idempotence.
- [ ] Run `node --test tests/x-teaser-native-host.test.cjs` and verify RED because the project is absent.
- [ ] Implement configured-root resolution, reparse rejection, streamed SHA-256 identity, idempotent frames/JSON/HTML, and a durable receipt.
- [ ] Implement guarded move requiring the matching receipt and a collision-free Done destination.
- [ ] Run `dotnet build ... -c Release` plus the Node host tests and verify GREEN.
- [ ] Commit `Add locked-down teaser reconciliation host`.

### Task 5: Chrome recorder UI, observer, and orchestration

**Files:**

- Create: `x-teaser.html`
- Create: `x-teaser.js`
- Create: `x-teaser.css`
- Create: `creator-tools/x-teaser-observer.js`
- Modify: `background.js`
- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `manifest.json`
- Create: `tests/x-teaser-chrome.test.cjs`

**Interfaces:**

- Consumes: Tasks 1-4, bridge config, one selected `File`, explicit row, and bounded observer messages.
- Produces: frozen pairing, local frames held in the recorder view, monotonic reconciliation calls, and one concise result card.

- [ ] Use `$impeccable` before UI edits to define a compact single-task flow.
- [ ] Write failing Chrome fixture tests for narrow permissions, no confirmation before explicit row choice, frozen proof, warning/ambiguity rejection, canonical capture, audit -> Sheet -> move ordering, and no-repost resume.
- [ ] Run `node --test tests/x-teaser-chrome.test.cjs` and verify RED.
- [ ] Implement native controls, SHA-256, three local frames at 20/50/80 percent, explicit row picker, one confirmation, optional X permission, dynamic observer, and background orchestration.
- [ ] Run the fixture suite and inspect 1280x800, 800x700, and 390x844 renderings with Playwright Chromium; exercise the primary flow and check console errors.
- [ ] Use `$web-design-guidelines`, fix applicable accessibility/usability findings, and rerun the UI suite.
- [ ] Commit `Add Chrome X teaser recorder`.

### Task 6: Packaging, documentation, and final gates

**Files:**

- Modify: `scripts/build-personal-package.ps1`
- Create: `scripts/build-x-teaser-native-host.ps1`
- Create: `docs/X_TEASER_CHROME_SETUP.md`
- Create: `docs/X_TEASER_AUTHENTICATED_SMOKE.md`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/creator-tools.test.cjs`
- Modify: `tests/extension-load.test.cjs`

**Interfaces:**

- Consumes: extension and host sources.
- Produces: personal extension v0.14.0 ZIP, native host v0.14.0 ZIP, hashes, and exact non-live install/smoke instructions.

- [ ] Write failing package tests for required personal entries, native package entries, version increment, and unchanged store package.
- [ ] Run focused package/load tests and verify RED.
- [ ] Extend personal packaging and create framework-dependent `win-x64` native-host packaging with an unexecuted HKCU installer.
- [ ] Document exact configuration, fixture rehearsal, authenticated X semantic smoke without posting, and separately authorized live gates.
- [ ] Run lint, typecheck, format check, all tests, Chrome unpacked load, personal/store builds, native build/tests, and package hashes.
- [ ] Commit `Package Chrome X teaser workflow`.
- [ ] Review the full recovery matrix, diff, and archive entries; fast-forward merge the branch locally to `main` without pushing.
