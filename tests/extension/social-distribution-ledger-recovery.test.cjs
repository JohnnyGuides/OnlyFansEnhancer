"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = require("../support/paths.cjs").personalRoot;

function storageOver(values) {
  return {
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
}

// One backend that outlives worker restarts: a ledger that compares the whole
// payload by event identity, like both real backends, and an advancing clock.
function backend(behavior = {}) {
  const ledger = new Map();
  const state = {
    calls: [],
    submits: 0,
    clock: 1_788_280_100_000,
    ledger,
    lostAck: new Set(behavior.lostAck || []),
    failOnce: new Set(behavior.failOnce || []),
    local: new Set(behavior.local || []),
    compactStale: behavior.compactStale === true,
  };
  state.now = () => (state.clock += 1000);
  state.client = {
    async appendDistributionLedger(payload) {
      state.calls.push(["ledger", payload.jobId, structuredClone(payload)]);
      if (state.failOnce.delete(payload.jobId)) {
        throw new Error(`ledger unavailable for ${payload.jobId}`);
      }
      const identity = `${payload.runId}|${payload.jobId}|${payload.eventId}`;
      const body = JSON.stringify(payload);
      let status;
      if (!ledger.has(identity)) {
        ledger.set(identity, body);
        status = state.local.has(payload.jobId) ? "recorded-local" : "updated";
      } else {
        status = ledger.get(identity) === body ? "idempotent" : "conflict";
      }
      if (state.lostAck.delete(payload.jobId)) {
        throw new Error("The acknowledgement was lost.");
      }
      return { status };
    },
    async appendTwitterTeaser(payload) {
      state.calls.push(["compact", "x", structuredClone(payload)]);
      if (state.compactStale) {
        state.compactStale = false;
        return { status: "stale", fingerprint: "feed0000" };
      }
      return { status: "updated", fingerprint: "feed0001" };
    },
    async appendRedditPost() {
      throw new Error("unused");
    },
  };
  return state;
}

function boot(values, state) {
  const context = vm.createContext({
    chrome: { storage: { local: storageOver(values) } },
    structuredClone,
    URL,
  });
  for (const relative of [
    "workflows/social-distribution-contract.js",
    "workflows/social-distribution-session-store.js",
    "workflows/social-distribution-orchestrator.js",
  ]) {
    vm.runInContext(
      fs.readFileSync(path.join(repositoryRoot, relative), "utf8"),
      context,
      { filename: relative },
    );
  }
  const result = {
    resultId: "2094523397057237306",
    resultUrl: "https://x.com/Johnny_Guides/status/2094523397057237306",
    replyResultId: "2094523397057237307",
    replyResultUrl: "https://x.com/Johnny_Guides/status/2094523397057237307",
  };
  const adapter = () => ({
    async prepare() {
      return { status: "prepared", preparedCaptionSha256: "c".repeat(64) };
    },
    async submit(input) {
      state.submits += 1;
      await input.beforeCommit();
      return { status: "submitted" };
    },
    async captureResult() {
      return result;
    },
  });
  const store = context.CreatorSocialDistributionSessionStore;
  return {
    store,
    orchestrator: context.CreatorSocialDistributionOrchestrator.create({
      store,
      catalogueClient: state.client,
      adapterFor: adapter,
      now: state.now,
    }),
  };
}

function plan() {
  return {
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
    targets: { x: true, reddit: [] },
    evidence: {
      x: "f".repeat(64),
      redgifs: "1".repeat(64),
      reddit: "2".repeat(64),
    },
    authorization: { at: 1_788_280_000_000, sha256: "3".repeat(64) },
  };
}

function ledgerCalls(state, jobId) {
  return state.calls.filter(
    ([kind, job]) => kind === "ledger" && job === jobId,
  );
}

test("a lost main-ledger acknowledgement retries the identical payload and never resubmits", async () => {
  const values = {};
  const state = backend({ lostAck: ["x"] });
  const runtime = boot(values, state);
  await runtime.store.create(plan());
  const first = await runtime.orchestrator.resumeSocialDistribution(plan().id);
  assert.equal(first.jobs.x.stage, "result-captured");
  const done = await runtime.orchestrator.resumeSocialDistribution(plan().id);
  assert.equal(done.jobs.x.stage, "sheet-complete");
  assert.equal(done.jobs.x.googleSynced, true);
  const main = ledgerCalls(state, "x");
  assert.equal(main.length, 2);
  assert.equal(JSON.stringify(main[0][2]), JSON.stringify(main[1][2]));
  assert.equal(state.submits, 1);
});

test("a failed reply-ledger append retries only the reply", async () => {
  const values = {};
  const state = backend({ failOnce: ["x:reply"] });
  const runtime = boot(values, state);
  await runtime.store.create(plan());
  await runtime.orchestrator.resumeSocialDistribution(plan().id);
  const done = await runtime.orchestrator.resumeSocialDistribution(plan().id);
  assert.equal(done.jobs.x.stage, "sheet-complete");
  assert.equal(ledgerCalls(state, "x").length, 1);
  const reply = ledgerCalls(state, "x:reply");
  assert.equal(reply.length, 2);
  assert.equal(JSON.stringify(reply[0][2]), JSON.stringify(reply[1][2]));
  assert.equal(state.submits, 1);
});

test("a failed compact append retries only the compact projection", async () => {
  const values = {};
  const state = backend({ compactStale: true });
  const runtime = boot(values, state);
  await runtime.store.create(plan());
  const first = await runtime.orchestrator.resumeSocialDistribution(plan().id);
  assert.equal(first.jobs.x.stage, "result-captured");
  const done = await runtime.orchestrator.resumeSocialDistribution(plan().id);
  assert.equal(done.jobs.x.stage, "sheet-complete");
  assert.equal(ledgerCalls(state, "x").length, 1);
  assert.equal(ledgerCalls(state, "x:reply").length, 1);
  assert.equal(state.calls.filter(([kind]) => kind === "compact").length, 2);
});

test("a restarted worker retries the persisted payload", async () => {
  const values = {};
  const state = backend({ lostAck: ["x"] });
  const before = boot(values, state);
  await before.store.create(plan());
  await before.orchestrator.resumeSocialDistribution(plan().id);
  const after = boot(values, state);
  const done = await after.orchestrator.resumeSocialDistribution(plan().id);
  assert.equal(done.jobs.x.stage, "sheet-complete");
  const main = ledgerCalls(state, "x");
  assert.equal(JSON.stringify(main[0][2]), JSON.stringify(main[1][2]));
  assert.equal(state.submits, 1);
});

test("a legacy captured job without a frozen payload is reviewed, never guessed or resubmitted", async () => {
  const values = {};
  const state = backend();
  const runtime = boot(values, state);
  await runtime.store.create(plan());
  const key = Object.keys(values)[0];
  values[key].jobs.x = {
    stage: "result-captured",
    submitAttempted: true,
    preparedComposerSha256: "c".repeat(64),
    resultId: "2094523397057237306",
    resultUrl: "https://x.com/Johnny_Guides/status/2094523397057237306",
    replyResultId: "2094523397057237307",
    replyResultUrl: "https://x.com/Johnny_Guides/status/2094523397057237307",
    replySubmitAttempted: true,
    updatedAt: 1_788_280_050_000,
  };
  const session = await runtime.orchestrator.resumeSocialDistribution(
    plan().id,
  );
  assert.equal(state.calls.length, 0);
  assert.equal(state.submits, 0);
  assert.equal(session.jobs.x.stage, "result-captured");
  assert.match(session.jobs.x.error, /capture time|review/i);
});

test("googleSynced stays false when only the reply ledger is local", async () => {
  const values = {};
  const state = backend({ local: ["x:reply"] });
  const runtime = boot(values, state);
  await runtime.store.create(plan());
  const done = await runtime.orchestrator.resumeSocialDistribution(plan().id);
  assert.equal(done.jobs.x.stage, "sheet-complete");
  assert.equal(done.jobs.x.googleSynced, false);
});
