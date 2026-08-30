# Fan Identity Mask privacy policy

Last updated: July 26, 2026

Fan Identity Mask has one purpose: to pseudonymize fan identities in supported
OnlyFans creator views inside the user's local browser display.

## Data processed locally

After the user reviews the in-extension disclosure and affirmatively enables
masking, the extension may read and process:

- Names, handles, profile-image locations, and stable account or chat
  identifiers visible in loaded OnlyFans pages
- Locally generated replacement names, handles, and avatars
- User-selected avatar images imported through the extension's settings page
- Extension settings, including handles that must never be masked

Stable identifiers, aliases, avatar assignments, imported avatars, and settings
are stored only in `chrome.storage.local` on the user's device. Imported images
are cropped and resized locally before storage.

## Data not collected or transmitted

The extension does not operate a developer server, analytics service,
advertising service, or telemetry endpoint. It does not transmit fan
information, browsing activity, imported images, or settings to the developer
or any third party.

The extension does not read or store message bodies, send messages, automate
account actions, scrape pages for export, download media, or change data on
OnlyFans.

## Sharing and sale

The extension does not sell, share, rent, or use user data for advertising,
creditworthiness, profiling, or any purpose unrelated to its single purpose.
No human can access the locally processed data through the extension.

Fan Identity Mask's use of information complies with the Chrome Web Store User
Data Policy, including the Limited Use requirements.

## Retention and deletion

Mappings and settings remain in Chrome local extension storage until the user
resets them, clears extension storage, or uninstalls the extension. Imported
avatar images remain until the user clears the image pack, clears extension
storage, or uninstalls the extension.

## Security

Chrome local extension storage is not encrypted. Users should import only
images they are comfortable storing locally in their Chrome profile.

## Contact

Privacy questions can be submitted through the public issue tracker:
https://github.com/JohnnyGuides/OnlyFansEnhancer/issues
