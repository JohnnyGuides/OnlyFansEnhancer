"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = path.resolve(__dirname, "..");

function loadRuntime(options = {}) {
  const values = {};
  const storage = {
    async get(keys) {
      const wanted =
        keys == null
          ? Object.keys(values)
          : Array.isArray(keys)
            ? keys
            : [keys];
      return Object.fromEntries(
        wanted
          .filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, structuredClone(values[key])]),
      );
    },
    async set(next) {
      Object.assign(values, structuredClone(next));
    },
  };
  const context = vm.createContext({
    chrome: { storage: { local: storage } },
    structuredClone,
    URL,
  });
  for (const relative of [
    "creator-tools/social-distribution-contract.js",
    "creator-tools/social-distribution-session-store.js",
    "creator-tools/social-distribution-orchestrator.js",
  ]) {
    vm.runInContext(
      fs.readFileSync(path.join(repositoryRoot, relative), "utf8"),
      context,
      { filename: relative },
    );
  }

  const calls = [];
  const behavior = options.behavior || {};
  const results = {
    x: {
      resultId: "2094523397057237306",
      resultUrl: "https://x.com/Johnny_Guides/status/2094523397057237306",
    },
    redgifs: {
      resultId: "ashley-cosplay-teaser",
      resultUrl: "https://www.redgifs.com/watch/ashley-cosplay-teaser",
    },
    "reddit:gamesgonewild": {
      resultId: "def456",
      resultUrl:
        "https://www.reddit.com/r/GamesGoneWild/comments/def456/new_post",
    },
    "reddit:nsfw_gif": {
      resultId: "ghi789",
      resultUrl: "https://www.reddit.com/r/NSFW_GIF/comments/ghi789/new_post",
    },
  };
  function adapter(jobId) {
    return {
      async prepare(input) {
        calls.push(`prepare:${jobId}:${input.dependencyUrl || "none"}`);
        if (behavior[`prepare:${jobId}`] === "fail") {
          throw new Error(`prepare failed for ${jobId}`);
        }
        return { status: "prepared" };
      },
      async submit() {
        calls.push(`submit:${jobId}`);
        if (behavior[`submit:${jobId}`] === "fail") {
          throw new Error(`submit uncertain for ${jobId}`);
        }
        return { status: "submitted" };
      },
      async captureResult() {
        calls.push(`capture:${jobId}`);
        if (behavior[`capture:${jobId}`] === "missing") return null;
        if (behavior[`capture:${jobId}`] === "fail") {
          throw new Error(`capture failed for ${jobId}`);
        }
        return results[jobId];
      },
    };
  }
  const sheetCalls = [];
  let sheetFingerprint = "1234abcd";
  let sheetRevision = 0;
  const compactUrls = new Set();
  function compactResult(payload, urlField) {
    const url = payload[urlField];
    if (compactUrls.has(url)) {
      return { status: "idempotent", fingerprint: sheetFingerprint };
    }
    if (payload.fingerprint !== sheetFingerprint) {
      return { status: "stale", fingerprint: sheetFingerprint };
    }
    compactUrls.add(url);
    sheetRevision += 1;
    sheetFingerprint = `feed${String(sheetRevision).padStart(4, "0")}`;
    return { status: "updated", fingerprint: sheetFingerprint };
  }
  const catalogueClient = {
    async appendDistributionLedger(payload) {
      sheetCalls.push(["ledger", structuredClone(payload)]);
      if (behavior[`sheet:${payload.jobId}`] === "conflict") {
        return { status: "conflict" };
      }
      return { status: "updated" };
    },
    async appendTwitterTeaser(payload) {
      sheetCalls.push(["x", structuredClone(payload)]);
      return compactResult(payload, "statusUrl");
    },
    async appendRedditPost(payload) {
      sheetCalls.push(["reddit", structuredClone(payload)]);
      return compactResult(payload, "redditUrl");
    },
  };
  const orchestrator = context.CreatorSocialDistributionOrchestrator.create({
    store: context.CreatorSocialDistributionSessionStore,
    catalogueClient,
    adapterFor: adapter,
    resolvePaidLink: options.resolvePaidLink,
    now: () => 1_788_280_100_000,
  });
  return {
    calls,
    context,
    orchestrator,
    results,
    sheetCalls,
    store: context.CreatorSocialDistributionSessionStore,
  };
}

