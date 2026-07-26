# Chrome Web Store listing

## Product name

OFEnhancer

## Summary

Locally replace fan names and avatars with persistent aliases on supported
OnlyFans creator views.

## Detailed description

OFEnhancer gives creators a consistent, private display layer for fan
identities.

When enabled, the extension replaces visible fan names, handles, and profile
pictures with persistent aliases in supported comment and direct-message views.
The same fan keeps the same replacement identity across supported views and
browser restarts.

Key features:

- Persistent local aliases for supported fan identities
- Neutral generated avatars with no network requests
- Optional user-imported avatar packs processed and stored locally
- Separate resets for names, pictures, or all mappings
- A protected list of creator handles that must never be masked
- No analytics, advertising, telemetry, or developer server

OFEnhancer changes only the local browser display. It does not change
OnlyFans data, read or store message bodies, send messages, scrape pages for
export, download media, or automate account actions.

Before masking starts, the settings page explains the local data processing and
requires affirmative consent.

## Category and audience

- Suggested category: Workflow & Planning
- Mature content: Yes
- Visibility: Public
- Regions: All regions where the listing and underlying service are permitted

## Single purpose

To pseudonymize fan identities in supported OnlyFans creator views inside the
user's local browser display.

## Permission justifications

### storage

Stores the user's consent and settings, protected creator handles, stable local
identity mappings, generated aliases, avatar assignments, and optional
user-imported avatars in Chrome local extension storage.

### https://onlyfans.com/*

Required to identify visible fan names, handles, profile images, and stable
account or chat identifiers in supported OnlyFans creator views and replace
their local presentation with persistent aliases. Access is not used for
analytics, advertising, export, media downloading, message-body processing, or
account automation.

## Privacy-practices form

Declare local handling of:

- Personally identifiable information: usernames and stable account/chat
  identifiers visible in supported views
- Website content: visible names, handles, and profile images required for the
  masking feature
- Personal communications context: identifiers and identity elements adjacent
  to supported direct-message views; message bodies are not read or stored

Certify:

- Data is used only for the extension's disclosed single purpose
- Data is not sold or transferred to third parties
- Data is not used for advertising, creditworthiness, or lending
- Humans do not read user data through the extension
- All processing and storage remain local to the user's device

Privacy policy:
https://johnnyguides.github.io/OnlyFansEnhancer/privacy.html

Homepage:
https://johnnyguides.github.io/OnlyFansEnhancer/

Support:
https://github.com/JohnnyGuides/OnlyFansEnhancer/issues

## Reviewer test instructions

1. Install the uploaded package.
2. The settings page opens automatically.
3. Confirm that masking is disabled and the enable control is unavailable
   before consent.
4. Review and select the local-processing consent checkbox.
5. Enable masking, leave "Neutral generated avatars" selected, and save.
6. In an authorized OnlyFans creator account, open a supported comments view or
   direct-message conversation list and reload the page.
7. Confirm that visible fan identity elements are replaced consistently while
   the creator handle listed in settings remains unchanged.
8. Disable masking and reload to confirm the original site presentation returns.

No credentials are embedded in or transmitted by the extension. Reviewers need
an independently authorized OnlyFans creator account to exercise live-site
selectors. The extension popup and options page can be inspected without a site
account.
