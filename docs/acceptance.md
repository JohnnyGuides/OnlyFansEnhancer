# Acceptance and platform evidence

This is a reusable procedure, not a record of a completed test run. Automated
commands are in [development](development.md). Product authority remains in
[the product contract](product.md). Keep private captures outside source and
never use real-account data merely to make automated tests pass.

## Separate authorization boundaries

Offline fixture checks, current signed-in page inspection, installation/registry
changes, public posting, live Sheet mutation, and real-media moves are different
operations. A successful fixture or inspection authorizes none of the later ones.
Use a disposable browser profile, inert media, temporary desktop data, and fake
HTTP handlers by default. Do not reuse a personal signed-in profile in Playwright.

Before a deliberate live action, review its exact plan and existing outcomes.
Stop on an unknown submit, changed row/recipe/file, ambiguous control, duplicate
candidate, missing trace, stale connection, or unclear final identity. Never
resolve an uncertain result by making a second public attempt. Stop and inspect
without causing additional actions; retain completed sibling outcomes.

## Offline desktop and package acceptance

Build/stage the real desktop and relay and run the .NET/native/package suites.
Use temporary `OFENHANCER_DATA_ROOT` and
`OFENHANCER_WEBVIEW2_USER_DATA_FOLDER` values for an inert desktop launch.
Confirm one authority process, second-launch behavior, window-close-to-tray,
tray Open/Exit, protocol version, and truthful disconnected/empty catalogue
states. Do not register a host or run the installer for this inspection.

Import only a synthetic snapshot, scan a disposable thumbnail root, rename/move
fixture images, and verify opaque thumbnail IDs, explicit ambiguous matching,
no path escape, no silent rebinding, and persistence after restart. Test migration
failure/backup recovery and malformed/over-limit snapshots. The package must
contain neither the temporary database/backup nor private settings/credentials.

Exercise the shared UI at 1440×900, 800×700, and 390×844, including keyboard flow,
visible focus, Escape/focus restoration in pickers, errors, reduced motion, and
no horizontal overflow or uncaught script errors. Check all Google UI states with
fake callbacks; fixture credentials and matching-client rejection never require
real consent. A local upload record must not appear as verified Google sync.

The synthetic local-file attachment test must set exactly the chosen inert file,
observe input/change events, detach the debugger even after failure, and reject a
wrong origin, tab, selector, generation, or file identity. Native channel tests
cover frame bounds, correlation, repeated requests, disconnect, and no replay.
Extension-load tests must exercise both built manifests and the store's disabled
pre-consent state; a blocked browser policy is not a successful load.

Installer acceptance separately covers fresh install, update from an older
running build, repair, interactive keep-data uninstall, explicit delete-data
uninstall, and silent keep-data uninstall. Confirm only owned HKCU entries change,
Chrome setup/reload guides use Chrome, current data survives update/repair, and
external media/profiles remain untouched. A StageOnly pass is not a compiled or
installed Setup pass. Unsigned local output is not a signed public release.

### Single-action uploader - 0.20.41

The 0.20.40 preparing-to-confirmation bounce was reproduced with the installed
personal Chrome uploader and with its retained preparation records in the real
extension worker and desktop runtime transport. PREPARE rejected with
`An existing prepared or uncertain draft exists for this work item.` The journal
was a legitimate duplicate-preparation blocker; the defective UI hid recovery
and reconstructed confirmation after the rejection. No journal was cleared to
make this release appear ready.

The shared uploader now checks availability before enabling one sticky **Upload**
action, awaits the file-port binding acknowledgement, and dispatches PREPARE and
START once for an admitted run. Known pre-admission rejection retains editable
files/details and requires a successful readiness check before retry. Uncertain
admission or START retains the bound run and exposes reconciliation instead of
repeating work. Runtime versions, catalogue revalidation, durable publication
intents and page/document bindings remain enforced. Optional media, destination
settings and catalogue selection use compact conditional disclosure; the generic
confirmation step and summary table are removed.

September 22 verification: `npm run check` passed (469 portable tests plus one
stage-dependent skip, 371 .NET tests, 13 native tests, and 14 Windows packaging
tests plus one compiler-dependent skip). Both skipped tests subsequently passed
against the built package: genuine isolated Chromium installation lifecycle and
the compiled installer's recovery/ordinary-update integration. The packaging
suite's isolated GUI-launch subcheck remained skipped while a real desktop
authority was running. New full-worker regressions cover both launcher paths,
file handoff, the actual recovery rejection, safe retry, uncertain START,
publication blocking, rejected binding and an offline desktop connection.

Impeccable context, Distill, Layout and Clarify were applied. The finish pass
checked initial, ready, loading, error and progress views, wide/narrow layouts,
long filenames and 200% text/zoom behavior. The final mechanical scan's only
finding was the incumbent Inter font, retained to preserve the product identity.
All 854 staged package files passed their size/SHA-256 verification.

The normal 0.20.41 update was installed successfully and the existing personal
Chrome extension reloaded at its unchanged ID and load location. The desktop
reported `Chrome connected. Ready to prepare uploads.` Three readable saved
settings/credential files retained their hashes; a before-hash of the open
catalogue database was unavailable and is not claimed. The next personal-profile
UI automation step was blocked by a tooling safety check. Post-fix authenticated
platform file handoff remains unverified; fixture results are not live publication
evidence. No public publication or catalogue mutation was performed.

For the remaining bounded live gate, select the generated
`.local/uploader-041/media/ofe-041-extension-benign-20260922.mp4` in Chrome (or the
corresponding `ofe-041-desktop-benign-20260922.mp4` in the desktop uploader).
Choose OnlyFans, **Prepare, then let me publish**, and **Choose later** for the
catalogue. Enter neutral development metadata and click **Upload** once. Stop at
the prepared/unpublished composer, never Publish; retain **Draft tools & recovery

> Export diagnostics** and the displayed result/error as evidence. Existing work
> that needs reconciliation must not be cleared merely to pass this gate.

### MainHub schedule and certifications — 0.20.40

