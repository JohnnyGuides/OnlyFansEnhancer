# Chrome X Teaser Reconciliation Design

## Goal

Extend the existing Chrome personal Creator Workflow Toolkit with a narrow X
Teaser Recorder. It binds one selected teaser file to one explicit
`Work / 2026 Video Catalogue` row before the user posts it on X. After X returns
one canonical status, it reconciles the confirmed row, the existing local teaser
audit, and the source file without an LLM, a repost risk, or broad filesystem
access.

Live X posting, live Sheet mutation, native-host registration, and real media
moves are acceptance gates. Development and automated verification use local
fixtures only.

## Chosen boundary

Add one focused recorder page and X adapter to the existing Chrome personal
extension. Reuse its catalogue client/contract, bridge configuration, background
service worker, packaging, and monotonic-session patterns. Add a small X session
store and Windows native host. Do not change identity masking, Realbooru,
creator-site upload adapters, or the Chrome Web Store edition.

Rejected alternatives:

1. A separate Chrome add-on plus native host duplicates bridge settings,
   fingerprints, permissions, and installation work.
2. A Firefox-specific partial build adds a second manifest/lifecycle and does not
   help the user's Chrome workflow.
3. A full cross-browser port adds unrelated surface without improving this task.

## Operator flow

1. Open **X Teaser Recorder** from the personal extension.
2. Select one teaser file. The recorder reads basename, size, `lastModified`,
   duration, and local SHA-256. It keeps the `File` and three representative JPEG
   frames only in the open recorder tab.
3. Load the bounded catalogue snapshot. Filename similarity may rank the list,
   but it never selects a row. The operator explicitly chooses one row.
4. Confirm one card containing exact file identity and catalogue row/ID. This
   freezes the pairing and current row fingerprint.
5. Post on X normally. This release observes X but does not click X's final Post
   control until an authenticated trace proves that flow.
6. The X adapter accepts only one visible status article whose canonical URL,
   `<time datetime>`, caption, and video metadata agree. A sensitive-media gate,
   missing video, multiple candidates, or unproved status leaves the session in
   `capture-needs-attention`.
7. After capture, the service worker persists the status ID before reconciliation.
   A captured status ID can never return to a pre-submit state or trigger a repost.
8. The native host appends the local audit entry and three frames. The Sheet
   bridge then re-reads the selected row and appends the canonical X URL to
   column O. Only after both succeed does the native host move the exact source
   file into `Done`.
9. The recorder reports status URL, row/ID, audit, Sheet, move, and the next manual
   recovery action.

## Pairing and identity

The catalogue row is always an explicit selection. Existing deterministic
similarity is advisory ordering only. A good filename is never sufficient
authority.

The frozen file proof contains only:

- basename, limited to 255 characters;
- byte size;
- `lastModified` milliseconds;
- duration seconds;
- lowercase SHA-256 hex;
- three in-memory JPEG frames until delivered to the native host.

No raw path, file bytes, cookie, credential, header, or request body enters
extension storage. The native host receives frame bytes only during the audit
operation and does not persist them outside the configured audit root.

## X capture boundary

X access is an optional host permission requested when the recorder starts. A
dynamically registered content script returns a bounded semantic record only
after all checks pass:

- canonical status URL and numeric status ID;
- caption text;
- exact ISO timestamp from `<time datetime>`;
- video duration;
- poster/media URL evidence;
- one unique status article;
- no unrevealed sensitive-content warning gate.

The first implementation is fixture-backed. It does not invent a private API or
claim a verified live selector contract. The authenticated smoke test must prove
the current X compose-to-status navigation and semantic adapter before live use.
Until then, an unsupported page fails closed and retains the pairing.

Representative frames come from the already-confirmed local `File`, not from an
X screenshot. This avoids warning overlays, cross-origin canvas failures, and
lower-quality recompression while proving the frames belong to the selected file.

## Restart-safe state

One Chrome-local record is keyed by a random session ID and contains only the
allow-listed pairing, bounded X metadata, row fingerprint, and monotonic stages:

`paired -> status-captured -> audit-complete -> sheet-complete -> moved`

`status-captured` is irreversible. Later saves cannot clear the status ID, URL,
or completed-stage flags. Writes for one session are serialized. A second session
cannot claim an already-recorded status ID. On a service-worker or browser restart:

- before status capture, resume observation only;
- after status capture, resume audit/Sheet/move only;
- after audit, never create different frames or a second audit entry;
- after Sheet, never append the URL again;
- after move, report the existing result.

