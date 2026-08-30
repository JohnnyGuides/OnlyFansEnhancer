# Authenticated Upload and Catalogue Design

## Status

Approved through the creator-workflow decisions recorded on 2026-08-22. This
is the `0.10.0` milestone that replaces the read-only upload probe with a real,
one-confirmation OnlyFans and Fansly workflow.

## Outcome

The creator selects a full video once, optionally selects a separate teaser,
and supplies or accepts catalogue metadata. The extension matches the episode
against `Work / 2026 Video Catalogue`, shows one compact summary, and after one
**Yes** drives the real authenticated OnlyFans and Fansly pages. Each confirmed
platform success is written to the catalogue immediately and independently.

The extension does not recreate private platform APIs. It transfers files into
the sites' real controls, drives the observed user interface, and observes only
the final successful create-post response needed to recover the public post
link.

## Locked workflow

- OnlyFans receives the full video and description. It does not receive the
  catalogue title and the extension does not select or change labels.
- Fansly receives the teaser through **Add Free Preview** on the full video's
  media bundle, while the full video is locked using the exact access preset
  `defaulT`. It receives the description,
  not the catalogue title.
- Pornhub, ManyVids, and Clips4Sale titles are outside this milestone. The
  catalogue still keeps a title because it is required for matching and new
  rows.
- Full-video upload begins immediately after confirmation. A missing teaser
  does not delay OnlyFans or the Fansly full upload; Fansly pauses before final
  submission until the creator supplies the teaser in the console.
- Publication is always Friday at `15:00 UTC`. The UI displays the corresponding
  local time without treating a fixed CET offset as authoritative.
- One confirmation starts both selected platforms. A failure on one platform
  does not roll back the other. Only pre-submission failures can retry the
  platform; after submission, a known post URL retries the catalogue commit
  only, while an unresolved link stops for manual recovery.

## Catalogue contract

The only spreadsheet in scope is:

- file: `Work`
- spreadsheet ID: `1Ninkxbv1SOvatcJ3AP4zwKWxdc32imlIkP_IMUSTR9E`
- tab: `2026 Video Catalogue`

Relevant columns are `A ID`, `B Release Date`, `C Title`, `D Description`,
`J Onlyfans Link`, and `K Fansly Link`.

Before confirmation the bridge returns one best candidate plus a confidence
explanation. Matching is deterministic and local to the bridge: normalized
filename/title tokens, description similarity, exact release Friday, nearby
Friday distance, and whether the requested link cells are empty. It does not
use an LLM.

If there is a credible existing candidate, the summary asks “Is this your
video from the sheet?” and Yes selects it. If no credible candidate exists,
the preview proposes the first empty catalogue row for the target Friday. A new
row writes only:

- `A`: a unique slug derived from the catalogue title;
- `B`: the target Friday date;
- `C`: the catalogue title;
- `D`: the description.

Season, category, tags, costs, thumbnails, and unrelated platform columns stay
untouched. A commit may fill `J` or `K` only when the cell is blank or already
contains the same canonical link. A different existing link is a conflict and
must never be overwritten automatically.

Every match result carries a row fingerprint. Every commit takes a script lock,
re-reads the row, verifies that fingerprint and the safe-link rule, then writes
only the requested cells. Successful platform links are committed immediately,
not after the other platform finishes.

## Components

### Upload console

The extension console owns the selected `File` objects in memory. It contains
separate **Full video** and optional **Teaser** inputs, title and description,
the next Friday at 15:00 UTC, selected targets, catalogue match status, one
confirmation button, and per-platform progress/retry cards.

File bytes, file paths, titles, and descriptions are never stored in
`chrome.storage`. Closing or reloading the console intentionally loses them.
Only the sheet endpoint URL, a random bridge secret, and non-sensitive workflow
preferences may be stored locally.

### File bridge

Chrome runtime messaging is JSON-oriented and is not used for large video
bytes. Each platform tab receives a small web-accessible extension iframe.
The iframe and upload console share the extension origin and exchange `File`
objects over a session-scoped `BroadcastChannel`. The iframe forwards the file
to its parent with structured clone; the isolated content script validates the
session and assigns it to the exact platform input with `DataTransfer`, then
dispatches native `input` and `change` events.

The bridge accepts files only for a currently active upload session, expected
platform, expected role (`full` or `teaser`), and exact tab. It never exposes a
filesystem path or serializes file bytes to storage.

### Platform adapters

Adapters are explicit state machines using the controls observed in the final
traces. They re-find and validate each control immediately before use and fail
closed on missing or ambiguous state.

OnlyFans:

1. open/reuse `https://onlyfans.com/posts/create`;
2. transfer full video to `#file_upload_input` through the media control;
3. fill the TipTap/ProseMirror description with native input events;
4. leave every label checkbox unchanged;
5. open scheduling, select the UTC-derived date and local platform time, and
   confirm;
6. wait for upload readiness, then click the unambiguous final Save/Schedule
   control once.

Fansly:

1. open/reuse the authenticated home composer;
2. select `Upload New` and transfer the full video;
3. mark the full video locked using exact preset `defaulT`;
4. choose **Add Free Preview** on that full-media bundle and transfer the
   teaser into the preview slot;
5. fill the description;
6. open the clock-over-calendar schedule control, set the UTC-derived local
   date/time, and click `Confirm Date`;
7. click Schedule/Post and the final confirmation once.

No generic “first matching button” fallback is allowed. The adapters can use
the exact stable selectors proved by the traces and semantic text/role checks
as a guarded fallback. If both disagree, the run pauses for manual recovery.

### Final-response observer

A minimal MAIN-world observer is installed before the final platform click. It
observes XHR completion for only:

- OnlyFans: `POST /api2/v2/posts`
- Fansly: `POST /api/v1/post`

It does not read request headers, cookies, authentication tokens, upload
requests, or request bodies. On a successful response it recursively extracts
only an unambiguous same-platform post URL or post ID. Ambiguous or unfamiliar
responses produce `posted-link-unresolved`; they never write a guessed link.

### Sheet bridge

An Apps Script web app attached to `Work` exposes two small actions:
`matchCatalogue` and `commitPlatformLink`. Requests must include the shared
secret configured in Script Properties and the extension. The script rejects
other spreadsheet IDs, sheets, actions, columns, or oversized input.

Apps Script is preferred over driving the Sheets DOM because it is stable and
range-precise, and over Google OAuth because it avoids a separate Cloud client
for one private sheet. Deployment is a one-time authenticated setup; the
extension provides the script source and settings fields but cannot silently
deploy it for the creator.

## Confirmation and recovery

The mutation summary shows the selected row or proposed new row, Friday/time,
full and teaser filenames, per-platform media mapping, `defaulT`, description,
and exact catalogue cells that may be filled. Only **Yes, upload** mutates a
platform or the sheet.

After confirmation:

- `uploading-full`, `waiting-for-teaser`, `configuring`, `scheduled`,
  `link-captured`, `catalogue-updated`, `failed`, and `conflict` are explicit
  states;
- retries resume only the failed platform;
- already committed links are idempotent;
- a missing teaser can be selected while full uploads continue;
- navigation, logout, selector ambiguity, changed catalogue rows, and unknown
  response shapes fail closed with a precise recovery message.

## Verification boundary

Automated browser fixtures must prove file assignment, description entry,
schedule selection, label non-mutation, Fansly media roles/preset selection,
one final click, response parsing, partial failure, retry, and immediate safe
sheet commits. Real authenticated testing may upload files only when the
creator explicitly confirms in the console; automated verification must not
publish real content.