The current upload form's publication dropdown now opens its owned schedule
picker, selects the requested UTC date/time, and verifies the saved readonly
date before continuing. Month navigation checks each resulting month and stops
on unexpected movement. Picker ownership, timezone, and selected date/time must
agree; ambiguous or changed controls stop preparation.

At the owner's explicit request, preparation automatically selects the three
identified legal certifications and verifies their checked state. It does not
select Sponsored Content or reaction-content options. Final Submit remains manual.
Fixtures cover correct scheduling, month transitions, unexpected month changes,
wrong upload ownership/timezone, failed saved-date readback, duplicate certification
controls, a click that does not check the boxes, and already accepted declarations.

Live MainHub browser inspection with the benign teaser fixture verified selecting
September 25, 2026 at 15:00 UTC and saving the draft date. Its readonly field
reported `25 September, 2026, 03:00:00 PM "UTC"`. The legal certifications were
inspected but not clicked through the browser tool, and final Submit was not
clicked. Automatic certification acceptance and month navigation were verified
with isolated browser fixtures; an installed release run remains unverified.

### Scheduler control repair — 0.20.39

September 22 live Fansly inspection confirmed that Confirm Date belongs to the
modal footer, outside `.modal-content`. Scheduler ownership now covers the whole
modal. Immediately before confirmation, the selected calendar month/day must
still match the intended date as well as the selected time. A matching summary
alone is insufficient. Live browser controls set September 25, 2026 at 17:00 in
Europe/Zurich and confirmed only the draft date; the composer displayed Schedule
while media continued uploading. The publication action was not clicked.

OnlyFans AM/PM list detection now normalizes case, matching the existing exact
action resolver and supporting lowercase source text rendered in uppercase.
Fixtures cover lowercase PM selection, the actual Fansly footer layout, and a
calendar changing after date selection. The owner confirmed the live PM option
is `<div class="vdatetime-time-picker__item">pm</div>`, establishing the casing
mismatch. Direct OnlyFans browser access was previously blocked, so a fresh
installed-version run remains unverified. No active upload was retried or
restarted for this repair.

### Fresh reinstall runtime-lock repair — 0.20.38

The owner's failed 0.20.37 installation stopped at `PreviousPackageRemoved`
because the existing tray process still held `desktop/clrjit.dll`. Inno's normal
application-closing pass occurs after `PrepareToInstall`, where Fresh cleanup
already runs. The embedded maintenance helper now requests graceful shutdown
before uninstall or cleanup, limited to exact desktop/native executable paths
under the journal's approved installation root and the current Windows session.
It uses the existing close-app window-message handler, waits for process exit,
and pauses without force termination when an application refuses to close.
Resuming preserves the transaction's completed phases and original roots.

A Windows process fixture holds a runtime file while hidden. Verification checks
graceful release, refusal without termination, and preservation of a same-named
application outside the approved root. Compiled installer recovery checks also
verify shutdown precedes uninstall and cleanup. User installation is separate
from these isolated fixture checks; the paused owner transaction is not reset.

### Upload preparation corrections — 0.20.37

September 21 owner traces and the supplied OnlyFans button markup establish
the current scheduler action (`at-attr="scheduled_msg"`,
`b-make-post__datepicker-btn`, `icon-schedule`) despite its generic accessible
label. The adapter prefers that combined identity, rejects incomplete or
conflicting controls, and supports the recorded unlabelled in-composer
`vdatetime` popup with Save for Later and Next/OK controls. Expiration dialogs
and final publication remain guarded.

An isolated real Chrome regression reproduced Fansly's binding failure:
`MessageSender.url` retains `/` after `pushState` while the frame and page report
`/home`. Binding now verifies the live homepage URL and original composer inside
the exact document. Concurrent checks can accept the same verified alias without
invalidating one another; foreign routes, documents, composers and connections
remain rejected. The Chrome regression uses intercepted inert HTML, not a live
account or upload.

Live inspection followed ManyVids' 3.43 GB test file through upload completion.
Its completed card replaces the Uppy item outside the dashboard, and Edit has no
URL attribute. The adapter now binds a newly appeared card by the approved file
receipt, exact filename, rounded displayed size, unique Edit action and icon.
The coordinator independently checks the in-document action proof, then accepts
one top-frame editor navigation within 30 seconds on the same bound connection;
the resulting canonical editor URL and document become the handoff identity.
Pre-existing/duplicate/replaced cards, unrelated destinations and lost bindings
are rejected. A live click on the completed neutral file opened its Edit page;
no Save or publication action was taken. The new automated handoff is covered by
fixtures and still needs a fresh installed-version run.

The owner's later ManyVids form trace matches the current title, description,
teaser Upload and custom-launch controls. Direct live interaction also verified
neutral title/description readback and September 25 at 17:00 in the displayed
Europe/Amsterdam timezone, without final Save. Fansly accepted neutral composer
text and exposed Upload New. Browser chooser calls selected no files on either
site, so those calls do not establish upload acceptance; file-URL access in the
browser-control extension is required before continuing that verification.

Pornhub's metadata form was visible while the adapter waited for a removed
`custom-dropdown` element. The metadata adapter now also recognizes the observed
`data-error="orientation"` dropdown and verifies exact selection readback.

Regression fixtures cover the owner-supplied scheduler identity, unlabelled
calendar, wrong/ambiguous actions, stale Fansly navigation metadata, concurrent
binding checks, and current Pornhub dropdown selection and failure cases.
These are supporting checks, not end-to-end live acceptance. Browser policy
blocked the Upload console and OnlyFans page; the owner traces describe manual
actions before this update. Installation and a fresh automated unpublished run
of this version remain unverified.

### Installer recovery — 0.20.36

`tests/packaging/windows/installer-recovery.test.cjs` compiles the production
installer logic under a random test AppId, with desktop integration declarations
removed. Its files and logs stay under `.local/installer-recovery-*`; its registry
changes are limited to that test AppId. Run it after `npm run build:desktop`.

