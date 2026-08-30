# ManyVids Upload Automation Design

## Status

Approved by the creator on 2026-08-30. This extends the authenticated upload
console with a real, one-confirmation ManyVids workflow. The final requirement
added during approval is that the uploaded video's continue/edit button on
`/upload-video` must be clicked immediately after processing finishes; a
completed upload left on that page may disappear after roughly one hour and
must never be parked there by the extension.

## Outcome

The creator selects the full video once, supplies the shared teaser, and may
optionally supply a ManyVids thumbnail. The same confirmation that starts the
selected OnlyFans and Fansly jobs may also start ManyVids. After **Yes**, the
extension drives the authenticated ManyVids upload page and edit page through
their real controls, saves the completed video promptly, derives the canonical
`https://www.manyvids.com/Video/{id}` link only after confirmed Save success,
and commits that link to the catalogue's existing `ManyVids Link` cell.

The extension does not replay a private ManyVids API, retain video bytes, or
automate deletion.

## Observed workflow

The design is grounded in the two creator traces captured on 2026-08-28 and
2026-08-30:

- `creator-upload-trace-manyvids-2026-08-28T21-50-40-078Z.json` proves that a
  full-video upload at `/upload-video` transitions to `/Edit-vid/{id}` and
  exposes the title, description, preview, tags, price, and schedule controls.
- `manyvids-uplaoded-clicked-on-save-went-to-content-manager-and-deleted.json`
  proves the custom thumbnail flow, the final Save action, successful
  navigation back to `/upload-video`, the canonical `/Video/{id}` link, and the
  content-manager route.

The deletion events at the end of the second trace are evidence only. No
adapter, recovery path, or test fixture may expose or call a Delete action.

## Locked creator defaults

The upload plan uses the creator's recorded workflow and the human-readable
labels verified against the authenticated edit form:

- full video: the console's **Full video** file;
- custom preview: the console's shared teaser file;
- thumbnail: an optional separate ManyVids image file;
- title and description: the catalogue title and description;
- co-performer: none;
- price mode: `Set Your Price`;
- price: `$19.99`;
- schedule: Friday at `15:00 UTC`;
- Vid Bundle: `This vid is not included in your Vid Bundle`;
- Premium: `Include this Vid to Premium`;
- tags: the ten configured ManyVids tags, selected through exact autocomplete
  matches.

The extension validates both stable control identity and visible label. If the
selector and label disagree, it stops instead of guessing. The optional
thumbnail is the only input that may be absent; when it is absent, the
site-generated thumbnail is preserved.

## Console and confirmation

The console adds **ManyVids** to the platform choices and a separate optional
**ManyVids thumbnail** picker. The existing teaser is shared by Fansly and
ManyVids. Confirmation is disabled until every required file and catalogue
field for the selected platforms is present.

The single confirmation summary shows:

- the matched catalogue row or proposed new row;
- full video, shared teaser, and optional thumbnail filenames;
- title, description, Friday, and `15:00 UTC`;
- `$19.99`, no co-performer, exact bundle and Premium modes, and tags;
- the exact catalogue cells that may be filled.

There is no second normal-flow approval on the ManyVids tab. **Yes, upload** is
authorization for the adapter to continue through Save. The extension never
clicks Save before the edit-page plan has been completely verified.

## Two-stage ManyVids job

ManyVids is a navigation-spanning state machine rather than a one-page content
script.

### Stage 1: create the draft

1. Open or reuse `https://www.manyvids.com/upload-video` in an authenticated
   tab.
2. Verify the expected upload surface and transfer the full video through the
   real file control.
3. Wait for the site's processing to expose exactly one completed-upload card
   for the selected filename and exactly one enabled continue/edit button on
   that card. A generic first-button fallback is forbidden because the same
   card also exposes deletion.
4. Record `uploadReadyAt` and click that verified continue/edit button
   immediately. The trace proves that this click transitions from
   `/upload-video` to `/Edit-vid/{numeric-id}`.
5. Capture the numeric ID and bind it to the active console job. Once an ID is
   captured, that job must never return to Stage 1 or upload the full video
   again.

### Stage 2: complete and save immediately

