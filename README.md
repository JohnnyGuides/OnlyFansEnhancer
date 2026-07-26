# OFEnhancer

OFEnhancer is a local Manifest V3 Chrome extension that changes how fan
identities appear in your browser. It does not edit accounts, send messages, or
change data on OnlyFans.

## What it masks

- Names and avatars on comments beneath posts
- Names, handles, and avatars in the DM conversation list
- The active DM header
- Avatars beside incoming DM messages
- Common fan-card layouts that use the same OnlyFans components

Each account is keyed primarily by its stable numeric user/chat ID. A generated
internet-style girl alias and avatar assignment are saved in
`chrome.storage.local`, so the
same fan remains the same across comments and DMs and after browser restarts.
Assigned remote image IDs, URLs, and fingerprints are also stored, preventing
the same image from being assigned to two accounts.

Original names and avatars are replaced by animated skeletons during the
initial batched mapping pass and whenever OnlyFans inserts a new row. The
synchronous pending marker runs before the asynchronous identity lookup, which
prevents the real identity from briefly flashing or being concatenated with its
replacement. All masked avatars are forced into the same circular frame.

## Install locally

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `OnlyFansEnhancer` project folder.
5. Open the extension’s **Details**, then **Extension options**.
6. Confirm your own handle is listed and choose an avatar source.
7. Reload OnlyFans.

The extension is intentionally limited to `https://onlyfans.com/*`.

## Avatar modes

### Neutral generated avatars

This is the default. Avatars are deterministic local SVGs and require no
outside network connection.

### Gelbooru API

This personal-build option requires your numeric Gelbooru API user ID—not your
username—and API key. Both appear in Gelbooru's API Access Credentials area;
the numeric ID also appears at the end of a profile URL such as
`...s=profile&id=2022304`. The settings page includes a connection test that
reports permission, authentication, non-JSON, and CAPTCHA/Cloudflare failures.
Gelbooru may display the credentials as one query fragment,
`&api_key=…&user_id=…`; that entire fragment can be pasted into the API-key
field and is split locally before storage.

The extension requests Gelbooru access only when you enable the mode. It queries
`1girl solo selfie score:>=50`, then applies its local safety and rating checks.
Any rating—including explicit—is the default; a general-only setting remains
available. It uses preview images, sends no OnlyFans identity to Gelbooru, and
falls back to a generated avatar if the API fails. Retrieved previews use the
same native face-detection/smart-crop pipeline, are converted to 96×96 WebP, and
are then stored locally with the account mapping.

API result pages are selected with Web Crypto randomness across the reported
result count, and each page is shuffled before assignment. Persistent sets of
used Gelbooru post IDs, source URLs, and API-provided MD5 fingerprints are
reserved in Chrome storage before any image download. Assigned and manually
rejected assets remain retired after mapping resets; clearing extension storage
or uninstalling the extension removes that history.

Clicking directly on a masked profile picture requests a different unused
remote picture without opening the profile card. The circle contracts, shows a
spinner over the faded old picture, and pops the new locally cached picture
into place. Avatar pointer events are intercepted before OnlyFans' delegated
navigation handlers and the avatar's profile link is removed; clicking the
masked name remains the way to open that fan's profile.

Remote Gelbooru image URLs are never left directly in an OnlyFans page. If
cropping is unavailable, the downloaded image bytes are still cached as a local
data URL. If downloading fails, a generated avatar is used instead of a broken
image icon.

Gelbooru's image hosts require a Gelbooru referrer and otherwise redirect to an
HTML hotlink page. A packaged declarative network rule sets that header only for
Gelbooru thumbnail, sample, and image paths. It does not apply to OnlyFans or
any other host.

Gelbooru ratings and tags are community-maintained and can be wrong. The API key
is stored in Chrome local extension storage, which is not encrypted.

### Realbooru local scraper

