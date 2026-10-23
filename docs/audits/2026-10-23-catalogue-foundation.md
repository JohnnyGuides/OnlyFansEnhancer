# Catalogue foundation audit — 23 October 2026

Completed read-only logic review, including an independent Claude Opus 5.5 review
and a separate adversarial refutation pass. This is an audit, not a release or live
publishing acceptance result.

## What this repo does

OFEnhancer is a personal Windows/Chrome workspace that imports a creator's catalogue,
prepares and publishes selected uploads, records some publication results, and collects
the owner's X posts and metrics. This review assumes one owner, several platform tabs,
background Chrome workers, occasional offline periods, restarts and manual site actions.

The acceptance standard is the owner's clarified goal: **the catalogue is the heart
and brains of the operation**. Uploads, edits, media, schedules, scans, analysis and
distribution relationships must become accurate catalogue records and synchronize
without silent gaps. Existing features and documentation do not establish that this
complete standard has been met.

Audited source: `e2190ef5f7c4f3ef1326d0010ee906595b8ccef6`, implementation version
`0.20.128`. A clean committed source archive was used because the primary checkout
contains preserved, unrelated version-only edits to `0.20.108`. No production code,
installed integration, provider data or publishing settings were changed by this audit.

## Current authority and update map

There is a central local database, but the operational record is distributed across
several stores and write paths. Those paths have different completion rules.

| Activity                                  | Existing record and update path                                                                                | Important limit                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Google catalogue import/matching          | Adaptive header reader → transactional SQLite projection; local publication evidence is overlaid               | Read-only import does not configure reviewed sheet sync; no general periodic inbound pull                  |
| Main OnlyFans/Fansly/ManyVids upload      | Browser workflow → observed receipt → local upload-result audit event → optional upload-sheet-writeback intent | Receipt identity, readiness and backfill gaps described below                                              |
| Pornhub upload                            | Preparation; final submit/result capture remain manual                                                         | Not equivalent to the automated result/writeback path                                                      |
| X calendar teaser                         | Browser IndexedDB draft + Chrome durable social job; local calendar stores date/source/clip                    | Pending destination, wording and execution state are not complete central catalogue records                |
| X discovery/metrics                       | Owner-only collector → SQLite observations, metrics, derived bindings → separate teaser sheet appender         | Destination links can be misused as source evidence; bounded scans do not prove complete account coverage  |
| Reddit/Redgifs                            | Manual draft/link handoff, with limited saved execution evidence                                               | Autonomous publishing, general metrics and full Google writeback are not implemented                       |
| Local media/production edits              | Thumbnail inventory, X clip library, edit settings and production handoff tables                               | These are separate partial records, not a complete versioned media/publication lifecycle                   |
| Edits made later on a platform            | No general cross-site edit/deletion reconciliation collector                                                   | A title/link/status changed outside a watched workflow is not universally reflected back                   |
| Generic reviewed Google projection outbox | Validated pending/attempted/completed/conflict states                                                          | No automatic production caller of `EnqueueProjection`; its existence is not full catalogue synchronization |
| Optional Apps Script bridge               | Separately deployed fixed-layout Google writer                                                                 | Independent implementation/deployment; a desktop build does not update the live script                     |

Implementation anchors: `docs/architecture.md:25`, `:100`, `:132`, `:259`;
`docs/product.md:77`, `:280`, `:433`; `docs/google-catalogue.md:180`, `:309`;
`desktop/OFEnhancer.Catalogue/SyncOutbox.cs:316`;
`desktop/OFEnhancer.Catalogue/ProductionHandoffs.cs:81`.

## Must fix for catalogue integrity and workflow correctness

### 1. A reply destination can become the teaser's source video

**What this is:** X discovery tries to associate observed teasers with catalogue videos.

**Problem:** If a teaser from A replies with B's paid-post URL, and no stronger source
sheet link or owner mapping exists, `RefreshXBindings` can bind the teaser to B. The
automatic teaser writer can then append that X URL to B's source teaser cell, reinforcing
the incorrect ownership. One binding cannot represent both content source and referral.