function plan(overrides = {}) {
  const base = {
    id: "social-distribution-0001",
    mode: "autonomous",
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
        {
          subreddit: "NSFW_GIF",
          presetId: "nsfw-gif",
          presetRevision: "4".repeat(64),
          title: { state: "nonempty", sha256: "5".repeat(64) },
          body: { state: "empty", sha256: "6".repeat(64) },
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
  };
  return { ...base, ...overrides };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("manual mode prepares independent roots and never clicks a submit control", async () => {
  const runtime = loadRuntime({
    behavior: { "capture:x": "missing", "capture:redgifs": "missing" },
  });
  await runtime.store.create(plan({ mode: "manual" }));
  const result = plain(
    await runtime.orchestrator.startSocialDistribution(plan().id),
  );
  assert.equal(result.jobs.x.stage, "prepared");
  assert.equal(result.jobs.redgifs.stage, "prepared");
  assert.equal(result.jobs["reddit:gamesgonewild"].stage, "planned");
  assert.equal(
    runtime.calls.some((call) => call.startsWith("submit:")),
    false,
  );
});

test("Redgifs failure blocks Reddit without cancelling successful X", async () => {
  const runtime = loadRuntime({
    behavior: { "prepare:redgifs": "fail" },
  });
  await runtime.store.create(plan());
  const result = plain(
    await runtime.orchestrator.startSocialDistribution(plan().id),
  );
  assert.equal(result.jobs.x.stage, "sheet-complete");
  assert.equal(result.jobs.redgifs.stage, "failed");
  assert.equal(result.jobs["reddit:gamesgonewild"].stage, "blocked");
  assert.equal(
    runtime.calls.some((call) => call.startsWith("prepare:reddit:")),
    false,
  );
});

test("one Reddit failure does not stop its sibling", async () => {
  const runtime = loadRuntime({
    behavior: { "prepare:reddit:gamesgonewild": "fail" },
  });
  await runtime.store.create(plan());
  const result = plain(
    await runtime.orchestrator.startSocialDistribution(plan().id),
  );
  assert.equal(result.jobs.redgifs.stage, "sheet-complete");
  assert.equal(result.jobs["reddit:gamesgonewild"].stage, "failed");
  assert.equal(result.jobs["reddit:nsfw_gif"].stage, "sheet-complete");
});

test("restart after an attempted submit captures the result without reposting", async () => {
  const runtime = loadRuntime();
  await runtime.store.create(
    plan({ targets: { x: true, reddit: [] }, evidence: { x: "f".repeat(64) } }),
  );
  await runtime.store.checkpoint(plan().id, "x", {
    stage: "submit-attempted",
  });
  const result = plain(
    await runtime.orchestrator.resumeSocialDistribution(plan().id),
  );
  assert.equal(result.jobs.x.stage, "sheet-complete");
  assert.equal(runtime.calls.includes("submit:x"), false);
  assert.equal(runtime.calls.includes("capture:x"), true);
});

test("missing result after submit becomes unresolved and never auto-reposts", async () => {
  const runtime = loadRuntime({ behavior: { "capture:x": "missing" } });
  await runtime.store.create(
    plan({ targets: { x: true, reddit: [] }, evidence: { x: "f".repeat(64) } }),
  );
  const first = plain(
    await runtime.orchestrator.startSocialDistribution(plan().id),
  );
  assert.equal(first.jobs.x.stage, "posted-link-unresolved");
  await runtime.orchestrator.resumeSocialDistribution(plan().id);
  assert.equal(runtime.calls.filter((call) => call === "submit:x").length, 1);
});

test("a later canonical result resolves uncertainty and unblocks Reddit without reposting Redgifs", async () => {
  const behavior = { "capture:redgifs": "missing" };
  const runtime = loadRuntime({ behavior });
  await runtime.store.create(plan());
  const first = plain(
    await runtime.orchestrator.startSocialDistribution(plan().id),
  );
  assert.equal(first.jobs.redgifs.stage, "posted-link-unresolved");
  assert.equal(first.jobs["reddit:gamesgonewild"].stage, "blocked");

  delete behavior["capture:redgifs"];
  const recovered = plain(
    await runtime.orchestrator.resumeSocialDistribution(plan().id),
  );
  assert.equal(recovered.jobs.redgifs.stage, "sheet-complete");
  assert.equal(recovered.jobs["reddit:gamesgonewild"].stage, "sheet-complete");
  assert.equal(
    runtime.calls.filter((call) => call === "submit:redgifs").length,
    1,
  );
});

test("Sheet conflict keeps captured result recoverable and never resubmits", async () => {
  const runtime = loadRuntime({ behavior: { "sheet:x": "conflict" } });
  await runtime.store.create(
    plan({ targets: { x: true, reddit: [] }, evidence: { x: "f".repeat(64) } }),
  );
  const first = plain(
    await runtime.orchestrator.startSocialDistribution(plan().id),
  );
  assert.equal(first.jobs.x.stage, "result-captured");
  await runtime.orchestrator.resumeSocialDistribution(plan().id);
  assert.equal(runtime.calls.filter((call) => call === "submit:x").length, 1);
});

test("retry creates a newly authorized session instead of reopening the old job", async () => {
  const runtime = loadRuntime({ behavior: { "prepare:x": "fail" } });
  await runtime.store.create(
    plan({ targets: { x: true, reddit: [] }, evidence: { x: "f".repeat(64) } }),
  );
  await runtime.orchestrator.startSocialDistribution(plan().id);
  await assert.rejects(
    runtime.orchestrator.retrySocialDestination(plan().id, "x", plan()),
    /new authorization/i,
  );
  const retryPlan = plan({
    id: "social-distribution-0002",
    targets: { x: true, reddit: [] },
    evidence: { x: "f".repeat(64) },
    authorization: {
      at: 1_788_280_200_000,
      sha256: "7".repeat(64),
    },
  });
  const result = plain(
    await runtime.orchestrator.retrySocialDestination(
      plan().id,
      "x",
      retryPlan,
    ),
  );
  assert.equal(result.id, retryPlan.id);
  assert.equal((await runtime.store.load(plan().id)).jobs.x.stage, "failed");
});

test("X waits for the exact paid-upload result while Redgifs and Reddit continue", async () => {
  let paidResult = null;
  const resolutions = [];
  const runtime = loadRuntime({
    async resolvePaidLink(dependency) {
      resolutions.push(structuredClone(dependency));
      return paidResult;
    },
  });
  const dependentPlan = plan({
    paidUrl: "",
    paidLinkSource: "onlyfans",
    paidUploadSessionId: "creator-upload-0001",
  });
  await runtime.store.create(dependentPlan);
  const waiting = plain(
    await runtime.orchestrator.startSocialDistribution(dependentPlan.id),
  );
  assert.equal(waiting.jobs.x.stage, "blocked");
  assert.equal(waiting.jobs.redgifs.stage, "sheet-complete");
  assert.equal(waiting.jobs["reddit:gamesgonewild"].stage, "sheet-complete");
  assert.equal(
    runtime.calls.some((call) => call.startsWith("prepare:x")),
    false,
  );
  assert.deepEqual(resolutions, [
    {
      platform: "onlyfans",
      uploadSessionId: "creator-upload-0001",
    },
  ]);

  paidResult = {
    platform: "onlyfans",
    uploadSessionId: "creator-upload-0001",
    postUrl: "https://onlyfans.com/123/johnny_guides",
  };
  const completed = plain(
    await runtime.orchestrator.resumeSocialDistribution(dependentPlan.id),
  );
  assert.equal(completed.jobs.x.stage, "sheet-complete");
  assert.equal(
    runtime.calls.includes("prepare:x:https://onlyfans.com/123/johnny_guides"),
    true,
  );
});

test("a mismatched paid-upload result never reaches the X adapter", async () => {
  const runtime = loadRuntime({
    async resolvePaidLink() {
      return {
        platform: "fansly",
        uploadSessionId: "other-upload-0001",
        postUrl: "https://fansly.com/post/123",
      };
    },
  });
  const dependentPlan = plan({
    paidUrl: "",
    paidLinkSource: "onlyfans",
    paidUploadSessionId: "creator-upload-0001",
    targets: { x: true, reddit: [] },
    evidence: { x: "f".repeat(64) },
  });
  await runtime.store.create(dependentPlan);
  const result = plain(
    await runtime.orchestrator.startSocialDistribution(dependentPlan.id),
  );
  assert.equal(result.jobs.x.stage, "blocked");
  assert.match(result.jobs.x.error, /does not match/i);
  assert.equal(
    runtime.calls.some((call) => call.startsWith("prepare:x")),
    false,
  );
});
