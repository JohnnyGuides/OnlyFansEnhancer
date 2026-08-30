# Catalogue Episode Picker Design

Date: 2026-08-30
Status: Approved in chat; written-spec review pending

## Goal

Replace the upload console's single inferred catalogue match with a
deterministic proposal engine backed by an explicit, searchable episode picker.
For a strong unique match, the console proposes the catalogue episode, missing
platform targets, and per-platform Friday schedule in one Yes/No card. Yes is
the authoritative association for that upload run. No exposes the filtered
picker without changing any site or sheet state.

This makes the planned `2026 Video Catalogue` schedule the source of truth
without requiring consistent filenames, fuzzy auto-commit, an LLM, or another
machine-learning service.

## Scope

This milestone will:

- load the populated catalogue rows and the next writable empty row through the
  existing authenticated Apps Script bridge;
- read Season/Arc and Episode so ordered series can be sequenced without AI;
- show likely rows first while allowing selection of any catalogue row;
- include `+ Add new catalogue entry` as an explicit choice;
- display each row's planned date and OnlyFans, Fansly, ManyVids, and Pornhub
  link state;
- preselect platform targets whose catalogue links are empty;
- use the catalogue date, series predecessor, extension upload ledger, and live
  authenticated platform queue to propose the earliest valid Friday;
- use deterministic, visible ranking signals only;
- make nonempty sheet metadata authoritative and fill only empty metadata
  fields from the upload draft;
- retain a single Yes/No proposal and fingerprinted, empty-only sheet writes;
- keep rows already linked to every inferred target out of the default
  likely-results group while retaining a `Show all` path.

The proposal engine will not:

- infer semantic equivalence between arbitrary names;
- fingerprint video files;
- add an LLM, embeddings, or a learning model;
- scan historical platform posts;
- resolve the complete legacy backlog automatically.

Pornhub link presence participates in target inference immediately. Actual
Pornhub file transfer, scheduling, submission, and link capture remain a
separate trace-driven adapter milestone. The existing Pornhub preset helper can
fill verified metadata, but it intentionally leaves site Save/Submit manual and
is not evidence that full upload automation exists.

## User Flow

1. The creator chooses the full video and optional/shared supporting media. The
   console initially suggests the next Friday and loads the catalogue.
2. If the catalogue bridge is configured, the console loads the catalogue once
   and ranks its rows locally whenever the draft changes.
3. When one row is a strong unique match, the console immediately prepares one
   proposal. For example:

   ```text
   Likely episode: Battlefield Episode 3
   Evidence: strong wording match; OF yes; Fansly yes; Pornhub missing
   Previous episode: scheduled on Pornhub for 4 September
   Proposal: Pornhub on 11 September at 15:00 UTC
   Yes / No
   ```

4. Yes accepts the episode, targets, and dates. No performs no mutation and
   opens a searchable episode control with these groups:
   - `Likely matches`
   - `All catalogue entries` when `Show all` is enabled
   - `+ Add new catalogue entry`
5. Every existing-row option includes its title, planned date, and compact link
   state, for example:

   ```text
   Claire — 28 Aug 2026 · OF yes · Fansly yes · MV missing · PH missing
   ```

6. Selecting an existing row fills a replacement proposal from that row:
   - a future sheet release date becomes the earliest allowed upload date;
   - a past sheet release date remains historical context and the upload plan
     keeps the next-Friday suggestion;
   - nonempty sheet title and description win;
   - an empty sheet metadata field may use the current draft value;
   - existing links are never changed by selection.
7. Selecting `+ Add new catalogue entry` proposes the empty row for the Friday
   already selected in the console. If several executable targets are pending,
   it proposes the first Friday that is verified free across all of them so the
   new release remains synchronized.
8. The final plan shows the exact row, matching reasons, inferred targets,
   metadata sources, target cells,
   and platform operations. Nothing writes or uploads before Yes.
9. No returns to the editable picker. Yes prepares the authenticated platform
   tabs and commits results with the existing safety rules.

If the bridge is unavailable, the existing explicit upload-only path remains
available, but it cannot provide catalogue choices or reconciliation.

## Picker Interaction

Use native HTML controls and the existing console styling:

- a text search field;
- a native select/list of currently filtered options;
- a `Show all catalogue entries` checkbox;
- a compact selected-row explanation beneath the control.

The select value is the numeric sheet row, never the displayed title. Duplicate
titles therefore remain unambiguous. Keyboard selection and visible labels are
required; no custom combobox framework or dependency is needed.

The selection behavior is conservative:

- a previously user-selected row remains selected while it is still valid;
- a strong unique result may become the single proposal, but not a mutation;
- an ambiguous result opens the picker instead of fabricating certainty;
- the final Yes button stays disabled until a proposal identifies one existing
  row or `+ Add new`, at least one pending executable target, and verified
  scheduling evidence.

## Catalogue Data Contract