**Evidence:** `desktop/OFEnhancer.Catalogue/XBindings.cs:48`, `:73`, `:95`;
`desktop/OFEnhancer.Catalogue/XSheetWriteback.cs:70`;
`desktop/OFEnhancer.Catalogue/XTeaserOverview.cs:97`.
An isolated public-API reproduction returned source `episode-b`, evidence `reply-link`,
and a sheet writeback candidate for B, although the test's content source was A.
Explicit source mappings and conflict rejection are real safeguards; they do not make
destination-only inference proof of content origin.

Opus identified the escalation, and the primary reproduced it: once the inferred
link is appended and re-imported, its evidence becomes `sheet-link`. An explicit
attempt to map it to A is then refused as `mapping-link-conflict`
(`desktop/OFEnhancer.Catalogue/XOwnerMappings.cs:29`). The app can turn its own
inference into stronger apparent evidence that obstructs correction.

**Fix:** Stop automatic source-sheet writes based only on `reply-link` inference.
Retain a source relationship and a separate promoted-destination relationship on the
same publication. Source A owns its teaser; B exposes it under other-episode incoming
X posts. Preserve planned/observed destinations and provenance for app-written sheet
links, so app-generated inferences can be corrected safely.

**If skipped:** Counts, history, matching and Google teaser cells can attribute a
publication to the wrong video. Excluding foreign authors does not solve this: these
are the owner's own posts promoting a different catalogue episode.

### 2. A manual publication watch can capture another post from the same tab

**What this is:** The app watches a prepared OnlyFans/Fansly document for a manual
successful post so it can record the resulting URL.

**Problem:** The observer verifies origin/document, endpoint and post-arm timing, but
does not establish that the accepted request/result belongs to the prepared media/draft.
A different post submitted in that same document during the six-hour watch can supply
the URL recorded against the original catalogue item.

**Evidence:** `extensions/personal/workflows/upload-response-observer.js:197`, `:233`,
`:366`; `extensions/personal/background.js:6891`.
An isolated VM reproduction armed a watch, submitted unrelated title/media to the same
allowed post endpoint, and observed `captured` with that unrelated post's canonical URL.
ManyVids adds an exact video-ID check; duplicate receipts and foreign documents are
already guarded. The reproduction establishes the OnlyFans case; Fansly shares the
identity gap in source, but was not separately reproduced.

**Fix:** Bind acceptance to minimal verified draft/media identity. When the site cannot
provide sufficient evidence, retain an unresolved result for review. Preserve privacy
limits: do not export full request bodies, cookies or credentials to implement the proof.

**If skipped:** A technically valid URL can be written to the wrong catalogue video.

### 3. Reconnect clears sync configuration; pre-sync results have no automatic backfill

**What this is:** Locally recorded publication results should eventually reach the
chosen Google catalogue when synchronization becomes available.

**Problem:** Every completed OAuth connection calls `SaveWorkbook`, including a
reconnection to the same workbook. That clears selected sheet/profile/readiness keys.
Existing pending intents survive but cannot run until setup is re-established. This
contradicts the recovery documentation's promise to preserve the chosen sheet.

A workbook-only/read-only connection has no selected profile sheet ID.
`RecordUploadResult` then stores the local publication without an upload-writeback intent.
Later reviewed sync setup does not reconstruct the missing intent. The background
writer only replays existing intents, and normal result UI excludes `recorded-local`
from retry. Read-only import is intentionally separate from reviewed sync; missing
eventual backfill is an unmet owner requirement, not loss of the local proof.

**Evidence:** `desktop/OFEnhancer.Catalogue/UploadCatalogue.cs:96`, `:131`;
`desktop/OFEnhancer.Catalogue/UploadSheetWriteback.cs:40`;
`desktop/OFEnhancer.Desktop/GoogleCatalogueController.cs:425`, `:526`, `:539`, `:941`;
`extensions/personal/upload-console.js:3630`.
An isolated public-API reproduction recorded a result before profile setup, enabled
the profile afterward and still found zero writeback intents. A later sheet pull
preserved the local URL. Another assertion confirmed saving the same workbook again
clears its existing sheet selection and Ready state. Read-only inspection of the current installed database
confirmed workbook selected, no worksheet/profile selected and sync not ready; no
upload-result events existed at that observation, so this audit does not allege an
already-lost real upload.

Opus found a limited repair path the initial diagnosis missed: re-associating a
still-loadable saved upload session can re-record its URL; the idempotent branch queues
an intent after setup. This is not automatic backfill, does not cover every historical
event and is subject to the association bugs below. New-row creation is also refused
while reviewed sync is Ready (`GoogleCatalogueController.cs:481`). Simply enabling
that mode does not complete the new-video lifecycle.

