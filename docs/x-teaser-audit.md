# X teaser inventory and queue

`tools/x-teaser-audit.mjs` compares three independent sources without posting,
editing the workbook, or moving media:

- a Google Sheet rows export, including the exact `Twitter Teaser(s)` links;
- a timestamped inventory of visible X video posts;
- the local `.TWEETS` directory and the separate recorder's audit receipts.

It reports confirmed teaser posts without a Sheet link, X videos that still need
teaser classification, duplicate Sheet bindings, local clips
without an exact catalogue pairing, and a proposed queue. A Sheet link absent
from one X profile sample is only a review item; the script does not assume a
post was deleted. It never guesses a catalogue row for an unlinked X post.

## Private input files

Keep account exports under `.local/twitter/` (Git ignores `.local/`). The Sheet
file has `{ "workbookId": "…", "sheetId": 2126708696, "rows": [[…], …] }`.
The first row contains headers such as `ID`, `Title`, `Season / Arc`,
`# teasers unposted`, and `Twitter Teaser(s)`. An X inventory has
`{ "observedAt": "ISO timestamp", "posts": [{ "statusId": "…",
"publishedAt": "ISO timestamp", "views": 123, "teaser": true,
"catalogueId": "…" }] }`. Set `teaser` only after confirming that an unlinked
X video is a teaser; `false` excludes an announcement or unrelated video.
Only assign `catalogueId` after checking an exact Sheet row. Optional pairings
are a JSON object from a local path relative to `.TWEETS` to a catalogue ID.

```powershell
node tools/x-teaser-audit.mjs --sheet .local/twitter/sheet.json --x .local/twitter/x.json --teasers 'D:\MEDIA - SELFMADE\Youtube2\.TWEETS' --pairings .local/twitter/pairings.json --record-snapshots .local/twitter/snapshots.json --out .local/twitter/report.json --markdown .local/twitter/report.md --queue .local/twitter/queue.json --strict
```

`--strict` exits nonzero for a visible X post missing from the Sheet or for a
status linked to multiple catalogue rows. The optional recorder root is supplied
with `--audit`; its `.creator-x-teaser-receipts` are read only. `--record-snapshots`
requires an X inventory captured within the previous hour and retains one view
sample per status and capture time. Repeated captures at 24 hours, 72 hours,
7 days, and 30 days after publication build comparable performance cohorts.

The queue only contains pending files with an explicit catalogue pairing. It
avoids a fourth consecutive teaser from one season when another season is ready,
and proposes 48-hour spacing at the median recent posting hour (19:00 UTC when
there are fewer than five recent posts). These are suggestions to review before
posting. Underperformance is flagged only below half the median views in a
cohort of at least ten posts measured at a comparable age. A single lifetime
view count is not enough to label a teaser underperforming.

The current separate X recorder still requires its verified Apps Script Sheet
bridge for remote append and receipt-protected Done moves. The desktop Google
catalogue connection supplies the uploader's catalogue, but does not replace
that remote reconciliation protocol. Do not move clips merely because a local
report or desktop record lists an X URL.
