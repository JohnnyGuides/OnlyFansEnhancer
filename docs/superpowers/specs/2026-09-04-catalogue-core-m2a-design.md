# Catalogue Core Milestone 2A Design

## Goal

Create the first trustworthy local catalogue inside the OFEnhancer desktop app.
It must preserve permanent video identity across re-imports and file renames,
inventory the curated thumbnail folder without changing it, make uncertain
matches visible, and give the user a useful catalogue view before Google OAuth
or live workbook writes are introduced.

## Boundary

This milestone includes:

- one per-user SQLite database owned by the desktop process;
- transactional schema migration with a verified pre-migration backup;
- bounded import of a read-only catalogue snapshot;
- a read-only curated-thumbnail scan;
- SHA-256 asset identity, permanent confirmed bindings, deterministic candidate
  ranking, and an explicit ambiguity picker;
- a responsive Catalogue view backed by the real local database; and
- inert fixtures and temporary folders for automated verification.

This milestone does not:

- authenticate to Google or edit the live workbook;
- inspect authenticated creator sites, post, schedule, delete, or retry content;
- move, rename, generate, or edit real media;
- scan the creator's real thumbnail folder during automated tests; or
- use an LLM, filename alone, or fuzzy similarity as proof of identity.

Google OAuth, workbook migration, developer metadata, and narrow verified Sheet
writes are Milestone 2B. Keeping that live boundary separate prevents an
offline storage feature from quietly becoming a production-data migration.

## Storage

Add a small `OFEnhancer.Catalogue` .NET library using
`Microsoft.Data.Sqlite` 8.0.20. The desktop app is the sole writer and opens one
store per process. The default database lives under
`%LOCALAPPDATA%\OFEnhancer\data\catalogue.db`; tests always use a temporary
directory.

SQLite `PRAGMA user_version` is the schema version. Version 1 contains only the
tables this milestone uses:

- `catalogue_items`: permanent opaque ID, source key and row evidence, display
  data, planned date, visible teaser counts, and bounded platform links;
- `media_assets`: content hash, role, file metadata, local path, and scan state;
- `asset_bindings`: one permanent confirmed asset-to-item decision;
- `audit_events`: meaningful imports, scans, confirmations, and recovery;
- `settings`: local values such as the configured thumbnail root.

Future job, social, metrics, and sync tables are not created speculatively.

### Migration recovery

Before changing a non-empty database from an older supported schema, the store
uses SQLite's online backup API to create a timestamped sibling backup, opens
that backup separately, and requires `PRAGMA integrity_check` to return `ok`.
The migration itself runs in one transaction. If it fails, the store closes its
connections, restores the verified backup, verifies the restored file, records
no false success, and refuses to continue. New empty databases do not need a
backup.

The tests inject a deliberately failing migration against a temporary database
and prove that the original rows and schema version survive. Production does
not expose a migration-debug command.

## Catalogue snapshot contract

The import accepts UTF-8 JSON no larger than 5 MiB and at most 10,000 items.
Each item has:

- a non-empty unique `sourceKey` supplied by the workbook projection;
- an optional positive `sourceRow` used only as supporting evidence;
- title, description, optional ISO date, optional series and episode;
- non-negative `xTeasers` and `redditTeasers` counts; and
- a bounded map of supported platform names to canonical HTTPS URLs.

Unknown fields, duplicate source keys, invalid dates, negative counts,
unsupported platforms, non-HTTPS links, overlong text, and over-limit snapshots
reject the entire import. The transaction does not partially apply.

Platform coverage accepts canonical post URLs only. Hosts and post-path shapes
must match the named platform; query strings and fragments are rejected except
for Pornhub's single bounded `viewkey`. The importer stores a normalized URL,
never arbitrary navigation URLs or credential-like parameters.

The first import creates an opaque GUID for each source key. Later imports
update the projection by source key while retaining the GUID and every confirmed
asset binding. Missing source keys become `archived` locally rather than being
deleted. Importing the same snapshot twice is idempotent.

The source file is only read. The desktop app never writes to it and never
stores raw workbook data outside the normalized local projection.

## Thumbnail inventory and identity

