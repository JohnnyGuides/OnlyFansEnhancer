# Mapped Avatar Grids

## Goal

Replace the text-only remote-picture history in the personal extension's options page with two picture grids:

1. current masked accounts, where a picture can be regenerated; and
2. retired pictures, where an unused picture can be made eligible for future selection again.

The Chrome Web Store edition remains unchanged.

## Current masked accounts

Each canonical identity mapping appears once. A tile shows the identity's current cached avatar, generated display name, and generated handle. It must never render the OnlyFans account key, real name, or real username.

Hovering or keyboard-focusing the tile reveals a **Regenerate** action. It uses the existing per-account `ROTATE_AVATAR` flow, preserving the masked name and handle. On success, the old picture becomes retired, the new picture replaces it in the grid, and an identity refresh signal makes open OnlyFans comments and DMs resolve the updated mapping. On failure, the old picture remains and the options page reports the error.

## Retired pictures

A retired tile is a history entry whose ID, source URL, and fingerprint do not match any currently assigned identity. It shows the original image and a **Re-enable** action on hover or keyboard focus.

Re-enabling is an atomic background-state mutation. It refuses a picture that is currently assigned, then removes the matching history entry and its source-specific ID, URL, and fingerprint reservations. Shared URL or fingerprint reservations remain blocked if another history entry or current identity still references them. The picture is not immediately assigned; it merely becomes eligible when that source returns it again.

## Interface and accessibility

Both sections use responsive square-image grids. Actions are native buttons, visible on hover and `:focus-within`, with accessible labels. Missing or failed retired-image URLs show a neutral unavailable-image tile without removing the re-enable control.

## Data flow

- A read-only background message returns current masked identities and retired history entries in one view model.
- The options page renders the two grids without placing canonical OnlyFans keys in visible text or DOM attributes; event handlers retain the key only in their closure.
- Regenerate calls the existing rotation message and refreshes the view after success.
- A new re-enable message performs the validated state mutation and refreshes the view after success.

## Verification

- Background regression coverage proves current identities are excluded from retired results.
- Background regression coverage proves re-enable refuses an assigned picture and releases only an unreferenced retired picture's blockers.
- Options/load coverage proves both grids and their native actions render.
- The existing personal and store checks must remain green, and the personal package must build without changing the store package contents.
