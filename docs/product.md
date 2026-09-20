# Product contract

This document owns intended behavior and capability status for the current source.
It is not a roadmap execution plan or evidence of live-account acceptance.
[Architecture](architecture.md) explains ownership; [acceptance](acceptance.md)
explains the evidence required before expanding automation.

## Interaction and safety

OFEnhancer prepares one exact plan and asks for one **Yes** before its authorized
mutations. The plan identifies files, catalogue item, targets, captions, saved
recipes, timing, and allowed catalogue effects. Changing those inputs invalidates
the plan. A new public attempt, deletion, or repost needs new authorization; an
unknown previous outcome is not permission to try again.

Uncertainty stops rather than guesses. Missing/ambiguous controls, changed page
identity, stale catalogue fingerprints, unresolved submission, and conflicting
links must remain visible. A failed target does not roll back or repeat a
successful sibling. Resumption continues only unfinished, still-authorized work.
Persist/read back an irreversible attempt checkpoint immediately before a final
control. Main X post and first reply have separate checkpoints. Recovery after an
attempt observes and reconciles; it cannot click the final control again.

Authenticated website actions remain in the user's signed-in Chrome context.
Do not export cookies, credentials, authorization headers, or request bodies,
replay private platform APIs outside that context, or make the desktop WebView a
second signed-in publishing browser. Local media stays private except for the
selected platform upload and expressly configured local audit. Neither a
filename nor a convenient default is permission to publish or bind identity.

## Current capabilities

| Surface                               | Implemented boundary                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal identity mask                | Persistent local pseudonyms; generated, local-pack, and optional remote-avatar modes; safe current/retired picture management                                                                                                                                                                            |
| Store identity mask                   | Explicit consent before enabling, generated/local-pack avatars, narrow OnlyFans display-only scope; no workflow, remote-avatar, debugger, or native-host code                                                                                                                                            |
| Windows workspace                     | Tray/single-user agent; real local catalogue and thumbnails; Google connection/import/sync controls; selected-Chrome connection and shared uploader UI                                                                                                                                                   |
| Desktop upload transport              | Authorized browser command/file channel and local upload result recording. The extension still owns browser execution and monotonic checkpoints; local recording is not a claim of Google synchronization                                                                                                |
| OnlyFans / Fansly / ManyVids uploader | Trace-grounded field/file preparation and final-submit paths, exact identity/readback, independent outcomes, and protected catalogue commits                                                                                                                                                             |
| Pornhub uploader                      | Activates the uploader, assigns the approved full/Pornhub file once, applies the selected metadata preset and verifies the title. Scheduling, final submission, and result capture remain manual                                                                                                         |
| X distributor                         | Traced main-post and paid-link first-reply phases. Manual mode stops before final controls; authorized autonomous phases require separate durable attempt checkpoints                                                                                                                                    |
| Redgifs / Reddit                      | Manual draft preparation is implemented. Redgifs selects the exact upload file input; Reddit prepares title and inserts a verified canonical Redgifs link into the exact empty link editor. Required remaining fields and publication are manual. Autonomous publishing remains trace-gated and disabled |
| X teaser recorder                     | Explicit file/catalogue pairing, semantic status capture, ordered local audit → catalogue append → receipt-protected Done move; separate from autonomous publication                                                                                                                                     |
| Supporting helpers                    | Exact C4S/Sheer metadata helpers, capped OnlyFans follow/list selection, local Reddit banner censor, and on-demand sanitized trace recorder                                                                                                                                                              |

The adapter and registry source own exact selectors, normalized default recipes,
and limits. Tests exercise those contracts with fixtures; external websites may
change. Do not describe a package build or fixture test as successful live posting.

## Publishing details that must survive refactoring

The catalogue description is the base caption. Fansly adds the configured block
once, applies the reviewed toggles, locks full media with the reviewed first or explicitly selected preset,
and uses the shared teaser through **Add Free Preview**. OnlyFans labels remain
unchanged. Friday scheduling is **15:00 UTC**. Fansly and ManyVids read the timezone displayed by their scheduling UI; OnlyFans uses the approved draft timezone and requires separate live verification of that UI representation. A verified common empty Friday is required when the selected flow
claims queue verification. Unknown queue availability is not inferred as free.