**Fix:** Preserve/revalidate the same-workbook destination on reauthorization without
silently restoring permission to mutate it. Preserve pending synchronization work
before its destination is configured. Provide safe owner-reviewed backfill and resolve
the new-row/readiness incompatibility. Keep read-only import and migration consent distinct.

**If skipped:** Uploads can remain local indefinitely even after the owner later enables
Google sync. “Connected” cannot serve as proof that all catalogue updates will follow.

### 4. Frozen physical row numbers can block a valid publication result

**What this is:** An approved run freezes a catalogue row and fingerprint.

**Problem:** Receipt recording requires the original physical row number as well
as stable identity. Sorting or inserting rows during a long upload/manual watch can
make the later accepted receipt return `stale` before catalogue recording. Normal
association also rejects the moved row. Social append retries can retain an old
whole-row fingerprint after another teaser changes the row.

**Evidence:** `desktop/OFEnhancer.Catalogue/UploadCatalogue.cs:100`, `:116`, `:221`;
`extensions/personal/background.js:5146`, `:7154`;
`extensions/personal/workflows/social-distribution-orchestrator.js:265`.
A public-API reproduction moved row 2 to row 3 with the same item ID, then recorded
the original receipt: `stale`, no replacement fingerprint and no local platform link.
The browser can still retain its receipt; every copy is not necessarily lost.
Value-only staleness on an unchanged row can return a fingerprint that main-upload
retries adopt; that narrower case is protected.

**Fix:** Resolve receipt ownership by stable item/source identity. Re-read current
row location and the permitted destination. Preserve the receipt even if applying it
needs review; retain pre-publication stale-plan guards.

**If skipped:** A harmless sheet sort can strand a real publication outside the catalogue.

### 5. Local evidence can masquerade as Google synchronization evidence

**What this is:** Local publication evidence is overlaid on imported catalogue rows.

**Problem:** X writeback checks that merged row to decide whether its URL is already
in Google. An owner mapping adds a local `owner-x-link` event, so the link is excluded
from sheet writeback even though it was absent from the imported Google cell.

**Evidence:** `desktop/OFEnhancer.Catalogue/XOwnerMappings.cs:43`;
`desktop/OFEnhancer.Catalogue/UploadCatalogue.cs:140`;
`desktop/OFEnhancer.Catalogue/XSheetWriteback.cs:80`.
A public-API reproduction imported an empty X cell and applied an owner mapping:
the URL was recorded locally, but there were zero sheet candidates. Mapping itself
is preserved correctly and no upload event is fabricated.

**Fix:** Keep imported-sheet evidence distinct from local publication evidence.
Determine Google completion from the imported cell or verified remote receipt,
not the merged display view.

**If skipped:** Successfully recording a fact locally can suppress its synchronization.

### 6. Apps Script can reuse an occupied social-link row for a new video

**What this is:** The optional bridge finds an empty catalogue row for a new entry.

**Problem:** It reads A:T but calculates `empty` from A:L only. A row containing just an
X link in O or Reddit data in T can be selected for an unrelated new item. The bridge
adds the new ID/title while retaining the old social evidence on that row.

**Evidence:** `integrations/google-apps-script/catalogue-bridge.gs:189`, `:205`, `:266`,
`:480`, `:500`; existing category-only protection is tested in
`tests/extension/publishing-workflow.test.cjs:1918`.
An assertion-based synthetic execution selected a row containing an old X link, then
committed a new identity while retaining that link. The deployed script version was
not inspected; this finding applies to the committed bridge implementation.

**Fix:** Decide emptiness using all consumed fields/columns; add O-only and T-only cases.

**If skipped:** The sheet can falsely associate old social posts with a newly created video.

### 7. A completed publication blocks an explicitly confirmed repeat upload

**What this is:** The durable action journal prevents accidental repeated submissions.

**Problem:** `assertAvailable` rejects a matching item/platform even when the old record
has a canonical receipt, status `catalogue-updated`, and the new run explicitly confirms
a repeat. The journal does not distinguish a completed, reconciled publication from
an uncertain attempt for admission to a new authorized run.

