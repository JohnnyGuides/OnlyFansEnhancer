"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = require("../support/paths.cjs").personalRoot;

function loadProposal() {
  const context = vm.createContext({ Date, Intl, URL });
  for (const relativePath of [
    "workflows/catalogue-contract.js",
    "workflows/catalogue-proposal.js",
  ]) {
    vm.runInContext(
      fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
      context,
      { filename: relativePath },
    );
  }
  return context.CreatorCatalogueProposal;
}

function loadContract() {
  const context = vm.createContext({ URL });
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "workflows/catalogue-contract.js"),
      "utf8",
    ),
    context,
    { filename: "workflows/catalogue-contract.js" },
  );
  return context.CreatorCatalogueContract;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function row(overrides = {}) {
  return {
    row: 110,
    id: "battlefield-ep02",
    releaseDate: "2026-02-20",
    title: "BATTLEFIELD 6 episode 2",
    description: "Battlefield episode",
    seasonArc: "Battlefield",
    episode: "2",
    pornhubLink: "",
    onlyfansLink: "https://onlyfans.com/1/johnny_guides",
    fanslyLink: "https://fansly.com/post/2",
    manyvidsLink: "https://www.manyvids.com/Video/3",
    fingerprint: "1234abcd",
    ...overrides,
  };
}

function emptyRow(rowNumber) {
  return {
    row: rowNumber,
    id: "",
    releaseDate: "",
    title: "",
    description: "",
    seasonArc: "",
    episode: "",
    pornhubLink: "",
    onlyfansLink: "",
    fanslyLink: "",
    manyvidsLink: "",
    fingerprint: "1234abcd",
  };
}

test("Pornhub catalogue URLs accept only one canonical viewkey", () => {
  const contract = loadContract();
  assert.equal(
    contract.canonicalPostUrl(
      "pornhub",
      "https://www.pornhub.com/view_video.php?viewkey=phabc123&utm_source=x#y",
    ),
    null,
  );
  assert.equal(
    contract.canonicalPostUrl("pornhub", "https://evil.example/?viewkey=x"),
    null,
  );
  assert.equal(
    contract.canonicalPostUrl(
      "pornhub",
      "https://www.pornhub.com/view_video.php?viewkey=one&viewkey=two",
    ),
    null,
  );
});

test("X catalogue URLs accept only one canonical numeric status", () => {
  const contract = loadContract();
  assert.equal(
    contract.canonicalXStatusUrl(
      "https://x.com/Johnny_Guides/status/2094523397057237306",
    ),
    "https://x.com/Johnny_Guides/status/2094523397057237306",
  );
  for (const value of [
    "https://twitter.com/Johnny_Guides/status/2094523397057237306",
    "https://x.com/i/status/2094523397057237306",
    "https://x.com/Johnny_Guides/status/2094523397057237306?private=1",
  ]) {
    assert.equal(contract.canonicalXStatusUrl(value), null);
  }
});

test("catalogue fingerprints protect the Twitter teaser column", () => {
  const contract = loadContract();
  const original = row({ twitterTeasers: "" });
  assert.notEqual(
    contract.fingerprint(original),
    contract.fingerprint({
      ...original,
      twitterTeasers: "https://x.com/Johnny_Guides/status/2094523397057237306",
    }),
  );
});

test("catalogue fingerprints protect the Reddit post list", () => {
  const contract = loadContract();
  const original = row({ redditPosts: "" });
  assert.notEqual(
    contract.fingerprint(original),
    contract.fingerprint({
      ...original,
      redditPosts:
        "https://www.reddit.com/r/GamesGoneWild/comments/def456/new_post",
    }),
  );
});

test("strong wording infers missing Pornhub and schedules after its predecessor", () => {
  const proposal = loadProposal();
  const rows = [
    row({ row: 110, id: "battlefield-ep02", episode: "2" }),
    row({
      row: 121,
      id: "battlefield-ep03",
      title: "BATTLEFIELD 6 + Angry Sex",
      episode: "3",
    }),
  ];

  const result = plain(
    proposal.build({
      draft: {
        filename: "BATTLEFIELD 6 Angry Sex (full).mp4",
        title: "BATTLEFIELD 6 Angry Sex",
        description: "",
      },
      snapshot: { status: "snapshot", rows, emptyRow: emptyRow(136) },
      now: new Date("2026-08-30T10:00:00Z"),
      executablePlatforms: ["onlyfans", "fansly", "manyvids"],
      queueByPlatform: {
        pornhub: {
          verified: true,
          scheduled: [{ catalogueRow: 110, releaseDate: "2026-09-04" }],
          occupiedFridays: ["2026-09-04"],
        },
      },
    }),
  );

  assert.equal(result.candidate.row, 121);
  assert.equal(result.predecessor.row, 110);
  assert.deepEqual(result.targets.recommended, ["pornhub"]);
  assert.deepEqual(result.targets.executable, []);
  assert.equal(result.schedules.pornhub.releaseDate, "2026-09-11");
  assert.equal(result.schedules.pornhub.verified, true);
  assert.equal(result.status, "not-executable");
});

