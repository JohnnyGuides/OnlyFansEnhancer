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
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const context = vm.createContext({
    chrome: { storage: { local: storage } },
    structuredClone,
    URL,
  });
  for (const relative of [
    "workflows/catalogue-contract.js",
    "workflows/x-teaser-contract.js",
    "workflows/x-teaser-session-store.js",
  ]) {
    vm.runInContext(
      fs.readFileSync(path.join(repositoryRoot, relative), "utf8"),
      context,
      { filename: relative },
    );
  }
  return {
    store: context.CreatorXTeaserSessionStore,
    values,
    interceptSet(value) {
      setInterceptor = value;
    },
  };
}

function pairing() {
  return {
    file: {
      basename: "resident-evil-ashley--teaser-01--face.mp4",
      size: 12345,
      lastModified: 1_788_244_200_000,
      duration: 36.787,
      sha256: "a".repeat(64),
    },
    catalogue: {
      row: 125,
      id: "resident-evil-ashley",
      title: "gooning to Ashley",
      fingerprint: "1234abcd",
    },
  };
}

function capture(statusId = "2094523397057237306") {
  return {
    statusId,
    statusUrl: `https://x.com/Johnny_Guides/status/${statusId}`,
    caption: "found Ashley in RE4",
    timestamp: "2026-08-31T20:31:00.000Z",
    duration: 36.787,
    poster: "https://pbs.twimg.com/media/poster.jpg",
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("X teaser storage keeps bounded reconciliation metadata and drops private fields", async () => {
  const { store } = loadStore();
  await store.save({
    id: "x-teaser-session-001",
    stage: "paired",
    pairing: {
      ...pairing(),
      rawPath: "D:\\MEDIA\\private.mp4",
      frames: ["data:image/jpeg;base64,private"],
    },
    cookie: "forbidden",
    requestBody: "forbidden",
  });

  const restored = plain(await store.load("x-teaser-session-001"));
  assert.equal(restored.stage, "paired");
  assert.deepEqual(restored.pairing, pairing());
  assert.equal(Object.hasOwn(restored, "cookie"), false);
  assert.equal(Object.hasOwn(restored, "requestBody"), false);
  assert.equal(Object.hasOwn(restored.pairing, "frames"), false);
  assert.equal(Object.hasOwn(restored.pairing, "rawPath"), false);
});

test("captured status and completed stages can never move backward or change identity", async () => {
  const { store } = loadStore();
  const id = "x-teaser-session-002";
  await store.save({
    id,
    stage: "status-captured",
    pairing: pairing(),
    capture: capture(),
  });
  await store.save({
    id,
    stage: "paired",
    capture: { ...capture("2094523397057237999"), statusId: "" },
  });
  await store.save({ id, stage: "audit-complete", auditOutcome: "updated" });
  await store.save({ id, stage: "status-captured", auditOutcome: "" });

  const restored = plain(await store.load(id));
  assert.equal(restored.stage, "audit-complete");
  assert.equal(restored.capture.statusId, "2094523397057237306");
  assert.equal(restored.auditOutcome, "updated");
});

test("one captured X status cannot belong to two sessions", async () => {
  const { store } = loadStore();
  await store.save({
    id: "x-teaser-session-003",
    stage: "status-captured",
    pairing: pairing(),
    capture: capture(),
  });

  await assert.rejects(
    store.save({
      id: "x-teaser-session-004",
      stage: "status-captured",
      pairing: pairing(),
      capture: capture(),
    }),
    /already belongs to another session/i,
  );
});

test("serialized writes preserve sibling reconciliation outcomes", async () => {
  const { store, interceptSet } = loadStore();
  const id = "x-teaser-session-005";
  await store.save({
    id,
    stage: "status-captured",
    pairing: pairing(),
    capture: capture("2094523397057237307"),
  });

  let writes = 0;
  interceptSet(async (next, values) => {
    writes += 1;
    if (writes === 1) await new Promise((resolve) => setTimeout(resolve, 5));
    Object.assign(values, next);
  });
  await Promise.all([
    store.save({ id, stage: "audit-complete", auditOutcome: "updated" }),
    store.save({ id, stage: "sheet-complete", sheetOutcome: "updated" }),
  ]);

  const restored = plain(await store.load(id));
  assert.equal(restored.stage, "sheet-complete");
  assert.equal(restored.auditOutcome, "updated");
  assert.equal(restored.sheetOutcome, "updated");
});

test("next action resumes only the first incomplete reconciliation stage", () => {
  const { store } = loadStore();
  assert.equal(store.nextAction({ stage: "paired" }), "observe-status");
  assert.equal(store.nextAction({ stage: "status-captured" }), "write-audit");
  assert.equal(store.nextAction({ stage: "audit-complete" }), "append-sheet");
  assert.equal(store.nextAction({ stage: "sheet-complete" }), "move-source");
  assert.equal(store.nextAction({ stage: "moved" }), "complete");
});

test("audit receipt survives restart without accepting private paths", async () => {
  const { store } = loadStore();
  const id = "receipt_session_123";
  await store.save({ id, stage: "paired", pairing: pairing() });
  await store.save({
    id,
    stage: "status-captured",
    capture: capture(),
  });
  await store.save({
    id,
    stage: "audit-complete",
    auditOutcome: "updated",
    auditReceipt: "abcdef0123456789abcdef0123456789",
    sourcePath: "D:\\MEDIA\\private.mp4",
  });
  const restored = await store.load(id);
  assert.equal(restored.auditReceipt, "abcdef0123456789abcdef0123456789");
  assert.equal(restored.sourcePath, undefined);
});
