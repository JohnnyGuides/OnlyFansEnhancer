# Architecture and trust boundaries

## Runtime ownership

OFEnhancer deliberately separates local authority from authenticated browser
authority. [The product contract](product.md) owns the safety requirements; the
modules below implement them.

| Owner                                 | Responsibilities and entry points                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/personal`                 | Chrome service worker, uploader/recorder pages, settings, avatar services, and `workflows/` adapters/contracts/checkpoints                            |
| `extensions/store`                    | Independent consent/settings/background UI for the display-only product                                                                               |
| `shared/identity-mask`                | One masking engine and stylesheet. Each edition supplies `identity-settings.js` before shared content code; absent configuration defaults to disabled |
| `shared/workspace`                    | Browser-rendered workspace, host abstraction, and desktop upload transport. Used by the personal extension and linked into the Windows build          |
| `desktop/OFEnhancer.Desktop`          | WPF/WebView2 UI, per-user tray agent, Google integration, browser selection, thumbnail serving, and native file selection                             |
| `desktop/OFEnhancer.Catalogue`        | SQLite store, migrations, import, identity/matching, thumbnail inventory, upload records, and sync outbox                                             |
| `desktop/OFEnhancer.Protocol`         | Bounded request validation and current-user named-pipe framing                                                                                        |
| `native-host/OFEnhancerNativeBridge`  | Stateless per-message relay between Chrome native messaging and the local desktop agent                                                               |
| `native-host/CreatorTeaserNativeHost` | Separate X receipt/audit/file reconciliation authority; not replaced by the desktop relay                                                             |
| `integrations/google-apps-script`     | Optional existing creator-owned Sheet bridge, independently deployed from source                                                                      |

The desktop is the sole local database writer. Its shared UI sends allow-listed
operations to the native host bridge and receives bounded results, not arbitrary
SQL or filesystem authority. `WebMessageRouter`, `WebMessageDispatcher`,
`AgentProtocol`, and their tests are the executable message contracts.

## Desktop, WebView, and Chrome

The workspace runs at `https://app.ofenhancer.local/` in WebView2. Local thumbnails
are served as `https://thumbs.ofenhancer.local/<opaque-asset-id>`, never by exposing
an arbitrary `file://` URL. Native resource resolution verifies the configured
root and current file identity. The single-instance/tray lifetime is independent
of an individual Chrome extension worker or visible desktop window.

Chrome connects to `com.johnnyguides.ofenhancer`. The bridge uses native-messaging
stdio frames, forwards bounded JSON over a per-user `CurrentUserOnly` named pipe,
and correlates request IDs. Frames are capped at 1 MiB. It accepts repeated
requests while the native connection is alive but owns no catalogue or publishing
state and opens no inbound network listener.

`BrowserUploadChannel` binds queued commands to the explicitly selected Chrome
connection/generation. `desktop-upload-runtime.js` services that channel while
preserving the extension's existing publisher. A disconnected/stale browser is
not silently replaced by another tab or connection. Pending work must not replay
file attachment or public submission merely because a process reconnects.

Desktop file selection uses WebView2 additional native File objects.
`MainWindow` verifies name, size, and modification time against that native
selection before a short-lived authorized local path reaches the trusted
attachment command. JSON alone cannot invent a native file selection. Paths are
not persisted as Chrome publishing checkpoints, exposed in page messages, or
returned in errors. `local-file-attacher.js` uses the exact tab/origin/input and
always detaches the debugger. Extension-page `File` objects instead use the
session-scoped file bridge; they are not serialized into JSON.

`UploadCatalogueController` records verified upload outcomes locally. That return
value explicitly distinguishes local success from Google synchronization. The
local SQLite catalogue, the optional direct Google sync outbox, and the older
Apps Script client are distinct boundaries, not interchangeable success signals.

## Browser execution and state

