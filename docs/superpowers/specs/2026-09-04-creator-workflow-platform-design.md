# Creator Workflow Platform Design

## Goal

Turn the personal OFEnhancer Chrome extension into a local creator workflow
system that prepares media, publishes through authenticated Chrome tabs,
records every resulting platform identity, keeps the video catalogue current,
and raises a private attention item when a publication disappears or performs
well below the creator's normal range.

The system remains deterministic by default. It may offer an optional
copy/paste AI prompt when a foreign catalogue cannot be mapped reliably, but an
LLM never chooses a catalogue item, platform action, deletion, or repost.

## Product boundary

The product has two cooperating parts:

- a self-contained Windows desktop application that owns local files, media
  generation, operational state, scheduled checks, analytics, Google access,
  and private attention state; and
- a personal Chrome extension that owns exact actions in the user's real
  authenticated website tabs.

The desktop app is the primary interface. The Chrome uploader is an optional
mirror and authenticated execution surface. Both use one plain-web frontend.

The Chrome Web Store identity-mask edition remains a separate narrow product.
It does not gain personal publishing origins, Native Messaging, debugger
access, desktop components, or creator data.

## Non-negotiable action contract

1. The user sees one exact cross-platform plan and accepts it with Yes or No.
2. The Yes is bound to a hash of the files, catalogue binding, text, date,
   destinations, presets, and execution mode. A changed plan needs a new Yes.
3. Every state-changing browser adapter is derived from a sanitized successful
   trace and verifies exact preconditions and postconditions.
4. A missing, duplicated, stale, changed, or ambiguous control stops only the
   affected job.
5. Immediately before a final public control, the system durably records the
   submit attempt. An uncertain outcome is reconciled and never blindly
   repeated.
6. CAPTCHA, login, verification, rate-limit, and moderation gates are never
   bypassed.
7. Deletion, replacement, retry, and later re-upload require a new Yes.
8. No passwords, cookies, authorization headers, private request bodies, or
   media bytes enter the Sheet or extension persistence.

## Runtime architecture

`OFEnhancer.Desktop` is one per-user tray application. It owns a single SQLite
connection, job scheduler, file inventory, media queue, Google OAuth tokens,
Sheet synchronization outbox, and analysis engine. It stays available at
logon; no Windows service is added.

WebView2 hosts the shared UI. Chrome Native Messaging launches a stateless
relay that forwards bounded messages over a current-user-only named pipe. The
relay has no database or platform logic.

The personal extension opens or focuses authenticated tabs, runs exact page
adapters, attaches local files through a brief Chrome Debugger Protocol
session, submits only an authorized plan, captures canonical results, and
returns bounded progress. Media bytes do not pass through Native Messaging.

Manifest V3 service-worker restarts are expected. Every job is recoverable
from durable desktop state and monotonic browser checkpoints.

## Operational data

SQLite is the local operational source. The desktop process is its only writer.
Use ordinary normalized tables plus append-only metric and audit history, not a
general event-sourcing framework:

- `catalogue_items`;
- `media_assets`;
- `asset_bindings`;
- `publication_jobs`;
- `job_attempts`;
- `platform_publications`;
- `social_posts`;
- `metric_snapshots`;
- `recommendations`;
- `sync_outbox`;
- `audit_events`; and
- `settings`.

Default SQLite rollback journaling and transactions are sufficient because one
process writes. A database migration creates a verified backup before changing
schema. A failed migration restores the previous file and leaves the new
binary unable to start jobs.

The Google workbook is the durable human projection, not a raw retry log.
Direct desktop OAuth with the narrow `drive.file` scope replaces the Apps
Script shared-secret bridge after a migration period.

## Workbook model

`2026 Video Catalogue` remains the main schedule. The columns the user needs
to see stay near the existing catalogue, especially:

- `# X teasers`; and
- `# Reddit teasers`.

Platform summaries, stable item ID, and synchronization metadata live in
grouped far-right columns that can be collapsed. Google developer metadata
binds the stable ID to the logical row through sorting and row moves.

Hidden-by-default companion tabs remain available to the user:

- `_Publications`: one row per paid publication, social post, first reply,
  Redgifs upload, or subreddit submission, including replacement relations and
  milestone metrics;
- `_Assets`: bounded asset identities, roles, recipe versions, and hashes,
  without absolute local paths;
- `_Audit`: meaningful authorizations, conflicts, deletions, replacements,
  migration outcomes, and recovery decisions; and
