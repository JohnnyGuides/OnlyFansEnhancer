# Master Uploader Shared Recipes Design

## Status

Approved and delegated by the creator on 2026-08-30. The implementation target
is Creator Workflow Toolkit `0.13.0`. This design records the creator's request
to interweave the existing Fansly, ManyVids, and Pornhub helpers into the
Master Uploader while preserving the one-confirmation and no-repost rules.

## Outcome

The upload console becomes the single place to prepare an episode. It builds
one exact platform plan from the catalogue row, selected files, release date,
saved helper profiles, and an explicit content preset. One **Yes, upload now**
starts every selected executable platform independently.

OnlyFans, Fansly, and ManyVids retain their traced final-submit automation.
Pornhub becomes a first-class planned target, uses an optional separate
`(limited)` file and the existing exact metadata presets, but stops before any
untraced file-transfer or final-submit action. Its result explains the one
remaining manual boundary instead of pretending the workflow is automated.

The same site-specific field logic serves both the Master Uploader and the
standalone helper panels. There must not be a second copy of Fansly caption and
toggle logic, ManyVids pricing/tag logic, or Pornhub preset logic.

## Scope

Version `0.13.0` includes:

- shared saved-profile behavior for the Master Uploader and standalone Fansly,
  ManyVids, and Pornhub helpers;
- exact Fansly caption composition and toggle application;
- the existing complete ManyVids upload/edit/Save workflow using the saved
  normalized profile rather than hardcoded defaults;
- a required Pornhub content preset and optional separate Pornhub video in the
  Master Uploader plan;
- trace-gated Pornhub preparation using only the currently verified
  orientation, tag, and category operations;
- resumable, serializable job state across Manifest V3 service-worker
  suspension;
- independent platform progress, failure, resume, and catalogue commits;
- Pornhub canonical-link and catalogue-column support for a future verified
  response observer, without inventing a capture path in this release;
- a `0.13.0` personal package and the existing store-safe package.

The following remain outside this milestone:

- automatic Pornhub file assignment, title/description entry, scheduling,
  submission, or response capture without a complete creator trace;
- Clips4Sale or Sheer execution from the Master Uploader;
- authenticated platform queue readers not grounded in captured evidence;
- an LLM, remote matching service, private platform API replay, or stored video
  bytes;
- automatic deployment of the Apps Script catalogue bridge.

## Approaches considered

### 1. Drive the existing helper panels from the Master Uploader

The console could open each site and simulate clicks on the helper panel. This
is superficially small but couples automation to presentation state, introduces
an extra confirmation layer, and cannot provide reliable job checkpoints.
Rejected.

### 2. Share each helper's inspected plan and apply operation

The existing site helper files retain their selectors and exact-match logic but
export narrow inspection/application functions. Their panels remain wrappers.
The authenticated upload adapter calls the same functions with the confirmed
Master Uploader plan. This removes duplication without adding a generic plugin
framework. Selected.

### 3. Delete the standalone helpers and keep only the Master Uploader

This would minimize entry points but remove the useful manual correction and
diagnostic mode. It would also make a full episode upload the only way to test
metadata changes. Rejected.

## Creator workflow

### Prepare

The console owns all `File` objects. The creator selects:

- **Full video**, required for OnlyFans, Fansly, and ManyVids;
- **Shared teaser**, required for ManyVids and used as Fansly Free Preview;
- **ManyVids thumbnail**, optional;
- **Pornhub video**, optional and normally the `(limited)` edition.

When Pornhub is selected, the effective file is the Pornhub file when present,
otherwise the full video. A teaser is never silently promoted to the Pornhub
video.

The console also contains **Content preset** with the exact options already in
the Pornhub profile: Straight, Gay, Lesbian, Bisexual Male, and Transgender.
Pornhub cannot be confirmed without one exact preset.

For a matched catalogue row with a nonempty Season/Arc, an exact normalized
Season/Arc-to-preset mapping may preselect the preset. The mapping is learned
only from a creator-confirmed upload. An unknown or empty Season/Arc requires
an explicit selection. The extension never infers sexuality or orientation
from a title, description, filename, performer, or tags.

### Propose

Catalogue matching remains deterministic. The plan uses the chosen catalogue
row, inferred missing links, and the common verified Friday where available.
The final summary shows:

- effective file for every selected platform;
- exact shared title and catalogue description;
- final Fansly caption and toggle states;
- exact Fansly access preset `defaulT`;
- complete ManyVids price, modes, time, and ten tags from the saved profile;
- Pornhub content preset, orientation, tags, categories, and manual boundary;
- release date and verification status;
- exact catalogue cells that may be written.

Changing a file, target, preset, profile, catalogue row, description, or date
invalidates the preview. Immediately before Yes, the console rereads the row
and current profiles and compares a complete plan signature.

### Execute

One Yes authorizes all traced operations shown in the summary. Platforms run
independently. One platform stopping does not stop already-authorized work on
another platform.

- OnlyFans retains the current full-video, description, Friday schedule, and
  final Save path while leaving labels unchanged.
- Fansly uploads full media, locks it with exact preset `defaulT`, adds the
  teaser as Free Preview, applies the shared Fansly caption/toggle recipe,
  schedules, and confirms Post.
- ManyVids retains the current two-stage full upload and edit workflow, but its
  metadata recipe comes from the current saved and normalized profile.
- Pornhub opens or reuses the authenticated uploader and uses the confirmed
  preset only when its verified metadata form is present. The console identifies
  the effective Pornhub filename, but this release does not assign that file or
  click Save/Submit. The result is `manual-submit-required`, not success.

### Reconcile

Only a canonical, verified post link may be committed. OnlyFans, Fansly, and
ManyVids keep their current immediate independent commits. Pornhub gains a
strict canonical form:

`https://www.pornhub.com/view_video.php?viewkey={bounded-viewkey}`

The catalogue bridge recognizes Pornhub column `H` and applies the same
fingerprint, idempotency, and conflict rules. Version `0.13.0` does not fabricate
or scrape a Pornhub link merely to exercise this contract; it is used only
after a future trace-backed observer supplies a verified URL.

## Shared platform recipes

No generic dependency or framework is added. The existing helper files remain
the ownership boundary for their site selectors:

- `fansly-prefill.js` exports a bounded composer inspector and metadata apply
  operation in addition to its panel mount;
- `manyvids-autofill.js` exports its form inspector and apply operation in
  addition to its panel mount;
- `ph-uploader.js` exports its preset inspector and apply operation in addition
  to its panel mount.

The exports accept an exact profile snapshot, an abort signal, and the existing
action budget. They recheck their form signature before mutation and return
structured per-field outcomes. The panel wrappers preview those outcomes and
leave their site final button manual. The Master Uploader adapter invokes the
same apply operation after its one global confirmation and owns the final
button only on trace-backed platforms.

The Master Uploader loads the normalized `creatorToolkitV2.profiles` snapshot
through the registry. It never reaches directly for `DEFAULT_PROFILES` except
when the saved settings are absent and the registry has produced defaults.
That exact snapshot participates in the confirmation signature and is copied
into the job request so a mid-run settings change cannot silently alter a
confirmed upload.

## Caption and metadata policy

The catalogue description is the canonical base caption.

For Fansly, the final caption is:

1. the trimmed catalogue description;
2. one blank line when both parts exist;
3. the trimmed configured Fansly message/hashtag block.

If the configured block is empty or already exists as one exact trailing
block, it is not added again. The Master Uploader sets the exact composed
caption shown in the preview. The standalone Fansly helper keeps its current
`empty-only` or `replace` policy when operating on unrelated manual composers.
Both paths use the same composer inspection, toggle logic, exact setter, and
verification.

ManyVids uses the saved normalized profile for co-performer, price, price mode,
launch mode, launch time, bundle mode, Premium mode, and exactly ten tags.
Title and description remain episode data, not profile data.

Pornhub uses one exact preset object for orientation, tags, and categories.
Existing values are preserved and only missing exact autocomplete values are
added, matching the standalone helper's current contract.

## Resumable upload state

Chrome extension service workers are disposable. `creatorUploadSessions`,
pending file requests, timeout handles, and Promise chains cannot be the only
source of truth.

The background worker stores one bounded serializable record per active upload
in `chrome.storage.session`. It contains:

- session ID and confirmed plan signature;
- bounded confirmed title, description, release data, and selected filenames;
- platform, tab ID, stage, timestamps, and required file roles;
- catalogue row, fingerprint, and safe commit metadata;
- ManyVids edit ID when known;
- monotonic `commitArmed`, `submitAttempted`, `postUrl`, and terminal status;
- no `File`, Blob, video bytes, local path, cookie, header, or authentication
  value.

The open console remains the only owner of `File` objects. The confirmed
textual draft is duplicated only in memory-backed `chrome.storage.session` so
the worker can recover a ManyVids card and finish or retry a safe catalogue
commit after suspension. It is cleared with the terminal job or browser
session and is not exposed to content scripts. When the worker restarts, the
console reconnects and proves that its still-open draft has the same plan
signature. Reloading or closing the console loses files by design and converts
unfinished file-dependent stages to manual recovery.

Every significant transition is checkpointed before the next irreversible
action. Before a final site Save/Post click, the page adapter performs a
background handshake that durably sets `submitAttempted`. If that checkpoint
fails, the adapter does not click. After a restart:

- `submitAttempted = false` may resume from the exact verified stage;
- `submitAttempted = true` with no verified link never clicks the site button
  again and reports manual link recovery;
- a verified `postUrl` retries only the catalogue commit;
- a ManyVids edit ID resumes only that exact editor and never Stage 1.

Recovery is event-driven through normal Chrome messages, tab navigation, and
storage. The extension does not add a keepalive timer or attempt to keep the
service worker immortal.

## Failure semantics

Each platform has an independent monotonic state machine. Allowed terminal
results include:

- `catalogue-updated` or `uploaded-no-sheet`;
- `manual-submit-required` for trace-gated Pornhub preparation;
- `failed` before any final submission attempt;
- `edit-failed` after a ManyVids ID exists;
- `posted-link-unresolved` after a final click without a verified URL;
- `catalogue-commit-failed`, `stale`, or `conflict` after a verified URL.

Retry rules are derived solely from the durable state. A generic Retry button
must never turn `submitAttempted` back to false. Unknown pages, duplicate tabs,
logged-out state, missing or ambiguous controls, changed labels, stale forms,
profile changes, and mismatched catalogue fingerprints fail closed.

## Minimal code boundaries

The implementation reuses native Chrome APIs and the existing toolkit. It adds
no runtime dependency and no speculative provider framework.

Expected focused changes are:

- the three existing site helper files for shared exports;
- `upload-platform-adapters.js` for composition of shared recipes with traced
  upload/final-submit steps;
- `upload-console.html/js/css` for Pornhub media, content preset, exact preview,
  and recovery display;
- `background.js` plus one small upload-session serialization module if keeping
  that logic in `background.js` would obscure the state machine;
- `registry.js` for bounded Season/Arc preset mappings and normalized profile
  snapshots;
- catalogue contract/client/Apps Script files for Pornhub canonical column-H
  support;
- manifest/package scripts only where required to load the shared code;
- focused existing test files and release documentation.

Clips4Sale, Sheer, identity masking, Reddit censoring, and the store edition are
not refactored.

## Verification

Automated checks must prove:

- Master Uploader and standalone panels call the same Fansly, ManyVids, and
  Pornhub inspection/application functions;
- saved normalized profiles, not hardcoded defaults, determine the confirmed
  plan;
- Fansly caption composition is exact and idempotent and toggles remain
  independent;
- ManyVids still assigns full/teaser/thumbnail roles, captures its edit ID,
  applies all ten exact tags, and clicks Save once;
- Pornhub selects the effective limited/full filename and exact content preset,
  applies only the verified append-only metadata recipe, and never assigns a
  file or clicks final Submit in this release;
- an unknown Season/Arc cannot produce an inferred content preset;
- changing any confirmed profile or plan input invalidates Yes;
- session serialization survives a simulated service-worker restart;
- recovery never repeats a final site click or ManyVids Stage 1;
- Pornhub canonical URLs and column-H commits reject malformed, stale, and
  conflicting values;
- partial platform failures do not block sibling platforms;
- only the bounded confirmed textual draft enters memory-backed session
  storage; no `File`, Blob, file path, video bytes, cookie, header, request
  body, or authentication value enters storage;
- the personal extension loads unpacked and the store package remains free of
  personal creator tools.

The complete `npm run check` release gate must pass. Authenticated smoke testing
may inspect readiness and shared recipe previews, but no test may publish a
real post without the creator's explicit Yes in the Master Uploader.

## Acceptance criteria

The milestone is complete when:

1. the extension displays version `0.13.0`;
2. one confirmed Master Uploader plan uses the exact saved helper profiles;
3. Fansly and ManyVids have no second independent metadata implementation;
4. Pornhub appears as an honest trace-gated target with correct file choice and
   preset behavior;
5. suspending/restarting the service worker cannot reset an irreversible job
   stage or authorize a duplicate submission;
6. all automated and package checks pass;
7. the result is committed and merged locally to `main` without pushing.