Johnny's current source is:

`D:\MEDIA - SELFMADE\Youtube2\.DONE_DEEDS\.thumbs`

The first scan chooses this (or another creator's folder) through a native
folder picker and stores that choice in the local database. The absolute path
is not compiled into or shipped with the package. If the remembered folder is
moved or removed, the next scan opens the picker again instead of trapping the
user on a dead path.

The scanner is recursive, skips reparse points, accepts PNG, JPEG, and WebP,
and stops at 20,000 files. It holds the selected root open and verifies each
opened file's final handle path before hashing it, so a root or queued child
swapped for a junction cannot escape the selected tree. It records file name,
absolute path, length, last write time, SHA-256, and a role hint:

- `_33` -> Pornhub 640x360 artwork;
- `_4K` -> Clips4Sale 4K artwork;
- otherwise -> curated artwork.

The suffix and `a` through `d` alternatives are evidence only. A rescan updates
the existing asset by SHA-256, so a confirmed binding survives a rename or
move. A disappeared file becomes unavailable; its binding and history remain.
No scan mutates the source tree.

### Deterministic matching

Candidate order is fixed and inspectable:

1. an existing confirmed binding;
2. an exact content hash already bound to an item;
3. exact normalized source-key tokens in the filename;
4. normalized title, series, and episode token overlap;
5. planned-date proximity; and
6. stable item-ID tie-break.

Only evidence levels 1 and 2 auto-bind. Filename and catalogue text only rank a
maximum of five candidates. No candidate, a weak top candidate, or a top-two
tie becomes `needsSelection`. The user sees the relevant curated thumbnails
and chooses once. That confirmation is stored and audited.

Perceptual video/frame hashing remains part of the approved programme but is
not faked in this catalogue-only slice; it belongs with the media probe in the
media-engine milestone.

## Desktop API

The WebView uses four strict operations:

- `getCatalogue`: returns bounded item summaries and current inventory state;
- `importCatalogueSnapshot`: imports validated JSON text;
- `scanThumbnails`: scans a supplied root only after desktop-side validation;
- `confirmAssetBinding`: records one item selection for one known asset.

The router rejects unknown fields and malformed IDs. It never returns absolute
paths. Thumbnail images are served to the WebView through an opaque
`https://thumbs.ofenhancer.local/<asset-id>` resource handler that resolves only
known available assets inside the configured root. Traversal, unknown IDs, and
paths outside the root fail closed.

In this milestone the catalogue mutations are desktop-only. The Chrome-hosted
copy shows the database as unavailable rather than inventing state. Native
Messaging catalogue transport can be added when the extension needs to consume
catalogue identity during an authenticated action.

## Catalogue interface

This is an extension of the existing restrained desktop visual system, not a
new product identity. It is an Operate surface built for quick scanning.

The Catalogue page contains:

- a compact header with item and thumbnail status;
- Search, `All`, `Needs thumbnail`, and `Bound` controls;
- thumbnail rows with title, planned date, platform coverage, and the only two
  social counts the user asked to see: X and Reddit;
- an honest first-run state with `Import snapshot` and `Scan thumbnails`;
- an inline needs-selection state; and
- a native dialog showing up to five candidate videos with thumbnails and one
  explicit `Use this video` action.

Import and scan success/error messages use a polite status region. Loading
uses a stable skeleton. Keyboard focus, 44-pixel controls, reduced motion,
compact desktop, and 390-pixel layouts are required. No sensitive title or
thumbnail appears in a Windows toast.

## Verification

Automated verification must prove:

- a new database receives schema v1;
- a failing migration restores the exact prior database;
- malformed or duplicate snapshots make zero changes;
- re-import keeps opaque IDs and confirmed bindings;
- rescanning a renamed identical file keeps the same asset and binding;
- filename similarity ranks but never auto-binds;
- unknown/out-of-root thumbnail URLs cannot read files;
- the Catalogue view renders first-run, populated, filtered, ambiguous, error,
  and narrow-screen states without console errors or horizontal overflow; and
- package output contains the database runtime but no database, backup, real
  path, private snapshot, or test fixture.

No automated or manual verification clicks a public platform control.
