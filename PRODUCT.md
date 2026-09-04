# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is an adult creator working on Windows in authenticated Chrome
sessions. They publish paid videos, free previews, teasers, thumbnails, and
social posts across several sites, then reconcile the resulting links and
status with a Google Sheets catalogue.

The normal interaction budget is one review and a Yes or No decision. An
ambiguous catalogue match may ask for one thumbnail choice.

## Product Purpose

OFEnhancer is intended to coordinate a video from local media through
preparation, publishing, link capture, catalogue updates, social monitoring,
and later re-release suggestions. The current release ships the local
catalogue, desktop shell, Google catalogue flow, and trace-backed Chrome
workflows. It replaces repeated form filling and link copying without hiding
uncertainty or publishing twice.

Success means the user can start from a local video or teaser, review one exact
plan, authorize it once, and later see a truthful record of what is live,
missing, removed, ready, or waiting for attention.

## Positioning

The product combines a local Windows workflow engine with trace-backed actions
inside the user's real signed-in Chrome tabs. It does not store platform
passwords, recreate private upload APIs, or use an LLM to guess catalogue
identity.

## Operating Context

- Windows desktop and Chrome are the supported environment.
- The desktop app owns local files, media processing, scheduled checks,
  operational history, and Google Sheet synchronization.
- The Chrome extension owns authenticated website interaction and exact page
  verification.
- The `2026 Video Catalogue` is the creator-facing schedule and platform
  summary. Detailed publication and asset history belongs in grouped columns
  and hidden companion tabs in the same workbook.
- Curated thumbnails live under
  `D:\MEDIA - SELFMADE\Youtube2\.DONE_DEEDS\.thumbs` and are the preferred
  visual identity for catalogue items.
- Friday at 15:00 UTC is the default release time.

## Current release

- The Windows app provides the desktop shell, local catalogue, thumbnail
  matching, and explicit Google Sheet inspection and migration flow.
- Chrome owns authenticated website interaction and exact page verification.
- Sanitized traces and tested adapters cover OnlyFans, Fansly, ManyVids, and X
  publishing/reply behavior. Live account behavior still requires the matching
  current trace and an authenticated session.
- Catalogue matching is deterministic: confirmed bindings and exact hashes
  come first, perceptual evidence ranks candidates, and a thumbnail picker
  resolves genuine ambiguity. An LLM is optional copy/paste assistance only.
- An uncertain submit is reconciled and never blindly repeated.

## Planned and trace-gated

- The intended publishing destinations include OnlyFans, Fansly, ManyVids,
  Pornhub Free/Paid, Clips4Sale variants, X, Redgifs, and Reddit. They are not
  all autonomous in the current release.
- Platform automation requires a sanitized successful trace and exact
  postconditions. A changed or ambiguous page stops the affected job.
- One plan-level Yes may authorize supported final controls. A changed plan,
  replacement post, retry, deletion, or re-upload requires a new Yes.
- X and Reddit monitoring, social performance comparison, and re-release
  suggestions are planned behavior, not current-release UI or automation.
- Complete current traces are still required before claiming autonomous
  Redgifs, Reddit, Pornhub Free/Paid, Clips4Sale four-version, or remote
  thumbnail-edit support.
- OFEnhancer owns its media recipes. JohnnyTools is reference behavior, not a
  runtime dependency.
- The Chrome Web Store identity-mask edition remains separate and does not
  inherit personal publishing permissions.

## Brand Commitments

- The supplied `finalLogo.png` is the current product mark.
- `OFEnhancer` is a working name; a later naming exercise may replace it.
- UI copy is short, direct, and human. It avoids implementation explanations
  unless the user opens technical details.
- Sensitive video titles, post text, subreddit names, and platform details do
  not appear in default Windows notifications.

## Evidence on Hand

- Successful sanitized upload traces and tested adapters exist for OnlyFans,
  Fansly, ManyVids, and X publishing/reply behavior.
- The repository contains deterministic catalogue proposal, monotonic session,
  no-repost, Apps Script, and native file-move tests.
- Complete current traces are still required before claiming autonomous
  Redgifs, Reddit, Pornhub Free/Paid, Clips4Sale four-version, or remote
  thumbnail-edit support.
- The current unpacked extension ID is
  `cfkenejbehihjmeokedjfccmhffeahgh`. Chrome has not stored a reusable manifest
  public key for it, so moving the extension requires a deliberate one-time
  identity and data migration.

## Product Principles

1. Show one exact plan, then ask once.
2. Stop on uncertainty; never guess or duplicate a public action.
3. Keep authenticated actions in Chrome and private files on the local PC.
4. Record meaningful outcomes in the catalogue without turning the visible
   sheet into an operational log.
5. Prefer supported APIs and native platform features; browser adapters remain
   trace-backed fallbacks.

## Accessibility & Inclusion

All primary flows must work by keyboard, expose useful names and status through
standard accessibility APIs, retain visible focus, and remain usable at compact
desktop widths. Reduced-motion preferences are respected.