test("ambiguous wording opens selection instead of choosing", () => {
  const proposal = loadProposal();
  const rows = [
    row({
      row: 20,
      id: "lara-arc-ep01",
      title: "Nervous Johnny prepares for his date",
    }),
    row({
      row: 29,
      id: "lara-arc-ep02",
      title: "Nervous Johnny prepares for his date",
    }),
  ];

  const result = plain(
    proposal.build({
      draft: {
        filename: "Nervous Johnny prepares for his date.mp4",
        title: "",
        description: "",
      },
      snapshot: { status: "snapshot", rows, emptyRow: emptyRow(136) },
      now: new Date("2026-08-30T10:00:00Z"),
      executablePlatforms: ["onlyfans", "fansly", "manyvids"],
      queueByPlatform: {},
    }),
  );

  assert.equal(result.status, "needs-selection");
  assert.equal(result.candidate, null);
  assert.deepEqual(
    result.alternatives.map((item) => item.row),
    [29, 20],
  );
});

test("standalone full limited final and VR filename noise does not weaken a match", () => {
  const proposal = loadProposal();
  const ranked = plain(
    proposal.rankRows(
      {
        filename: "Claire (full) limited FINAL VR.mp4",
        title: "",
        description: "",
      },
      [row({ row: 55, id: "claire", title: "Claire" })],
    ),
  );

  assert.equal(ranked[0].similarity, 1);
  assert.equal(ranked[0].score, 90);
});

test("teaser remains meaningful catalogue wording instead of filename noise", () => {
  const proposal = loadProposal();
  const ranked = plain(
    proposal.rankRows(
      { filename: "Claire.mp4", title: "Claire", description: "" },
      [row({ row: 55, id: "claire-teaser", title: "Claire Teaser" })],
    ),
  );

  assert.notEqual(ranked[0].similarity, 1);
  assert.equal(ranked[0].similarity < 0.75, true);
});

test("explicit numeric selection bypasses similarity without bypassing queue evidence", () => {
  const proposal = loadProposal();
  const selected = row({
    row: 55,
    id: "claire",
    title: "An unrelated catalogue title",
    manyvidsLink: "",
  });

  const result = plain(
    proposal.build({
      draft: { filename: "opaque-file.mp4", title: "", description: "" },
      snapshot: {
        status: "snapshot",
        rows: [selected],
        emptyRow: emptyRow(136),
      },
      selectedRow: 55,
      now: new Date("2026-08-30T10:00:00Z"),
      executablePlatforms: ["onlyfans", "fansly", "manyvids"],
      queueByPlatform: {},
    }),
  );

  assert.equal(result.candidate.row, 55);
  assert.deepEqual(result.targets.executable, ["manyvids"]);
  assert.equal(result.status, "needs-queue-evidence");
});

test("Add New uses the snapshot empty row and a collision-safe ID", () => {
  const proposal = loadProposal();
  const rows = [row({ row: 20, id: "episode-42", title: "Older video" })];

  const result = plain(
    proposal.buildNewCandidate(
      {
        title: "Episode 42",
        description: "New description",
        releaseDate: "2026-09-04",
      },
      {
        status: "snapshot",
        rows,
        emptyRow: emptyRow(136),
      },
    ),
  );

  assert.equal(result.row, 136);
  assert.equal(result.id, "episode-42-2");
  assert.equal(result.releaseDate, "2026-09-04");
  assert.equal(result.fingerprint, "1234abcd");
  assert.deepEqual(
    [
      result.pornhubLink,
      result.onlyfansLink,
      result.fanslyLink,
      result.manyvidsLink,
    ],
    ["", "", "", ""],
  );
});

test("series predecessor requires an exact normalized arc and numeric episode", () => {
  const proposal = loadProposal();
  const rows = [
    row({ row: 8, seasonArc: "Lara Arc", episode: "1" }),
    row({ row: 9, seasonArc: "lara-arc", episode: "2" }),
    row({ row: 10, seasonArc: "Lara Arc Extended", episode: "3" }),
    row({ row: 11, seasonArc: "Lara Arc", episode: "bonus" }),
  ];

  assert.equal(
    proposal.findPredecessor(
      row({ row: 12, seasonArc: "LARA ARC", episode: "4" }),
      rows,
    ).row,
    9,
  );
  assert.equal(
    proposal.findPredecessor(
      row({ row: 12, seasonArc: "LARA ARC", episode: "bonus" }),
      rows,
    ),
    null,
  );
});