Add one read-only bridge action that returns a bounded catalogue snapshot. Each
populated row contains:

- sheet row number;
- catalogue ID;
- release date;
- title;
- description;
- Season/Arc;
- Episode;
- Pornhub, OnlyFans, Fansly, and ManyVids links;
- the existing protected-row fingerprint.

The response also contains the first fully empty writable row. The bridge reads
only the existing A:L catalogue rectangle and caps accepted row numbers at the
current 5,000-row safety boundary.

The console loads this snapshot once per open console or after an explicit
refresh. Draft edits only rerank the local snapshot; they do not repeatedly call
Apps Script.

The current match action can remain temporarily for compatibility, but the new
console flow will not use its single-candidate result.

## Target Inference

For an existing row, an empty canonical platform-link cell is evidence that the
platform remains pending; a nonempty cell is evidence that it must not be
uploaded again. The mapping is Pornhub H, OnlyFans J, Fansly K, and ManyVids L.

The proposal preselects every pending platform for which a trace-backed upload
adapter is available. A missing Pornhub link is shown as a recommended target,
but Yes cannot claim it will execute until the separate Pornhub upload adapter
passes its own trace and submission tests. If no link is missing, the console
refuses to propose a duplicate upload.

The user may change inferred targets after No. Target inference never writes a
link, treats a scheduled item as published, or overrides a nonempty cell.

## Queue Evidence and Upload Ledger

The extension stores a small local ledger for every upload it prepares:
catalogue row and fingerprint, platform, intended Friday, platform job/post ID
when available, canonical link when captured, and state (`prepared`,
`scheduled`, `published`, `removed`, or `unverified`). The ledger stores no
video bytes.

Before showing the final proposal and again immediately before Yes, the
platform adapter reads the authenticated creator queue in that platform's own
browser context. It reconciles the live queue with the ledger:

- a live scheduled item updates or confirms the ledger;
- a manually deleted item becomes `removed`;
- a changed date replaces the stale ledger date;
- conflicting or unavailable live evidence becomes `unverified` and disables
  automatic scheduling for that platform.

The live queue wins over local history. The extension does not send a naked
authenticated request outside the site's browser context. Each live queue
reader requires trace-backed endpoints or controls and deterministic fixtures;
until a platform has that evidence, it cannot claim queue-aware scheduling.

## Scheduling Semantics

Scheduling is calculated independently for each proposed platform:

1. Calculate the next Friday in the console's existing 15:00 UTC schedule.
2. If the selected row has a valid future catalogue date, use it as the earliest
   allowed date. A historical date remains context and is not rewritten.
3. If Season/Arc matches exactly after normalization and Episode is a positive
   integer, find the greatest lower episode number as the predecessor. Do not
   infer a predecessor from row adjacency or title semantics.
4. If that predecessor is live-scheduled on the target platform, the earliest
   date is the following Friday.
5. Walk forward by seven days until the target platform's verified queue has no
   conflicting upload in that Friday slot.
6. Show the predecessor, occupied slots, and final date as proposal evidence.

Thus a three-month-old episode that already has OnlyFans and Fansly links but
lacks Pornhub can rank as the likely episode and infer Pornhub as the target. If
its preceding episode is scheduled on Pornhub next Friday, the proposal uses
the Friday after that. This is deterministic sequence and queue analysis, not
semantic AI.

For the catalogue state inspected on 2026-08-30, the final populated schedule
row is 135 (`1 push-up = 1 orgasm`) dated 2026-08-28, with no later planned
rows. With no predecessor or live platform conflict, the current baseline is
Friday 2026-09-04 at 15:00 UTC.

Selecting an existing historical row does not rewrite its release-date cell.
This matters when catching ManyVids or Pornhub up to an episode already released
on OnlyFans or Fansly: the catalogue retains the episode's original release
date while the new platform upload uses the suggested Friday. Add New remains
the only path that writes a new release date into column B.

## Deterministic Ranking

Ranking affects display order only. It cannot authorize a selection or sheet
write.

Normalize comparison text by:

- Unicode normalization and lowercasing;
- replacing punctuation/underscores with spaces;
- collapsing whitespace;
- stripping only the approved standalone noise tokens `full`, `limited`,
  `final`, `vr`, and common video extensions.

Score each populated row with the existing simple primitives:

1. Exact normalized title or ID match is the strongest signal.
2. Filename and draft-title token overlap with row title and ID provide a
   bounded similarity score.
3. Season/Arc and an explicit episode number strengthen an otherwise matching
   candidate; they never create a match alone.
4. Description overlap remains a lower-weight tie-breaker.
5. Rows missing platform links rank above fully linked rows after text matching.
6. Sheet row number is the stable final tie-breaker.