**Evidence:** `extensions/personal/workflows/upload-session-store.js:96`, `:133`, `:151`;
`extensions/personal/background.js:4724`.
An isolated reproduction retained the successful receipt and rejected the next
explicitly confirmed run with `upload-publication-recovery-required`.

Opus also identified the finite lifetime limit: the journal refuses new entries at
200 records, with no completion/supersession route (`upload-session-store.js:196`).
This branch was source-verified, not filled to capacity in the reproduction. The
journal applies to autonomous final actions and the ManyVids save path; manual-watch
capture does not generally create these action records.

**Fix:** Keep unknown attempts blocked. Allow a new distinct, explicitly authorized
repeat after the previous result is reconciled, retaining both publication records.

**If skipped:** A legitimate later upload of the same catalogue item can remain blocked
behind a recovery message for an already completed publication.

## Should fix for visible and recoverable synchronization

### 8. Equivalent OnlyFans URL forms can create a false conflict

**What this is:** A post can have a numeric URL with or without a handle suffix.

**Problem:** Recording and Google writing recognize the same post ID, but the local
overlay deduplicates exact strings. Recorded `/123456789/johnny_guides` plus the
sheet's `/123456789` becomes `local-link-conflict` and blocks subsequent operations.

**Evidence:** `desktop/OFEnhancer.Catalogue/UploadCatalogue.cs:108`, `:164`;
`desktop/OFEnhancer.Desktop/GoogleTeaserLinkWriter.cs:41`.
The primary reproduced those two forms producing publication state `review`.

**Fix:** Compare a shared platform/post-identity key and preserve original source text.

**If skipped:** A valid, unchanged publication can look like conflicting evidence.

### 9. Association and writeback conflicts lack a complete recovery surface

**What this is:** Saved uploads can be associated with a catalogue item, and background
writeback preserves pending or conflicting outcomes.

**Problem:** The association UI ignores returned per-platform outcomes and always
shows “Association saved.” This can hide more than a Google delay: a `stale` or
`conflict` return exits before the local publication event is inserted
(`UploadCatalogue.cs:106`, `:116`, `:119`). The association handler also drops
`googleError` from its summary. Separately, a pending writeback whose title/description
changed can become terminal `conflict`, disappear from automatic retry selection and
remain outside the Google panel's generic outbox counts.

**Evidence:** `extensions/personal/upload-console.js:6566`, `:6583`;
`extensions/personal/background.js:7165`;
`desktop/OFEnhancer.Desktop/GoogleTeaserLinkWriter.cs:64`;
`desktop/OFEnhancer.Desktop/GoogleCatalogueController.cs:586`, `:1028`;
`desktop/OFEnhancer.Catalogue/UploadSheetWriteback.cs:40`.
These visibility/recovery paths were traced in source, not reproduced end to end.
Refusing stale metadata or an uncertain write is a valid safeguard and must remain.

The title check also precedes the already-present-link check. Even a link the owner
has already inserted can remain conflicted after a title edit. Re-recording returns
the existing same-key intent; it does not create an automatically rebased one.

**Fix:** Expose each effect as local-only, pending, conflicted or verified in Google.
Provide safe review/rebase for never-attempted work and read-only reconciliation for
already-attempted work. Local recording must not look equivalent to verified synchronization.

**If skipped:** Work can remain stuck or absent from the central record while the
owner sees an apparently completed association with no clear repair action.

### 10. Calendar publication does not complete the local clip lifecycle

**What this is:** Teaser files have ready/posted/verdict states used for reuse and rotation.

**Problem:** A calendar run knows its media but does not centrally commit the exact
clip-to-status relation. The library lists root-folder clips as ready, and time-window
pairing explicitly excludes ready clips. A calendar-posted clip can remain offered
as ready and miss its posted/verdict lifecycle.

**Evidence:** `desktop/OFEnhancer.Catalogue/XTeaserLibrary.cs:13`;
`desktop/OFEnhancer.Catalogue/XTeaserClips.cs:235`;
`extensions/personal/workflows/social-distribution-orchestrator.js:656`.
This was source-traced; no real publication or filesystem-move reproduction was run.

**Fix:** Commit the verified run's exact clip identity/hash and actual status to the
catalogue. Exclude proven posted artifacts from ready selection; preserve original
files and existing logged, undoable move rules.

**If skipped:** Ready counts and later rotation/analysis can disagree with actual posting.

