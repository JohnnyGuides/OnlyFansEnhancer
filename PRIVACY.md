# Privacy policy

Last updated: July 23, 2026

Fan Identity Mask processes webpage content only to replace fan names and
profile pictures in the user’s local browser display.

## Data processed and stored locally

The extension may read and locally store:

- Stable OnlyFans account or chat identifiers visible in the loaded page
- Profile handles visible in the loaded page when needed as a fallback key
- Locally generated replacement names and handles
- Avatar assignments and the IDs/URLs/fingerprints of assigned Gelbooru or
  Realbooru posts
- Locally cached face/smart-cropped versions of assigned remote images
- User-selected avatar images, stored as locally cropped WebP data
- Extension settings, including handles that should never be masked
- A numeric Gelbooru API user ID and API key if the user enables that optional mode

This information is stored in Chrome local extension storage. Fan Identity Mask
does not operate a developer server, analytics service, advertising service, or
telemetry endpoint, and the developer does not receive this information.

## External transmission

In neutral-avatar mode, the extension does not transmit fan information to any
third party.

If the user explicitly enables Gelbooru mode, the extension sends an HTTPS
request to Gelbooru containing only:

- The configured Gelbooru API credentials
- A fixed anime-selfie tag query and the user-selected rating mode
- Standard connection information such as the user’s IP address and browser
  networking metadata

OnlyFans usernames, stable account IDs, message contents, comments, and browsing
activity are not included in Gelbooru requests. Assigned thumbnail images are
downloaded from Gelbooru image servers and converted to local data URLs. Because
Gelbooru's image hosts reject hotlinks, the extension sets
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

## Sharing and sale

The extension does not sell, share, rent, or use user data for advertising,
creditworthiness, or any unrelated purpose.

## Retention and deletion

Identity mappings remain until the user selects **Reset all mappings**, clears
extension storage, or uninstalls the extension. The retired remote-image
history intentionally survives a mapping reset to prevent reuse; clearing
extension storage or uninstalling removes it.

## Security note

Chrome local extension storage is not encrypted. Users should treat an optional
Gelbooru API key accordingly and should not reuse passwords as API keys.
