# Mapped Avatar Grids Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the text-only remote-picture history with current-account and retired-picture grids that safely regenerate or re-enable pictures.

**Architecture:** Keep identity state and trust-boundary decisions in `background.js`. Expose one sanitized view message plus one validated re-enable mutation; render native image/button tiles in the existing options page and reuse `ROTATE_AVATAR` for regeneration.

**Tech Stack:** Chrome Manifest V3, vanilla JavaScript, HTML/CSS, Node test runner, Playwright.

## Global Constraints

- The Chrome Web Store edition remains unchanged.
- Never render an OnlyFans account key, real name, or real username.
- A currently assigned picture can never be re-enabled.
- Re-enable releases only blockers no longer referenced by another current or retired picture.
- Use native controls and existing dependencies only.

---

### Task 1: Background avatar management view

**Files:**

- Modify: `background.js:1507-1535`
- Test: `tests/background.test.cjs:582-617`

**Interfaces:**

- Produces: `getAvatarManagementView(): Promise<{current: CurrentTile[], retired: RetiredTile[]}>`
- `CurrentTile`: `{primaryKey, displayName, handle, avatarUrl, avatarKind}`; `primaryKey` is transport-only and must not be rendered.
- `RetiredTile`: `{source, id, sourceUrl, postUrl, fingerprint}`.

- [x] **Step 1: Write the failing view test**

After creating and rotating `user:6`, send `GET_AVATAR_MANAGEMENT_VIEW` and assert that `user:6` appears once in `current`, its generated display name/handle and cached data-image URL are returned, the currently assigned ID is absent from `retired`, and the former ID is present in `retired` with its source URL.

- [x] **Step 2: Run the background test and verify RED**

Run: `node --test tests/background.test.cjs`

Expected: failure from `Unknown extension request.` for `GET_AVATAR_MANAGEMENT_VIEW`.

- [x] **Step 3: Implement the minimal sanitized view**

Build a set of current `{source,id}`, URLs, and fingerprints from `state.identities`. Return canonical mappings from `Object.entries(state.identities)` and history entries that do not match any current reservation. Include no aliases and no account-derived labels.

Add the message case:

```js
case "GET_AVATAR_MANAGEMENT_VIEW":
  return { avatarView: await getAvatarManagementView() };
```

- [x] **Step 4: Run the background test and verify GREEN**

Run: `node --test tests/background.test.cjs`

Expected: pass.

---

### Task 2: Safe retired-picture re-enable and cross-tab refresh

**Files:**

- Modify: `background.js:1327-1377, 1403-1410, 1758-1820`
- Test: `tests/background.test.cjs:582-617`

**Interfaces:**

- Produces: `reenableRemoteAvatar(source, id): Promise<void>`.
- Extends existing `ROTATE_AVATAR` behavior to emit `signalIdentityRefresh("pictures")` after successful state mutation.

- [x] **Step 1: Write failing mutation tests**

Assert that `REENABLE_REMOTE_AVATAR` rejects the currently assigned Realbooru ID. Re-enable the former retired ID and assert its history record, `usedRealbooruIds[id]`, URL reservation, and unshared fingerprint reservation are gone while the current ID remains blocked. Assert the control signal timestamp changes after options-driven rotation.

- [x] **Step 2: Run the background test and verify RED**

Run: `node --test tests/background.test.cjs`

Expected: failure from unknown re-enable request and missing refresh signal.

- [x] **Step 3: Implement the minimal atomic mutation**

Inside `queueStateMutation`, normalize the source to `gelbooru` or `realbooru`, locate exactly one history record, reject if its ID/URL/fingerprint matches any current identity, remove the record and source-specific ID reservation, then delete URL/fingerprint reservations only when no remaining history/current identity references them. Add:

```js
case "REENABLE_REMOTE_AVATAR":
  await reenableRemoteAvatar(message.source, message.id);
  return { avatarView: await getAvatarManagementView() };
```

After a successful `rotateAvatar`, call `signalIdentityRefresh("pictures")` before returning.

- [x] **Step 4: Run the background test and verify GREEN**

Run: `node --test tests/background.test.cjs`

Expected: pass with assigned-picture refusal and precise blocker release proven.

---

### Task 3: Current and retired picture grids

**Files:**

- Modify: `options.html:312-319`
- Modify: `options.js:174-200`
- Modify: `options.css:313-345`
- Test: `tests/extension-load.test.cjs`

**Interfaces:**

- Consumes: `GET_AVATAR_MANAGEMENT_VIEW`, `ROTATE_AVATAR`, and `REENABLE_REMOTE_AVATAR`.
- Produces DOM containers `#currentAvatarGrid` and `#retiredAvatarGrid` containing native `.avatar-tile` buttons.

- [x] **Step 1: Write the failing browser assertions**

Seed one mapped identity through the service worker, reload options, assert one current tile and its masked label render, assert the canonical key is absent from `document.body.textContent` and DOM attributes, rotate through the tile, and confirm the picture changes and a retired tile appears. Click Re-enable and confirm the retired tile disappears.

- [x] **Step 2: Run the extension load test and verify RED**

Run: `node --test tests/extension-load.test.cjs`

Expected: failure because `#currentAvatarGrid` and `#retiredAvatarGrid` do not exist.

- [x] **Step 3: Implement minimal markup and renderer**

Replace the ordered list with two labeled grid containers. Render each tile as a native button containing a lazy image, masked caption, and overlay action label. Keep `primaryKey` in the click-handler closure rather than a `data-*` attribute. Regenerate via `ROTATE_AVATAR`; re-enable via `REENABLE_REMOTE_AVATAR`; disable the clicked button during work and refresh both grids on success. Use `showStatus` for errors.

- [x] **Step 4: Add responsive and accessible CSS**

Use `grid-template-columns: repeat(auto-fill, minmax(112px, 1fr))`, square `aspect-ratio`, `object-fit: cover`, and an absolutely positioned overlay visible on `.avatar-tile:hover` and `.avatar-tile:focus-visible`. Preserve a visible focus outline and an unavailable-image fallback.

- [x] **Step 5: Run browser and personal tests and verify GREEN**

Run: `npm run test:personal`

Expected: all personal tests pass with no page errors.

---

### Task 4: Full verification and personal package

**Files:**

- Verify: `manifest.json`
- Verify: `scripts/build-personal-package.ps1`
- Verify unchanged: `store/`

- [x] **Step 1: Run all checks and builds**

Run: `npm run check`

Expected: lint, typecheck, format check, 19 or more tests, personal build, and store build all pass.

- [x] **Step 2: Inspect the personal package**

Inspect the generated v0.8.2 ZIP and assert it contains the updated options files and no localhost scraper strings.

- [x] **Step 3: Audit the spec requirement by requirement**

Confirm both grids, masked-only labels, regenerate consistency, retired exclusion, safe re-enable, failure preservation, keyboard visibility, missing-image fallback, and unchanged store package each have direct source/test/build evidence.