Realbooru mode uses the separately installed `realbooru_scraper` companion
project. Its executable binds only to `127.0.0.1:47831`; the extension sends it
the fixed selfie query and receives post metadata. No OnlyFans identifier, name,
message, or comment is sent to the companion or Realbooru.

The companion uses the user's `realbooru 0.3.0` dependency for post-detail
scraping. Its wrapper selects a random paginator page first because the
dependency's built-in random path currently omits the page offset. Start
`start_scraper.cmd` and leave its console open while Realbooru or mixed mode is
enabled. The options page has a connection test.

The companion is not loaded into Chrome as a second extension. Chrome cannot
execute Dart or start local programs, so the Chrome extension requests post
metadata from the loopback companion, which then contacts Realbooru. The
compiled service listens only on the local machine.

Realbooru results locally require `selfie`, `solo`, and female-identifying tags.
The same narrow age-safety exclusion used for Gelbooru remains active. Image
bytes are downloaded once, face/smart-cropped to 96×96 WebP, and stored locally.
Realbooru IDs share the URL and MD5 retirement lists with Gelbooru, preventing
cross-source reuse when both services expose the same asset.

### Mixed anime + real mode

The popup slider sets the exact Realbooru probability in 10% steps; Gelbooru
receives the remaining probability. For example, 70% means every new picture
request independently starts with a 70% Realbooru / 30% Gelbooru choice. This
applies to first assignments and click-to-reroll requests. Existing assignments
remain unchanged across ordinary page refreshes. If the selected source is
temporarily unavailable, the extension tries the other. Both sources use the
same local crop and permanent retirement history.

### Imported selfie pack

Select any number of real or anime selfie images in the options page. Each file
is processed locally:

1. Chrome's native `FaceDetector` is tried when the browser exposes it.
2. If unavailable or no face is found, a detail-weighted smart crop favors the
   upper-center portion of the image.
3. The crop is resized to a 96×96 WebP avatar.
4. The avatar is stored locally and assigned to at most one account.

Download only images you are permitted to use, then import the local files.

## Reset or disable

- Use the popup to disable masking, then reload the OnlyFans tab.
- **Reset names** creates new persistent names and handles while retaining each
  account's current picture and stable mapping.
- **Reset pictures** retains names and stable mappings, permanently retires the
  current pictures, and lazily requests replacements using the current slider
  probability.
- Use **Reset all mappings** in options to discard all aliases and avatar
  assignments. New ones are created on the next scan.

## Chrome Web Store

Do not submit this personal build unchanged. The Gelbooru and local-companion
integrations materially increase review, adult-content, native-companion,
third-party terms, and intellectual-property risk. See `STORE_READINESS.md` for
a safer publication plan.

The separate `store/` edition removes all remote-image integrations and keeps
only neutral generated avatars plus optional images imported and processed
locally by the user. It starts disabled, requires affirmative consent in the
settings page, and requests only `storage` plus the narrow
`https://onlyfans.com/*` host scope.

Run the store validation and build:

```powershell
npm run test:store
npm run build:store
```

The upload-ready ZIP is written to `dist/` with `manifest.json` at the archive
root. Store copy, permission justifications, reviewer instructions, and listing
artwork are in `store-listing/`. The public privacy-policy source is in `docs/`.

## Development checks

Install the test dependency and run the self-contained test suite:

```powershell
npm install
npm test
```

The optional saved-page test requires locally saved OnlyFans post and DM pages:

```powershell
$env:FIM_POST_SNAPSHOT='C:\path\to\saved-post.html'
$env:FIM_DM_SNAPSHOT='C:\path\to\saved-messages.html'
npm run test:snapshots
```

Saved pages may contain private account information and must not be committed.
Only the DOM masking core is tested against these snapshots. OnlyFans can change
its markup, so selectors may need maintenance over time.

## Alias generation

Aliases are generated deterministically from a pool of 240+ Reddit-inspired feminine names,
plus varied display-name and handle patterns. Handles are normalized safely when a name
contains accents, and collisions receive stable numeric disambiguation.
