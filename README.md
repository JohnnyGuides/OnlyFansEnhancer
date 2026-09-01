# Creator Workflow Toolkit

The personal Chrome edition includes an explicit-pairing X teaser recorder. See [Chrome X teaser setup](docs/X_TEASER_CHROME_SETUP.md), the [authenticated no-post smoke test](docs/X_TEASER_AUTHENTICATED_SMOKE.md), and the [X/Redgifs/Reddit trace-capture guide](docs/SOCIAL_TRACE_CAPTURE.md).

Creator Workflow Toolkit is the personal Manifest V3 extension for the
JohnnyGuides creator workflow. It combines the original Fan Identity Mask with
the creator-site helpers previously kept as separate Tampermonkey scripts.

The personal edition is intentionally broader than the separately packaged
Chrome Web Store edition. The store edition remains the narrow, display-only
**Fan Identity Mask** product under `store/`.

## Fan Identity Mask

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

## Creator workflow helpers

Each helper has its own opt-in toggle and versioned profile in extension
settings. State-changing helpers are disabled by default. Enabling one requests
only that site's optional permission and adds a manual **preview → confirm →
verified result** panel. The Master Uploader is the deliberate exception: after
one exact Yes confirmation, it may drive the observed OnlyFans, Fansly, and
ManyVids upload/schedule controls and reconcile the resulting links. It calls
the same saved-profile recipes as the standalone Fansly, ManyVids, and Pornhub
helpers, so their metadata rules cannot drift into separate implementations.
The Yes card spells out the exact saved Fansly toggles, ManyVids commercial
recipe, and Pornhub orientation/tags/categories being authorized.

- **Master Uploader** keeps the full video, shared Fansly/ManyVids teaser,
  optional ManyVids thumbnail, and optional Pornhub video only in its open tab
  and shows one exact Yes/No plan. When Pornhub is selected, its optional video
  is preferred (normally the `(limited)` edition); otherwise the full video is
  the fallback. The teaser is never used as a Pornhub fallback. Sheet setup is
  optional: without a
  bridge, **Yes, upload now** opens or reuses the selected platform tabs without
  reading or writing the sheet. A configured but failing bridge offers an
  explicit **Continue without sheet** choice. Upload-only mode shows captured
  post links in the console but cannot check existing catalogue links.
  With a connected bridge, it reads a bounded `A:L` snapshot from
  `Work / 2026 Video Catalogue` and ranks likely episodes locally from the
  filename, title, ID, Season/Arc, Episode, existing platform links, and Friday
  plan. This is deterministic fuzzy matching; it sends no video or catalogue
  text to an AI service. A strong unique result becomes one Yes/No proposal.
  No, an ambiguous result, or a weak result opens a searchable native picker
  with an explicit **Add new catalogue entry** choice. Empty link cells infer
  the missing platforms. Pornhub can be selected as an honest, trace-gated
  preparation target: it opens or reuses the authenticated uploader and applies
  only the verified exact orientation/tag/category preset. Its file assignment,
  scheduling, title/description, final Submit, and link capture remain manual
  until a complete trace proves those controls. Smart Yes remains disabled when
  authenticated platform queue evidence is unavailable or stale, and the
  console offers the explicit **Continue without sheet** route instead.
  Immediately before a smart Yes, it
  rereads the chosen row and stops if its fingerprint, inferred targets, or
  verified Friday plan changed. Yes starts the full upload on all selected
  authenticated sites,
  schedules Friday at 15:00 UTC, leaves OnlyFans labels unchanged, and gives
  Fansly a teaser attached through **Add Free Preview** to full media locked
  with exact preset `defaulT`. On ManyVids it waits up to 45 minutes for the
  named upload card to finish, immediately opens that card's editor, attaches
  the teaser as Custom Preview, fills the verified $19.99/Friday 15:00 UTC
  profile and ten exact tags, optionally uploads the supplied thumbnail, and
  clicks Save once. It observes only the OnlyFans/Fansly final create-post XHRs;
  ManyVids is resolved from its exact numeric edit route after the success
  navigation. Empty catalogue J/K/L cells are filled immediately and
  independently when connected. A conflict is never overwritten.
  Immediately before each automated final click, the worker writes and reads
  back a monotonic submission checkpoint. Bounded textual job state and
  filenames survive a Manifest V3 worker restart in session storage; video
  objects, bytes, local paths, credentials, cookies, headers, and request bodies
  never enter storage. A restored uncertain submission stops for manual link
  recovery instead of risking a duplicate. Only pre-submission platform
  failures can retry the upload; after submission, a known post URL retries the
  sheet write only and an unresolved link requires manual recovery so the
  extension cannot create a duplicate post. A ManyVids correction after its
  numeric ID is known resumes that exact editor and never uploads the full video
  again. A worker restart proves the still-open filenames and profile signature,
  then turns interrupted pre-submit work into a safe exact retry. Confirmed file
  objects are frozen for the run; only a teaser that was missing at Yes may be
  supplied later. Fully terminal jobs are removed from session storage, while
  recoverable sheet/link states remain available for the browser session.
