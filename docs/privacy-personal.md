# Personal OFEnhancer privacy

Applies to the personal Creator Workflow Toolkit extension and Windows workspace.
The store edition has its separate [public policy](https://johnnyguides.github.io/OnlyFansEnhancer/privacy.html).
This policy describes the current source, not an assurance about third-party
websites or separately deployed services. Last updated: September 12, 2026.

## Local processing and storage

Identity masking reads visible OnlyFans account/chat identifiers and, when needed,
handles as fallback keys. Chrome-local storage holds generated aliases, protected
creator handles, avatar assignments, selected/cropped local WebP images, remote
image IDs/URLs/fingerprints, retired-image history, and settings. Picture management
renders masked labels, not real account keys. Message bodies are not the masking
feature's input.

Workflow helpers inspect the current form, composer, buttons, tags, and lists to
perform the user's requested operation. Stored settings include helper profiles
and up to 100 bounded action-result entries with tool, time, page URL, outcome,
and per-field status. Resumable sessions may hold approved title/description,
filenames, file identity hashes, catalogue identity/fingerprints, canonical public
links, and stage/attempt metadata. X/social records retain the bounded metadata
needed to avoid duplicates and reconcile results. Therefore local storage should
not be treated as free of sensitive creator metadata.

Selected extension-page File objects and frame data are held in the open page's
memory until used; media bytes are not serialized into Chrome session records.
Closing/reloading the page discards those File objects. The desktop validates
native-selected file objects before passing a short-lived authorized path to
Chrome's trusted local attachment operation. Those paths are not Chrome storage,
page-visible messages, logs, or error text. Authenticated website interaction
remains in the user's Chrome session; cookies, authentication headers, tokens,
and request bodies are not exported to the desktop or catalogue bridge.

The desktop maintains a local SQLite catalogue, stable bindings, thumbnail
inventory/cache, settings, pending sync operations, and history under its dedicated
user-data directory. It reads explicitly chosen local media/thumbnail roots.
Thumbnail rendering exposes opaque IDs rather than arbitrary filesystem URLs.
The separate X host writes three representative JPEG frames, audit records and
receipts under the configured local audit root, then performs a validated Done
move only after the preceding audit and catalogue stages. It does not upload the
audit to a developer service.

## Network destinations

OFEnhancer has no developer-operated telemetry, analytics, advertising, or data
collection endpoint. Requested platform actions and selected uploads are processed
by the supported websites in their normal authenticated Chrome context.
Narrow final-response observers extract expected canonical result identity; they
do not read request bodies, headers, or authentication credentials.

Generated/local avatar modes make no remote-avatar requests. Optional Gelbooru
mode sends the configured API user ID/key, fixed tag query/rating choice, and
ordinary connection metadata to Gelbooru. Optional Realbooru/mixed mode retrieves
public listing/post/image data; bundled inert HTML parsing needs no local companion
server. Remote images are cached as local data. Host-specific Referer rules identify
the image provider, not the OnlyFans page. Fan IDs, handles, messages, and browsing
activity are not included in those provider requests. These providers still see
normal network metadata such as the connecting IP address.

When configured, the creator-owned Apps Script endpoint receives bounded approved
catalogue metadata, basenames, fingerprints, canonical platform links, and
allow-listed distribution data. Its deployment URL/shared secret are Chrome-local
settings. The target workbook is selected through a Script Property, not hard-coded
in source. Desktop OAuth credentials and media bytes/paths are not sent to it.
Deployment and data retained in the creator's Google account are the creator's
responsibility.

Direct Google connection uses the selected system browser and the limited
`drive.file` flow for one picked spreadsheet. Google receives OAuth and requested
workbook operations. The matching Desktop app client file is imported through a
native picker; its secret is stored encrypted with current-user Windows DPAPI and
sent only to Google's token endpoint for code exchange/refresh. Refresh credentials
are protected in their separate DPAPI vault; access tokens remain in memory.
The client secret and tokens never enter WebView, extension storage, SQLite,
installer/source packages, or logs. Read-only import does not mutate Google;
optional synchronization requires a separately reviewed migration and confirmed
write contract.

## Retention and deletion

Reset all mappings removes identity mappings but intentionally retains retired
remote-image history to prevent accidental reuse. Re-enable an unassigned retired
picture explicitly to release its blockers when safe. Clear Chrome extension
storage or uninstall the extension to remove its full stored data, including
settings/history/secrets. Helper logs can also be cleared in uploader Settings.
Chrome local extension storage is not encrypted; do not reuse passwords as API
keys or bridge secrets.

Google disconnect clears the current connection's saved refresh credential and
selection but preserves the local catalogue, pending work, and history. It does
not claim to revoke every Google-side grant or erase the separately imported
Desktop client file. Manage any external consent and source JSON separately.

Desktop update/repair preserves user data. Interactive uninstall defaults to
keeping it and offers explicit removal of `%LocalAppData%\OFEnhancer`; silent
uninstall keeps it. External selected media/audit roots, downloaded credential
JSON, Google spreadsheets, and Chrome profiles are not erased by that choice.
Test data/captures may also contain private material: keep them outside source
and delete only deliberately selected owned files.

OFEnhancer does not sell or use these data for advertising, creditworthiness, or
unrelated purposes. Local-only handling is a boundary, not protection from other
software or people with access to the same Windows account/device.
