# Privacy policy

Last updated: July 26, 2026

Creator Workflow Toolkit is a personal, locally installed extension. Its Fan
Identity Mask feature replaces fan names and profile pictures in the local
browser display. Its optional workflow helpers interact with supported creator
site forms and controls at the user's direction.

## Data processed and stored locally

The extension may read and locally store:

- Stable OnlyFans account or chat identifiers visible in the loaded page
- Profile handles visible in the loaded page when needed as a fallback key
- Locally generated replacement names and handles
- Avatar assignments and the IDs, URLs, and fingerprints of assigned Gelbooru
  or Realbooru posts
- Locally cached face- or smart-cropped versions of assigned remote images
- User-selected avatar images, stored as locally cropped WebP data
- Extension settings, including handles that should never be masked
- A numeric Gelbooru API user ID and API key if the user enables that optional mode
- Per-helper enabled or disabled settings

Workflow helpers may read the currently displayed upload form, composer, user
list, button labels, and selected tags in order to fill fields or activate the
requested controls. The extension does not copy those page contents into its
own persistent storage.

This information is stored in Chrome local extension storage. Creator Workflow
Toolkit does not operate a developer server, analytics service, advertising
service, or telemetry endpoint, and the developer does not receive this
information.

## External transmission

In neutral-avatar mode, the identity-mask feature does not transmit fan
information to any third party.

If the user explicitly enables Gelbooru mode, the extension sends an HTTPS
request to Gelbooru containing only:

- The configured Gelbooru API credentials
- A fixed anime-selfie tag query and the user-selected rating mode
- Standard connection information such as the user's IP address and browser
  networking metadata

OnlyFans usernames, stable account IDs, message contents, comments, and
browsing activity are not included in Gelbooru requests. Assigned thumbnail
images are downloaded from Gelbooru image servers and converted to local data
URLs. Because Gelbooru's image hosts reject hotlinks, the extension sets
`Referer: https://gelbooru.com/` only on Gelbooru thumbnail, sample, and image
requests. It does not send the OnlyFans page URL as the referrer.

If the user enables Realbooru or mixed mode, the extension contacts the
user-operated loopback service at `http://127.0.0.1:47831`. It sends only a
fixed selfie query and requested result count. The companion then retrieves
public Realbooru listing and post pages. OnlyFans usernames, identifiers,
messages, comments, and browsing activity are not sent to the companion or
Realbooru. Assigned image bytes are downloaded from Realbooru and converted to
local data URLs. A network rule sets `Referer: https://realbooru.com/` only for
Realbooru thumbnail and image paths.

The creator workflow helpers make no direct requests to a developer-operated
service. When a helper fills a form, follows an account, selects users, or
clicks a site control, the supported website may process that action through
its normal authenticated page behavior, just as it would after a manual click.
The bundled Clips4Sale category list is read locally from the extension.

## Sharing and sale

The extension does not sell, share, rent, or use user data for advertising,
creditworthiness, or any unrelated purpose.

## Retention and deletion

Identity mappings remain until the user selects **Reset all mappings**, clears
extension storage, or uninstalls the extension. The retired remote-image
history intentionally survives a mapping reset to prevent reuse; clearing
extension storage or uninstalling removes it.

Workflow-helper settings remain until extension storage is cleared or the
extension is uninstalled.

## Security note

Chrome local extension storage is not encrypted. Users should treat an optional
Gelbooru API key accordingly and should not reuse passwords as API keys.
