# X teaser dashboard — requirements draft

Status: draft from owner brainstorming on 1 October 2026. Nothing here is implemented
unless [x-teaser-audit](x-teaser-audit.md) already says so. Goal: the most engagement
per post per day, with one teaser posted per day and variety across the catalogue.

## Owner needs

1. A thorough review of how every tweet is performing.
2. A clear link from each catalogue episode to its teasers, including episodes with none.
3. Recommendations for upcoming teasers that rotate across categories and seasons
   (games, dolls, reviews and every other group).
4. A warning when a posted teaser underperforms, suggesting a re-edit or a spare cut.
5. A scan of the whole X account that keeps everything current.
6. A mapping between local teaser files and X posts: which episodes have spare
   (unposted) teasers and which posts have no local file.

## Screen

One page, top to bottom, no section headings; state is shown by colour, opacity
and outline.

### Timeline strip

- Row 1: the last 7 days of posted teasers, oldest left. Square (1:1) thumbnails
  from the real teaser frame, uniform spacing, date above.
- Under each thumbnail, one line: views, likes, reposts, engagement rate. The
  icon key is shown once. Green = at least 15% above the owner's usual at the same
  post age, red = at least 20% below, grey otherwise.
- Row 2: the next 7 days. Outlined = scheduled on X; faded = planned only;
  empty slot with `+` = nothing planned. A scissors mark means a planned re-edit.
- Clicking a posted item shows a one-line detail with Re-edit or More like this.

### Coverage flow

- Every catalogue episode is one rounded square in a single continuous flow
  that wraps across lines (no per-season rows).
- A thin coloured line above the squares marks the category, with the category
  name written once where it starts; a break in the line starts a new season.
- Solid green square: the number inside is teasers used (posted). Amber corner
  badge: teasers ready (unposted local clips). Amber outline without fill: only
  ready clips. Bordered grey: nothing yet. Empty squares must stay visible in
  dark mode.
- Clicking a square shows category, season, episode, used and ready counts.

### Picking mode

- Clicking an empty or planned day in row 2 enters picking mode for that day.
- Seasons tweeted in the last 7 days (and already planned in the week) are
  nearly hidden; categories with two or more recent or planned posts are dimmed;
  fresh episodes with a ready clip are outlined as recommended picks.
- Clicking a recommended episode plans it for that day and advances to the next
  empty day; each pick updates the similarity rules for the following days.

### History and retirement

- A longer history view (30 days, 90 days, all) lists every past teaser as a
  compact square with the same one-line numbers, sorted or filtered by
  performance relative to comparable posts.
- A teaser is a retirement candidate only when it is in the bottom band of a
  cohort of at least 10 posts compared at the same age (24 h, 72 h, 7 d, 30 d),
  never from one lifetime count.
- Retire marks the teaser as retired in the local record (the post stays on X
  unless the owner deletes it). The episode's used count then excludes it, so the
  episode returns to rotation and appears in picking mode, preferring a spare cut
  or a re-edit of the retired clip.

### Local teaser folders

- `.TWEETS\` holds ready (unposted) clips; `Done\` holds posted clips awaiting a verdict; `Done\Good\` holds clips whose tweet performed at or above the owner's usual; `Done\Failed\` holds clips whose tweet underperformed — remake candidates, and their episode returns to rotation.
- The verdict is taken at 7 days against comparable teasers at the same age. The app moves the clip automatically and records every move in an undoable log. Clips are identified by file fingerprint, so moves and renames never break the binding.
- Files are named `<catalogue episode key>__t<N>[-variant].mp4` (applied to the existing folder on 1 October 2026 with a revert list in the ignored `.local/twitter/`).

### Automatic first reply

- For every teaser the owner posts (through OFEnhancer or by hand), the extension posts the first reply 15–60 minutes later (random), live rather than scheduled, so X's link preview card can be removed and confirmed gone before posting.
- The text rotates between short variants (for example "full vid (no ppv)", "full session", "full vid :)") followed by `-> <the episode's OnlyFans link from the catalogue>`. A durable checkpoint and a scan for an existing owner reply prevent duplicates.

## Data needed

- **X posts with metrics over time.** Candidate sources, to decide: the owner's
  logged-in X session read passively by the extension (own profile timeline and
  post analytics pages), an X analytics export, or the paid X API. Each post
  needs status ID, post time, media, views, likes, reposts, replies, bookmarks,
  and repeated samples at 24 h, 72 h, 7 d and 30 d. Older posts only have
  lifetime numbers and are compared within their own age band.
- **Catalogue binding.** Sheet column `Twitter Teaser(s)` links, the recorder's
  receipts, and explicit owner pairing for unlinked posts. Never guess a row.
- **Local files.** The `.TWEETS` folder, Done folder and receipts, with explicit
  file-to-episode pairing.

## Open questions

- How X data is collected and how often (see candidate sources above).
- Engagement rate formula: currently (likes + reposts + replies + bookmarks) ÷ views.
  Should some actions weigh more?
- The "usual": the owner's last 30 days overall, or per category.
- Cadence: one post per day at a fixed hour, or learned from the best hours.
- Whether the similarity rules should also consider performer, game or other tags.
- Whether re-edit suggestions should propose cut points or only flag the teaser.
- Where this lives: the desktop app, the extension console, or a separate page.