- Reproduce a registered but missing `unins000.exe` and a saved 0.20.35 preflight.
  The repair uses the approved folder, removes obsolete fixture state, installs
  and verifies the package, and retires only the Windows checkpoint.
- Resume `OwnedStatePurged` with a newly copied package and uninstaller present.
  Neither the new uninstaller nor completed purge operations may run again.
- Run an ordinary update and silent uninstall, retaining fixture user data.
- .NET coverage exercises every phase with the same/newer repair version,
  rejects downgrades and changed roots, restores an interrupted Chrome-obligation
  write, distinguishes corrupt checkpoints from absence, and checks product-root
  evidence. Preflight alone must not block normal desktop startup.

These isolated runs do not install into the owner's live product folder or
remove/reset the owner's Chrome extension.

## Google acceptance on a disposable workbook copy

Follow [Google catalogue](google-catalogue.md). First prove adaptive import leaves
the original workbook unchanged, including moved/aliased headers, multiple tabs,
ambiguous matches, conflicting link text/hyperlinks, and invalid rows. Import must
not establish write-back readiness.

Review and approve the exact sync migration on the copy only. Compare protected
cells/formulas, owned metadata/columns/tabs, row count and stable IDs. Repeat the
verified setup to prove idempotency. Move a bound row and verify lookup follows
metadata rather than its old position. A conflicting field must stop; a simulated
uncertain mutation must reconcile read-only, never submit twice. Disconnect and
reconnect must preserve local history and pending outcomes. Only after this copy
acceptance may a separately authorized live workbook be considered.

## Signed-in platform inspection — no public action

Load the generated personal runtime into its deliberate stable Chrome location.
Use current native registration only when that installation step is separately
authorized. Inspect the exact target route and form against the adapter's trace.
Do not click Save, Schedule, Post, Submit, or an equivalent final action during an
inspection-only pass. Any path that currently auto-submits after the plan's Yes
must not be started merely to inspect its first preparation step.

For OnlyFans, inspect description/file/scheduling and unchanged labels. For
Fansly, inspect the reviewed first or explicitly selected full-media preset, Add Free Preview, exact caption/toggles,
and the reviewed local representation of 15:00 UTC. For ManyVids, verify the exact
uploaded video identity, full-upload/editor transition, profile values and single
Save boundary; don't resume another video's editor. Pornhub activation, file assignment, preset and title are automated preparation; schedule, submission and result capture remain manual.

September 14 inspection confirmed the current ManyVids readonly `#dp1` calendar, `#available_time` select, and explicit timezone in the custom-launch label. Fansly's current scheduling modal also displays its timezone. Those inspections did not save or publish. OnlyFans live composer inspection was blocked by the browser tool's site policy; fixture results are not live acceptance. For the missing OnlyFans evidence, record from an empty NEW POST composer: open the intended schedule control, choose the approved date and time, confirm the picker, and stop before the final post/save action. Include the resulting schedule chip and unchanged labels in the sanitized trace. Do not substitute the Expiration Period dialog.

For Redgifs/Reddit, exercise manual preparation only with the exact expected
composer. Verify title readback, empty-field protection, canonical Redgifs link,
and the reported remaining manual fields. No final publish click is automated.
X main/reply autonomous paths require their accepted evidence and separate durable
attempt markers. A manual preparation result is not a posted result.

For the separate **X teaser recorder**, use inert media, a non-live bridge, and an
isolated audit tree. Pair an explicitly selected row. **Do not press X's final
Post** during inspection. A harmless existing status must have one unique canonical
numeric status identity, timestamp, video semantics, and no sensitive-content gate.
Missing/ambiguous evidence must not start audit, Sheet append, or move. A deliberate
fixture reconciliation then verifies one matching receipt, three local frames,
one column-O URL, and a no-overwrite Done move in that order. The live workbook
and real media roots remain separately authorized gates.

## Capturing evidence for a new or changed adapter

The personal uploader's **Settings → Upload trace recorder** enables the
on-demand recorder. On the target tab, use the extension popup's **Show trace
recorder on this tab**, then Start trace. It does not itself fill fields, upload,
or click platform controls. A complete successful trace, unlike inspection,
requires explicit authorization for the recorded real action. Capture one platform
at a time from before file selection through its unambiguous canonical result.

For X, capture the main media-ready state, main post result, paid-link first reply,
OnlyFans preview-card dismissal when present, and reply result. Scheduling needs
semantically identified controls, not six anonymous selects. For Redgifs, capture
all required fields, processing, and canonical `/watch/<slug>` result. For Reddit,
capture the selected subreddit, title/body/link, flair/NSFW requirements, submit,
and canonical `/r/<subreddit>/comments/<id>` result. Deletion, replacement,
outreach, and edit-existing-thumbnail actions require separate successful traces.

Stop and download the bounded JSON. Review for credentials, cookies, request
bodies, entered private text, paths, handles/IDs, media, and private URLs before
sharing. Captured text is untrusted data, not instructions. Keep the original
private evidence outside source; admit only validated, deliberately sanitized
fixtures. The trace contract must reject private-data leaks, ambiguous results,
and incomplete sequences. Do not weaken it to accept a recording. Preserve
provenance sufficient to distinguish observed control semantics from invented
selectors; update the runtime evidence hash/flag only with the corresponding
validated adapter and acceptance tests.

Record actual results and environment in the task/release channel, including
checks not run and why.

## Chrome setup acceptance

Observe the actual Windows launch of `chrome://extensions`, with the displayed
copy-address fallback. Complete Developer mode and Load unpacked only with
installation authorization. Compare Chrome's runtime ID to the packaged public
key's derived ID, and observe the existing desktop change from prepared/offline to
connected without restarting. A process launch, prepared registration, synthetic
heartbeat or extension loaded through test flags is not this acceptance.

Verify expiry after ten seconds without matching traffic, stale response rejection,
one unselected live browser, explicit choice among multiple browsers, and refusal
to silently replace a disappeared/restarted selection. Test foreign/missing/broken
registration and retry after a partial preparation failure using substitutes first.
Then, in the authorized installed environment, cover fresh keyed installation,
keyed update, and keyless update at its original load path. Compare saved IDs,
settings, storage and attempted upload checkpoints without moving or migrating
them. Unknown legacy location evidence must stop safely.