The personal background worker owns registration, tab binding, shared settings,
message allow-lists, and durable progress. The console owns the current selected
Files and approved preview. Upload admission follows the worker preflight: the
console's readiness check sends the run's own request through the same
preflight PREPARE runs, assuming only the repeat-copy confirmation that Upload
always asks for first. A repeat revealed by the catalogue save is confirmed
before PREPARE, and any preflight refusal at PREPARE is a clean not-started
result that keeps the draft editable and re-checks readiness. Page adapters inspect the current signed-in DOM;
narrow page-world response observers accept only the expected successful final
response and canonical identity. They do not grant generic API interception or
trust a content-script-supplied URL as proof of successful submission.

Site helper files own exact inspection/application logic. The coordinator calls
those operations directly with an approved profile snapshot rather than clicking
helper-panel UI or keeping a second copy of their recipes. Standalone wrappers
remain useful for bounded manual correction. Registry normalization owns profile
defaults; adapters recheck form signatures before mutation.

Upload session state is bounded and serializable because Manifest V3 workers can
be suspended. It may include approved metadata, basenames, plan signatures,
canonical outcomes, fingerprints, and monotonic stage flags, but not File bytes,
cookies, request bodies, or raw media paths. The open uploader still has to retain
or deliberately reselect the exact File. X recorder/distributor checkpoints use
their own durable allow-listed records. A persisted final-attempt marker is not
cleared on restart or storage retry. The local `creatorUploadActionsV1` journal retains final intent and canonical receipts independently of session metadata. Preparation records retain hashed work/plan identity, command, platform, frame and document, including an issued file-delivery phase. New sessions cannot bypass an existing action for the same work; full journals reject new work without evicting unresolved records. Legacy records remain visible.

Privileged preparation messages recheck the exact document, route, frame and current connection object before and after durable writes. Only the recorded ManyVids editor handoff can replace that document binding. File assignment and upload-start actions are not transport retries. Idempotent checkpoint/progress acknowledgements may resume; explicit refusals fail once.

Final response observation is armed at the durable final-action boundary. Earlier requests are excluded and preparation time does not consume its timeout. A canonical receipt is checkpointed independently of the adapter return. Ambiguous identities and application errors do not establish acceptance. `recorded-local` is terminal independently of sibling platforms and never implies Google synchronization, including an idempotent local record.

## Catalogue and reconciliation

Stable local item IDs and verified content identity survive row moves and file
renames. A filename is a search hint, not a key. `CatalogueSnapshotImporter` and
migrations use transactions and verified sibling backups where required;
`ThumbnailInventory` rejects unsafe filesystem traversal. Current thumbnail
matching is deterministic, not a perceptual media engine.

Direct Google import and reviewed sync have different acceptance criteria.
`GoogleCatalogueImportReader` recognizes bounded headers read-only;
`GoogleWorkbookProfile` and `GoogleWorkbookMigrator` enforce the stricter write-back
layout. Developer metadata locates stable item rows; fingerprints protect fields.
The outbox never rewinds an attempted mutation to pending. Details, recovery, and
operator procedures are maintained only in [Google catalogue](google-catalogue.md).

The separate X host uses a basename plus identity proof within configured roots,
not a caller-provided arbitrary path. Representative frames come from the selected
local File, avoiding page overlays and cross-origin screenshot ambiguity. It
writes validated audit frames/data and a durable receipt, then the extension
performs the protected Sheet append, and only then requests the exact Done move.
Retries accept identical existing artifacts; conflicting files or destinations
stop. The receipt, hash/root checks, and audit → Sheet → move ordering are all
required. Neither native host owns Chrome cookies or authenticated site sessions.

## X collection

