# Google Catalogue Sync Milestone 2B Design

## Goal

Connect the OFEnhancer desktop catalogue to one user-selected Google
spreadsheet without broad Drive access, a shared Apps Script secret, or a
hardcoded workbook ID. The desktop app must inspect the workbook before it
changes anything, show one exact migration proposal, require one Yes, preserve
stable video identity when rows move, and make every later write recoverable
and independently verifiable.

Milestone 2A remains the operational source: SQLite owns identity, bindings,
and pending work. Google Sheets is the creator-facing schedule and durable
human projection.

## Boundary

This milestone includes:

- one-time Google OAuth setup for the Windows desktop app;
- system-browser selection of exactly one Google spreadsheet;
- read-only workbook inspection and local catalogue import;
- an idempotent, explicitly confirmed workbook migration;
- stable row identity through Google developer metadata;
- a persistent local sync outbox with conflict and recovery states;
- narrow, fingerprinted, read-back-verified Sheet writes;
- compact Catalogue sync controls and truthful recovery messages; and
- fake-Google and temporary-database verification only.

This milestone does not:

- connect to or mutate Johnny's live workbook during automated testing;
- publish, schedule, delete, retry, or inspect authenticated creator sites;
- move or generate real media;
- make the Chrome extension depend on desktop sync yet;
- silently migrate the legacy Apps Script deployment; or
- claim that a Google Cloud OAuth client exists when none has been configured.

The old Apps Script bridge remains a compatibility path until a later
publishing milestone consumes the desktop outbox. Its source must no longer
ship a personal workbook ID, and new setup must not ask for a bridge secret.

## Chosen approach

### Google access

Use Google's desktop/mobile Picker OAuth flow in the system browser. The app
requests only `https://www.googleapis.com/auth/drive.file`, sets
`prompt=consent` and `trigger_onepick=true`, filters for Google Sheets, and
accepts exactly one `picked_file_ids` value. It uses a random `127.0.0.1`
loopback port, a cryptographically random state value, and PKCE S256. The app
never embeds Google sign-in in WebView2 and never uses the deprecated
copy/paste authorization flow.

The OAuth client ID is install-time/user configuration, not a secret and not
a repository constant. It must match Google's installed-app client-ID shape.
No client secret is accepted or stored. The selected file is validated through
Drive as an editable Google spreadsheet before its ID is persisted.

Refresh tokens are protected for the current Windows user with DPAPI and
stored in a dedicated local token file. Access tokens remain in memory and are
refreshed shortly before expiry. Logs, WebView messages, SQLite audit details,
and package output never include authorization codes, access tokens, refresh
tokens, or bearer headers. Disconnect deletes the local protected token and
workbook binding; remote revocation is an explicit user action, not a side
effect of a failed request.

### HTTP boundary

Use one injected `HttpClient` with fixed Google authorization, token, Drive,
and Sheets origins. Request builders percent-encode identifiers, bound payload
and response sizes, set timeouts, and reject redirects away from the expected
origin. A single 401 may refresh an access token and repeat a read. A mutating
request is never blindly retried; after an uncertain response the service
re-reads the target and either recognizes the idempotency key/readback or marks
the operation unresolved.

The implementation uses direct REST and the .NET standard library plus the
small official `System.Security.Cryptography.ProtectedData` package. It does
not add a general Google SDK, background framework, event store, or dependency
injection container.

## Workbook discovery and profile

The Picker-selected file ID is the sole workbook identity. The app never
searches the whole Drive by title and never chooses the first similarly named
file.

Inspection reads workbook properties, sheet properties, the first bounded
header area, the catalogue range, and matching developer metadata. It supports
one documented legacy catalogue profile in this milestone:

- preferred tab name: `2026 Video Catalogue`;
- rows: at most 5,000 populated catalogue rows;
- current fields: ID, release date, title, description, season/arc, episode,
  Pornhub Free, OnlyFans, Fansly, ManyVids, X links/count evidence, Reddit
  unique-teaser count, and Reddit links; and
- new grouped far-right fields: stable OFEnhancer ID, Pornhub Paid,
  Clips4Sale, and last verified sync.

The profile is selected by recognizable bounded header/column evidence, not by
the workbook ID. An exact preferred tab name breaks a tie only after its schema
matches. Zero or multiple credible tabs, duplicate stable IDs, more than 5,000
rows, a protected/uneditable file, or a non-empty conflicting far-right cell
stops inspection. The user gets a concise conflict; the app does not guess.

