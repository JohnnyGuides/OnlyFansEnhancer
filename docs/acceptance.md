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

## Fresh reinstall lifecycle — 0.20.27

Fresh reinstall is distinct from Fresh reset. Setup stages its maintenance
coordinator and temporary verifier outside the old install, data and WebView2
roots before copying package files. A durable transaction blocks normal startup,
keeps the verified legacy native origin reachable only for removal, records
bounded removal failures and retries them without Reload, and accepts absence
only from the same-profile verifier using `management.getAll` plus uninstall
events. Only then may Setup run the verified old uninstaller and purge owned
desktop state. Clean desktop installation may finish with Chrome setup pending;
the transaction completes only when the current build presents a receipt created
by Chrome's genuine install lifecycle.