test("verified scheduling respects future catalogue dates and occupied Fridays", () => {
  const proposal = loadProposal();
  const schedule = plain(
    proposal.proposeSchedule({
      now: new Date("2026-08-30T10:00:00Z"),
      row: row({ releaseDate: "2026-09-11" }),
      predecessor: null,
      platform: "manyvids",
      queueEvidence: {
        verified: true,
        scheduled: [],
        occupiedFridays: ["2026-09-11", "2026-09-18"],
      },
    }),
  );

  assert.equal(schedule.verified, true);
  assert.equal(schedule.releaseDate, "2026-09-25");
  assert.equal(schedule.scheduledIso, "2026-09-25T15:00:00.000Z");
  assert.deepEqual(schedule.evidence, [
    "Catalogue date sets the earliest slot: 2026-09-11",
    "ManyVids already has an upload on 2026-09-11",
    "ManyVids already has an upload on 2026-09-18",
  ]);
});

test("multiple executable targets use one Friday verified free across every queue", () => {
  const proposal = loadProposal();
  const candidate = row({
    title: "Shared Friday",
    id: "shared-friday",
    pornhubLink: "https://www.pornhub.com/view_video.php?viewkey=shared",
    onlyfansLink: "",
    fanslyLink: "",
  });
  const result = plain(
    proposal.build({
      draft: { filename: "Shared Friday.mp4", title: "Shared Friday" },
      snapshot: {
        status: "snapshot",
        rows: [candidate],
        emptyRow: emptyRow(136),
      },
      now: new Date("2026-08-30T10:00:00Z"),
      executablePlatforms: ["onlyfans", "fansly", "manyvids"],
      queueByPlatform: {
        onlyfans: {
          verified: true,
          scheduled: [],
          occupiedFridays: ["2026-09-11"],
        },
        fansly: {
          verified: true,
          scheduled: [],
          occupiedFridays: ["2026-09-04"],
        },
      },
    }),
  );

  assert.equal(result.status, "ready");
  assert.equal(result.schedules.onlyfans.releaseDate, "2026-09-18");
  assert.equal(result.schedules.fansly.releaseDate, "2026-09-18");
});

test("missing queue evidence stays unverified", () => {
  const proposal = loadProposal();
  const schedule = plain(
    proposal.proposeSchedule({
      now: new Date("2026-08-30T10:00:00Z"),
      row: row({ releaseDate: "2026-05-08" }),
      predecessor: null,
      platform: "manyvids",
      queueEvidence: null,
    }),
  );

  assert.equal(schedule.verified, false);
  assert.equal(schedule.releaseDate, "2026-09-04");
  assert.deepEqual(schedule.evidence, ["ManyVids queue is not verified"]);
});

test("fully linked rows produce no pending target", () => {
  const proposal = loadProposal();
  const linked = row({
    pornhubLink: "https://www.pornhub.com/view_video.php?viewkey=ph1",
  });

  const result = plain(
    proposal.build({
      draft: {
        filename: "BATTLEFIELD 6 episode 2.mp4",
        title: "BATTLEFIELD 6 episode 2",
        description: "",
      },
      snapshot: {
        status: "snapshot",
        rows: [linked],
        emptyRow: emptyRow(136),
      },
      now: new Date("2026-08-30T10:00:00Z"),
      executablePlatforms: ["onlyfans", "fansly", "manyvids"],
      queueByPlatform: {},
    }),
  );

  assert.equal(result.status, "nothing-pending");
  assert.deepEqual(result.targets.recommended, []);
});

test("explicit repeat targets retain their links and still require queue evidence", () => {
  const linked = row({
    onlyfansLink: "https://onlyfans.com/123456789/creator",
  });
  const result = plain(
    loadProposal().build({
      selectedRow: linked.row,
      snapshot: { status: "snapshot", rows: [linked] },
      now: new Date("2026-08-30T10:00:00Z"),
      executablePlatforms: ["onlyfans"],
      repeatPlatforms: ["onlyfans"],
    }),
  );
  assert.deepEqual(result.targets.executable, ["onlyfans"]);
  assert.equal(result.candidate.onlyfansLink, linked.onlyfansLink);
  assert.equal(result.status, "needs-queue-evidence");
});
