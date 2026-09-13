# Google catalogue: setup and recovery

The Windows app connects to one selected Google spreadsheet. Read-only adaptive
import, optional reviewed write-back, and the older Apps Script bridge are
separate operations. Connecting one does not silently configure or migrate the
other. Use a disposable workbook copy for the first write-back acceptance.

## Desktop OAuth setup

Enable Google Picker, Drive, and Sheets APIs in the creator-controlled Google
Cloud project and create a **Desktop app** OAuth client. A Web application client
file is not accepted. Neither the repository nor a generic installer supplies
working credentials.

In Settings, open **Finish Google setup** or **Developer setup**, choose
**Import Google setup file**, and select the JSON downloaded for that Desktop
client. The native Windows picker validates the client ID and Google endpoints.
A file for a different configured ID is rejected without changing the saved
connection or catalogue. Cancelling changes nothing. Import into an unconfigured
app also fills its public client ID.

The current implementation needs the matching native client secret for token
exchange/refresh. It encrypts the imported ID/secret with current-user Windows
DPAPI in `%LocalAppData%\OFEnhancer\data\google-desktop-client.dat`. The secret is
sent only to Google's token endpoint, never to WebView, Chrome, authorization URL,
SQLite, logs, repository, or package. The downloaded JSON remains at its original
location; protect it separately. A public client ID alone does not complete
production setup.

Authorization uses `drive.file`, state/PKCE, a loopback callback, and a system
browser. Refresh credentials have their own DPAPI vault; access tokens stay in
memory. The selected browser is explicit; a saved browser that disappears falls
back to Windows default, and a launch failure offers reconnection. Google sign-in
is not embedded in WebView2 and does not reuse creator-site cookies.

For a personalized installer, create the ignored `.local/personal-installer.json`:

```json
{
  "extensionId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "googleOAuthClientId": "123456789012-exampleclient12345678.apps.googleusercontent.com"
}
```

These values are examples, not credentials. For fresh installations, omit
`extensionId`; guided Chrome setup uses the packaged stable personal identity.
An explicit legacy ID is an advanced compatibility setting and does not prove
installation. Supply your public Desktop client ID independently of Chrome.
`npm run build:desktop` reads this profile; its schema accepts only these public
settings, which seed absent desktop settings without replacing existing ones.
Never add the downloaded client JSON, its secret, or tokens. A generic build
exposes Developer setup instead. Google sign-in may use Edge or the system browser
even when Chrome is unavailable for uploads.

## Connect and import without changing the sheet

Select **Connect Google Sheet**, choose the browser when prompted, complete
consent, select exactly one spreadsheet, then return and select **Import catalogue**.
Confirm the worksheet name and imported count. This operation only updates the
local catalogue, not Google Sheets.

The reader examines the first 20 rows and first 24 columns (A–X) of visible tabs
for a unique header. It requires ID (also Video ID, Item ID, Source key) and Title
or Name. Recognized optional columns may move within A–X; matching ignores case
and punctuation, not meaning. Catalogue/Catalog tabs take priority over incidental
tables, but multiple matching catalogue tabs, headers, or columns stop import.

After discovery, only the selected tab is read, bounded to A1:X5002. At most 5,000
video entries are accepted, and a selected grid extending beyond row 5,002 is
rejected. Invalid mapped dates/counts or duplicate IDs stop before local changes.
Unrecognized columns are ignored; absent imported rows are archived, not erased.

Multiple links retain their original text and hyperlink evidence. Conflicting
displayed/hyperlinked posts are flagged, not silently resolved. Invalid link text
stays source evidence while only validated platform URLs become actionable links.
Correct ambiguous headers/data in the source or deliberately choose the right
workbook; do not relax validation to force an import.

## Optional reviewed sheet synchronization

Read-only adaptive import does not make an arbitrary sheet safe to mutate.
**Set up sheet sync** (or **Check workbook** for an existing connection) uses the
stricter sync profile. Inspect the proposal, choose **Review changes**, and verify
workbook, tab, row count, change count, and conflicts before **Yes, update the
workbook**. A changed proposal requires a new review. Once sync is ready, use its
controls rather than the separate read-only import for that session.

The migration is additive and preserves foreign cells, formulas, existing link
history, and row identity. Its owned structures include stable row developer
metadata `ofenhancer.item_id.v1`, the profile's grouped far-right fields, and
hidden `_Publications`, `_Assets`, and `_Audit` companion tabs. Exact layout and
validation are defined by `GoogleWorkbookProfile` and `GoogleWorkbookMigrator`,
not by an independently edited column map in this guide. Reapplying an already
verified proposal must not duplicate metadata, tabs, or history.