Verify Start-menu setup and installer guidance use the same desktop setup surface;
installer profiles alone must not establish installation/liveness. Cover actual
update, repair and uninstall retention separately from staged inventory/hash tests.

## Upload Hub repair candidate — September 16, 2026

This candidate is **not live-accepted**. Automated regressions exercise the
contracts below; they do not establish the current authenticated site DOM.
Earlier task logs report partial signed-in inspection, but no complete benign
four-platform preparation trace is available. Do not promote those notes or
manufactured calendar/media fixtures into a successful live run.

| Platform | Automated boundary covered                                                                                                                                                                                                                   | Live evidence still required                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| OnlyFans | Independent schedule-action labels must agree; competing expiration actions, existing dialogs, arbitrary date dialogs and expiration surfaces stop before date/time mutation. Exact readback, labels and manual final-action guards remain.  | Actual Schedule post action, current scheduler implementation, attached benign media, schedule chip and unchanged labels. |
| Fansly   | One homepage composer; its own Add Media/Media source menu; exact Upload New; one synchronously activated and uniquely scoped file input. No-op, delayed foreign activation, source conflicts and ambiguity fail with stage-specific errors. | Actual source-to-file path and complete current media/preset/preview/permissions, caption/toggles and scheduling flow.    |
| Pornhub  | Session-entry navigation is separate from narrow MainHub uploader-route recognition, positive device capability and exact resolved document binding. Login, wrong pages, disabled/conflicting actions and document changes are rejected.     | Complete authenticated entry/redirect chain, real device activation, owned benign file and metadata preparation.          |
| ManyVids | Existing upload logic is unchanged. Fixtures cover one selected card, one upload attempt, its completion/Edit destination and foreign/replaced/duplicate rejection.                                                                          | Actual upload-complete to same-video editor handoff, metadata and manual Save boundary.                                   |

The OnlyFans scheduler currently supported by this candidate is the positively
identified `vdatetime` surface. A different live scheduler is deliberately
unsupported until its actual structure is captured; no generic dialog or nearby
icon is accepted as a substitute.

Fansly failure propagation is exercised through both prepare results and runtime
platform-result messages into the actual Upload Hub card. A sibling platform
remains intact and a foreign-session event cannot clear the failure. These tests
do not authorize retrying an uncertain file delivery or final action.

### Bounded recorder acceptance still pending

Enable Settings → Upload trace recorder, then use the extension popup's Show
trace recorder on this tab. Start one trace per platform in an empty composer
or uploader. Use only a generated non-explicit clip and neutral text. Select a
file only once and use the approved future Friday at 15:00 UTC when scheduling.

For OnlyFans, capture attachment, caption, the intended Schedule post action,
its actual scheduler, picker confirmation and resulting chip; check labels and
stop before final Save/Post. For Fansly, capture Add Media → Upload New → file
handoff, media preparation, preview/permissions/preset, caption/toggles and date
confirmation; stop before Post. For Pornhub, reach the uploader through the
signed-in Upload Video entry and record the final uploader/device-file/metadata
flow; stop before Submit. Do not record credentials or authentication forms.

For ManyVids, first review any existing selection/upload intent. Do not repeat
an uncertain assignment. Record the owned benign file through completion, its
single Edit/Continue action and the same-video editor; stop before final Save.
An upload-start record alone is not upload completion or editor acceptance.

Use Stop and download and review the sanitized JSON before sharing. The recorder
now retains independent safe action labels, opaque control relationships and
surface headings, while rejecting arbitrary text and long numeric identifiers.
Its redacted routes do not by themselves prove exact account/video identity;
that proof must still come from the bound runtime and same-card editor checks.
A compiled installer or a green fixture run does not close these live gates.

## Upload Hub trace follow-up — 0.20.25

The owner supplied separate manual Fansly and ManyVids traces on September 16, 2026. These are evidence of current controls and manual actions, not recordings
of a successful automated four-platform run. Private trace JSON and screenshots
remain outside the repository.

Fansly's trace shows the homepage image control inside its source dropdown,
Upload New activating the composer's hidden multiple-file input, and an active
media modal after selection. That modal contains a single-select preview input
inside the full-media card as well as other inputs. The source resolver no longer
requires Upload New children before opening the image menu. The preview path
requires the exact input activated by the owned card's Upload New action; a
foreign input, conflicting label, no-op or multiple activation stops before the
teaser handoff. The trace does not independently establish whether source choices
are lazy, successful processing completion, or the approved preset's final state.
Those are separate fixture/acceptance claims.

ManyVids' trace records a manual button action followed by an edit-vid document,
then editor title/description, preview, thumbnail and launch controls. It begins
after the main transfer and does not retain the exact completion-card identity or
visibility changes. The owner separately reports that activating the tab reveals
Edit. The adapter now requests a bounded real foreground activation while
observing its owned upload. Tests cover exact tab/window/document binding,
sibling-interaction deferral, foreground denial and same-card editor ownership.
An isolated Chrome extension test verifies the actual tabs/windows APIs and
unchanged document ID with inert intercepted pages. It is not authenticated
ManyVids acceptance. Recorder diagnostic version 4 includes bounded visibility
and focus events so future evidence can show that transition explicitly.

Pornhub's approved title is now filled and read back before preset iteration,
then verified again afterward. A partially completed preset no longer prevents
the title from being attempted. Schedule and optional custom thumbnail still
require manual review and are listed on the platform card; their current DOM
contracts have not been established by the supplied screenshot.

The repeated OnlyFans Expiration Period screenshot is an unresolved live failure.
An installed package does not prove that Chrome's running worker or page adapters
were reloaded. Version checks now reject incompatible workers and page adapters
before a new file bridge or run, without replacing an active page. This is a
runtime safety fix, not proof of the current schedule control. The actual current
Schedule post action and scheduler surface still need a bounded trace after
checking the running version. Do not repeat a previous file selection to obtain
it; inspect the existing draft and stop before final Save/Post.