### 11. Per-teaser intent is split between the browser and a second reply engine

**What this is:** The calendar editor and catalogue-driven discovery worker both support
automatic first replies, using a shared reservation policy.

**Problem:** The normal editor persists the selected fallback URL and frozen wording,
but pending draft/target/reply intent is not a complete catalogue record. The separate
worker derives a single canonical OnlyFans post URL from its bound row and cannot
consume every profile/Fansly/alternate-video target exposed by the editor.

**Evidence:** `shared/workspace/teaser-draft-store.js:143`;
`extensions/personal/workflows/social-distribution-session-store.js:135`;
`desktop/OFEnhancer.Catalogue/XTeaserReplyQueue.cs:63`;
`extensions/personal/workflows/x-first-reply.js:48`;
`extensions/personal/workflows/x-reply-policy.js:122`.
Shared reservations protect editor-owned jobs and let the editor replace an unattempted
scanner reservation. A blanket claim that closing the editor loses/overrides its
fallback is false: targeted recovery tests pass. Opus rejected the proposed generic
worker race as a defect: ownership checks fail safely, and a reply-less post needs
separate sheet/owner evidence before entering that worker. Missing shared catalogue
intent remains a capability gap; it is not evidence of duplicate replies.

**Fix:** Make one durable per-publication intent available through the catalogue and
have both execution paths consume it. Preserve existing no-repeat attempt ownership.

**If skipped:** The catalogue cannot provide a complete pending-operation overview,
and two workflows continue to have different destination semantics.

### 12. Cross-platform edits, scans and analysis are incomplete capabilities

**What this is:** The owner expects every supported site's content lifecycle to feed
the catalogue, including later edits and analysis.

**Problem:** The implemented collectors are concentrated on X. Main-site upload
watchers observe a specific prepared document for a limited period, not general
post-upload edits or deletions. Title propagation across existing platform posts,
full monitoring/performance/replacement orchestration, parts of Pornhub/C4S and
Reddit/Redgifs automation are explicitly deferred. Production handoff binding and
thumbnail/clip inventories are partial asset records, not a universally synchronized
version history.

**Evidence:** `docs/product.md:77`, `:280`, `:433`;
`docs/production-handoff.md:9`;
`desktop/OFEnhancer.Catalogue/ProductionHandoffs.cs:81`;
`desktop/OFEnhancer.Desktop/GoogleWorkbookProfile.cs:21`;
`desktop/OFEnhancer.Catalogue/SyncOutbox.cs:316`.
The reviewed workbook's `_Publications`, `_Assets` and `_Audit` schema does not prove
those facts are automatically populated. The generic projection enqueue API has no
production caller. These are capability gaps against the clarified goal, not claims
that every deferred feature is a new regression.

**Fix:** Specify per-site coverage and catalogue effects explicitly, implement the
missing observation/intent/result/reconciliation paths in order, and show unsupported
coverage and freshness honestly. Reuse the current validated event/outbox mechanisms.

**If skipped:** “Everything is catalogued and synced” will remain an inaccurate
description even after the individual bugs above are fixed.

### 13. Apps Script appends can duplicate comma-separated X links on retry

**What this is:** Repeating the same accepted result should be idempotent: it should
leave one record of that result.

**Problem:** The bridge splits existing links only on whitespace, so a URL with its
trailing comma is not recognized as the already-present canonical URL. The desktop
writer handles these separators differently.

**Evidence:** `integrations/google-apps-script/catalogue-bridge.gs:322`, `:332`;
`desktop/OFEnhancer.Desktop/GoogleTeaserLinkWriter.cs:17`.
An assertion-based synthetic reproduction appended status 123 twice in a comma-separated
cell. No deployed bridge was exercised.

**Fix:** Share a canonical embedded-URL parsing contract and test comma/semicolon retries.

**If skipped:** Sheet history can accumulate duplicate links and distort downstream counts.

## Independent Opus review and refutation

The installed Claude Code CLI ran two read-only jobs with runtime model metadata
`claude-opus-5-5`: an independent source review and a separate refutation of the
primary team's specific hypotheses. Both completed successfully (108 and 63 CLI
turns respectively). Available tools were restricted to Read, Glob and Grep. Opus
ran no tests, provider calls or mutations; the primary executed the reproductions.

