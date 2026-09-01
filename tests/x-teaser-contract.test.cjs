"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = path.resolve(__dirname, "..");

function loadContract() {
  const context = vm.createContext({ URL });
  for (const relative of [
    "creator-tools/catalogue-contract.js",
    "creator-tools/x-teaser-contract.js",
  ]) {
    vm.runInContext(
      fs.readFileSync(path.join(repositoryRoot, relative), "utf8"),
      context,
      { filename: relative },
    );
  }
  return context.CreatorXTeaserContract;
}

function fileProof(overrides = {}) {
  return {
    basename: "resident-evil-ashley--teaser-01--face.mp4",
    size: 12_345_678,
    lastModified: 1_788_244_200_000,
    duration: 36.787,
    sha256: "a".repeat(64),
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    row: 125,
    id: "resident-evil-ashley",
    title: "gooning to Ashley from Resident Evil 4",
    description: "Ashley teaser",
    fingerprint: "1234abcd",
    ...overrides,
  };
}

test("canonical X status URLs accept one handle and numeric status without query ambiguity", () => {
  const contract = loadContract();

  assert.equal(
    contract.canonicalStatusUrl(
      "https://x.com/Johnny_Guides/status/2094523397057237306",
    ),
    "https://x.com/Johnny_Guides/status/2094523397057237306",
  );
  for (const value of [
    "https://twitter.com/Johnny_Guides/status/2094523397057237306",
    "https://x.com/Johnny_Guides/status/not-a-number",
    "https://x.com/Johnny_Guides/status/2094523397057237306?token=private",
    "https://x.com/Johnny_Guides/status/2094523397057237306#fragment",
    "https://x.com/i/status/2094523397057237306",
  ]) {
    assert.equal(contract.canonicalStatusUrl(value), null, value);
  }
});

test("filename evidence ranks catalogue rows but never selects one", () => {
  const contract = loadContract();
  const result = contract.rankCatalogueRows(fileProof(), [
    row({ row: 104, id: "resident-evil-claire", title: "Claire Redfield" }),
    row(),
    row({ row: 110, id: "battlefield-ep02", title: "Battlefield 6" }),
  ]);

  assert.equal(result.selectedRow, null);
  assert.equal(result.rows[0].row, 125);
  assert.equal(result.rows[0].id, "resident-evil-ashley");
  assert.ok(result.rows[0].score > result.rows[1].score);
});

test("pairing freezes only a bounded file proof and one explicit row", () => {
  const contract = loadContract();
  const pairing = contract.freezePairing(
    fileProof({ rawPath: "D:\\private\\teaser.mp4", cookie: "forbidden" }),
    row({ twitterTeasers: "https://x.com/Johnny_Guides/status/1" }),
  );

  assert.deepEqual(JSON.parse(JSON.stringify(pairing)), {
    file: fileProof(),
    catalogue: {
      row: 125,
      id: "resident-evil-ashley",
      title: "gooning to Ashley from Resident Evil 4",
      fingerprint: "1234abcd",
    },
  });
  assert.throws(
    () => contract.freezePairing(fileProof(), null),
    /explicit catalogue row/i,
  );
  assert.throws(
    () => contract.freezePairing(fileProof({ sha256: "bad" }), row()),
    /file proof/i,
  );
});

test("capture validation fails closed on ambiguity, warning gates, and missing media proof", () => {
  const contract = loadContract();
  const capture = {
    url: "https://x.com/Johnny_Guides/status/2094523397057237306",
    articleCount: 1,
    caption: "found Ashley in RE4",
    timestamp: "2026-08-31T20:31:00.000Z",
    duration: 36.787,
    poster: "https://pbs.twimg.com/media/poster.jpg",
    video: true,
    warningGate: false,
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(contract.validateCapture(capture))),
    {
      statusId: "2094523397057237306",
      statusUrl: capture.url,
      caption: capture.caption,
      timestamp: capture.timestamp,
      duration: capture.duration,
      poster: capture.poster,
    },
  );

  for (const overrides of [
    { articleCount: 2 },
    { warningGate: true },
    { video: false },
    { timestamp: "yesterday" },
    { duration: 0 },
    { poster: "javascript:alert(1)" },
  ]) {
    assert.throws(
      () => contract.validateCapture({ ...capture, ...overrides }),
      /capture/i,
    );
  }
});