All new preparation and test shortcuts remain manual. No production-site final
Save, Post or Submit is authorized by a fixture pass. Full authenticated retests,
installed-upgrade acceptance and current-site completion remain separate gates.

## Chrome setup and Upload refresh — 0.20.26

Implemented on the editable Windows checkout on 2026-09-19. The canonical
personal extension ID remains `aocoaajmhccmefmfebgiiogfdojciild`.

- `npm run check:web`: lint, type checking, formatting, reproducible extension
  builds and 423 portable/extension/desktop-UI tests passed.
- `npm run check:windows`: 54 catalogue and 301 desktop .NET tests, 13 native
  tests and 14 Windows packaging tests passed; X teaser host built.
- `npm run build:desktop`: the self-contained Windows package and Inno Setup
  installer compiled. The remote shell's missing ProgramFiles(x86) environment
  value was restored for that build process from the Windows known-folder API.
- Production fixture validation resolved all three real development files,
  including the 3,429,630,660-byte full video, with 22,744 bytes of managed
  allocation for the descriptors and bounded header checks.
- An isolated Chromium profile exercised the actual production lifecycle and
  file-attacher modules: supported self-uninstall, absence of the old extension,
  a genuine new-install receipt with no old checkpoint, preservation of a separate
  test extension and site storage, and native attachment of all three actual
  fixtures to an unpublished local form. No publication endpoint was present.
- Rendered setup guides, the desktop setup dialog and Upload Console were checked
  at desktop and narrow widths; picker keyboard operation, three-way workflow
  navigation and 125% layout coverage are included in browser tests.

The signed-in personal Chrome profile has no connected browser automation
interface. Its old-install removal, new packaged-extension loading, fresh desktop
connection and authenticated platform preparation were therefore **not live
verified**. The existing desktop authority also prevented the package test's
second GUI launch; that sub-check was explicitly skipped. No real account content
was published, and the running personal Chrome profile was not modified.

