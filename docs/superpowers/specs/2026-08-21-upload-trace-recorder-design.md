# Upload Trace Recorder Design

## Purpose

Record enough sanitized evidence from real upload flows to design reliable
OnlyFans, Fansly, ManyVids, and Pornhub adapters. The recorder observes; it
never publishes, edits, deletes, or schedules platform content.

## Packaging and activation

The recorder is a read-only tool inside the personal Creator Workflow Toolkit,
implemented by `creator-tools/upload-trace-recorder.js`. It is enabled by
default, but recording never starts automatically. Four independent dynamic
content-script registrations allow each platform to work whenever its own
optional permission is available. The Chrome Web Store edition excludes the
recorder and all other personal creator tools.

The panel has four actions: **Start trace**, **Stop and download**, **Download
last trace**, and **Discard saved trace**. Start creates one origin-bound
session. A same-origin refresh resumes it. Stop preserves the trace locally and
downloads JSON. Sessions stop after 45 minutes or 800 events.

## Captured evidence

Each event contains an ISO timestamp and elapsed milliseconds. The recorder may
capture only:

- sanitized origin/path route changes, retaining only Pornhub's public
  `viewkey` query parameter;
- selected-file redacted extension, byte size, and MIME type, never bytes, a
  basename, or a local path;
- compact semantic signatures for meaningful buttons, custom clickable
  ancestors, submit controls, calendar choices, and same-platform candidate
  post links canonicalized to exclude title-bearing path suffixes;
- trusted user changes to structured controls, including exact select labels,
  checkbox/radio state, rich-text, plaintext-only, or native-editor
  empty/nonempty state, and Enter/Tab/Escape actions; free-text controls never
  expose their contents, and whitespace or zero-width editor content is empty;
- explicit Creator Workflow Toolkit panel actions, control mutations, run
  starts, and sanitized outcomes with tool IDs, item labels, and statuses but
  no result details;
- form submission without form values;
- enumerated upload lifecycle states, progress, busy state, and visible
  candidate post links, never raw status sentences;
- sanitized fetch, XHR, and beacon resource origin/path and timing, with file
  names replaced and every path segment redacted unless it is on a strict
  structural allowlist; never methods, headers, cookies, queries, bodies, or
  responses.

While a trace is active, candidate-bounded periodic semantic snapshots detect
upload completion and resulting links even when a single-page app reveals them
without a route change or an observed attribute mutation. A pending snapshot
is never postponed by later mutations, so continuous progress churn cannot
starve capture. Visibility checks reject controls hidden by an ancestor.

Signatures may include tag, type, role, stable-looking IDs/names/test IDs,
short class tokens, and a short redacted label. They never contain input or
textarea values. Email addresses and URLs are redacted from labels and status
text.

Interaction events carry provenance. Trusted browser events are marked
`user`; explicit helper-runtime markers are marked `toolkit-*`; page routes,
resources, and semantic changes describe site reactions. Generic untrusted DOM
events are marked `script` rather than incorrectly attributed to the toolkit.
This lets a trace compare a successful manual workflow with the corresponding
helper run without guessing who changed a control.

## Failure behavior

- Recorder-panel activity is ignored.
- Identical consecutive events and snapshots are deduplicated.
- An active trace on another origin is displayed but not appended to.
- Storage errors appear in the panel without changing the platform page.
- Event-cap, timeout, and download failures preserve the last local trace.
- The recorder makes no network requests of its own.

## Verification

Node tests cover integration, default settings, four per-site registrations,
sanitizers, and package boundaries. Playwright covers Start, refresh
persistence, nested/custom click ancestry, rich-editor, plaintext-only, and
native-editor state, file/click/submit/resource/route/status capture,
same-platform canonical links, hidden-link rejection, periodically revealed
result links under continuous DOM churn, bounded snapshot scanning, filename
and resource-path redaction, Stop, download, and the absence of platform-form
markup or live-value mutations. The personal ZIP must contain the recorder;
the store ZIP must not.