1. Reattach the adapter after navigation and record `editPageEnteredAt`.
2. Transfer the shared teaser through **Custom Preview → Upload**.
3. When supplied, transfer the thumbnail and complete the thumbnail's own Save
   control before continuing.
4. Fill title and description.
5. select all ten tags by fresh exact autocomplete matches and verify the final
   tag count;
6. set `$19.99`, the Friday/date controls, `15:00`, the bundle mode, and the
   Premium mode;
7. wait only for required site processing and verified control readiness;
8. click the unambiguous final **Save** control once;
9. if ManyVids shows a deterministic field-validation error, correct only that
   verified field and allow one explicit corrective Save attempt; never loop or
   blindly repeat the click.

There is no intentional delay, queue, or user pause after either upload
readiness or edit-page readiness. The continue/edit button is clicked as soon
as the completed card can be verified, and the final Save is clicked as soon as
the verified form is ready. A watchdog treats 45 minutes after full-file
assignment without reaching `/Edit-vid/{id}` as an urgent failure boundary,
leaving a safety margin before the observed roughly one-hour disappearance. It
surfaces an immediate manual-recovery warning and never starts a fresh
duplicate upload. This watchdog is a fallback, not a scheduler.

## Cross-navigation coordination

The upload console remains the owner of all `File` objects. File bytes and
local paths are never serialized into `chrome.storage`. Non-sensitive job
metadata may be kept in `chrome.storage.session`, including platform, tab ID,
catalogue row fingerprint, captured ManyVids ID, current stage, timestamps, and
whether Save was attempted.

The background service worker observes the expected ManyVids navigation and
re-injects the guarded adapter on the captured tab. The console then reconnects
its existing file bridge so the teaser and optional thumbnail can cross into
the edit page. Service-worker suspension must not reset the job to Stage 1.

If the console is closed or reloaded, its in-memory files are intentionally
lost. A captured ManyVids edit ID remains visible as a recoverable manual draft;
the extension does not guess files, re-upload, or Save an incomplete form.

## Success, link recovery, and catalogue commit

A captured edit ID proves only that a draft exists. It is not publication
success. The adapter marks Save successful only when the observed Save action
is followed by the proved success transition back to `/upload-video` without a
visible validation error.

After that transition, the canonical link is
`https://www.manyvids.com/Video/{captured-id}`. The link is committed
immediately to column `L`, whose live header is `ManyVids Link`, using the same
row fingerprint and safe-link rules as the OnlyFans and Fansly commits:

- fill the cell only when it is blank or already contains the same canonical
  link;
- never overwrite a different existing link;
- retry a failed sheet commit without re-uploading or re-saving ManyVids.

The ManyVids result is independent of the other platforms. A Fansly or
OnlyFans failure does not roll it back, and a ManyVids failure does not prevent
already-confirmed links from those platforms being committed.

## Failure and recovery rules

- Logged out, wrong route, missing control, ambiguous selector, label mismatch,
  missing required file, failed preview/thumbnail processing, invalid tag
  selection, or unknown Save result fails closed with a precise status.
- Before a ManyVids ID exists, retry may restart Stage 1.
- After a ManyVids ID exists, retry resumes only `/Edit-vid/{id}` and may never
  upload the full video again.
- After Save success, retry is catalogue-only.
- The final Save control is never clicked with an incomplete or unverified
  plan.
- Delete controls are permanently outside the adapter's allowed action set.

## Verification boundary

Automated fixtures must prove:

- the upload-page to edit-page transition and numeric ID capture;
- reattachment across navigation without losing the active job;
- correct full, teaser, and optional-thumbnail media roles;
- exact title, description, tags, price, Friday/time, bundle, and Premium
  settings;
- immediate verified continue/edit click after upload processing and no
  arbitrary wait before the final Save attempt;
- watchdog behavior before the one-hour disappearance boundary;
- one normal Save click and at most one deterministic corrective attempt;
- rejection of selector/label disagreement and ambiguous controls;
- successful navigation detection before canonical-link creation;
- idempotent resume rules that prevent duplicate uploads;
- safe column-`L` catalogue commits and conflict handling;
- absence of any Delete action from production code and fixtures.

Real authenticated testing must not upload or save content without the
creator's explicit console confirmation. Readiness checks may inspect semantic
controls but must not transfer files or click platform mutation controls.