ManyVids uses the saved normalized profile, including its exact ten tags, price,
modes, and time. Upload observation can continue beyond 45 minutes; only progress in the owned upload scope can establish a stall. Resume only the proven
video's editor through the recorded Edit action and its first verified navigation. Its final Save remains a single attempt. Returning to the upload page does not prove acceptance; an unverified Save stays unresolved and cannot be repeated. Source defaults are not
an independently maintained product table.

The optional Pornhub video falls back to the full video, never the teaser. The
creator selects one exact content preset. Only a creator-confirmed exact
Season/Arc mapping may preselect it; never infer orientation from performers,
titles, filenames, descriptions, or tags. Existing metadata is preserved while
missing exact tags/categories are added. Title readback follows the preset. The file bridge supports the Pornhub role and only its approved uploader origin. A preparation result is not publication success.

The manual Redgifs/Reddit preparation adapter reflects the observed composers of
September 8, 2026. That observation is not a complete successful publishing
trace. Reddit verifies the title hash again before link insertion and refuses
nonempty changed fields. The accepted X trace includes OnlyFans preview-card
dismissal before the first reply; ambiguous dismissal stops. X scheduling remains
manual because the recorded six select controls are not semantically identified.

Trace-gated platform runtime flags and hashes live in
[the evidence registry](../extensions/personal/workflows/social-trace-evidence.js).
The sanitized X fixtures preserve the successful-flow evidence without private
media or development captures. No flags should be enabled merely to make the
interface appear complete.

## Catalogue and local media

Catalogue identity is stable, explicit, and independent of row position. An
existing verified binding or hash can establish identity; title, filename, date,
and episode similarities only rank bounded candidates. They cannot silently
choose a row. A strong proposal still needs the creator's Yes; ambiguity opens
the searchable picker. Re-read row/identity/profile fingerprints before mutation.
Never overwrite a different existing platform link; an identical canonical link
is idempotent. Per-platform results and reconciliation remain independent.

The desktop is the local SQLite writer. Import is bounded, transactional, and
keeps missing remote rows as archived rather than silently deleting history.
Local thumbnail indexing reads supported PNG/JPEG/WebP files from a picked root,
uses stable opaque IDs, and rejects path/reparse escapes. It does not alter media
or implement perceptual matching. Disconnecting Google preserves local data,
history, and pending work. Google operation/recovery semantics are owned by
[Google catalogue](google-catalogue.md).

## Accessibility, privacy, and lifecycle

Chrome readiness separates desktop-agent availability, standard-path Chrome
discovery, effective personal identity and exact native registration, fresh
identity-matched relay exchanges, and upload-browser selection. A successful
launch or setup preparation is not a connection. A single live unselected browser
can establish integration liveness; multiple live browsers require explicit
selection before upload work. Observing status neither selects a browser nor
queues work. Ten-second expiry and check failures remove current green status.
The relay check does not establish separate X-host or publishing-workflow health.

Fresh personal setup prepares the installed keyed package and owned current-user
registration. The user still enables Developer mode, chooses Load unpacked, and
selects the displayed folder in Chrome. Setup never edits Chrome profiles or
force-install policy. The Start-menu connection shortcut opens the same desktop
setup experience. Legacy keyless packages retain their original load location;
unknown legacy identity/location evidence stops repair rather than migrating
Chrome storage. Catalogue JSON import is independent of Chrome and Google setup.

Use native keyboard-operable controls, visible focus, readable status and errors,
reduced-motion support, and usable desktop/compact/390-pixel layouts. Picture
management exposes masked labels only, not real account keys. A current avatar
cannot be re-enabled as retired; release a retired blocker only when no other
current/retired assignment still references it. Missing images have a fallback.
Do not replace real connection/catalogue states with sample success or fake rows.

Update/repair and ordinary reinstall preserve catalogue, settings, history, and local credentials.
Fresh reinstall deliberately removes all safely identified OFEnhancer-owned desktop state and caches.
Interactive uninstall offers explicit removal of the dedicated user-data folder;
silent uninstall preserves it. No Chrome profiles or enterprise policy are edited,
and no unpacked extension is silently enabled. Notification text must remain
neutral: **OFEnhancer needs attention**, not a title, account, path, or caption.

