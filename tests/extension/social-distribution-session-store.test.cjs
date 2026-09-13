"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = require("../support/paths.cjs").personalRoot;

function loadStore() {
  const values = {};
  let setInterceptor = null;
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
      if (setInterceptor) return setInterceptor(structuredClone(next), values);
      Object.assign(values, structuredClone(next));
    },
  };
  const context = vm.createContext({
    chrome: { storage: { local: storage } },
    structuredClone,
    URL,
  });
  for (const relative of [
    "workflows/social-distribution-contract.js",
    "workflows/social-distribution-session-store.js",
  ]) {
    vm.runInContext(
      fs.readFileSync(path.join(repositoryRoot, relative), "utf8"),
      context,
      { filename: relative },
    );
  }
  return {
    store: context.CreatorSocialDistributionSessionStore,
    interceptSet(interceptor) {
      setInterceptor = interceptor;
    },
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
    targets: {
      x: true,
      reddit: [
        {
          subreddit: "GamesGoneWild",
          presetId: "games-gone-wild",
          presetRevision: "c".repeat(64),
          title: { state: "nonempty", sha256: "d".repeat(64) },
          body: { state: "empty", sha256: "e".repeat(64) },
          flair: "Cosplay",
          nsfw: true,
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
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("create derives independent X, Redgifs, and Reddit jobs from one frozen plan", async () => {
  const { store } = loadStore();
  const created = plain(await store.create(plan()));
  assert.deepEqual(Object.keys(created.jobs), [
    "x",
    "redgifs",
    "reddit:gamesgonewild",
  ]);
  for (const job of Object.values(created.jobs)) {
    assert.equal(job.stage, "planned");
    assert.equal(job.submitAttempted, false);
  }
  assert.equal(JSON.stringify(created).includes("private"), false);
});

test("checkpoints never move backward or clear submit attempts", async () => {
  const { store } = loadStore();
  const id = plan().id;
  await store.create(plan());
  await store.checkpoint(id, "x", {
    stage: "submit-attempted",
    submitAttempted: true,
  });
  await store.checkpoint(id, "x", {
    stage: "prepared",
    submitAttempted: false,
  });
  const restored = plain(await store.load(id));
  assert.equal(restored.jobs.x.stage, "submit-attempted");
  assert.equal(restored.jobs.x.submitAttempted, true);
});

test("submit and uncertainty stages arm no-repost protection automatically", async () => {
  const { store } = loadStore();
  const id = plan().id;
  await store.create(plan());
  await store.checkpoint(id, "x", { stage: "submit-attempted" });
  await store.checkpoint(id, "redgifs", {
    stage: "posted-link-unresolved",
  });
  const restored = plain(await store.load(id));
  assert.equal(restored.jobs.x.submitAttempted, true);
  assert.equal(restored.jobs.redgifs.submitAttempted, true);
});

test("completed jobs cannot be overwritten by a later stale failure", async () => {
  const { store } = loadStore();
  const id = plan().id;
  await store.create(plan());
  await store.checkpoint(id, "x", {
    stage: "sheet-complete",
    resultId: "2094523397057237306",
    resultUrl: "https://x.com/Johnny_Guides/status/2094523397057237306",
  });
  await store.checkpoint(id, "x", { stage: "failed", error: "stale" });
  const restored = plain(await store.load(id));
  assert.equal(restored.jobs.x.stage, "sheet-complete");
});

test("captured canonical result identity is immutable", async () => {
  const { store } = loadStore();
  const id = plan().id;
  await store.create(plan());
  await store.checkpoint(id, "redgifs", {
    stage: "result-captured",
    submitAttempted: true,
    resultId: "ashley-cosplay-teaser",
    resultUrl: "https://www.redgifs.com/watch/ashley-cosplay-teaser",
  });
  await assert.rejects(
    store.checkpoint(id, "redgifs", {
      stage: "result-captured",
      resultId: "different",
      resultUrl: "https://www.redgifs.com/watch/different",
    }),
    /result identity/i,
  );
});

test("X keeps an immutable main result while arming and capturing its first reply", async () => {
  const { store } = loadStore();
  const id = plan().id;
  await store.create(plan());
  await store.checkpoint(id, "x", {
    stage: "submit-attempted",
    resultId: "2094523397057237306",
    resultUrl: "https://x.com/Johnny_Guides/status/2094523397057237306",
    replySubmitAttempted: true,
  });
  await store.checkpoint(id, "x", {
    stage: "result-captured",
    replyResultId: "2094523397057237307",
    replyResultUrl: "https://x.com/Johnny_Guides/status/2094523397057237307",
  });
  const restored = plain(await store.load(id));
  assert.equal(restored.jobs.x.replySubmitAttempted, true);
  assert.equal(restored.jobs.x.replyResultId, "2094523397057237307");
  await assert.rejects(
    store.checkpoint(id, "x", {
      replyResultId: "2094523397057237308",
      replyResultUrl: "https://x.com/Johnny_Guides/status/2094523397057237308",
    }),
    /reply.*identity/i,
  );
});

test("X rejects a malformed first-reply identity even when its main result was saved earlier", async () => {
  const { store } = loadStore();
  const id = plan().id;
  await store.create(plan());
  await store.checkpoint(id, "x", {
    stage: "submit-attempted",
    resultId: "2094523397057237306",
    resultUrl: "https://x.com/Johnny_Guides/status/2094523397057237306",
  });
  await assert.rejects(
    store.checkpoint(id, "x", {
      stage: "result-captured",
      replyResultId: "2094523397057237307",
      replyResultUrl: "https://example.com/status/2094523397057237307",
    }),
    /reply identity/i,
  );
});

test("X first reply must belong to the same account and differ from the main status", async () => {
  const { store } = loadStore();
  const id = plan().id;
  await store.create(plan());
  await store.checkpoint(id, "x", {
    stage: "submit-attempted",
    resultId: "2094523397057237306",
    resultUrl: "https://x.com/Johnny_Guides/status/2094523397057237306",
  });
  await assert.rejects(
    store.checkpoint(id, "x", {
      stage: "result-captured",
      replyResultId: "2094523397057237307",
      replyResultUrl: "https://x.com/AnotherAccount/status/2094523397057237307",
    }),
    /same X account/i,
  );
  await assert.rejects(
    store.checkpoint(id, "x", {
      stage: "result-captured",
      replyResultId: "2094523397057237306",
      replyResultUrl: "https://x.com/Johnny_Guides/status/2094523397057237306",
    }),
    /different X status/i,
  );
});

test("captured result URL must belong to the exact destination job", async () => {
  const { store } = loadStore();
  const id = plan().id;
  await store.create(plan());
  await assert.rejects(
    store.checkpoint(id, "x", {
      stage: "result-captured",
      resultId: "ashley-cosplay-teaser",
      resultUrl: "https://www.redgifs.com/watch/ashley-cosplay-teaser",
    }),
    /canonical result/i,
  );
  await assert.rejects(
    store.checkpoint(id, "reddit:gamesgonewild", {
      stage: "result-captured",
      resultId: "def456",
      resultUrl: "https://www.reddit.com/r/OtherSub/comments/def456/new_post",
    }),
    /canonical result/i,
  );
});

test("serialized sibling checkpoints preserve simultaneous X and Redgifs progress", async () => {
  const { store, interceptSet } = loadStore();
  const id = plan().id;
  await store.create(plan());
  let writes = 0;
  interceptSet(async (next, values) => {
    writes += 1;
    if (writes === 1) await new Promise((resolve) => setTimeout(resolve, 5));
    Object.assign(values, next);
  });
  await Promise.all([
    store.checkpoint(id, "x", {
      stage: "submit-attempted",
      submitAttempted: true,
    }),
    store.checkpoint(id, "redgifs", {
      stage: "prepared",
    }),
  ]);
  const restored = plain(await store.load(id));
  assert.equal(restored.jobs.x.stage, "submit-attempted");
  assert.equal(restored.jobs.x.submitAttempted, true);
  assert.equal(restored.jobs.redgifs.stage, "prepared");
});

test("store rejects unknown jobs and cannot replace an authorized plan", async () => {
  const { store } = loadStore();
  const original = plan();
  await store.create(original);
  await assert.rejects(
    store.checkpoint(original.id, "reddit:not-selected", { stage: "prepared" }),
    /unknown distribution job/i,
  );
  await assert.rejects(
    store.create({
      ...original,
      catalogue: { ...original.catalogue, row: 126 },
    }),
    /already exists/i,
  );
});

test("list returns durable sessions in stable order", async () => {
  const { store } = loadStore();
  const second = { ...plan(), id: "social-distribution-0002" };
  await store.create(second);
  await store.create(plan());
  assert.deepEqual(
    plain(await store.list()).map((record) => record.id),
    ["social-distribution-0001", "social-distribution-0002"],
  );
});