A row may become the single proposal only when its existing composite score is
at least 75, its best title/ID token similarity is at least 0.75, and it leads
the next row by at least 0.15 similarity. Token similarity reuses the existing
Dice coefficient: twice the unique-token overlap divided by the total unique
tokens in both values. Otherwise the console opens the picker. These constants
remain covered by fixtures and can change only with a reported false-positive
or false-negative example.

The UI lists the reasons beside the selected candidate, such as `exact ID`,
`5 of 6 title words match`, `Episode 3`, or `Pornhub missing`. It does not show
a rounded "90% confident" label or imply semantic understanding.

Rows already linked to all inferred targets are excluded from `Likely matches`
to reduce accidental duplicate uploads. They remain reachable through `Show
all` and are visibly marked as already linked. The final preparation step still
removes already-linked targets and refuses an empty target set.

## Existing Row and Add-New Semantics

### Existing row

- Preserve all nonempty A:D metadata.
- Use a future column-B date for the platform schedule; otherwise preserve that
  cell and use the next-Friday suggestion only in the upload plan.
- Use a draft value only where the corresponding selected-row field is empty.
- Preserve every nonempty platform link.
- Re-read and fingerprint-check the row before every platform-link commit.

### Add new

- Use the selected Friday as the scheduling floor and choose the first common
  verified-free Friday across all executable targets.
- Propose the first fully empty row returned by the snapshot.
- Derive the internal catalogue ID with the existing collision-safe slug logic.
- Write A:D only with the first successful platform-link commit, as today.
- Write each platform link independently and only into its empty cell.

## Pornhub Boundary

The snapshot reads Pornhub H so backlog and target inference are truthful. The
current preset helper may apply orientation, tags, and categories, but leaves
Save/Submit manual. Full Pornhub automation requires a trace covering file
selection, upload completion, title, description, categories/tags, scheduling,
submission, scheduled-queue discovery, deletion/date-change reconciliation,
and canonical `viewkey` capture. Only then may Pornhub become an executable Yes
target and commit H through the existing fingerprinted empty-only bridge.

## Delivery Gates

The common implementation plan covers the catalogue snapshot, deterministic
proposal engine, picker fallback, target inference, ledger, and queue-reader
contract. A platform becomes queue-aware only when its reader has a captured
fixture proving scheduled-item identity, date, deletion, and date-change
behavior. A platform becomes an executable target only when its upload adapter
also proves file transfer, final submit, and canonical-link capture.

These gates allow OnlyFans, Fansly, and ManyVids to retain their current proven
upload behavior while queue readers are added independently. Pornhub may appear
as `recommended but not yet executable` until its additional trace is supplied;
the UI must never turn that limitation into a working-looking Yes button.

## Error Handling

- Snapshot authentication, deployment, or network failure leaves the picker
  unavailable and offers the existing explicit upload-only choice.
- A missing or changed selected row stops preparation and requests a catalogue
  refresh.
- Duplicate visible titles are safe because selection uses row number.
- A selected row already linked to every chosen platform disables Yes and
  explains that nothing is pending.
- A stale row fingerprint stops only the sheet commit; it never retries a
  platform submission.
- Search with no results keeps `+ Add new` visible and offers `Show all`.
- Ambiguous text similarity opens the picker rather than selecting a row.
- Missing or contradictory live queue evidence disables automatic scheduling
  for that platform and identifies the exact missing evidence.
- A predecessor without a positive numeric Episode is ignored for sequencing.

## Testing

Add focused tests proving:

- the bridge snapshot maps columns A:L correctly, including Pornhub H;
- the snapshot exposes Season/Arc E and Episode G without changing sheet data;
- the first empty row and row bounds remain deterministic;
- ranking is stable, explainable, and never authorizes a row;
- selected rows use sheet metadata when nonempty and draft metadata only when
  the sheet cell is empty;
- strong unique wording yields one proposal while ambiguous wording opens the
  picker;
- link presence infers only missing targets and never selects a linked target;
- series ordering uses exact normalized Season/Arc plus numeric Episode;
- a predecessor scheduled next Friday moves that platform proposal to the
  following Friday;
- verified occupied slots move forward one Friday at a time;
- live queue deletions and date changes override the local ledger;
- unavailable live queue evidence never masquerades as verified scheduling;
- future selected-row dates set the scheduling floor, while past or empty dates
  retain the next-Friday floor without rewriting B;
- duplicate titles select distinct numeric rows;
- linked rows are hidden from likely results but available through `Show all`;
- Add New uses the chosen Friday and the existing empty-row proposal;
- no platform mutation or sheet write happens before final Yes;
- stale and conflicting rows retain the existing fail-closed behavior;
- upload-only mode continues to work without a bridge.

The final verification remains `npm run check`, including a fresh personal
extension package and unpacked Chrome load.

## Iteration Evidence

The first version records no behavioral telemetry and trains nothing. Follow-up
ranking changes must come from concrete examples the creator reports as poorly
ordered. The trace or test fixture for each example becomes a deterministic
regression test before the scoring rules change.