## Deferred product intent — not implemented capability

The following intent is retained so it is not mistaken for discarded scope:

- A local media engine with reproducible teaser, `_33` 640×360 and `_4K` badge
  recipes; an audited LGPL-compatible FFmpeg distribution; validated/hash-checked
  temporary output and atomic no-overwrite completion. Automated media creation,
  perceptual matching, and the full cross-platform variant pipeline are not present.
- Complete Pornhub free/paid and C4S variant automation, edit-existing-thumbnail
  operations, Redgifs/Reddit autonomous publishing, and expired-subscriber outreach
  each require fresh successful traces and their own acceptance. Outreach must
  never repeat a recipient; keyed recipient identity stays local and only aggregates
  belong in the sheet. Existing list-selection/follow helpers are not outreach.
- Monitoring, scheduling orchestration, performance analysis, and replacement
  suggestions are not a completed system. Intended comparisons use common-age
  24h/72h/7d/30d measurements and meaningful own-history cohorts of at least ten.
  X/Reddit teaser counts mean unique teaser assets, not raw post count. Replacement
  history is append-only; underperformance does not itself authorize deletion or
  reposting. Unreliable freshness requires explicit manual refresh, not guessed data.
- Public desktop distribution requires signed/timestamped releases and verified
  installation. A self-update channel is deferred until signed release metadata
  and its trust/recovery policy exist.

These statements preserve product direction, not permission to fill evidence gaps
or remove current safeguards. No unresolved public-platform trace is silently
promoted to a tested implementation.

## Development template and fresh drafts

The personal Upload Console has one **Dev · Load Template** action. It loads
`neutral-full.mp4`, `neutral-teaser.mp4` and `neutral-thumbnail-valid.png`
from the fixed development fixture root
`F:\WORK\Creations\OFEnhancer\.local\upload-test-media`.
No folder selection is required. The desktop validates the exact names, content
headers, non-empty bounded sizes and unmodified metadata, and issues in-memory
opaque capabilities. The video remains on disk: JavaScript receives descriptors,
not multi-gigabyte blobs or absolute paths. The existing bound native file
attacher delivers it. Ordinary selected File objects still use the normal path.
Neither the control nor its fixture contract is included in the store edition.

The template fills neutral title/description, all four main-video destinations
and the next Friday at 15:00 UTC. It locks manual preparation and skips catalogue
association. Saved captions, tags and categories cannot leak into the neutral
draft; existing pricing/access settings and saved presets are unchanged.
Loading does not start uploading. Review and confirm the plan separately.

**Draft actions → Start a new draft** clears the form after a settled run and
leaves neutral mode. Remote uploads and recovery/publication evidence remain.
An active run or unresolved file request prevents replacing the draft.

## Normal update versus Fresh reset

A normal update keeps the Chrome extension, its identity and settings. Reload
Creator Workflow Toolkit after installing an update. A version mismatch never
counts as a working upload connection. Existing uncertainty and final-action
evidence remain available for duplicate prevention.

**Fresh reset** in Chrome setup creates a durable extension-only reset barrier. The connected personal extension clears only
its own Chrome storage and requests supported self-uninstall. If the old build
cannot receive or perform the request, Chrome setup requires manual removal of
Creator Workflow Toolkit and identifies the exact old ID. Load the displayed
`extension-keyed` folder afterward. Reloading or a saved extension ID cannot
complete a reset. OFEnhancer allows Chrome's removal call a bounded failure and
reconnect window; only then does a successful self-removal or explicit manual
Remove confirmation open the barrier. Completion still requires a
current-version genuine-install receipt and a new matching exchange. Pre-reset receipts
remain rejected after desktop restarts. Interrupted resets remain pending.

Fresh reset keeps the catalogue, Google configuration, desktop settings, upload
history and other application data. **Fresh reinstall** uses the same verified
Chrome-removal gate, then uninstalls the old package, purges owned settings,
catalogue, credentials, checkpoints, WebView2 data and obsolete installed files,
and installs clean files. An interruption resumes from its durable transaction;
ordinary startup cannot reopen old state. No Chrome Preferences, Secure Preferences, extension
databases, enterprise policies or other browser profile internals are edited.
