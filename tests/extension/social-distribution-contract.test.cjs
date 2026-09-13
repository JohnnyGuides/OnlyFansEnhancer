"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = require("../support/paths.cjs").personalRoot;

function loadContract() {
  const context = vm.createContext({ URL });
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "workflows/social-distribution-contract.js"),
      "utf8",
    ),
    context,
    { filename: "workflows/social-distribution-contract.js" },
  );
  return context.CreatorSocialDistributionContract;
}

function input(overrides = {}) {
  return {
    id: "social-distribution-0001",
    mode: "manual",
    catalogue: {
      row: 125,
      id: "resident-evil-ashley",
      title: "gooning to Ashley",
      fingerprint: "1234abcd",
    },
    socialFile: {
      basename: "ashley-social-teaser.mp4",
      size: 12345,
      lastModified: 1_788_244_200_000,
      duration: 36.787,
      sha256: "a".repeat(64),
    },
    caption: { state: "nonempty", sha256: "b".repeat(64) },
    paidUrl: "https://onlyfans.com/1/johnny_guides",
    targets: {
      x: true,
      reddit: [
        {
          subreddit: "GamesGoneWild",
          presetId: "games-gone-wild",
          presetRevision: "c".repeat(64),
          title: { state: "nonempty", sha256: "d".repeat(64) },
          body: { state: "empty", sha256: "e".repeat(64) },
        },
      ],
    },
    evidence: {
      x: "f".repeat(64),
      redgifs: "1".repeat(64),
      reddit: "2".repeat(64),
    },
    authorization: {
      at: 1_788_280_000_000,
      sha256: "3".repeat(64),
    },
    ...overrides,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("explicit deferred catalogue preserves publication proof validation", () => {
  const contract = loadContract();
  assert.equal(
    contract.freezeDistributionPlan(input({ catalogue: null })).catalogue,
    null,
  );
  assert.throws(
    () => contract.freezeDistributionPlan(input({ catalogue: undefined })),
    /catalogue row/,
  );
  assert.throws(
    () =>
      contract.freezeDistributionPlan(
        input({ catalogue: null, socialFile: {} }),
      ),
    /file proof/,
  );
});

test("freezes one bounded distribution plan without caption or body text", () => {
  const contract = loadContract();
  const plan = contract.freezeDistributionPlan({
    ...input(),
    captionText: "private caption",
    cookie: "forbidden",
    targets: {
      ...input().targets,
      reddit: [
        {
          ...input().targets.reddit[0],
          titleText: "private title",
          bodyText: "private body",
          flair: "Cosplay",
          nsfw: true,
        },
      ],
    },
  });

  assert.deepEqual(plain(plan), {
    ...input(),
    targets: {
      x: true,
      reddit: [
        {
          ...input().targets.reddit[0],
          flair: "Cosplay",
          nsfw: true,
        },
      ],
    },
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.targets.reddit[0]), true);
  assert.equal(JSON.stringify(plan).includes("private"), false);
});

test("requires trace evidence for every selected publishing path", () => {
  const contract = loadContract();
  assert.throws(
    () =>
      contract.freezeDistributionPlan({
        ...input(),
        evidence: { x: "f".repeat(64) },
      }),
    /Redgifs trace evidence/i,
  );
  assert.throws(
    () =>
      contract.freezeDistributionPlan({
        ...input(),
        targets: { x: true, reddit: [] },
        evidence: {},
      }),
    /X trace evidence/i,
  );
});

test("rejects ambiguous catalogue, unsafe URLs, duplicate subreddits, and unhashed copy", () => {
  const contract = loadContract();
  assert.throws(
    () =>
      contract.freezeDistributionPlan({
        ...input(),
        catalogue: { ...input().catalogue, row: 0 },
      }),
    /catalogue/i,
  );
  assert.throws(
    () =>
      contract.freezeDistributionPlan({
        ...input(),
        paidUrl: "javascript:alert(1)",
      }),
    /paid URL/i,
  );
  assert.throws(
    () =>
      contract.freezeDistributionPlan({
        ...input(),
        caption: { state: "nonempty", sha256: "" },
      }),
    /caption/i,
  );
  assert.throws(
    () =>
      contract.freezeDistributionPlan({
        ...input(),
        targets: {
          x: false,
          reddit: [
            input().targets.reddit[0],
            { ...input().targets.reddit[0], subreddit: "gamesgonewild" },
          ],
        },
      }),
    /duplicate subreddit/i,
  );
});

test("accepts X-only and Reddit-only plans and normalizes public identifiers", () => {
  const contract = loadContract();
  const xOnly = contract.freezeDistributionPlan({
    ...input(),
    targets: { x: true, reddit: [] },
    evidence: { x: "f".repeat(64) },
  });
  assert.deepEqual(plain(xOnly.evidence), { x: "f".repeat(64) });

  const redditOnly = contract.freezeDistributionPlan({
    ...input(),
    targets: {
      x: false,
      reddit: [{ ...input().targets.reddit[0], subreddit: "r/GamesGoneWild" }],
    },
    evidence: { redgifs: "1".repeat(64), reddit: "2".repeat(64) },
  });
  assert.equal(redditOnly.targets.reddit[0].subreddit, "GamesGoneWild");
});

test("can freeze a paid-link dependency on the authorized platform upload", () => {
  const contract = loadContract();
  const plan = contract.freezeDistributionPlan({
    ...input(),
    paidUrl: "",
    paidLinkSource: "onlyfans",
    paidUploadSessionId: "creator-upload-0001",
  });
  assert.equal(plan.paidUrl, "");
  assert.deepEqual(plain(plan.paidLinkDependency), {
    platform: "onlyfans",
    uploadSessionId: "creator-upload-0001",
  });
  assert.throws(
    () =>
      contract.freezeDistributionPlan({
        ...input(),
        paidUrl: "",
        paidLinkSource: "onlyfans",
      }),
    /upload session/i,
  );
  assert.throws(
    () =>
      contract.freezeDistributionPlan({
        ...input(),
        paidUrl: "",
        paidLinkSource: "pornhub",
        paidUploadSessionId: "creator-upload-0001",
      }),
    /paid URL|paid-link source/i,
  );
});

test("exact teaser SHA proof does not require decoding video duration", () => {
  const contract = loadContract();
  const value = input();
  delete value.socialFile.duration;
  const plan = contract.freezeDistributionPlan(value);
  assert.deepEqual(plain(plan.socialFile), {
    basename: "ashley-social-teaser.mp4",
    size: 12345,
    lastModified: 1_788_244_200_000,
    sha256: "a".repeat(64),
  });
});

test("manual Reddit draft preparation can omit publish traces but never X proof or become autonomous", () => {
  const contract = loadContract();
  const draft = input({
    preparationOnly: true,
    evidence: { x: "f".repeat(64) },
  });
  assert.equal(contract.freezeDistributionPlan(draft).preparationOnly, true);
  assert.throws(
    () => contract.freezeDistributionPlan({ ...draft, mode: "autonomous" }),
    /manual/,
  );
  assert.throws(
    () => contract.freezeDistributionPlan({ ...draft, evidence: {} }),
    /X|x/,
  );
  assert.throws(
    () => contract.freezeDistributionPlan({ ...draft, preparationOnly: false }),
    /evidence|trace|SHA/i,
  );
});
