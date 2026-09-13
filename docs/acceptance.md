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
Fansly, inspect full-media lock `defaulT`, Add Free Preview, exact caption/toggles,
and the reviewed local representation of 15:00 UTC. For ManyVids, verify the exact
uploaded video identity, full-upload/editor transition, profile values and single
Save boundary; don't resume another video's editor. Pornhub remains metadata
preparation with its file/title/schedule/submit/result boundaries manual.

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