- the existing subreddit sheet: status, notes, rules, title/body template,
  flair, link policy, Redgifs acceptance, frequency, sources, and checked date.

Local SQLite keeps raw polls, retries, and transient diagnostics. The Sheet
keeps meaningful current projections and milestone snapshots. Writes use
read-before-write fingerprints, narrow batch updates, idempotency keys, and
readback verification.

## Catalogue and asset identity

Every catalogue item has a permanent opaque ID. Matching uses ordered evidence:

1. permanent user-confirmed binding;
2. exact SHA-256 match;
3. an asset-family match based on duration, codec/geometry, sampled normalized
   frame perceptual hashes, and curated-thumbnail perceptual hashes;
4. supporting filename aliases, normalized title/series/episode tokens,
   planned Friday, and platform gaps; and
5. future planned catalogue rows before `Add New`.

Perceptual similarity ranks evidence but never proves identity. Automatic
selection requires an absolute threshold and a clear margin over the second
candidate. Genuine ambiguity shows three to five curated thumbnails. One click
creates a permanent binding that survives rename and move.

Different teaser files may bind to the same catalogue item. Exact full-video,
limited, 4K, 1080p, cumshots-only, teaser, and artwork variants retain separate
asset IDs under one item.

`FileSystemWatcher` only prompts a scan. Periodic inventory plus exact file
metadata and hashes is authoritative.

The curated thumbnail source is:

`D:\MEDIA - SELFMADE\Youtube2\.DONE_DEEDS\.thumbs`

Naming evidence includes `_33` for Pornhub 640x360, `_4K` for Clips4Sale 4K
artwork, and `a` through `d` as alternatives. It remains supporting evidence,
not identity by itself.

## Catalogue interface

The desktop Catalogue view shows each video as a compact thumbnail row/card
with title, planned date, platform coverage, live/ready X teaser counts,
live/ready Reddit teaser counts, and attention state. Filters include planned,
missing platform, ready teaser, removed social post, and needs attention.

The selected ManyVids artwork becomes the proposed primary catalogue thumbnail
only after the ManyVids Save result is verified. A primary-thumbnail change can
prepare a reviewed cross-platform update plan. Platforms with immutable media
show `repost required` instead of pretending an update is possible.

## Media engine

OFEnhancer owns its media recipes and test fixtures. JohnnyTools supplies
reference behavior only and is not invoked after the port is accepted.

Initial versioned recipes are:

- `teaser-v1`: port the existing highlight, early-frame, audio-peak, duration,
  H.264, AAC, 1920x1080, and size-cap behavior;
- `ph-thumb-33-v1`: center-crop, resize, strip metadata, and constrain a
  640x360 Pornhub image below the configured size cap; and
- `c4s-4k-badge-v1`: combine the primary artwork with a pre-rendered transparent
  4K badge at one of a small set of user-selected positions.

Clips4Sale video recipes separately track teaser, 1080p, 4K, and cumshots-only
outputs. Their exact transcode parameters are added only after requirements and
traces confirm them.

Use pinned FFmpeg/ffprobe binaries with an audited LGPL-compatible build.
Invoke processes with argument arrays, `-nostdin`, and machine-readable
progress. Write to a temporary output, verify duration, dimensions, codecs,
size, and hash, then move atomically. Never silently overwrite.

Missing `_33` and `_4K` art is offered immediately after selecting the video,
platform, and primary artwork. The desktop UI shows progress and output preview.

A teaser moves to `DONE` only when every selected destination has a verified
live result and the move was part of the accepted plan. Same-volume moves are
atomic renames. Cross-volume moves use copy, hash verification, and source
deletion. Later platform deletion does not silently move the file back; a retry
asks the user to locate it if necessary.

## Publishing model

One parent publication plan creates independent platform jobs. The state model
is:

`draft -> matched -> prepared -> reviewed -> authorized -> opening -> attaching -> filling -> ready-to-commit -> submit-attempted -> verifying -> recorded -> completed | needs-attention`

Stages never move backward. Captured platform IDs and canonical URLs are
immutable. A sibling failure does not erase a successful job.

Each adapter declares its page signature, exact controls, required state,
mutations, postconditions, result extractor, trace-fixture version, and
reconciliation method. Unknown site UI stops and requests a new trace.

The default release is Friday at 15:00 UTC, converted explicitly for each
platform and daylight-saving boundary.

Platform recipes:

- OnlyFans: full video, description, schedule, submit, and canonical link;
- Fansly: full video, free teaser/preview, `defaulT` preset, locks, schedule,
  submit, and canonical link;
- ManyVids: full video, teaser, optional selected artwork, title, description,
  price, tags, performer/category settings, and Save as soon as verified upload
  completion enables it;
- Pornhub Free and Pornhub Paid: separate records and links; standalone
  Pornhub-only runs are normal;
- Clips4Sale: teaser, 1080p, 4K, and cumshots-only outputs as separate records;
- X: teaser post followed by a separate first reply containing the selected
  paid link, with the OnlyFans preview card dismissed before the reply; and
- Redgifs/Reddit: Redgifs creates one watch URL, then each selected subreddit
  receives its own link submission.

Title is required for Pornhub, ManyVids, and Clips4Sale. Descriptions and
bounded presets are proposed automatically. Paid-platform and social teaser
files may differ.

Manual mode fills and stops before each final public control. Autonomous mode
may use final controls after the same plan-level Yes. This is one global
setting, not repeated inside every destination card.

## Social publishing and ledger

Social records are separate for:

- X main post;
- X first reply;
- Redgifs upload; and
- every subreddit submission.

States are `planned`, `ready`, `published`, `live`, `missing`,
`removed-by-author`, `removed-by-platform`, `replaced`, and `unknown`.

The last subreddit selection becomes the next default. Presets may contain
several subreddits. The X caption is the initial Reddit title, but each
subreddit may override title, optional body, flair, NSFW setting, link policy,
and rule notes. Only user-approved presets may run autonomously.

Replacing an X reply or post creates a new record linked to the old one. The
old identity is never overwritten. A deleted or removed social item creates an
attention item; re-upload always needs authorization.

Visible counts are asset counts, not post counts:

- X count: distinct teaser asset IDs with at least one live X main post; and
- Reddit count: distinct teaser asset IDs with at least one live subreddit
  post.

Nine subreddit submissions that share one Redgifs teaser count as one Reddit
teaser while retaining nine detailed publication rows.

## Monitoring

The desktop scheduler performs checks in polite batches. It spreads due work
through the day, respects platform rate-limit headers, backs off exponentially
on throttling and server errors, and offers manual refresh. It never disguises
high-frequency scraping as human behavior.

Preferred data sources:

- X official API when the user supplies developer access;
- Reddit OAuth Data API when the application is approved;
- trace-backed while-open browser checks where supported APIs do not exist; and
- manual refresh when neither reliable route exists.

No Redgifs or adult-platform internal API is treated as a stable public
contract.

Metric snapshots use common ages: 24 hours, 72 hours, 7 days, and 30 days,
plus a latest local value. X stores impressions, likes, replies, quotes,
reposts, and per-post engagement rate when available. Aggregated X video views
do not score an individual repost. Reddit stores score, comments, and exposed
removal state while respecting deletion requirements.

Deleted Reddit API-fetched title, body, and URL data is purged within the
required window. The system retains a tombstone, dates, platform ID where
permitted, and the creator's independent local asset/catalogue relationship.

## Performance analysis and retry suggestions

Performance is compared with the creator's own comparable history at the same
post age. X cohorts distinguish original and repost but avoid speculative
micro-segmentation. Reddit cohorts are per subreddit.

A cohort needs at least ten qualifying historical posts. Below that, the UI
says there is not enough history and does not label the post good or bad.

The primary explanation uses rolling medians and percentiles. A robust
median-absolute-deviation score may support, not replace, that explanation. A
post is an underperformer only when both its age-matched engagement rate and a
second concrete metric such as likes fall below configurable cohort bounds.

The dashboard also compares the current 30-day median with the previous
30-day median when both periods contain enough posts.

Recommendations are deterministic and factual, for example: `Below your usual
24-hour range. Consider changing the opening or caption after 30 days.` The
system does not invent a new creative concept. A retry queue stores the prior
record, earliest date, revised asset/caption proof, and new authorization.
Nothing is deleted or reposted automatically.

## Attention and privacy

The Windows tray icon may show a red dot or neutral count. Default notification
text is only `OFEnhancer needs attention`. It never includes a video title,
caption, subreddit, platform, or adult-content detail. The user opens the app
to see the reason.

Attention items include changed site UI, login/CAPTCHA, Sheet conflicts,
missing files, uncertain submissions, deleted/replaced posts, failed status
checks, underperforming posts with sufficient evidence, and incomplete media
jobs.

## Settings and supporting tools