The personal extension records the owner's own X posts while the owner browses
x.com and during its own background scans (below); it never clicks, types or
scrolls there. The worker
registers two dynamic `https://x.com/*` scripts at `document_start`:
`x-collector-page.js` in the main world wraps `fetch` and `XMLHttpRequest` before
X's code captures them, returns X's original responses unchanged, and reads a
clone of responses from the GraphQL operation allowlist in
`x-collector-contract.js` only. The account id comes from X's own `twid` cookie
or `Viewer` response; posts by any other author are dropped. A response whose
shape no longer parses is discarded whole and counted as `schema-drift`; quoted
and reposted posts nested in a response are not parsed. Before X's scripts run,
the page script hands a `MessageChannel` port to the isolated
`x-collector-relay.js` over a synchronous DOM event, at most once; batches then
travel only over that port, which page scripts never see. Chrome injects one script URL once per
document across worlds, so the relay loads the same contract source as
`x-collector-relay-contract.js`. When no network batch arrives, the relay reads
rendered owner articles (status link, `time`, text, video, metrics `aria-label`)
and tags them `dom`. Only exact counts are read from the label (plain digits or
digits in thousands groups); an abbreviated or decimal figure such as `1.2K`
leaves that metric `null`, never an approximation. Text and video come only from the outer post: anything
inside an embedded quote block (nested `article`, `div[role="link"]` or
`quoteTweet`) is ignored, and when the outer post's text cannot be isolated (more
than one remaining timestamp or text block) the row keeps no text or media. The worker validates every batch strictly
(`x-collector-forwarder.js`), keeps a bounded queue, forwards at most 25 rows per
`recordXObservations` desktop request, drops undeliverable batches without
retrying, and keeps counters in session storage
(`creatorXCollectorDiagnosticsV1`), including `ownerMismatchRows` with the time
and handle of the last batch the desktop refused for a different account.

A `TweetWithVisibilityResults` wrapper whose inner `tweet` has no `__typename`
(X's current form) is read as the post when it carries `rest_id` and `legacy`.
`FetchScheduledTweets` (X's compose > unsent > scheduled list,
`data.viewer.scheduled_tweet_list`) is parsed whole or not at all: id,
`execute_at` time, a 280-character text excerpt and the media count/types; any
unexpected shape is `schema-drift` and nothing is sent. The list travels as a
`scheduled` relay message, is validated in the worker and forwarded at once,
without retry, through `recordXScheduledPosts`.

Background scans (`x-collector-scanner.js`) keep the data fresh without the
owner browsing. A one-minute `creator-x-scan` alarm asks the desktop
(`getXScanPlan`: the recorded owner with its account id, a pending "Scan now"
request, the owner's own non-reply posts of the last 31 days, and
`desktopStartedUtc`, when this OFEnhancer process started). A scan is due once
after every OFEnhancer start (trigger `startup`: the start is later than the
last attempt, at least 2 minutes after it, outside a rate-limit pause), every 6
hours, when one of those posts passes 24 h, 72 h, 7 d or 30 d of age
since the last attempt, or on request; automatic scans are at least 30 minutes
apart and any two scans at least 2 minutes. An HTTP 401, 403 or 429 answer
pauses automatic scans for 6 hours, doubling per consecutive such error up to
48 hours (a finished scan resets it); "Scan now" still runs and the dashboard
shows the pause. Without a known owner account no tab
is opened. One scan at a time (in memory; a run record left by a stopped worker
has its tab closed) opens one inactive tab on `https://x.com/<owner>/with_replies`
(blank first, then navigated to a URL ending in `#creator-scan=<run marker>`;
after a worker restart only an inactive x.com tab whose URL still carries the
recorded marker is closed). If the owner activates or closes the scan tab at any
point, the scan stops at once (`user-took-over`) and the tab is neither
navigated nor closed. The page script keeps X's own request for an
allowlisted profile timeline (`UserRepliesTimeline` and the other profile
timelines) as a template only when its `variables.userId` is the owner's account,
with the request headers limited to `authorization`, `x-csrf-token`,
`x-twitter-auth-type`, `x-twitter-active-user`, `x-twitter-client-language`,
`x-client-transaction-id` and `content-type`. The worker sends `status`/`page`
commands with `chrome.tabs.sendMessage`; only the worker (not a tab) may command,
and the relay passes them over the private port. Each `page` replays the template
once with the response's `Bottom` cursor; the response goes through the ordinary
collector path. The worker waits 2–4 s (random) before every replay and stops on
the first non-200, unreadable or drifted answer (`error`, no retry), when the page
cookie's account is not the owner (`owner-mismatch`, checked before the first
replay and on every page), when there is no next cursor (`complete`), a page
brings no new owner post (`no-new-posts`), a page's newest post is older than the
window (`window-reached`; 35 days for routine scans, none for the first full
backfill) or at the page cap (`page-cap`: 30 pages for the backfill, 10 after),
and after 8 minutes (`timeout`). After a finished scan the same tab opens
`https://x.com/compose/post/unsent/scheduled` so the collector reads the scheduled
list (waits up to 25 s). The tab is then closed in every case. The outcome,
pages, new rows and scheduled count are kept in `chrome.storage.local`
(`creatorXScanV1`, last 20 runs) and sent with `recordXScanResult`. "Scan now" on
the extension's dashboard starts a scan directly (`requestXScan` handled by the
worker); in the desktop workspace it records a request that the next alarm tick
picks up.