Profile and selected tab IDs are stored as data so a later settings milestone
can add other creator layouts without changing the sync engine. This milestone
does not build a generic spreadsheet-mapping language.

## Stable item identity and import

Every populated catalogue row receives document-visible developer metadata:

- key: `ofenhancer.item_id.v1`;
- value: the permanent local catalogue `item_id`; and
- location: the exact row dimension on the selected catalogue sheet.

The same opaque ID is written to the grouped far-right `OFEnhancer ID` cell as
human-recoverable evidence. Developer metadata is the runtime locator; the
cell and physical row number are readback/supporting evidence. Metadata stores
no secrets.

Before migration, a row without metadata is matched to the local catalogue by
its validated source key. If no local item exists, the local import creates
one opaque ID. A row whose metadata points to a different existing item, two
rows with one ID, or one row with multiple item IDs is a conflict. No metadata
is rewritten to make the conflict disappear.

Read-only inspection may import a normalized snapshot into the local store.
Rows with valid metadata retain that item ID even on a fresh local database.
Missing remote rows become archived locally only after a complete verified
pull. A partial or malformed response makes zero local catalogue changes.

## Workbook migration

Inspection produces a deterministic migration plan and SHA-256 plan hash. The
plan names only counts and structural outcomes in the main UI:

- rows to bind;
- far-right headers/cells to add;
- companion tabs to create or verify;
- legacy rows already correct; and
- conflicts that prevent migration.

The plan contains no token or private path. `Apply migration` opens one compact
Yes/No confirmation bound to the plan hash. Yes immediately re-inspects the
workbook. Any changed fingerprint invalidates the plan and returns to preview.

The migration is additive and idempotent:

1. create or verify hidden-by-default `_Publications`, `_Assets`, and `_Audit`
   tabs with versioned exact headers;
2. add/verify grouped far-right main-sheet headers without overwriting
   non-empty foreign data;
3. create missing row metadata and stable-ID cells;
4. hide/group only the new technical columns and companion tabs; and
5. re-read every affected structure and row before recording success.

Existing tabs, rows, formulas, links, formatting outside the owned ranges, and
the legacy `Creator Distribution Ledger` are retained. This milestone does not
rewrite existing publication history into the new tabs automatically.

Google's structural `spreadsheets.batchUpdate` is used for one validated
atomic migration batch where possible. If a request is invalid, the entire
batch fails. A network-uncertain result is reconciled by a complete readback;
the app never submits the same migration blindly.

## Local storage version 2

Schema version 2 adds only the persistence used now:

- `google_row_bindings`: workbook, sheet, local item, metadata ID, last
  observed row, and verified remote fingerprint;
- `sync_outbox`: immutable operation ID, unique idempotency key, item,
  destination field, bounded payload, expected remote fingerprint, monotonic
  state, attempt count, safe error code, and timestamps; and
- settings for the selected workbook/profile and last successful pull/sync.

Outbox states are `pending`, `attempted`, `completed`, `conflict`, and
`unresolved`. They never move backward. Startup converts no attempted row back
to pending. It first reconciles the remote target; a confirmed readback marks
completed, a differing value marks conflict, and an unavailable result remains
unresolved.

The OAuth token is not stored in SQLite. Migration from schema 1 uses the
existing verified-backup/transaction/restore mechanism.

## Sync contract

Each outbox write is one field projection for one stable item. The operation
freezes:

- workbook and sheet IDs;
- item ID and metadata key/value;
- destination field and canonical bounded value;
- expected remote field fingerprint;
- intended-value fingerprint; and
- a unique idempotency key.

Execution is strictly serialized:

1. refresh authorization if required;
2. search developer metadata for the item ID and require exactly one row;
3. read the exact target cell plus protected row evidence;
4. return idempotent success when it already equals the intended value;
5. stop with conflict when the expected fingerprint changed or a protected
   non-empty value would be overwritten;
6. mark the outbox row `attempted` before the HTTP mutation;
7. send one narrow values batch containing only the owned cell(s);
8. re-resolve the metadata row and read back the exact value; and
9. mark completed only after verified equality.

Physical row numbers are never persisted as the write target. No generic
automatic retry follows an attempted mutation. The UI offers manual `Sync now`
for pending work; conflicts require inspection or a newly authorized
replacement operation.