The desktop navigation is Catalogue, Uploads, Teasers, Attention, and Settings.
The Uploads view separates official video distribution from social teaser
distribution. X and Reddit details sit side by side at desktop widths.

The Chrome popup contains only Open OFEnhancer, current attention state, Record
this site, Settings, and identity-mask toggle. The recorder is hidden until
requested. Identity masking and avatar sources are one settings group.

Existing Fansly, ManyVids, Pornhub, Clips4Sale, and other helper logic moves
into its platform settings page. Forms replace raw profile JSON. Sheer remains
available but disabled. Obsolete site helper cards are removed after their
logic is migrated.

The supplied logo replaces the generic C. `OFEnhancer` remains a working name
until a separate naming exercise picks a broader product name. All user-facing
copy receives a Humanizer pass.

## OnlyFans expired-subscriber outreach

Outreach is a separate module, not an uploader setting. It requires a fresh
trace of current OnlyFans list and messaging behavior.

The local database stores a keyed one-way identifier for each contacted
account, campaign ID, and outcome. It never messages the same recipient twice.
The Sheet receives campaign dates and aggregate totals, not individual fan
identities. Every final send needs an explicit campaign review and Yes.

## Installation and updates

A per-user Inno Setup installer installs the self-contained desktop app,
stateless native bridge, shared UI, stable extension folder, audited media
runtime, Native Messaging registration, and startup entry.

An existing installation offers Update, Reinstall/repair, or Uninstall.
Update stops the agent, backs up the database, installs binaries, performs a
transactional migration, verifies startup, and preserves the backup until
success. Repair replaces owned binaries and registration while preserving user
data. Uninstall removes only OFEnhancer-owned files, HKCU registration, and
startup entries; catalogue, settings, database, generated media, and user media
remain unless explicitly selected.

The installer never silently enables an unpacked extension or applies
enterprise policy. It guides Developer Mode and Load unpacked. Because the
current extension lacks a reusable manifest key, moving to an installer-owned
folder is a one-time identity migration with export, import, readback, and
explicit retirement of the old extension.

The app and installer require signing and timestamping before a public release.
A self-update channel is out of scope until signed release metadata exists.

## Evidence and testing

Every feature uses TDD for deterministic logic and fixture tests for browser
adapters. Media recipes use small golden fixtures. Database migrations test
backup, kill recovery, and rollback. Sheet tests target fakes or a separate
opt-in test workbook. Installer tests cover clean, update, repair, and uninstall
in Windows Sandbox or a VM.

Live acceptance is separate and explicitly authorized. Automated tests never
publish, send outreach, mutate the live Sheet, install registry entries, or
move real media.

Missing evidence gates at design approval:

- valid Redgifs upload and canonical-result trace;
- complete Clips4Sale four-version trace;
- current Pornhub Free/Paid traces;
- current Reddit Redgifs-link submission trace;
- edit-existing-thumbnail traces for every mutable platform; and
- current OnlyFans expired-list outreach trace.

No adapter is claimed autonomous before its trace fixture, contract tests,
safe readiness test, and one controlled user-authorized acceptance run.

## Programme sequence

1. **Desktop foundation:** shared WebView2 shell, one local agent, Native
   Messaging relay, safe CDP file-attachment proof, installer staging.
2. **Catalogue and asset identity:** SQLite, Google OAuth, workbook migration,
   thumbnail catalogue, deterministic matching, ambiguity picker.
3. **Owned media engine:** teaser, `_33`, `_4K`, validation, progress, and safe
   `DONE` handling.
4. **Existing paid-platform vertical slice:** desktop-controlled OnlyFans,
   Fansly, and ManyVids with local file paths, recovery, links, and Sheet sync.
5. **Pornhub and Clips4Sale:** Free/Paid Pornhub and four C4S variants after
   current traces.
6. **Social publishing:** X/reply, Redgifs, Reddit presets, separate ledger,
   and global manual/autonomous mode.
7. **Monitoring and analysis:** liveness, replacement detection, metrics,
   adaptive baselines, trend, retry queue, private attention state.
8. **Thumbnail reconciliation:** primary art, generated variants, remote update
   plans, and immutable-social handling.
9. **Consolidation:** popup/settings overhaul, subreddit research schema,
   outreach, extension identity migration, installer hardening, copy and UI
   audits.

Each numbered programme item receives its own implementation-ready plan. A
later milestone may consume verified outputs from an earlier milestone but may
not bypass its evidence gates.