Normal updates preserve extension state. Fresh reset remains blocked until a
current, genuinely installed extension crosses the durable reset barrier; neither
an old saved ID, reload nor silence alone is accepted. Reset retains desktop
catalogue, Google configuration and history and never edits Chrome profile
internals. See [the product reset contract](product.md#normal-update-versus-fresh-reset).

## Creator upload profile admission — 0.20.35

- Confirmed creator workflow profiles use a canonical SHA-256 signature instead
  of storing a potentially truncated serialized profile bundle. Custom profile
  sets larger than 50,000 characters remain admissible without weakening the
  post-confirmation change check.
- A preparation rejected before the background accepts its session is rolled
  back locally. The Upload Hub restores the confirmation controls and does not
  expose a Retry action for a target that never existed.
- The bounded legacy serialized signature remains accepted during the update so
  an already-open 0.20.34 Upload Console can finish its admission handshake.

## Windows/Chrome lifecycle separation — 0.20.34

- Inno Setup owns only Windows planning, verified previous-package removal,
  protected owned-root cleanup, package verification, and acknowledgement that a
  separate Chrome obligation exists. It does not open Chrome, wait for removal,
  or turn uncertainty into a success claim.
- Fresh reinstall retires the Windows transaction after verified installation
  while the single Chrome record remains outside purge roots. App launch resumes
  that task without repeating desktop cleanup. Legacy Windows and reset schemas
  have one bounded migration path; legacy silence-based “verified” state becomes
  unknown rather than proof.
- The app records requested, rejected, user-reported removed/absent, unknown, and
  admitted states separately. Continuing unconfirmed keeps the previous
  installation denied and still requires a genuine replacement receipt.
- Self-uninstall does not pre-clear local/session/sync storage. A genuine install
  initializes durably and publishes its receipt only after normalization. Worker
  restart resumes the same identity; update/reload cannot mint one.
- The retired receipt barrier covers browser exchange plus direct catalogue and
  upload-result calls. The native host stamps the actual Chrome origin on every
  browser request; the obsolete verifier origin/package and duplicate reload
  guide are absent.
- Interactive uninstall defaults to keeping data. Explicit removal uses the same
  configured-root, ownership, and reparse protections as Fresh cleanup and states
  separately that Chrome is unchanged. Silent uninstall keeps data.

The versioned sections below are historical acceptance records. They explain why
the superseded implementation existed; they are not simultaneous current
requirements where they conflict with 0.20.35 or the product contract.

## Fresh reinstall lifecycle — 0.20.27

Fresh reinstall is distinct from Fresh reset. Setup stages its maintenance
coordinator outside the old install, data and WebView2 roots before copying
package files. A durable transaction blocks normal startup, keeps the verified
legacy native origin reachable only for removal, and automatically asks the old
extension to clear its own storage and uninstall itself. Chrome gets a bounded
failure/reconnect window. If it refuses, Setup opens the connected profile's
Extensions page and asks for one explicit Remove click; loading another
developer-mode extension is not part of the normal workflow. Only then may
Setup run the verified old uninstaller and purge owned
desktop state. Clean desktop installation may finish with Chrome setup pending;
the transaction completes only when the current build presents a receipt created
by Chrome's genuine install lifecycle.

## Fresh maintenance staging — 0.20.28

Setup passes the unexpanded logical `{tmp}` destinations to Inno Setup's
`ExtractTemporaryFiles` matcher. The temporary coordinator is therefore
extracted before any old state is changed; packaging regression
coverage rejects expanding those match patterns to physical paths.

## Automatic Chrome removal — 0.20.29

- Fresh reinstall asks the connected old extension to clear its storage and
  remove itself; a successful removal does not require loading a verifier.
- If Chrome refuses automatic removal, Setup opens the connected profile's
  Extensions page and asks for one ordinary **Remove** click. **Reload** is
  never accepted as removal.
- Setup does not stage or display the former verifier extension or separate
  removal guide. A genuinely new installation receipt is still required
  before the desktop upload connection becomes ready.

## Bounded Fresh installer flow — 0.20.30

- The temporary coordinator has a bounded shutdown; confirmed Chrome removal
  cannot leave Setup waiting indefinitely on an empty Preparing page.
- Chrome removal instructions, progress, retry, and the one-click manual
  fallback appear on a native Setup page. The coordinator displays no separate
  instruction dialog.
- Automatic removal names its maximum wait. Manual fallback uses short bullets,
  opens the connected Chrome profile, and requires **Verify removal** before
  destructive desktop cleanup can begin.

## Non-blocking Chrome cleanup — 0.20.31

- The Chrome-removal page never expands `{app}` before Inno Setup initializes
  it; pre-install maintenance uses the selected wizard directory directly.
- The action button has dedicated width for **Remove extension**, **Check and
  continue**, and **Continue setup**, with the Back button repositioned so
  labels do not truncate or overlap.
- Setup accepts an existing verified checkpoint immediately. Otherwise it asks
  the connected extension or verifier for removal evidence, then uses a bounded
  absence check when the user confirms the extension is already gone.
- A missing Chrome confirmation cannot trap Setup. Explicit continuation records
  the unconfirmed result and proceeds; if a safe Fresh transaction could not be
  staged, Setup abandons only its maintenance journals, degrades to an in-place
  update, and preserves existing data.

## Atomic Fresh completion — 0.20.32

- Fresh reinstall suppresses the ordinary desktop launch until the clean package
  is finalized. Its single post-install launch opens Chrome setup directly.
- Desktop startup can safely and idempotently finalize a fully copied package
  from `OwnedStatePurged` or `CleanPackageInstalled`, serialized with the
  installer's finalizer so concurrent launches cannot move the journal backward.
- A `ChromeSetupPending` journal is rendered as **Finish Fresh reinstall**. It
  skips Chrome removal and desktop cleanup, preserves the clean package, and
  proceeds only to the remaining Chrome connection step.
- The completion page restores the native **Finish** label; custom Fresh-page
  labels and button sizing do not leak into other wizard pages.

## Retired Fresh maintenance checkpoint — 0.20.33

- Verifying the clean desktop package copies the Chrome reset journal into the
  installed data directory, then immediately completes and deletes the separate
  Fresh maintenance transaction and its source reset journal.
- Chrome admission remains enforced by the installed reset journal; it does not
  depend on retaining installer state until Chrome is configured.
- A legacy `ChromeSetupPending` transaction is silently excluded from Fresh
  resume detection. Setup presents its normal installed-product choices and
  launches only the remaining Chrome setup step after installation.
- Desktop startup safely retires any legacy `ChromeSetupPending` transaction,
  preventing old successful Fresh reinstalls from affecting future installers.

## CreatorWorkflow production draft — development check, 29 September 2026

- The native production handoff uses its own current-user named pipe. It does not extend the browser agent's allowlist or permit public WebView file-path requests.
- The catalogue and desktop suites passed 59/59 and 343/343 after adding version-4 draft persistence, local file hashing and path validation, idempotent retries, changed-source detection, refusal to bind a changed file, and a pipe round trip.
- The review window was rendered from the development build with illustrative data and shown to the owner before a versioned installer. Binding requires an explicit catalogue item and does not upload or publish.
- At that point the installed desktop was still the prior build. The installed-product checks follow below.

## CreatorWorkflow production draft — installed 0.20.84 check, 29 September 2026

- Version 0.20.84 advanced the coordinated desktop, native protocol, personal extension, and installer version. Lint, type checking, formatting, and the portable suite passed 530 tests with one intentional skip before staging. The skipped persistent Chromium lifecycle test passed after staging. Catalogue and desktop suites passed 59 and 343 tests; native tests passed 13. Windows packaging passed 14 tests with one stage-dependent skip, then the compiled installer recovery test passed against the staged package.
- The generic installer was built from commit `654bdd9` and copied to `dist/OFEnhancer-Setup-0.20.84.exe` (78,778,890 bytes, SHA-256 `4C46C2F8E7C767E03671BE616CC2E5B2845E9301EC00B9F652C17EED98258F4A`). A normal per-user update from the older installation succeeded; a second normal repair installed the commit-built package. The installed executable matches its staged binary and reports `0.20.84+654bdd9`. Existing settings bytes and catalogue item, asset, and binding counts were unchanged. The new production-handoff table had no rows before the live test.
- CreatorWorkflow's packaged 0.1.1 agent registered a generated one-second neutral MP4 and sent it to the running installed production pipe. OFEnhancer saved one unpublished `awaiting-review` draft with the expected file size and SHA-256, no catalogue item binding, and no change to existing catalogue counts. After the normal repair restarted OFEnhancer, CWT read back the same handoff ID and state; retrying preparation reused the ID. Computer Use listed a native **Production draft** window before and after restart.
- Computer Use initially denied window access. After the owner's direct instruction to retry, it opened the installed native review window. The window showed the synthetic episode/edit, `neutral-final.mp4`, and **Awaiting review**; **Bind files** was disabled without a selected catalogue item. Clicking **Reject** closed the window and moved the installed catalogue record and CWT operation to `rejected`, with a review timestamp and no bound item. Existing catalogue counts remained unchanged and no drafts remained pending. A real final-media handoff and **Bind files** still need direct acceptance; no upload or publication was attempted. Browser-authorized attachment remains a separate acceptance gate.

## Whole-codebase audit overhaul — installed 0.20.85 and 0.20.86 checks, 30 September 2026

- Every meaningful first-party source file (145 files, 58,656 lines) was reviewed; findings F01–F25 and leads L01–L03 from the audit register each received an evidence-backed disposition. Confirmed defects were fixed in 24 commits on top of `0978cc6`, each with a regression test recorded failing before the fix and an independent review that reran the suites and killed mutants. Disproved diagnoses (F25 series-preset loss, F13 marker ownership, F24 manual final click, L01 replay) were left unchanged.
- Persisted-format changes: preparation journal step ids gain `select-media1..8` and `attach-media1..8` (legacy ids keep their meaning; signatures and work hashes unchanged); social jobs gain `preparedComposerSha256`, `capturedAt`, `ledgerEvents` and `appended` (an X job prepared by an older version must be prepared again; a job captured but not fully appended stops for review and is never resubmitted); the extension stores a trace generation counter; Chrome-reset journal enums are validated strictly (every state written by 0.20.84 still loads). Wire changes: native admission of `resolveUploadThumbnail`; malformed browser replies settle as `invalid-browser-reply`; two new Apps Script error strings and one controller error code. The Apps Script change is verified against the fake sheet only and is not deployed by this repository.
- Behaviour to note: an interrupted Chrome reset completes through "Set up Chrome" instead of a status read; the catalogue dialog's Refresh is disabled during an upload; the follow tool stops a batch on a row mismatch; a blank ManyVids co-performer fails instead of picking the negative option; a genuine first installation no longer requires a previous package, while an existing, damaged, foreign or unlistable target still fails closed.
- Full gate on the 0.20.86 source, nothing else running: lint, type check, format, structure 10, packages 13, unit 314, browser 383 plus the fresh-reinstall lifecycle test rerun alone after staging (1/1), .NET 63 + 428, native 31, Windows packaging 18 (packaged GUI launch skipped because the installed desktop was running), staging, teaser host and installer builds. `dist/OFEnhancer-Setup-0.20.86.exe` is 78,788,792 bytes, SHA-256 `dec673ac731f47130ec753a58b580b20a0879790caf3c1582361746efd76b7c5`.
- 0.20.85 and then 0.20.86 were installed as silent normal updates (exit 0, logs under `.local/`, command in [development](development.md#release-and-normal-update-procedure)). Settings bytes, catalogue data files and credentials were unchanged; no pause marker was left; the desktop restarted from the install folder and reported the new version through the native bridge. The owner reloaded the existing extension entry. The live signed-in upload retest was not driven by the agent: its browser tool cannot act on extension pages or on the target site, so that step was handed to the owner as a bounded procedure ending at a prepared, unpublished draft.

## Normal update — installed 0.20.87 check, 30 September 2026

- Version 0.20.87 packages the ten `origin/main` fixes after 0.20.86 (`fd3babb`..`b6dc651`: settings serialization, workspace late polls, Fansly legacy preset, undelivered upload requests, Google write/sync failure reporting, installer manifest-less repair and drive-root refusal, Chrome setup fault naming, plain Google wording, preflight admission F17).
- Gate on the 0.20.87 source: lint, type check, format, portable suite 727 (726 pass, 1 stage-dependent skip), .NET 446 + 63, native 31, Windows packaging 18 (16 pass, 2 stage-dependent skips), teaser host and installer builds. The first `dotnet test` run failed with an MSBuild `OutOfMemoryException` because system commit headroom was exhausted (886 MB free virtual memory); after `dotnet build-server shutdown` the single-node rerun passed. The three stage-dependent tests passed when rerun after staging (3/3).
- `dist/OFEnhancer-Setup-0.20.87.exe` is 78,793,749 bytes, SHA-256 `e22badaa79a0b2023d7e819f5b925d4f6d30f2f54c353e666f656b64700e569f`; stage manifest SHA-256 `7ac8b251663458fddc04f54e41875584b71f1a1fbc42a4d0d4e4cf6cf5f2ce72`.
- Installed as a silent normal update (exit 0, `.local/OFEnhancer-0.20.87-install.log`). The installed desktop reports `0.20.87+b6dc651` and matches the staged binary; the desktop and native bridge restarted from the install folder. Settings, owned-root markers and Google client/token files were byte-identical before and after. Extension reload and a live upload retest were not performed by the agent.

## Upload console fixes — installed 0.20.88 check, 30 September 2026

- Owner-reported issues fixed in `990637d`: the frame picker reopens at the last chosen frame (seconds, crop and timeline window, reset when the full video or thumbnail changes); extra media chips sit beside **Add media**, truncated with a remove control, and the redundant platform hints are gone; extra media accepts audio (`.mp3`, `.m4a`, `.wav`, `.aac`, `.ogg`, `.flac`) alongside videos and PNG/JPEG images; the frame dialog's **Add frame at start** checkbox has a larger target and the sticky footer no longer sits under the timeline; category is carried through the local catalogue (schema v5, `catalogue_items.category`); clicking a similar catalogue entry binds its ID and fills title, description, category and Season/Arc; the button reads **Upload** until a field moves off the selected entry, then **Update & upload**, which writes only changed fields; an auto-match fills an empty description instead of blanking the sheet's; `catalogue-entry-missing` now re-imports the sheet and retries the same ID once, then returns `catalogue-entry-not-on-sheet`, clears the binding and asks for a new choice, never appending a row or matching by title.
- Two independent reviews accepted the candidate (mutations on the audio kind check, missing-row retry, explicit-click reset, category label comparison and auto-match description fill were killed). Owner approved the rendered media row; the checkbox and hint removal were rendered for review.
- Gate on the 0.20.88 source: lint, type check, format, portable suite 731 (730 pass, 1 stage-dependent skip), .NET 451 + 65 (single-node run), native 31, Windows packaging 18 (16 pass, 2 stage-dependent skips), teaser host and installer builds; the three stage-dependent tests passed after staging (3/3). `dist/OFEnhancer-Setup-0.20.88.exe` is 78,791,769 bytes, SHA-256 `082ffa46066e657902c305a3a5a558343c45728f17cac40fdb989159debb6a80`; stage manifest SHA-256 `67ceece7b6160471eb183d76c270ef10c49b19424ace841ff839ed27b5c4f668`.
- Installed as a silent normal update (exit 0, `.local/OFEnhancer-0.20.88-install.log`). The installed desktop reports `0.20.88+22b69bb`, matches the staged binary, and restarted with the native bridge from the install folder. Settings and Google client/token files were byte-identical. On first launch the catalogue migrated to schema version 5 after writing `catalogue.db.backup-v4-*`; all 137 items remain and category is empty until the next Google import. Live Google writes, the missing-row recovery against the real sheet, audio acceptance on OnlyFans/Fansly and the extension reload were not exercised by the agent.

## Upload console round two — installed 0.20.89 check, 1 October 2026

- Changes since 0.20.88: the description is a plain-text L-shape editor beside a fixed 16:9 thumbnail placeholder and is locked during runs; buttons are not text-selectable; similar-entry cards are updated in place instead of rebuilt on thumbnail changes; an explicit catalogue pick uses the sheet date (a past date prepares unscheduled posts and shows a history icon with a dimmed date; a future non-Friday moves to the next Friday with an info icon); each extra video sent to Fansly gets its own generated teaser as its free preview (`media{n}Teaser`, Fansly only); manual-mode OnlyFans/Fansly preparations passively watch the prepared tab for the owner's own publish and commit the post link to the catalogue (`awaiting-manual-publish`, 6-hour cap, same tab/document/watch id, first successful post only); the recovery notice rechecks automatically when the desktop-hosted browser connects and keeps Upload disabled until a check succeeds; the Chrome connection is one header pill that keeps the browser switch visible whenever more than one browser is live.
- Built in four isolated lanes and integrated on main, then independently reviewed: the integrated candidate (REWORK for the unlocked editor, fixed), the polish delta (REWORK for the hidden browser switch, fixed) and each fix (ACCEPT). Mutations on link-capture identity guards, the Fansly-only teaser role, editor locking, recovery guards and the browser-switch condition were killed. The owner reviewed the rendered upload screen, past-date indicator, recovery notice and header pill.
- Gate on the 0.20.89 source: lint, type check, format, portable suite 762 (761 pass, 1 stage-dependent skip), .NET 452 + 65, native 31, Windows packaging 18 (16 pass, 2 stage-dependent skips), teaser host and installer builds. After staging, the fresh-reinstall lifecycle test passed and one installer-recovery case failed once (uninstaller absent right after compile) and passed on an isolated rerun (2/2); recorded as intermittent. `dist/OFEnhancer-Setup-0.20.89.exe` is 78,799,148 bytes, SHA-256 `4ea997d35c06b315915cdbcc7eb3ba85aa9cd29d7f5d18fd1f8b8ddda20f2198`; stage manifest SHA-256 `3dac0796df1e8e5e80101baff1b9a38898b816ab94f950d21e2ad652b2b9a379`.
- Installed as a silent normal update (exit 0, `.local/OFEnhancer-0.20.89-install.log`). The installed desktop reports `0.20.89+6505c0e`, matches the staged binary, and restarted with the native bridge. Settings and Google client/token files were byte-identical. Live manual-publish link capture, Fansly previews on extra videos, audio extras on the platforms and the extension reload were not exercised by the agent.

## Automatic X first reply — owner live check required

Source, fixture and real-Chrome tests do not establish the live X composer
behaviour, so `CreatorXFirstReplyEvidence.liveCheck` is empty and **Auto first
reply** defaults to off ("needs one live check"). One real reply, by the owner:

1. With the desktop running and the extension reloaded, post a teaser (or use one
   posted within 24 hours) whose catalogue row links it in `Twitter Teaser(s)`
   and holds the canonical OnlyFans link, with no reply yet. Open the own X
   profile once so the collector records it.
2. In the extension settings, turn on **Auto first reply**. Within five minutes
   of the due time (15–60 minutes after posting, or at once when already past) a
   background tab opens the teaser, replies and closes.
3. On X, confirm exactly one owner reply reading the variant, a new line and
   `-> <link>`, with no link card. The settings log should show
   `posted reply <id>`.
4. Record `tests/fixtures/social-traces/x-first-reply.json` with no account
   data, for example
   `{"schemaVersion":1,"platform":"X","flow":"automatic-first-reply","outcome":"posted","cardAbsentOnX":true,"checkedOn":"YYYY-MM-DD"}`,
   and set `liveCheck` to the SHA-256 of that file's bytes. The default then
   becomes on.

Any other logged outcome (`card-not-removed`, `mismatch`, `unconfirmed`) or
a visible card on the posted reply fails the check: turn the setting off and keep
the log.

## X collector — installed 0.20.90 check, 1 October 2026

- 0.20.90 adds passive collection of the owner's own X posts and metrics (`699ead8`, `0f9d34a`): a document-start page script on x.com reads copies of allowlisted X timeline/detail responses, keeps only the signed-in owner's posts, and hands batches to the extension over a private MessageChannel port; a page-reading fallback takes only the outer post (quoted cards excluded). The desktop stores posts and dated metric samples through the new `recordXObservations` operation (Migration 6: `x_owner`, `x_posts`, `x_metric_samples`); other accounts are refused. Nothing is clicked, typed or scrolled by the collector.
- Independently reviewed twice (REWORK for quoted-card leakage in the page-reading fallback and for a readable batch nonce, then ACCEPT); mutations on response passthrough, owner filters, port lock, sender check, ambiguity guard and desktop validation were killed.
- Gate on the 0.20.90 source: lint, type check, format, portable suite 779 (778 pass, 1 stage-dependent skip), .NET 454 + 72, native 31, Windows packaging 18 (16 pass, 2 stage-dependent skips), teaser host and installer builds; the three stage-dependent tests passed after staging. `dist/OFEnhancer-Setup-0.20.90.exe` is 78,820,741 bytes, SHA-256 `edad501f37672c0f30a83f811b9ad7f25f0889422630b2db35e7cd6809c42988`; stage manifest SHA-256 `79a4d4205740e2b9e24d871340c5991a729e80fd9080fb32a7c6b37644db3a0c`.
- Installed as a silent normal update (exit 0, `.local/OFEnhancer-0.20.90-install.log`). The installed desktop reports `0.20.90+785bdfe` and matches the staged binary; the catalogue migrated to version 6 after writing `catalogue.db.backup-v5-*`. Settings and Google client/token files were byte-identical. Live collection on x.com awaits the extension reload.