Every scan writes a live activity log (`activity` in the scanner): the trigger,
mode, phase (`starting`, `opening`, `loading`, `reading`, `waiting`, `paging`,
`scheduled`, `closing`, `done`), pages and posts so far, and up to 150 lines of
plain text naming each step, each page read, and each owner post read with the
counters X sent for it. Each page reply from the page script carries up to 40
post previews (`scanPreview` in the contract: id, time, kind, a 140-character
excerpt, first media type, a `pbs.twimg.com` poster URL and the six counters
exactly as parsed); the worker keeps only previews that pass
`validScanPreviews`. The log is informative only and never alters a scan. The
worker keeps it in `chrome.storage.session` (`creatorXScanActivityV1`) and
sends it, at most once a second and always at the end, with
`recordXScanActivity` (newest 60 lines); the desktop validates it strictly and
keeps it in memory only (`XScanActivityBoard`), never in the catalogue. Both
dashboards read it with `getXScanActivity` (the extension page from the worker,
the desktop workspace from the board), every 1.5 s while a scan runs and every
10 s otherwise, and reload the overview when a scan finishes. A log that claims
to be running but has not been updated for 90 seconds is shown as interrupted,
never as an active scan.

Catalogue migration 9 adds `x_scheduled_posts` (one row per scheduled post: time,
text excerpt, media summary, first/last seen; a post missing from a later list is
marked `gone`, an empty list marks all gone; only the recorded owner account's
list is accepted, otherwise `x-owner-unknown`/`x-owner-mismatch`) and
`x_scan_state` (the pending request time and the last scan outcome; a result
whose scan started at or after the request clears it).

Catalogue migration 6 adds `x_owner` (the single recorded account; a different
account is refused with `x-owner-mismatch`), `x_posts` (one row per status;
the first sighting inserts the row from either source; afterwards network rows
own the content and DOM rows only refresh sightings) and
`x_metric_samples` (actual age in hours, at most one sample per status and
minute, near-identical samples within 10 minutes skipped). The desktop repeats
shape, size and author checks and stores reposts without their foreign text,
media, links or counters. Only IDs, timestamps, counters, links and the text of
the owner's own posts are stored; no media, other accounts or cookies.

Catalogue migration 7 adds the teaser manager tables. After each
`recordXObservations` batch and each catalogue import the desktop recomputes
`x_first_replies` (per teaser — an owner post with video that is neither a reply
nor a repost — the earliest owner reply in its conversation carrying an
OnlyFans or Fansly post link) and `x_post_bindings`: a status linked from exactly
one row's `Twitter Teaser(s)` cell binds as `sheet-link`; otherwise a first-reply
link matching exactly one row's OnlyFans/Fansly link binds as `reply-link`;
`owner` bindings are never replaced. Disagreements and ambiguous matches are
recorded in `x_binding_conflicts`, and an ambiguous match binds nothing; titles
are never compared.