## Sheet bridge

Extend the existing Apps Script bridge with `appendTwitterTeaser`.

- Read A:O so column O participates in the protected fingerprint.
- Column N remains untouched because it owns its existing count formula.
- Canonicalize only `https://x.com/<handle>/status/<numeric-id>`.
- Re-read the exact row under the existing script lock.
- Reject a changed fingerprint, row/ID mismatch, malformed URL, or ambiguous
  state.
- If column O already contains the exact canonical URL, return `idempotent`.
- Otherwise append the URL to the existing newline-separated links and verify
  the row after `SpreadsheetApp.flush()`.

Master Uploader calls continue to use the same bridge and become safer because
their row fingerprint also detects column-O drift. Existing platform link cells
remain no-overwrite.

## Native host trust boundary

Use one small .NET 8 Windows console host with Chrome native-messaging stdio
framing and a test-only one-request CLI mode. Configuration beside the executable
contains:

- allowed teaser root;
- audit root;
- `Done` directory name relative to the teaser root;
- audit filenames (`catalogue.json`, `frame-data.json`, `report-template.html`,
  `index.html`).

The current-user installer accepts the exact Chrome extension ID and generates a
native manifest with only that `chrome-extension://<id>/` origin. Packaging does
not run the installer or change the registry.

Messages contain a basename and stable identity, never an absolute path. Before
each operation the host:

- rejects rooted names, separators, `..`, invalid status IDs, and oversized data;
- resolves configured roots and every target to absolute paths;
- rejects source, audit, or destination paths outside those roots;
- rejects reparse points/symlinks in every existing path segment;
- requires exactly one source basename match;
- verifies size, UTC last-write milliseconds within filesystem precision, and
  SHA-256;
- rejects missing or multiple matches, identity mismatch, and destination
  collisions.

### Audit operation

The host validates all inputs before writing. Frame names are
`<catalogue-id>-<status-id>-f1.jpg` through `f3.jpg`. Existing frames are accepted
only if their SHA-256 matches; otherwise the operation fails. It appends one exact
entry to `frame-data.json`, appends the URL to the exact row in `catalogue.json`,
updates summary counts, and regenerates `index.html` by replacing the template's
single `__AUDIT_DATA__` marker. Aggregate JSON/HTML files use same-directory
temporary files and atomic replacement. A durable status receipt records exact
hashes and makes reruns idempotent.

### Move operation

The host requires the durable matching audit receipt. The extension calls it only
after the Sheet stage is durable. The host revalidates the source identity and
moves it to `<teaserRoot>/<DoneName>/<basename>` only when the destination does
not exist. It never deletes or overwrites.

## Failure ordering

The operation order is local audit -> Sheet -> move.

- Audit failure: Sheet and source remain unchanged.
- Sheet failure: audit is durable and source remains in place; resume at Sheet.
- Move failure: audit and Sheet are durable; resume only the exact move.
- Worker/browser restart: persisted monotonic state shows the first incomplete
  stage.
- X success without capture proof: no Sheet, audit, or move occurs; manual status
  recovery can bind one canonical status to the frozen session without reposting.

## Permissions

The personal Chrome extension adds:

- `nativeMessaging`;
- optional host permission `https://x.com/*`.

It reuses existing `storage`, `scripting`, `webNavigation`, and optional Apps
Script permissions. No broad file permission is added. The Chrome Web Store
edition remains unchanged.

## Verification

Automated tests use a fake bridge and temporary fixture roots. They cover:

- explicit pairing and filename-only non-authority;
- ambiguous catalogue ordering;
- canonical X status parsing and duplicate status rejection;
- row drift, column-O conflict, and idempotent append;
- monotonic recovery after each stage;
- sensitive-warning/frame gate rejection;
- native traversal/root/reparse escape, identity mismatch, multiple match, and
  destination collision;
- idempotent audit reruns and source move only after durable audit output;
- rendered Chrome UI at desktop, compact, and mobile widths;
- native host build and fixture integration;
- existing personal/store regression and package gates.

The human gates are current-user native-host installation, reloading the personal
Chrome extension, an authenticated X compose/status smoke without a real post,
one deliberate fixture reconciliation against a non-live bridge, and only then
explicit approval for live Sheet/audit/media use.

## External implementation facts

Chrome native messaging on Windows discovers the host manifest through
`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\<name>` or the machine
equivalent. The native manifest uses `allowed_origins`. Development and packaging
do not change the registry.

- <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
