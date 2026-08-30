# Authenticated release smoke test

Run this checklist manually in a disposable or low-risk draft wherever the
platform permits it. Do not commit credentials, cookies, private saved pages,
account identifiers, or screenshots containing customer data.

Passing fixtures are required before this checklist. A live success never
replaces an automated test.

This release checklist is inspection-only. It must never click or exercise a
real Save, Schedule, Post, Submit, or equivalent final control. The posting
steps below describe a separately authorized creator acceptance run and are not
part of the release smoke test.

## Before testing

- Build and load the validated personal ZIP or its exact source revision.
- Open the extension options and restore safe defaults.
- Confirm every state-changing helper is disabled and has autorun off.
- Grant only the origin currently under test.
- Enable one helper, reload its supported route, and confirm only one toolkit
  panel is mounted.
- Use a draft with harmless test metadata and a manual recovery path.
- Keep DevTools open for uncaught errors, but do not paste private page markup
  into issues or logs.

For every helper, verify that Disable and Stop prevent the next mutation, a
route change removes the panel, returning to the route mounts one clean panel,
and missing/duplicate/hidden controls yield a visible failure with no guessed
action. Also verify that the options-page action log records a concise truthful
outcome without page content or credentials.

## Upload console

- Confirm the extension reports version `0.13.0` before testing. For the release
  smoke pass, stop at the final preview on every site; do not click the global
  Yes when it would reach a real final platform control.
- Configure distinctive safe saved profiles and verify the Master Uploader
  preview shows the same Fansly caption policy, ManyVids commercial metadata,
  and Pornhub exact preset as their standalone panels.
- After the preview is confirmed in an automated fixture, replace the source
  input programmatically and verify the bridge still transfers only the frozen
  confirmed file identity. Confirm the full, thumbnail, and Pornhub inputs are
  disabled; a teaser missing at Yes may be supplied once and is then frozen.

- With no sheet bridge configured, select a harmless full-video fixture and
  enter a description. Confirm **Yes, upload now** appears, the preview says
  no sheet data will be read or written, and no platform tabs open before Yes.
  Click No and confirm nothing uploads. A configured but failing bridge must
  show its error and offer **Continue without sheet**, never silently bypass it.
- Only during an authorized live upload-only run, confirm Yes opens or reuses
  the selected signed-in platform tabs, captured links appear in the console,
  and successful cards say **Scheduled · sheet not connected** with no retry.
  There must be no sheet requests in this mode. Sheet-based existing-link
  checks are unavailable, so use a genuinely new upload.
- For the connected path, configure the creator-owned Apps Script deployment
  and verify a catalogue match changes no platform tab and no sheet cell before
  **Yes, upload now**.
- Select a harmless full-video fixture without a teaser. Confirm the preview
  names the exact row, Friday at 15:00 UTC, OnlyFans full-media mapping, Fansly
  `defaulT` locked-full mapping, missing teaser wait, and J/K no-overwrite rule.
- Click No on a credible match and confirm the next empty row is proposed
  without changing the sheet.
- Click Yes and confirm both full transfers begin through real file controls;
  OnlyFans labels must remain unchanged byte-for-byte.
- Supply the teaser after Fansly reports **Waiting for teaser**. Confirm it is
  attached through **Add Free Preview** on the same media bundle and the full
  video is locked with exact preset `defaulT`.
- Confirm the browser-local time represents 15:00 UTC, including the applicable
  daylight-saving offset, before either final platform control is clicked.
- Confirm each final platform click occurs once, the resulting public post link
  is canonical, and its J or K cell is filled immediately after that platform
  succeeds.
- Pre-fill J or K with a different link and confirm the extension reports a
  conflict without overwriting it.
- Force a pre-submission platform fixture to fail, confirm the other remains
  posted and committed, then retry only the failed platform. After a final
  submission, confirm a known post URL retries only the sheet write and an
  unresolved link offers no automated repost.
- Use an unfamiliar final response fixture and confirm the run stops at
  **Posted; link unresolved** without guessing a sheet link.
- In an automated worker-restart fixture, confirm bounded textual state resumes,
  an already captured ManyVids ID reopens only that editor, and an attempted
  submission without a captured URL requires manual recovery. Inspect session
  storage and confirm no `File`, bytes, local path, credential, cookie, header,
  or request body was persisted.
- Confirm simultaneous platform checkpoints retain every sibling
  `submitAttempted` flag, terminal jobs are removed, and uncertain/manual-link
  recovery jobs remain available until the browser session ends.

## Clips4Sale

- Open the current upload/edit route and preview a profile with no approved
  category. Confirm the category remains unchanged.
