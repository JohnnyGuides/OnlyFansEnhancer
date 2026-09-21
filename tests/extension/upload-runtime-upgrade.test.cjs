"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
function harness() {
  const session = {},
    local = {};
  let refuseArchive = false;
  function storage(values, persistent) {
    return {
      async get(keys) {
        const names =
          keys == null
            ? Object.keys(values)
            : Array.isArray(keys)
              ? keys
              : [keys];
        return structuredClone(
          Object.fromEntries(
            names
              .filter((k) => Object.hasOwn(values, k))
              .map((k) => [k, values[k]]),
          ),
        );
      },
      async set(value) {
        if (
          persistent &&
          refuseArchive &&
          Object.hasOwn(value, "creatorUploadRecoveryV1")
        )
          throw new Error("archive-not-durable");
        Object.assign(values, structuredClone(value));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys])
          delete values[key];
      },
    };
  }
  const sandbox = vm.createContext({
    URL,
    TextEncoder,
    structuredClone,
    crypto: webcrypto,
    chrome: {
      storage: {
        session: storage(session, false),
        local: storage(local, true),
      },
    },
  });
  for (const name of ["catalogue-contract", "upload-session-store"])
    vm.runInContext(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../extensions/personal/workflows/" + name + ".js",
        ),
        "utf8",
      ),
      sandbox,
    );
  return {
    store: sandbox.CreatorUploadSessionStore,
    session,
    local,
    refuseArchive: () => {
      refuseArchive = true;
    },
  };
}
const record = {
  id: "upgrade-session",
  launcher: "desktop",
  draft: {
    title: "Neutral test",
    fullFilename: "neutral.mp4",
    publishMode: "manual",
  },
  platforms: {
    manyvids: {
      tabId: 12,
      documentId: "22222222-2222-2222-2222-222222222222",
      boundUrl: "https://www.manyvids.com/upload-video",
      status: "uploading-full",
      stage: "upload",
      tokens: { full: "a".repeat(48) },
    },
  },
};
const step = {
  actionId: "select-full",
  platform: "manyvids",
  commandId: "11111111-1111-1111-1111-111111111111",
  documentId: "22222222-2222-2222-2222-222222222222",
  signature: "a".repeat(64),
  tabId: 12,
  frameId: 0,
  outcome: "intent",
};
test("upgrade archives old preparation, drops live bindings, preserves unrelated data and still prevents duplicate work", async () => {
  const f = harness();
  await f.store.ensureRuntimeVersion("0.20.24");
  await f.store.save(record);
  await f.store.recordStep(record.id, {
    ...step,
    work: await f.store.workIdentity(record),
  });
  await f.store.recordStep(record.id, {
    ...step,
    work: await f.store.workIdentity(record),
    outcome: "issued",
  });
  f.local.creatorToolkitV2 = { saved: true };
  f.session.unrelated = { keep: true };
  const before = structuredClone(f.local.creatorUploadRecoveryV1[0].steps);
  await f.store.ensureRuntimeVersion("0.20.31");
  assert.equal(f.session[f.store.KEY_PREFIX + record.id], undefined);
  assert.deepEqual(f.local.creatorToolkitV2, { saved: true });
  assert.deepEqual(f.session.unrelated, { keep: true });
  const archived = (await f.store.listRecovery())[0];
  assert.equal(archived.archivedVersion, "0.20.24");
  assert.deepEqual(JSON.parse(JSON.stringify(archived.steps)), before);
  await assert.rejects(
    f.store.assertAvailable({ ...record, id: "another-session" }, ["manyvids"]),
    /existing.*draft|reconcile/i,
  );
});
test("same runtime version never clears current preparations or queues", async () => {
  const f = harness();
  await f.store.ensureRuntimeVersion("0.20.24");
  await f.store.save(record);
  await f.store.recordStep(record.id, step);
  const before = JSON.stringify({ session: f.session, local: f.local });
  await f.store.ensureRuntimeVersion("0.20.24");
  assert.equal(JSON.stringify({ session: f.session, local: f.local }), before);
});
test("upgrade persists final-action evidence before removing legacy session state", async () => {
  const f = harness();
  f.session[f.store.KEY_PREFIX + record.id] = {
    ...record,
    platforms: {
      manyvids: {
        ...record.platforms.manyvids,
        commitArmed: true,
        submitAttempted: true,
      },
    },
  };
  await f.store.ensureRuntimeVersion("0.20.31");
  assert.equal(f.session[f.store.KEY_PREFIX + record.id], undefined);
  assert.equal((await f.store.listPublication()).length, 1);
  await assert.rejects(
    f.store.assertAvailable({ ...record, id: "another-session" }, ["manyvids"]),
    /publication attempt/,
  );
});
test("failed archive durability leaves old bindings and all recovery records untouched", async () => {
  const f = harness();
  await f.store.ensureRuntimeVersion("0.20.24");
  await f.store.save(record);
  await f.store.recordStep(record.id, step);
  const before = JSON.stringify({ session: f.session, local: f.local });
  f.refuseArchive();
  await assert.rejects(
    f.store.ensureRuntimeVersion("0.20.31"),
    /archive-not-durable/,
  );
  assert.equal(JSON.stringify({ session: f.session, local: f.local }), before);
});
test("downgrade or malformed version does not delete current state", async () => {
  const f = harness();
  await f.store.ensureRuntimeVersion("0.20.31");
  await f.store.save(record);
  const before = JSON.stringify({ session: f.session, local: f.local });
  for (const version of ["0.20.24", "invalid", ""])
    await assert.rejects(
      f.store.ensureRuntimeVersion(version),
      /version|downgrade/i,
    );
  assert.equal(JSON.stringify({ session: f.session, local: f.local }), before);
});

test("a durable final receipt without its draft is review evidence, never a restorable execution session", async () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../extensions/personal/background.js"),
    "utf8",
  );
  const from = source.indexOf("async function getCreatorUploadSession("),
    to = source.indexOf("function creatorUploadSessionProofMatches(", from);
  assert.ok(from >= 0 && to > from);
  let writes = 0;
  const sessions = new Map();
  const id = "a".repeat(48);
  const context = vm.createContext({
    Date,
    Map,
    Promise,
    setTimeout: () => 1,
    ensureCreatorUploadRuntimeVersion: async () => {},
    creatorUploadClean: (v) => String(v),
    CREATOR_UPLOAD_SESSION_PATTERN: /^[a-f0-9]{48}$/,
    creatorUploadSessions: sessions,
    checkpointCreatorUploadSession: async () => {
      writes++;
    },
    CREATOR_UPLOAD_SESSION_STORE: {
      load: async () => ({
        id,
        platforms: { onlyfans: { submitAttempted: true } },
      }),
    },
  });
  vm.runInContext(source.slice(from, to), context);
  assert.equal(await context.getCreatorUploadSession(id), null);
  assert.equal(sessions.size, 0);
  assert.equal(writes, 0);
});
