# Upload Coordinator Vertical Slice Design

## Status

Approved in conversation on 2026-08-22 as the first bounded delivery of the
hybrid authenticated-tab architecture. This slice prepares the reusable
coordinator and proves page capability detection. It does not upload, post,
schedule, edit, or delete platform content.

## Purpose

Give the personal Creator Workflow Toolkit one extension-native upload console
where the creator selects one video, enters the episode metadata, chooses
OnlyFans and/or Fansly, and asks the extension to open or reuse the real
authenticated site tabs. The console reports what each page can safely support
before any future state-changing adapter is allowed to run.

This is the smallest persistent slice that advances the complete workflow:

1. select the video once;
2. carry title, description, and intended publication time in one console;
3. open or reuse authenticated platform tabs;
4. inspect the real pages without changing them;
5. fail closed when the page is logged out, incomplete, ambiguous, or stale.

Spreadsheet matching, file transfer into platform upload controls, platform
submission, post-link reconciliation, X first-reply monitoring, and ManyVids or
Pornhub drivers are separate slices built on this coordinator.

## Safety and privacy contract

- The console is included only in the personal package. The store edition is
  unchanged.
- Selecting a file keeps the `File` object only in the open console page. Video
  bytes, base64 data, local paths, captions, and descriptions are never written
  to `chrome.storage` or sent over the network by this slice.
- A reload or closed console deliberately loses the selected file. The UI says
  so clearly.
- Page probes run in Chrome's isolated extension world and are read-only. They
  may inspect element types, stable semantic attributes, visibility, enabled
  state, and bounded redacted labels. They never read input values, cookies,
  local storage, request bodies, headers, or platform responses.
- No generic first-button fallback is allowed. Multiple equally plausible
  controls produce an ambiguous result.
- No upload, post, schedule, save, edit, or delete control is clicked. Future
  state-changing actions must add a separate complete preview and explicit
  confirmation gate.
- OnlyFans remains a required host permission. Fansly access is requested from
  the user gesture that starts a Fansly probe.

## User interface

The popup adds one primary **Open upload console** button above the settings
button. It opens or focuses one `upload-console.html` extension tab.

The console contains:

- one video file input accepting `video/*`;
- title and description fields;
- a `datetime-local` intended-publication field;
- OnlyFans and Fansly target checkboxes;
- a **Check selected sites** button;
- one result card per selected platform;
- a clear safety note that this slice checks readiness and cannot post.

The check button stays disabled until a video and at least one platform are
selected. Results distinguish: opening, checking, composer detected, page
loaded without a detectable composer, login required, ambiguous controls,
permission denied, load timeout, and probe failure.

## Components

### Upload console

`upload-console.js` owns the in-memory draft, validates the selected file, asks
for selected optional origins, sends one coordinator request, and renders the
returned results. Its pure validation and date helpers are exported through
`globalThis.CreatorUploadConsole` for Node tests. No framework or new dependency
is introduced.

The intended-publication value defaults to the next Friday at 12:00 local time.
If the current local time is already Friday at or after noon, it selects the
following Friday. This is a convenience default, not a catalogue commitment.

### Background tab coordinator

`background.js` handles `PROBE_CREATOR_UPLOAD_TARGETS`. Platform definitions
contain only the platform ID, allowed URL pattern, and safe landing URL.

Platforms run serially. For each platform the coordinator:

1. verifies the ID is allow-listed;
2. queries matching tabs after host permission exists;
3. reuses the single matching tab, or opens the safe landing URL when none
   exists;
4. refuses to choose when multiple matching tabs exist;
5. waits up to 20 seconds for a newly opened tab to finish loading;
6. validates the expected platform origin, injects the read-only probe once,
   then validates the tab and report origins again;
7. returns one sanitized capability report.

The result never contains page text beyond bounded redacted semantic labels and
never contains the draft text or file bytes.

### Capability probe

`creator-tools/upload-capability-probe.js` uses semantic scoring rather than
site class names. It reports candidate counts and unambiguous best candidates
for:

- media file input;
- caption editor;
- schedule/date control;
- final post/schedule control.

File inputs may be visually hidden because real sites commonly wrap them in a
custom media picker. Other controls must be visible and enabled. Stable
attributes such as `type`, `role`, `name`, `id`, `aria-label`, placeholder, and
test IDs contribute bounded tokens. Class names and control values do not.

A password field or login/sign-in route yields `login-required`. A unique
video/upload input plus caption editor and publish control inside one semantic
composer boundary yields `composer-detected`. Missing capabilities, disabled or
invisible ancestor containers, and controls split across separate forms yield
`page-detected`; tied top candidates yield `ambiguous`.

## Failure handling

- Permission denial changes only the Fansly result card.
- Tab creation, load, injection, and probe errors are isolated per platform.
- New-tab timeouts leave the tab open for the user and report the timeout.
- Navigating or reloading after a result makes the report informational only;
  future mutating slices must re-probe immediately before applying.
- Closing the console aborts no platform state because this slice performs no
  platform mutations.

## Verification

Automated checks cover:

- file-type and required-field validation;
- next-Friday calculation across Friday boundaries;
- popup-to-console opening behavior;
- serial OnlyFans/Fansly coordination, tab reuse, tab creation, ambiguity, and
  timeout behavior with fake Chrome APIs;
- read-only probe results for detected, missing, logged-out, and ambiguous
  fixture pages;
- absence of form mutations and captured input values;
- personal-package inclusion and store-package exclusion;
- full lint, typecheck, formatting, test, and package-build checks.

An authenticated live check may open OnlyFans and Fansly pages and inspect the
result cards. It must not upload or post anything.