While Google is connected, the hourly `XTeaserController` tick (independent of
`xTeaserRoot`) asks `GoogleCatalogueController` to write discovered teaser links
back to the sheet on the serial request dispatcher. It refreshes the bindings,
then takes at most five owner video teasers bound by `reply-link` or `owner`
evidence, with no recorded conflict, whose status is missing from the bound
row's `Twitter Teaser(s)` cell, oldest first. `GoogleTeaserLinkWriter` appends
`https://x.com/<owner handle>/status/<id>` to that one cell (see
`docs/google-catalogue.md`), and the returned workbook is imported so the binding
becomes `sheet-link` evidence. Each attempt is an `x-sheet-writeback` audit event
(`appended`, `already-present` or `failed` with its code); a failed status waits
1 h, doubling per consecutive failure up to 24 h. A row-specific refusal moves
on to the next teaser, any other failure ends the run. No schema change: the
audit log is the ledger. `getTeaserOverview` carries the counts as
`sheetWriteback` (pending, waiting, written, last outcome/code/time).

When the `xTeaserRoot` setting is set, `XTeaserController` runs two minutes after
start and then hourly. It lists video files in the root, `Done`, `Done\Good`
and `Done\Failed` (no other folders, no reparse points), hashes them beside the
serial request dispatcher (reusing the hash while size and modification time are
unchanged) and applies the result to `x_local_clips`: a known hash keeps its row
and pairing wherever it moves, changed content is a new clip, and absent clips
are flagged missing. The episode key comes from the `<key>__t<N>[-variant]`
name. A posted clip pairs with a teaser only when exactly one teaser bound to
that episode was posted within three days after the file's modification time
and no other clip claims it. The optional `xTeaserRevertListPath` CSV is imported
once for its owner-made `x_status_id` pairings; a status listed for two files or
a file listed under two statuses is skipped. `x_teaser_verdicts` records each
teaser's 7-day verdict once: the rate (likes + reposts + replies + bookmarks) /
views from the sample closest to 168 h within ages 144–240 h, not counting the
owner's own first reply once it was posted, is compared, in exact decimal
arithmetic, with the median of the other teasers' rates in that window; fewer
than 10 peers means no verdict. A paired clip still in `Done\` that was never
moved by a verdict then moves to `Done\Good` or `Done\Failed` after path,
collision and fresh-hash checks. The hash is taken beside the request queue and
the file's size and modification time are re-checked at the move. Each clip is
moved at most once: after a successful verdict move, wherever the owner puts it
(undo or by hand) stays. `x_clip_moves` logs moves and refusals (`collision`,
`fingerprint-mismatch`, `locked`, `error`, `unsafe-path`); a refusal identical to
the clip's last log row is not logged again, and one clip's failure does not
stop the others. Agent operations `getTeaserOverview` (bounded: 500 episodes, 200 teasers, 200
unpaired clips, 50 moves) and `undoTeaserClipMove` (moves back only when the
clip and its hash are unchanged and the original path is free) serve the teaser
dashboard. The overview lists every active catalogue episode with its category,
series and episode, each teaser's X poster image (only `pbs.twimg.com`) and a
"usual": the medians of the other teasers' samples at a comparable age
(0.8–1.25 times the latest sample's age, at least ±2 h, one sample per teaser,
at least 3 teasers). `x_planned_slots` holds the owner-local plan, one episode
(and optionally one of its clips; a failed clip marks a re-edit) per calendar
day, through `getTeaserPlan`, `setTeaserPlanSlot` (UTC yesterday to 61 days ahead)
and `clearTeaserPlanSlot`; nothing is sent to X. The shared
`shared/workspace/teaser-dashboard.js` renders it in the desktop workspace's
Twitter view and on the extension's `teaser-dashboard.html` page, which the
upload console links to; the desktop serves the same operations to its
workspace directly. The overview also carries the owner's current X scheduled
posts (at most 50), outlined on their day in the next-7-days row, and the scan
status shown above the strip with a "Scan now" button (`requestXScan`).

The automatic first reply uses the agent operation `getTeaserReplyQueue` (empty
payload; at most 50 items): the owner handle and each teaser posted in the last
24 hours that is bound without a recorded conflict and has no owner post replying
in its conversation, with the episode's canonical OnlyFans URL only when every
OnlyFans link on the row is that form for one post. A five-minute
`chrome.alarms` tick in the extension polls it while the setting is on and
keeps one record per status in `chrome.storage.local`
(`creatorXFirstReplyV1`; the setting is `creatorXFirstReplySettingsV1`): the
random due time, variant, attempts, and an outcome log (`posted`,
`skipped-existing-reply`, `no-link`, `card-not-removed`, `mismatch`,
`late-given-up`, `unconfirmed`, `wrong-account`, `binding-changed`,
`no-longer-eligible`, `error`) with counters shown in the settings
page. A status already recorded is never scheduled again; a teaser without a
link is revisited until its 24 hours end. Ticks never overlap. A due item runs
only after a fresh desktop answer still lists it for the same owner and link. One due item per tick
opens the status in a new background tab (its id is recorded so a tab left by an
interrupted run is closed on the next tick), requires X's profile link to name
the owner account (otherwise `wrong-account`, not retried), checks it is the owner's exact teaser
shown once with no newer owner status, pastes the text, removes a link card with
the reply heuristic and re-pastes at most three times, and requires the exact text
with no card in the composer. The record is then durably marked
`submit-attempted`; turning the setting off before this point aborts the run. The page repeats the
account, link and card gate in the same turn as the Reply
click, and the reply is confirmed by a new owner status on the page. Nothing is
retried after the checkpoint, including after a worker restart (`unconfirmed`);
failures before it retry at most three times. Replies over two hours past their
due time are marked late. The default follows
`CreatorXFirstReplyEvidence.liveCheck` in the evidence registry.

## Source and generated boundaries

[The composition recipe](../packaging/extensions.json) maps runtime paths to
canonical files. The Node builder validates manifest/HTML closure and store
isolation, then generates both unpacked trees and deterministic ZIPs. It refuses
source replacement, traversal, symlink outputs, and non-runtime files. The Apps
Script is deliberately not embedded in either extension.

Desktop `.csproj` Content links compose the same workspace and uploader source
into its runtime `app/` directory. The nested `app/app/upload-host.js` output is a
link of the same source needed by the uploader's relative HTML reference, not an
independently edited implementation. The uploader marks Chrome-only setup links;
its desktop host removes those links and displays guidance to configure the
optional bridge in Chrome, rather than navigating to unavailable desktop options.
Windows staging consumes the Node builder's
validated inventory; it has no second hand-maintained extension file list.

`packaging/windows` owns installer input; `packaging/store` owns public listing
assets/copy. These are not runtime forks. `docs/privacy.html` and `docs/index.html`
retain their public-site paths; the store package copies that same privacy HTML.
The source tree contains no generated packages or native binaries.

## Wire and evidence limits

`ChromeIntegration` owns bounded local setup diagnostics and fixed-package
preparation. Readiness messages bypass the catalogue/Google dispatcher. Only the
desktop WebView advertises `chrome-readiness`; the narrower extension-hosted
workspace does not infer Chrome absence from unsupported desktop diagnostics.
The native relay replaces `bridgeExtensionId` with Chrome's invocation origin.
`BrowserUploadChannel` requires matching effective identity plus a current setup
challenge before counting traffic as live. This is local diagnostic evidence,
not authentication against another process running as the same user. Setup
changes invalidate old liveness and pending channel work. Reconnect never releases
offline UI mutations, and retired connection generations cannot consume commands.

Lifecycle persistence has two disjoint authorities. The Windows maintenance
record owns consented roots, package identity, and completed uninstall/purge/copy/
verification effects. It contains no Chrome-ready claim and is retired after a
verified package acknowledges the durable Chrome obligation. The Chrome reset
record lives beside that transaction, outside purge roots, and is the only owner
of removal requests/rejections, user reports, retired receipts, replacement stage,
and admitted receipt. It is never copied into the desktop data root.

Inno Setup invokes only Windows plan/checkpoint/cleanup/finalization operations.
Recovery retains the original approved roots and completed cleanup phases, even
when a newer repair installer adopts the transaction. A missing registered
uninstaller can be recovered inside the verified product root. Once removal is
checkpointed, Setup never runs an uninstaller again for that transaction. Saved
preflight alone does not block desktop startup; destructive phases still do.
The installed app owns all Chrome guidance and admission. The extension owns only
its resumable genuine-install initialization record. The native bridge remains a
transport: it stamps Chrome's actual invocation origin on every browser request,
while the desktop applies the reset/admission barrier to upload exchange and to
direct catalogue/result operations. Diagnostics may remain reachable while a
reset is pending; general catalogue and upload authority does not.

Fresh installs use `extension-keyed`; `extension` remains the keyless compatibility
composition from the same runtime sources. `packaging/personal-identity.json`
contains only the fixed public key and derived ID. Private key material is neither
needed nor distributed. Setup verifies the installed package inventory, refuses
foreign registration targets, writes only exact current-user origins, and leaves
Google preferences and Chrome storage intact. A command-line extension override
remains effective for that process and disables saved-setup changes.

The relay accepts Chrome's Windows origin plus decimal parent-window handle,
including zero for service workers. Frames remain bounded to 1 MiB of UTF-8.
Oversized replies return a correlated `frame-too-large` error, never a truncated
snapshot. Each connected pipe has a 90-second lifetime; a failed connection does
not remove a listener worker. Browser command queues enforce byte and count bounds.

Public WebView JSON commands cannot contain a file command or nested `filePath`.
Only the native AdditionalObject selection path creates privileged file commands.
Missing AdditionalObjects are normal for ordinary WebView messages.

Catalogue URL evidence requires HTTPS, exact platform authority, no credentials
or nondefault port, and exact route identity. Query/fragment ambiguity is rejected;
Pornhub allows one `viewkey` parameter on `view_video.php` or `video/show`.
Creator-specific legacy OnlyFans normalization remains unchanged.

## Upload Hub action and acquisition contracts

Action identity includes independent accessible labels, scoped ownership, a
unique candidate and the expected post-click surface. Conflicting names do not
fall back to a nearby action. OnlyFans checks for expiration before interacting
with the supported scheduler. Fansly requires file-input activation caused by
its exact Upload New click, not merely the existence of a visible file modal.
Pre-file errors carry the composer/media-menu/upload-new/file-input stage into
the existing per-platform Upload Hub error presentation.

Pornhub acquisition starts at the signed-in Upload Video session entry
`https://www.pornhub.com/upload/videodata`; no execution is injected there.
Execution is permitted only on `https://pornhub.mainhub.com/upload/uploader`,
with either no query or the sole `site=ph` parameter, after positive unambiguous
device capability validation. Login/non-uploader pages, unknown redirects and
occupied uploaders fail closed. The final URL is stored exactly; accepting two
acquisition URL forms never makes those URLs interchangeable during execution.
Top frame, tab, document ID, active session and live connection checks remain.
This narrow contract is not a claim of complete authenticated live acceptance;
see the dated limitations in [acceptance](acceptance.md).