- Configure one exact known category, related category, performer, audience,
  price, description prefix, and keyword set. Confirm the preview names every
  proposed change before Apply becomes available.
- Confirm category menus execute serially and no unrelated modal closes.
- Test an unavailable and a duplicate category; both must fail closed without
  selecting the first result.
- Confirm the exact performer is selected, `Assign Performer` is never confused
  with `Unassign Performer`, and assignment state is verified.
- Confirm existing descriptions and keywords are preserved under append policy.
- Start a second draft in the same SPA session and confirm state is freshly
  inspected rather than inherited.
- Confirm Save/Submit remains manual.

## Pornhub uploader

- In the Master Uploader, provide both a full video and a separate Pornhub
  `(limited)` video and confirm the plan names the Pornhub file. Remove it and
  confirm the full video becomes the fallback. A teaser must never become the
  Pornhub file.
- Confirm an exact Pornhub content preset is required. The master preparation
  may apply only orientation, tags, and categories, then must report
  **Manual submit required**. It must not assign a file, write a title or
  description, schedule, query/click Submit, or claim a captured link.
- In a fixture with a Season/Arc, confirm an exact preset selected at Yes is
  saved as that deterministic future mapping without changing the profile
  snapshot used by the active run.

- Type a query that produces an exact suggestion plus fuzzy/promoted/wrapper
  rows. Confirm only the exact fresh suggestion is accepted.
- Change the query quickly and confirm results from the previous query are
  rejected.
- Confirm existing chips are preserved, duplicates are skipped, capacity is
  enforced, and each accepted chip is verified by identity.
- Confirm an unavailable tag and orientation produce accurate failures.
- Confirm Save/Submit remains manual.

## ManyVids

- Open an edit page containing existing commercial metadata. Confirm nothing
  changes before Preview and Apply.
- Confirm configured tags use exact fresh autocomplete results, preserve
  existing chips, skip duplicates, and stop at capacity.
- Confirm unknown free/membership mode controls are skipped unless their exact
  accessible labels are configured.
- Confirm price and schedule/timezone choices are previewed exactly.
- Trigger Apply twice and confirm runs never overlap.
- Confirm Save/Submit remains manual.

## Sheer

- Confirm the helper works with `window.jQuery` absent.
- Open a form where taxonomy options arrive late and confirm Preview waits for
  stable usable options.
- Under append mode, confirm existing tags remain and only exact missing tags
  are added.
- Under replace mode, make one configured label unavailable and confirm no
  existing tag is cleared.
- Confirm zero and duplicate exact matches fail visibly.
- Confirm Save/Submit remains manual.

## Fansly

- Confirm opening a composer causes no mutation.
- Apply to an empty composer and verify caption plus distribution/reply toggles
  independently.
- Apply with an existing caption and confirm append policy preserves it.
- Clear generated text manually and confirm no observer restores it.
- Confirm the Post control is never focused, clicked, or activated.

## OnlyFans expired-list selection

- Enable Fan Identity Mask and use two rows with the same displayed alias.
  Confirm stable account IDs, not rendered names, drive row identity.
- Confirm the helper refuses a row with an empty stable ID or ambiguous
  selection control.
- Start while rows virtualize or detach and confirm disconnected rows are not
  reported as changed.
- Press Stop during scrolling and during a configured delay; no later checkbox
  may change.
- Confirm the hard action and duration caps are enforced.
- Confirm the final OnlyFans Add action remains manual.

## OnlyFans expired-list follow

- Confirm the route/dialog contains the required expired-list context before a
  plan can run.
- Confirm a blocking unknown modal prevents every Follow click.
- Confirm the exact visible account state changes to Following before an action
  is counted.
- Confirm a rate-limit message, unclickable row, detached row, retry exhaustion,
  no-progress condition, action cap, duration cap, and Stop each terminate with
  an accurate result.
- Confirm no global popup closer runs and no action occurs behind a modal.

## Reddit banner censor

- Test current `www.reddit.com`, `sh.reddit.com`, and `old.reddit.com`.
- Start screen capture before navigation and verify banner imagery never becomes
  visible at first paint.
- Verify current DOM, open Shadow DOM, and old-layout banner targets are covered
  without hiding post media or unrelated navigation.
- Disable the helper and confirm injected styles and local covers are removed
  immediately on every supported layout.

## Release record

Record the tested extension version, commit, date, browser version, platform
route/version, pass/fail result, and sanitized selector diagnostics. A selector
failure blocks that adapter from release; disable it until its fixture and
adapter contract are updated.
