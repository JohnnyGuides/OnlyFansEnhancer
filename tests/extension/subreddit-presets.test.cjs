"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = require("../support/paths.cjs").personalRoot;

function loadPresets() {
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "workflows/subreddit-presets.js"),
      "utf8",
    ),
    context,
    { filename: "workflows/subreddit-presets.js" },
  );
  return context.CreatorSubredditPresets;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("normalizes catalogue seed rows into stable bounded presets", () => {
  const presets = loadPresets();
  const snapshot = plain(
    presets.normalizeSnapshot([
      {
        subreddit: "r/GamesGoneWild",
        status: "Approved",
        notes: "flair: Cosplay\nnsfw: yes\nUse a Redgifs link.",
        ignored: "forbidden",
      },
      {
        subreddit: "NSFW_GIF",
        status: "Needs review",
        notes: "Confirm title wording manually.",
      },
    ]),
  );
  assert.deepEqual(snapshot.presets[0], {
    id: "gamesgonewild",
    subreddit: "GamesGoneWild",
    status: "Approved",
    rawStatus: "Approved",
    readiness: "review",
    notes: "flair: Cosplay\nnsfw: yes\nUse a Redgifs link.",
    revision: snapshot.presets[0].revision,
  });
  assert.match(snapshot.presets[0].revision, /^[a-f0-9]{8}$/);
  assert.equal(Object.hasOwn(snapshot.presets[0], "ignored"), false);
});

test("autonomous mode exposes only Approved presets while manual mode keeps review rows", () => {
  const presets = loadPresets();
  const snapshot = presets.normalizeSnapshot([
    { subreddit: "ApprovedSub", status: "Approved", notes: "" },
    { subreddit: "ReviewSub", status: "Needs review", notes: "check" },
    { subreddit: "NopeSub", status: "Rejected", notes: "" },
  ]);
  assert.deepEqual(
    plain(presets.forMode(snapshot, "autonomous")).map(
      (preset) => preset.subreddit,
    ),
    ["ApprovedSub"],
  );
  assert.deepEqual(
    plain(presets.forMode(snapshot, "manual")).map(
      (preset) => preset.subreddit,
    ),
    ["ApprovedSub", "ReviewSub"],
  );
});

test("rejects duplicate, malformed, and unbounded subreddit rows", () => {
  const presets = loadPresets();
  assert.throws(
    () =>
      presets.normalizeSnapshot([
        { subreddit: "r/Same_Sub", status: "Approved" },
        { subreddit: "same_sub", status: "Approved" },
      ]),
    /duplicate/i,
  );
  assert.throws(
    () => presets.normalizeSnapshot([{ subreddit: "bad-name!" }]),
    /subreddit/i,
  );
});

test("ready shortlist preserves source labels without granting autonomous permission", () => {
  const presets = loadPresets();
  const snapshot = presets.normalizeSnapshot([
    { subreddit: "CheckSub", status: "check", notes: "Review rules" },
    { subreddit: "ReadySub", status: "Ready", notes: "" },
    {
      subreddit: "PermissionSub",
      status: "permissions",
      notes: "Request access",
    },
    { subreddit: "RejectedSub", status: "Rejected", notes: "" },
  ]);
  assert.deepEqual(
    plain(presets.rankReady(snapshot)).map((row) => row.subreddit),
    ["ReadySub", "CheckSub", "PermissionSub", "RejectedSub"],
  );
  assert.equal(snapshot.presets[1].rawStatus, "Ready");
  assert.equal(snapshot.presets[1].status, "Needs review");
  assert.equal(presets.forMode(snapshot, "autonomous").length, 0);
  assert.equal(presets.forMode(snapshot, "manual").length, 3);
});