The refuter confirmed the central attribution defects, identified their escalation,
and exposed the same-workbook reconnect reset, completed-journal capacity limit,
and association results that were not saved locally. The independent review also
identified moved-row receipt failures, mixed local/remote provenance, URL equivalence
and the uncompleted clip lifecycle. The primary reproduced the additional catalogue
cases before accepting them.

Corrections and limitations applied to the integrated findings:

- Read-only import intentionally does not configure write permission. Missing later
  backfill is a lifecycle requirement, not permission to bypass reviewed setup.
- Re-association can recover some still-loadable upload sessions after setup; there
  is no automatic, complete historical backfill.
- Reply-worker ownership fails safely. The proposed broad duplicate/wrong-reply race
  was not accepted as a confirmed defect.
- Stale-metadata and uncertain-attempt guards must stay; a repair surface must operate
  without weakening them.
- The independent review read historical acceptance notes as current authentication
  state. That inference was rejected: the owner had already reauthorized, and the
  previous turn verified catalogue reading. This audit's fresh local check established
  the missing profile/readiness, not a currently invalid Google grant.
- A legacy-provider/desktop authority-switch concern and some metadata/archive edge
  cases remain source-review candidates. They were not independently reproduced and
  are not promoted to additional confirmed findings here.

The two final Opus reports and model metadata are preserved with the local audit
evidence as `claude-independent-report.md`, `claude-refutation-report.md` and matching
metadata files. Historical/live-state claims in those raw reports should be read with
the corrections above.

## What held up under inspection

- Verified local upload URLs are preserved by the audit overlay across stale Google
  imports. Conflicting evidence is retained for review instead of silently selected.
- Item identity survives a row move when its stable source identity is unchanged.
- Google mutation intent is checkpointed before dispatch. Attempted/unresolved work
  is reconciled by reads rather than blindly resubmitted.
- Exact owner/document/connection checks, ManyVids video-ID checks, frozen plan checks
  and duplicate-result guards are implemented.
- The normal calendar editor retains fallback selection through close/reopen, and its
  manual-publication/delayed-reply recovery cases pass targeted synthetic tests.
- Explicit owner teaser mappings are preserved; ambiguous/conflicting associations
  block the relevant automatic actions.

## Evidence and limits

Primary independently executed eleven adversarial scenarios: seven catalogue cases
(targetless backfill, same-workbook selection reset, source/destination binding, its
re-import/correction escalation, moved-row receipt rejection, equivalent URL conflict
and owner-map writeback suppression), two upload cases (unrelated manual receipt and
completed-publication repeat blocking), and two Apps Script cases (occupied row reuse
and comma retry duplication). These are not eleven independent real incidents. The
catalogue program also asserts local-evidence preservation and stable identity after
row moves.

Delegated read-only review reported 41 existing upload/session tests passing. Ten
targeted teaser tests passed, with logs inspected by the primary reviewer: fallback
reopen (1), manual/restart/delayed reply (7), and first-reply ownership/eligibility (2).
Three focused catalogue safeguard tests also passed under the primary reviewer:
local evidence preservation/conflict retention, pending-attempt persistence across
reopen, and explicit owner mapping preservation. Total selected existing cases: 54.
An earlier first-reply test attempt failed because the source archive did not yet have
generated `dist` files. After building the personal extension, the selected rerun
passed; the initially attempted full file was not rerun and is not claimed passing.

Reproduction programs, synthetic outputs and Claude CLI transcripts remain under
`.local/foundation-audit-2026-10-23`. They contain neutral test examples and source
analysis; they are not provider acceptance evidence.

No live upload, public post/reply, real Google write, platform edit, media move,
credential change, full test aggregate or installed browser end-to-end acceptance
was performed. The live Apps Script deployment and every active platform's current
composer were not verified. Security penetration testing and dependency advisory
research were not part of this logic audit. High-impact execution/identity/persistence
paths were read in depth; this is not a claim that every source/test line was read.

## Required acceptance before calling the workflow seamless