Only canonical public links, counts, stable IDs, timestamps, and documented
projection values may enter the Sheet. Absolute paths, captions, private
request material, credentials, and raw diagnostic retries are rejected by the
outbox validator.

## Desktop operations

The WebView receives strict bounded operations:

- `getGoogleCatalogueStatus`;
- `saveGoogleClientId`;
- `startGoogleCatalogueConnection`;
- `cancelGoogleCatalogueConnection`;
- `inspectGoogleWorkbook`;
- `applyGoogleWorkbookMigration` with one plan hash;
- `syncGoogleCatalogue`; and
- `disconnectGoogleCatalogue`.

Connection starts asynchronously so the WebView/dispatcher is not held while
the user is in the system browser. Status polling exposes only coarse states:
`notConfigured`, `disconnected`, `connecting`, `needsInspection`,
`migrationReady`, `ready`, `syncing`, `conflict`, or `error`. Browser callback
parameters and tokens never cross the WebView boundary.

All network/store work remains off the WPF UI thread and serialized with the
existing desktop dispatcher. Unknown fields, stale plan hashes, concurrent
start/sync attempts, and missing services fail closed with stable error codes.

## Interface

This extends the existing Catalogue page and restrained Operate visual system.
It does not add a new top-level page.

One compact `Google Sheet` strip sits between Catalogue controls and the list:

- disconnected: `Connect Google Sheet`;
- connecting: `Finish in your browser` plus Cancel;
- inspection needed: workbook name and `Check workbook`;
- migration ready: a short change summary and `Review changes`;
- ready: last verified sync, pending/conflict counts, `Sync now`, and a quiet
  reconnect/disconnect menu; and
- conflict/error: one direct reason and the next safe action.

Migration review is a native dialog with the exact workbook/tab, counts,
blocked conflicts, and only `No` / `Yes, update the workbook`. No technical
OAuth, metadata, fingerprint, scope, or outbox explanation appears unless the
user opens details.

Google client-ID setup lives in Settings under a collapsed `Google setup`
section. Normal use never repeats it. Copy remains short, human, keyboard
accessible, responsive at compact desktop and 390 pixels, and respectful of
reduced motion. No Windows notification includes a workbook title or video
data.

## Failure and recovery

- Cancelled browser consent returns to disconnected without an error toast.
- State mismatch, multiple picked files, wrong MIME type, or no edit capability
  discards the authorization result.
- Token refresh failure requires reconnect and leaves outbox rows unchanged.
- Read timeout leaves the last verified local catalogue visible and marks sync
  stale.
- Changed migration plan returns to preview; it is never auto-approved.
- Duplicate/missing metadata and non-empty conflicting cells stop writes.
- An attempted write with unknown outcome becomes unresolved and is reconciled
  by read only.
- Disconnect never deletes catalogue rows, audit history, or pending work.

## Verification

Automated tests use injected HTTP handlers, fake callback receivers, and
temporary SQLite/token folders. They prove:

- authorization URL, exact `drive.file` scope, Picker parameters, PKCE/state,
  one-file callback validation, token redaction, and refresh behavior;
- schema-2 migration backup/restore and monotonic outbox transitions;
- deterministic tab/profile discovery and fail-closed ambiguity;
- stable metadata binding across row moves and fresh-local import;
- migration plan hashing, stale-plan rejection, idempotent replay, and complete
  readback;
- no overwrite on fingerprint drift, duplicate metadata, or non-empty foreign
  values;
- uncertain mutation reconciliation without a second mutation;
- strict WebView payloads and no secrets/paths in responses;
- all Catalogue sync UI states, the Yes/No migration review, keyboard flow,
  desktop/compact/mobile layout, no overflow, and no browser-console errors;
  and
- staged/package output contains no token, workbook ID, client secret,
  personal Apps Script ID, database, backup, or live fixture.

An optional later acceptance test may use a separately created disposable
workbook after explicit user authorization. The live `2026 Video Catalogue` is
not an acceptance target for this milestone.

## Sources

- Google Picker for desktop/mobile apps:
  https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker
- OAuth 2.0 for desktop apps:
  https://developers.google.com/identity/protocols/oauth2/native-app
- Google Sheets developer metadata:
  https://developers.google.com/workspace/sheets/api/guides/metadata
- Google Sheets batch updates:
  https://developers.google.com/workspace/sheets/api/guides/batchupdate
- Values batch updates by data filter:
  https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdateByDataFilter
