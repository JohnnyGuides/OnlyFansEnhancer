# Master Uploader and Teaser Distributor Design

## Goal

Extend the personal Chrome Creator Workflow Toolkit so one explicit plan can
prepare or publish an official video and distribute its social teaser across X,
Redgifs, and Reddit. The extension must reconcile every confirmed result with
the existing Work catalogue without an LLM, without silently choosing a video,
and without repeating a public post after restart or partial failure.

## User workflow

The Master Uploader accepts these independent inputs:

- full video;
- paid-platform teaser, when a paid platform needs one;
- one social teaser shared by X and Redgifs/Reddit;
- title, description, and editable social caption;
- the paid-video URL to promote;
- official-upload destinations;
- X and selected Reddit destinations; and
- `Confirm manually` or `Autonomous` execution mode.

The paid-platform and social teaser inputs may point to the same file, but the
extension never copies one into the other silently. The catalogue title
prefills the social caption. The social caption becomes the X caption and the
default title for each Reddit post.

Before any platform mutation, the extension reads the catalogue and proposes
exactly one of these outcomes:

1. use an existing catalogue entry and fill only its missing destinations;
2. use an existing future/planned catalogue entry;
3. add a new entry at the next verified free Friday release slot; or
4. require explicit selection from ranked candidates when the evidence is
   ambiguous.

Filename similarity, dates, series/episode evidence, and existing platform
links only rank or explain candidates. They never authorize a match. The user
confirms the exact catalogue entry or `Add New` once before execution.

The final plan lists every file role, catalogue action, destination, schedule,
caption, paid link, subreddit override, and execution mode. Nothing is
published before the user accepts that plan with `Yes`.

## Execution modes

### Confirm manually

The extension opens the authenticated Chrome tabs, assigns files, fills fields,
and applies verified settings. It leaves every final public publish control to
the user. After the user publishes, the extension observes the resulting page
or verified platform response and resumes reconciliation.

### Autonomous

The same complete plan and one initial `Yes` authorize the final platform
controls for that run. Chrome must remain open and signed in. The extension may
drive background tabs that it created, but it does not use a second hidden
browser, store account passwords, or recreate private authenticated upload
requests outside the browser.

CAPTCHA, verification gates, expired login, missing required controls, changed
flair, ambiguous success, or rate limiting pauses only the affected destination
and brings it to the user's attention.

## Mandatory trace-evidence gate

No autonomous X, Redgifs, or Reddit publishing adapter may be designed from
memory, public screenshots, guessed selectors, or synthetic fixtures alone.
Before an adapter is implemented or enabled, the existing sanitized Record
Steps system must capture one successful authenticated manual flow on that
platform:

- X: select the social teaser, enter the caption, publish, observe the canonical
  status, create the first reply with the paid URL, and observe that reply;
- Redgifs: select the teaser, complete every required metadata/control step,
  wait through processing, publish, and observe the canonical public URL; and
- Reddit: create a Redgifs link post, select the subreddit, enter title and any
  body, select flair/NSFW controls, publish, and observe the canonical post.

The recorder may retain semantic control roles, bounded element signatures,
navigation, sanitized request/response shapes, upload/processing state,
platform IDs, and canonical public URLs. It must exclude field values, caption
or body text, local paths, video bytes, cookies, credentials, authorization
headers, and private request bodies.

Deletion/replacement automation has a separate evidence gate. It remains a
manual, explicitly authorized action until a sanitized delete and replacement
trace exists for that platform. Fixture tests derived from traces must preserve
only the minimal semantic evidence needed by the adapter.

## Destination behavior

### Official platforms

OnlyFans, Fansly, ManyVids, and supported Pornhub steps reuse the existing
Master Uploader contracts. A confirmed canonical result fills only a missing
catalogue link. A different existing link is a conflict and is never silently
overwritten.

### X

X receives the social teaser and master caption. After the main status is
confirmed, the extension creates the first reply with the selected paid-video
URL. The main status and first-reply URLs are captured separately. Deleting and
replacing an underperforming X post preserves the old ledger record and creates
a replacement record only after a new explicit `Yes`.

### Redgifs and Reddit

When Reddit is selected, Redgifs uploads the social teaser first. Reddit does
not begin until Redgifs exposes one confirmed canonical public URL.

The user selects one or more subreddits. The last selection is the default for
the next run. Each subreddit preset may provide an editable title template,
optional body template, flair, NSFW setting, Redgifs acceptance, and rule
notes. The master caption is the default Reddit title. The paid-video URL is
included in the Reddit body only when the approved subreddit preset allows it.

One subreddit failure does not block the others. A deleted or
moderator-removed post may be offered for replacement, but replacement always
requires a new explicit `Yes`.

## Orchestration and recovery

The run is a durable set of destination jobs with frozen file proofs,
catalogue identity, approved text/settings, and monotonic checkpoints. The
stages are equivalent to:

`planned -> prepared -> submitted -> result-captured -> sheet-complete`

Stages never move backward, and a captured platform identity cannot change.
Restart recovery resumes only the first incomplete operation. An attempted
submission with no provable result becomes `posted-link-unresolved`; it is not
submitted again automatically.

Independent destinations continue after a sibling failure. X is independent
of Redgifs. Reddit jobs depend on a successful Redgifs result. Successful jobs
are checkpointed immediately. The run summary uses `published`, `prepared for
manual confirmation`, `blocked`, and `failed` per destination.

## Google Sheet model

The source spreadsheet is `Work`, spreadsheet ID
`1Ninkxbv1SOvatcJ3AP4zwKWxdc32imlIkP_IMUSTR9E`.

The live `2026 Video Catalogue` currently contains:

- M: `# teasers unposted`;
- N: `# teasers`;
- O: `Twitter Teaser(s)`;
- P: `Clips4Sale Link`;
- Q: `Cost`; and
- R: `Thumbnail Override`.

The design adds the next compact pair without disturbing existing columns:

- S: `# Reddit posts`;
- T: `Reddit Post(s)`.

Column T stores the canonical Reddit URLs for that catalogue entry. Column S
counts those URLs using the same visible pattern as the existing X count/link
pair. Confirmed additions append; they never replace a different existing URL.

The existing `2026 uploads` Reddit area is the seed for subreddit research:

- Y: `Subreddit`;
- Z: `Status`; and
- AA: `Notes`.

Its existing AC:AH post area already records post date, teaser/asset,
release/campaign, status, post URL, and notes. New normalized automation data
must not overload or erase those user-maintained cells.

Two hidden structured tabs provide automation detail:

### Teaser Distribution Ledger

One immutable row per public item, including run ID, catalogue ID, platform,
subreddit/destination, parent Redgifs or X status identity, caption/title/body,
canonical URL and platform ID, publication time, current status, replacement
relationship, last checked time, and evidence source. X main posts, X first
replies, Redgifs uploads, and individual Reddit posts are separate rows.

### Subreddit Presets

One row per subreddit, initially seeded from `2026 uploads!Y:AA`. It stores the
approved title/body templates, flair, NSFW setting, link policy, Redgifs
acceptance, cooldown/rule notes, research sources, research time, review state,
and last successful use. Only `Approved` rows may be used in Autonomous mode.

## Subreddit research

A separate research agent reads the existing subreddit targets and rough notes,
then checks current subreddit rules, wiki/sidebar information, posting UI, and
other primary community sources. It records source URLs and the research date,
preserves the user's notes, and marks every proposal `Needs review`. Conflicting
or missing evidence remains explicit. Research never publishes and never makes
a preset eligible for Autonomous mode without user approval.

## Status reconciliation and rate limits

The extension reconciles public status at most once per 24 hours while Chrome
is open, after a new publication, or when the user selects `Refresh status`.
Automatic scans use the smallest account-level or platform-supported listing
request available and match platform IDs locally. They do not request every
stored URL individually.

Results are cached. Rate-limit responses stop that platform immediately and
respect its retry time. Old or missing records receive individual checks only
through manual refresh or a user-authorized replacement flow.

Statuses include `live`, `deleted-by-you`, `moderator-removed`,
`unavailable/private`, and `unknown`. The system distinguishes them only when
the platform exposes sufficient evidence. Historical rows remain in the
ledger. Compact catalogue counts reflect current confirmed records without
destroying history.

## Security and privacy boundaries

- Authenticated platform actions stay in the user's signed-in Chrome context.
- No account password, session cookie, authorization header, private request
  body, or video bytes are written to extension persistence or the Sheet.
- Local files remain in the active browser session; persisted records contain
  bounded file identity proofs only.
- The native helper is restricted to configured source, audit, and destination
  roots and uses durable receipts before moving media.
- Public publishing, replacement publishing, live Sheet writes, native-host
  installation, and registry changes remain explicit acceptance gates.

## Verification

Implementation must include:

- contract tests for file roles, exact pairing, captions, presets, and plan
  authorization;
- state-machine tests for partial success, dependency blocking, restart,
  unresolved submission, and no-repost behavior;
- Apps Script fixture tests proving append-only X/Reddit changes, exact-row
  fingerprints, idempotency, and conflict refusal;
- fixture-driven Chrome adapter tests for X, Redgifs, and Reddit;
- successful sanitized trace fixtures for every automated platform flow, with
  tests proving secrets, entered text, local paths, and media bytes are absent;
- rendered desktop, compact, and mobile tests for the complete review flow;
- rate-limit, deletion, moderator-removal, and stale-preset tests;
- native-host path, receipt, and recovery tests; and
- separate authenticated smoke tests that stop before publishing, followed by
  one user-authorized controlled publication per destination.

No implementation is considered live-ready merely because fixture tests or
package builds pass.

## Out of scope

- Posting while Chrome is closed;
- a cloud scheduler or stored platform credentials;
- LLM-based catalogue matching or autonomous subreddit-rule interpretation;
- bypassing CAPTCHA, verification, platform throttling, or moderator controls;
- automatic replacement of deleted/removed posts; and
- silently overwriting existing catalogue or ledger identities.