## Upload runtime versions and foreground observation

The desktop browser exchange requires a matching extension product version in
addition to the existing identity, native-origin, connection and setup-generation
proofs. An incompatible worker receives no new commands and the UI requests a
reload of the existing extension. Pending commands are rejected, not replayed
when a compatible worker later connects. Page adapters carry a product-coupled
revision and must match before file-bridge installation or adapter execution.

A version transition archives preparation records and durably preserves final
attempts before removing only transient upload-session bindings. Archived steps
still participate in same-work conflict checks. Same-version startup changes
nothing; malformed version state and downgrades fail without adopting a queue.
A durable final receipt without an approved draft is review evidence, not an
executable session. No broad browser-storage or catalogue reset is involved.

ManyVids foreground assistance is a privileged upload-observation request. It
revalidates the exact session, port, top frame, tab, document and route before and
after real Chrome tab/window activation. A short lease prevents overlap with
file handoff; pending files and sibling composer/editor work defer activation.
The adapter verifies actual visibility/focus, throttles subsequent requests and
retains the same-card/exact-destination guard at Edit. Focus transport failures
are not automatically retried. Other platform workflows do not receive a generic
button-click or navigation facility.

New draft retires only a settled Upload Hub view and its file/port handles. Late
old-port, retry and social-observation replies cannot populate the next view.
Active runs and unresolved handoffs refuse the reset. Remote drafts, archived
preparation and durable final-attempt evidence are not deleted.