| Scenario                                                           | Catalogue proof required                                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Each supported platform's manual and automatic upload              | Exact item/media → exact accepted post → one local publication → verified Google effect or visible pending work      |
| Result received before sync setup/offline                          | Local proof survives; later safe destination setup backfills exactly once                                            |
| Partial multi-site success                                         | Successful siblings remain recorded; failed or uncertain siblings resume without duplicate publication               |
| Edit metadata or move a sheet row                                  | Identity remains stable; changes/history and conflicts are visible; no wrong-row write                               |
| Close editor / suspend worker / restart Chrome / reconnect desktop | Approved job survives where supported; no missing receipt or repeated final action; unsupported recovery is explicit |
| Manual post followed by delayed automatic reply                    | Actual publication time starts delay; selected target and frozen text survive; actual reply is recorded once         |
| Source A teaser promoting B                                        | A owns content/performance; B shows other-episode incoming post; Google reflects both roles without conflation       |
| Profile destination                                                | Account destination is recorded without inventing a destination video                                                |
| Edit/delete a post outside OFEnhancer                              | Site observation updates the correct publication and its history, or the site is visibly unsupported/stale           |
| Re-render or replace local media                                   | Original retained; exact new artifact/version and affected publications are traceable                                |
| A sync conflict or uncertain provider outcome                      | A visible repair path observes/reconciles; it does not delete evidence or repeat an uncertain action                 |
| Whole-account scan/analysis                                        | Coverage, truncation, account, observation time and unavailable results are explicit                                 |

These are acceptance criteria for future repairs and capability completion. They are
not completed live UAT results.

## Repair direction

Start with containment of incorrect attribution, then make the catalogue's record
complete before expanding automatic site actions:

1. Stop promoting destination-only guesses into source-sheet facts. Record a verified
   main post's selected source immediately and provide correction with provenance.
2. Represent each video's assets/versions, platform publications, incoming/outgoing
   teaser relationships, pending jobs and observed results through the central catalogue.
   Profile destinations remain account relationships. Reuse the current catalogue,
   audit and outbox code where it is sound.
3. Give every permitted catalogue effect a durable completion/recovery path. Separate
   local recording, pending Google work and verified remote completion, including
   pre-setup results and same-workbook reauthorization.
4. Repair receipt identity, moved-row resolution, journal completion and canonical URL
   comparison without weakening uncertain-attempt or stale-plan protections.
5. Complete the declared site/operation coverage, then run the bounded installed UAT
   matrix against real evidence with the required publication authorizations.

Field ownership remains an explicit product/architecture decision: today Google owns
most editable row metadata while SQLite owns unsynchronized publication facts. The
owner's central-catalogue requirement needs a defined conflict policy for app edits,
sheet edits and later site observations. Neither an incoming refresh nor a frozen
browser job should silently redefine those rules. The existing auxiliary workbook
tabs can be considered for richer projections; their presence alone is not synchronization.

## Repair status

The subsequent catalogue foundation repair addresses findings 1–11 and 13 in the
supported workflows: source/promotion separation; identity-bound manual capture
with explicit in-app recovery when evidence is insufficient; frozen workbook
affinity and durable writeback; stable row recovery; distinct local/Google states;
full-row Apps Script occupancy; archived completed publication guards; canonical
OnlyFans identity; reviewed conflict recovery; exact clip publication state; and
central workflow/reply/script records. New-row creation uses a durable operation
ID and one atomic content/U-ID/developer-metadata mutation. The additive
`_Workflows` ledger projects verified workflow metadata to its original workbook.
The optional Apps Script source must still be deployed independently.

Finding 12 remains a coverage boundary: there is no universal collector for later
edits/deletions made directly on every platform, no general cross-platform metrics
collector, and no complete versioned filesystem media engine. The new metadata
ledger does not pretend those collectors exist. OnlyFans manual publication also
requires owner-confirmed link recovery until an identity-backed provider response
contract is qualified. Unsupported autonomous site actions remain manual.

Source/unit/browser-fixture verification and installed release evidence belong in
`docs/acceptance.md`. They do not establish live provider publication or Google
write acceptance. Full UAT must verify the supported installed workflow with the
owner's selected source, actual post, frozen reply destination, script mapping and
read-back catalogue results.

## Original audit verdict

The current program does not guarantee that every upload or change is correctly
catalogued and synchronized. Some protection mechanisms are sound, but the owner’s
central-catalogue workflow is not complete. Repair publication identity, source versus
destination, durable backfill and visible reconciliation first; then complete site
coverage and qualify the actual installed end-to-end workflows. A wholesale rewrite
is not established as necessary by these findings.
