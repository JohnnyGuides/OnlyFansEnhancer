# Privacy policy

Last updated: September 1, 2026

Creator Workflow Toolkit is a personal, locally installed extension. Its Fan
Identity Mask feature replaces fan names and profile pictures in the local
browser display. Its workflow helpers interact with supported creator-site
forms and controls only at the user's direction.

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

If the user enables Realbooru or mixed mode, the personal extension directly
retrieves public Realbooru listing and post pages using a fixed selfie query. A
bundled hidden extension document parses those inert HTML responses locally;
there is no companion process or localhost service. OnlyFans usernames,
identifiers, messages, comments, and browsing activity are not sent to
Realbooru. Assigned image bytes are downloaded from Realbooru and converted to
local data URLs. A network rule sets `Referer: https://realbooru.com/` only for
Realbooru thumbnail and image paths.

The creator workflow helpers make no requests to a developer-operated service.
The personal build declares access to its supported creator sites so helpers
are ready without an upload-time permission prompt. State-changing helpers
still require a local preview and confirmation before changing a form or
account state. When a helper fills a
form, follows an account, selects users, or clicks a site control, the supported
website processes that action through its normal authenticated page behavior,
just as it would after a manual click. The extension does not transmit workflow
profiles or action logs elsewhere.

The personal upload console keeps selected full and teaser `File` objects only
in the open console page's memory. File bytes and filesystem paths are not
copied to Chrome storage or JSON runtime messages. A same-extension-origin file
bridge structured-clones the selected `File` into the expected authenticated
site input after confirmation. Closing or reloading the console discards its
files.

If the creator configures the private catalogue bridge, the Apps Script
deployment URL and shared secret remain in Chrome local extension storage.
During matching and confirmed link commits, the extension sends bounded title,
description, filename, release date, target platform, catalogue row/fingerprint,
and public post link to that creator-owned Apps Script deployment. The included
script is fixed to spreadsheet `Work`, tab `2026 Video Catalogue`, and columns
A-D/J/K. It takes a lock and never overwrites a different existing link.

On confirmed uploads, a narrow page-world observer reads only the successful
response from OnlyFans `POST /api2/v2/posts` or Fansly `POST /api/v1/post` to
extract one unambiguous post ID or URL. It does not read request bodies,
headers, cookies, authentication tokens, or upload responses. Unknown or
ambiguous response shapes are not written to the catalogue.

## Sharing and sale

The extension does not sell, share, rent, or use user data for advertising,
creditworthiness, or any unrelated purpose.

## Retention and deletion

Identity mappings remain until the user selects **Reset all mappings**, clears
extension storage, or uninstalls the extension. The retired remote-image
history intentionally survives a mapping reset to prevent reuse. A user may
explicitly re-enable an unassigned retired picture in extension settings;
clearing extension storage or uninstalling removes the entire history.

Workflow-helper settings and up to 100 concise local action-result entries
remain until they are cleared under **Upload console → Settings**, extension
storage is cleared, or the extension is uninstalled. Entries contain the tool
ID, time, page URL, overall result, and per-field status; they do not copy post
bodies, messages, credentials, or page content.

## Security note

Chrome local extension storage is not encrypted. Users should treat an optional
Gelbooru API key and catalogue bridge secret accordingly and should not reuse
passwords as either value.