- **Upload trace recorder** is a read-only development helper enabled by
  default. Its small panel remains idle until **Start trace** is clicked, then
  records bounded, sanitized upload evidence across same-site refreshes for
  OnlyFans, Fansly, ManyVids, or Pornhub. It never captures captions, file
  names, file bytes, raw status text, cookies, headers, or request bodies and
  never publishes anything. It distinguishes trusted user choices, toolkit
  actions, and site reactions so a manual success can be compared with the
  corresponding autofill run.
- **Clips4Sale upload assistant** serializes exact category, related-category,
  performer, audience, price, description, and keyword changes. The corrupt
  legacy 1,116-entry random taxonomy was removed; category changes require an
  approved profile value.
- **Pornhub uploader presets** preserve existing metadata and append only fresh
  exact autocomplete matches. Missing or ambiguous values stop the preset. The
  standalone panel and Master Uploader use the same saved preset and exact
  Season/Arc mapping resolver. After Yes validates a Pornhub plan, the exact
  confirmed Season/Arc-to-preset pair is remembered for future proposals.
- **Fansly composer assistant** operates on one visible composer after preview,
  preserves existing text by default, applies posting toggles independently,
  and never focuses or clicks Post.
- **ManyVids edit assistant** shows every nonempty-field overwrite before
  applying it, verifies exact tags and options, caps tags at ten, and leaves
  semantically unverified mode controls untouched until their exact labels are
  configured.
- **Sheer tag assistant** uses native select state rather than page jQuery,
  appends by default, and refuses an incomplete replacement.
- **OnlyFans expired-list selection assistant** uses stable profile/user keys,
  hard action/time limits, verified selection state, and a real abort barrier.
  It never clicks Add.
- **OnlyFans expired-list follow assistant** requires a preview and
  confirmation, enforces a conservative cap and delay, and stops on any modal,
  rate-limit signal, missing identity, or unverifiable result.
- **Reddit banner censor** injects fail-closed CSS at document start and adds a
  neutral local cover for supported current, sh, and old Reddit layouts.

The tools share one route-aware lifecycle, abortable action runner, accessible
Shadow DOM panel system, and local action log. Disabling a tool aborts it in
already-open tabs. Workflow profiles and the last 100 concise outcomes stay in
Chrome local extension storage and are never sent anywhere. Active and
recoverable Master Uploader checkpoints use memory-backed Chrome session
storage; completed jobs are removed immediately and the remainder disappears
with the browser session.

The third-party **Bypass All Shortlinks Debloated** userscript is deliberately
not included.

## Install locally

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open the extension’s **Details**, then **Extension options**.
6. **Optional, only for catalogue reconciliation:** copy `apps-script/catalogue-bridge.gs` into
   the Apps Script project attached to `Work`, set Script Property
   `CREATOR_UPLOAD_SECRET`, deploy it as a web app executing as you with access
   set to **Anyone**, then save the deployment URL and same long random secret
   under **Video catalogue bridge**. The secret authorizes the otherwise
   anonymous extension request; do not share either value.
7. Confirm your own handle is listed and choose an avatar source.
8. Enable only the workflow helpers you want and approve their per-site
   permissions. The upload trace recorder is enabled but idle by default;
   recording begins only after **Start trace**. Review the advanced profile
   JSON if you need different metadata, limits, or exact mode labels.
9. Reload a newly enabled creator-site tab. Existing enabled tools stop
   immediately when disabled.
10. Reload OnlyFans.

The personal edition requests access only to the supported creator-site routes
listed in `manifest.json`.

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
rejected assets remain retired after mapping resets. The settings page shows
current masked accounts and genuinely retired pictures in separate grids:
current pictures can be regenerated without changing the masked name or handle,
and an unassigned retired picture can be explicitly re-enabled for future random
selection.

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

### Extension-native Realbooru

Realbooru mode is self-contained in the personal extension. Its service worker
fetches fixed public Realbooru listing and post URLs, while a bundled offscreen
document uses `DOMParser` to extract inert metadata. No Dart installation,
companion executable, localhost service, or permanently open console is
required.

Realbooru’s public DAPI currently reports that it is offline, so the extension
uses the public HTML pages. It never executes page scripts or accepts an
arbitrary URL from a content script. Parsed URLs must remain on
`https://realbooru.com`, listing/detail responses are size-limited, and only
supported original-image paths are accepted. The parser document is closed
after each bounded scrape. The options page has a direct connection test.

No OnlyFans identifier, name, message, comment, or browsing URL is included in
Realbooru requests.

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

Do not submit this personal build unchanged. In addition to its remote-avatar
integrations, it now contains multi-site form and account-action helpers. That
is unsuitable for the store edition's privacy-only single purpose and
materially increases review, adult-content, automation, third-party terms, and
intellectual-property risk. See `STORE_READINESS.md`.

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
npm run check
```

`npm run check` runs type-aware ESLint async rules, JavaScript type checking,
formatting and source-encoding checks, unit/DOM/browser behavior tests, both
extension-edition regressions, and both package builds. The creator-tool
fixtures specifically cover fail-closed matching, stale autocomplete results,
replacement safety, abort barriers, action caps, and SPA/settings lifecycle
cleanup.

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