Write operations bind workbook/sheet/item/metadata IDs, expected field
fingerprint, intended canonical value, and a unique idempotency key. Physical row
numbers are not durable write targets. Sync re-finds the metadata row and verifies
its fingerprint before a narrow write, then verifies readback. Missing/duplicate
metadata, nonempty conflicting cells, changed identity, or fingerprint drift
blocks the mutation instead of overwriting another system's work.

## Recovery

The local outbox states are `pending`, `attempted`, `completed`, `conflict`, and
`unresolved`. They are monotonic. A timeout after a mutation might mean Google
accepted it; never convert it back to pending or repeat the HTTP write blindly.
Reconcile by read-only inspection. Matching intended remote data can complete the
operation; inconsistent or inconclusive evidence remains a conflict/unresolved
item requiring review. Migration has the same no-blind-retry rule.

A failed pull leaves the last verified catalogue visible with a truthful failure
state. Expired/invalid refresh credentials require reconnection, not deletion of
the outbox. Disconnect clears its saved refresh credential and connection selection but
preserves catalogue rows, audit/history, and pending work. It is not data deletion.
Do not edit the database or force a status transition as a routine repair.

Before the first live migration, use a disposable copy: compare protected cells
and formulas, repeat the verified setup to prove idempotency, move a bound row,
exercise a harmless owned-field sync, and prove a conflicting or uncertain write
is not repeated. The [acceptance procedure](acceptance.md) defines the boundaries.

## Optional Apps Script integration

Existing extension workflows and the X audit → Sheet → move flow can use a
creator-owned deployment of
[`catalogue-bridge.gs`](../integrations/google-apps-script/catalogue-bridge.gs).
Desktop OAuth setup does not replace it or silently move its data.

Create an Apps Script project for the **target catalogue**, copy that source,
set the Script Properties `CREATOR_UPLOAD_SECRET` (a private, high-entropy shared
secret) and `CREATOR_UPLOAD_SPREADSHEET_ID` (the exact chosen spreadsheet ID), then
**deploy it as a web app** with access appropriate to this personal integration.
Configure the HTTPS deployment URL and secret in the personal uploader settings.
Do not publish or commit either the secret or deployment-specific configuration.
A missing/invalid spreadsheet property fails explicitly; the script contains no
personal workbook ID.

The script has a deliberately fixed compatibility layout: `2026 Video Catalogue`,
`2026 uploads` presets, and `Creator Distribution Ledger`. Its constants and tests
own exact columns. Platform writes are narrow and fingerprint-protected under a
script lock; X URLs append to column O while the column-N formula stays untouched.
Identical links are idempotent and different existing main links are not replaced.
Subreddit preset revisions and distribution ledger IDs also participate in safe
reconciliation. Update the deployed script deliberately when that contract changes;
rebuilding an extension does not deploy Apps Script.

First rehearse with a non-live workbook/deployment and synthetic rows. The endpoint
receives bounded approved catalogue metadata, canonical links, and allow-listed
ledger information; it does not receive media bytes, local paths, cookies, or
Google desktop credentials. Its URL/secret are Chrome-local settings, unlike the
native desktop credential vault. Never imply a successful local catalogue record
has already been committed through either remote route.

## Verification boundaries

Item count (5,000) and physical row index (up to 5,002) are separate bounds.
The legacy Apps Script backend retains its row-5,000 write limit. Structural
inspection clips requested ranges to each sheet's reported grid size.

Reinspection first persists a not-ready state. Only successful verification
restores readiness. Conflicts remain blocked after restart; a transport failure
requires another inspection without being classified as a structural conflict.
Local rows, credentials and frozen outbox intent survive.

Projection reads request formula text, and migration inspection retains
user-entered formula evidence. Foreign formulas are not empty cells. Projection
writes use a row metadata ID with null entries for untouched columns and recheck
the destination header. These checks are not atomic compare-and-swap: concurrent
cell or column edits between validation and dispatch can still race the write.
The optional writer has no automatic production enqueue path. Live use requires
the separately authorized copy acceptance and exclusive editing coordination.

X recorder sessions freeze the Apps Script endpoint, workbook and worksheet.
Reconciliation requires matching remote append evidence; desktop-local
idempotency is insufficient. Old sessions without source/receipt evidence stop
for review. A durable append-attempt checkpoint prevents resubmitting an
uncertain append: recovery reads the frozen Sheet and moves only after finding
the exact item and status URL. Deploy the updated bridge deliberately before
pairing new remote reconciliation sessions.
