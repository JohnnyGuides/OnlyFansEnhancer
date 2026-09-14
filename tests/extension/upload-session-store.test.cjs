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
  const context = vm.createContext({
    chrome: {
      storage: {
        session: {
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
            if (setInterceptor) {
              await setInterceptor(structuredClone(next), values);
              return;
            }
            Object.assign(values, structuredClone(next));
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete values[key];
            }
          },
        },
      },
    },
    structuredClone,
    crypto: require("node:crypto").webcrypto,
    TextEncoder,
    URL,
  });
  context.chrome.storage.local = context.chrome.storage.session;
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "workflows/catalogue-contract.js"),
      "utf8",
    ),
    context,
  );
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "workflows/upload-session-store.js"),
      "utf8",
    ),
    context,
    { filename: "workflows/upload-session-store.js" },
  );
  return {
    store: context.CreatorUploadSessionStore,
    values,
    interceptSet(interceptor) {
      setInterceptor = interceptor;
    },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("recovery capacity refuses new work without evicting unresolved sessions", async () => {
  const { store } = loadStore();
  const step = {
    actionId: "start-upload",
    platform: "manyvids",
    outcome: "intent",
    commandId: "11111111-1111-1111-1111-111111111111",
    documentId: "22222222-2222-2222-2222-222222222222",
    signature: "a".repeat(64),
    tabId: 42,
    frameId: 0,
  };
  for (let index = 0; index < 20; index++)
    await store.recordStep(`capacity-session-${index}`, step);
  await assert.rejects(
    store.recordStep("capacity-session-overflow", step),
    /journal is full/i,
  );
  assert.equal((await store.listRecovery())[0].id, "capacity-session-0");
  assert.equal((await store.listRecovery()).length, 20);
  await store.recordStep("capacity-session-0", {
    ...step,
    outcome: "observed",
  });
  assert.equal((await store.listRecovery())[0].steps[0].outcome, "observed");
});

test("legacy recovery records beyond the old cap remain visible", async () => {
  const { store, values } = loadStore();
  values[store.RECOVERY_KEY] = Array.from({ length: 25 }, (_, index) => ({
    id: `legacy-session-${index}`,
    steps: [],
  }));
  assert.equal((await store.listRecovery()).length, 25);
});

test("resetting an abandoned platform removes only its preparation evidence", async () => {
  const { store } = loadStore();
  const step = {
    actionId: "select-full",
    platform: "fansly",
    outcome: "intent",
    commandId: "11111111-1111-4111-8111-111111111111",
    documentId: "22222222-2222-4222-8222-222222222222",
    signature: "a".repeat(64),
    tabId: 42,
    frameId: 0,
  };
  await store.recordStep("abandoned-test-session", step);
  await store.recordStep("abandoned-test-session", {
    ...step,
    platform: "onlyfans",
    commandId: "33333333-3333-4333-8333-333333333333",
  });

  await store.resetPreparation("abandoned-test-session", "fansly");

  const records = plain(await store.listRecovery());
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "abandoned-test-session");
  assert.equal(records[0].steps.length, 1);
  assert.equal(records[0].steps[0].platform, "onlyfans");
  assert.equal(
    records[0].steps[0].commandId,
    "33333333-3333-4333-8333-333333333333",
  );
});

test("resetting preparation refuses a platform with a durable publish attempt", async () => {
  const { store } = loadStore();
  const id = "protected-test-session";
  await store.save({
    id,
    draft: { fullFilename: "neutral.mp4" },
    platforms: { fansly: { submitAttempted: true } },
  });

  await assert.rejects(
    store.resetPreparation(id, "fansly"),
    /publication attempt/i,
  );
});

test("final intent survives session loss and prevents a new session bypass", async () => {
  const { store, values } = loadStore();
  const record = {
    id: "durable-session-1111",
    draft: {
      title: "private caption",
      fullFilename: "private.mp4",
      scheduledIso: "2026-09-18T15:00:00Z",
    },
    catalogue: { source: "desktop", itemId: "private-item" },
    platforms: {
      onlyfans: {
        tabId: 42,
        documentId: "22222222-2222-2222-2222-222222222222",
        commitArmed: true,
        submitAttempted: true,
      },
    },
  };
  await store.save(record);
  delete values[store.KEY_PREFIX + record.id];
  const recovered = await store.load(record.id);
  assert.equal(recovered.platforms.onlyfans.submitAttempted, true);
  assert.equal(
    (await store.list()).find((item) => item.id === record.id).platforms
      .onlyfans.submitAttempted,
    true,
  );
  assert.doesNotMatch(JSON.stringify(values), /private|caption|Filename/);
  await assert.rejects(
    store.assertAvailable({ ...record, id: "durable-session-2222" }, [
      "onlyfans",
    ]),
    /unresolved/i,
  );
  await store.save({
    id: record.id,
    platforms: { onlyfans: { submitAttempted: false } },
  });
  assert.equal(
    (await store.load(record.id)).platforms.onlyfans.submitAttempted,
    true,
  );
  await store.remove(record.id);
  assert.equal(
    (await store.load(record.id)).platforms.onlyfans.submitAttempted,
    true,
  );
});

test("durable receipt retains a canonical result independently of session metadata", async () => {
  const { store, values } = loadStore();
  const id = "canonical-result-session";
  await store.save({
    id,
    draft: { title: "private" },
    platforms: {
      fansly: {
        submitAttempted: true,
        postUrl: "https://fansly.com/post/123456789",
      },
    },
  });
  delete values[store.KEY_PREFIX + id];
  assert.equal(
    (await store.load(id)).platforms.fansly.postUrl,
    "https://fansly.com/post/123456789",
  );
  assert.doesNotMatch(JSON.stringify(values), /private/);
});

test("export migrates available legacy final flags before session storage is lost", async () => {
  const { store, values } = loadStore();
  const id = "legacy-final-session";
  values[store.KEY_PREFIX + id] = {
    id,
    draft: { fullFilename: "neutral.mp4", title: "private caption" },
    platforms: { fansly: { commitArmed: true, tabId: 7 } },
  };
  const exported = plain(await store.listPublication());
  assert.equal(exported.length, 1);
  assert.equal(exported[0].submitAttempted, true);
  assert.doesNotMatch(JSON.stringify(exported), /neutral|caption|Filename/);
  delete values[store.KEY_PREFIX + id];
  assert.equal((await store.load(id)).platforms.fansly.commitArmed, true);
  await assert.rejects(
    store.assertAvailable(
      { id: "new-final-session", draft: { fullFilename: "neutral.mp4" } },
      ["fansly"],
    ),
    /unresolved/,
  );
});

test("another command or session cannot repeat a selected role after acknowledgement loss", async () => {
  const { store } = loadStore();
  const record = {
    id: "first-preparation-session",
    draft: { fullFilename: "neutral.mp4" },
  };
  const step = {
    actionId: "select-full",
    platform: "onlyfans",
    outcome: "intent",
    commandId: "11111111-1111-4111-8111-111111111111",
    documentId: "22222222-2222-4222-8222-222222222222",
    signature: "a".repeat(64),
    work: await store.workIdentity(record),
    tabId: 42,
    frameId: 0,
  };
  await store.recordStep(record.id, step);
  await assert.rejects(
    store.recordStep(record.id, {
      ...step,
      commandId: "33333333-3333-4333-8333-333333333333",
    }),
    /existing.*action/i,
  );
  await assert.rejects(
    store.assertAvailable(
      {
        ...record,
        id: "new-preparation-session",
        draft: { ...record.draft, title: "A changed title" },
      },
      ["onlyfans"],
    ),
    /existing.*draft/i,
  );
  await store.assertAvailable({ ...record, id: "new-preparation-session" }, [
    "fansly",
  ]);
});

test("desktop and extension preparation journals do not collide", async () => {
  const { store } = loadStore();
  const extensionRecord = {
    id: "extension-preparation-session",
    launcher: "extension",
    draft: { fullFilename: "neutral.mp4" },
  };
  await store.recordStep(extensionRecord.id, {
    actionId: "select-full",
    platform: "fansly",
    outcome: "intent",
    commandId: "11111111-1111-4111-8111-111111111111",
    documentId: "22222222-2222-4222-8222-222222222222",
    signature: "a".repeat(64),
    work: await store.workIdentity(extensionRecord),
    tabId: 42,
    frameId: 0,
  });

  await store.assertAvailable(
    {
      id: "desktop-preparation-session",
      launcher: "desktop",
      draft: { fullFilename: "neutral.mp4" },
    },
    ["fansly"],
  );
});

test("recovery journal keeps bounded non-secret monotonic step evidence across session loss", async () => {
  const { store, values } = loadStore();
  const id = "journal-session-12345678";
  const step = {
    actionId: "start-upload",
    platform: "manyvids",
    outcome: "intent",
    commandId: "11111111-1111-1111-1111-111111111111",
    documentId: "22222222-2222-2222-2222-222222222222",
    signature: "a".repeat(64),
    tabId: 42,
    frameId: 0,
    filePath: "C:\\private\\video.mp4",
    caption: "private",
  };
  await store.recordStep(id, step);
  await store.recordStep(id, { ...step, outcome: "observed" });
  await store.recordStep(id, step);
  const recovered = plain(await store.listRecovery());
  assert.equal(recovered[0].steps[0].outcome, "observed");
  assert.equal(recovered[0].explicitResumeRequired, true);
  assert.equal(await store.load(id), null);
  assert.doesNotMatch(JSON.stringify(values), /private|filePath|caption/);
  await assert.rejects(
    store.recordStep(id, { ...step, tabId: 99 }),
    /identity changed/,
  );
  await assert.rejects(
    store.recordStep(id, { ...step, actionId: "publish" }),
    /Invalid preparation/,
  );
});

test("upload session storage round-trips only bounded allow-listed metadata", async () => {
  const { store } = loadStore();
  const id = "upload-session-12345678";
  await store.save({
    id,
    createdAt: 100,
    updatedAt: 200,
    draft: {
      title: `Episode${"x".repeat(1000)}`,
      description: "Caption",
      fullFilename: "episode.mp4",
      profiles: { fanslyPrefill: { message: "#tags" } },
      cookie: "forbidden",
    },
    catalogue: { row: 42, id: "episode", fingerprint: "1234abcd" },
    platforms: {
      onlyfans: {
        platform: "onlyfans",
        tabId: 7,
        stage: "submit",
        status: "submitted",
        createdAt: 100,
        updatedAt: 200,
        commitArmed: true,
        submitAttempted: true,
        postUrl: "https://onlyfans.com/1/johnny_guides",
        token: "forbidden",
      },
      unknown: { status: "forbidden" },
    },
    cookie: "forbidden",
    requestBody: "forbidden",
  });

  const restored = plain(await store.load(id));
  assert.equal(restored.id, id);
  assert.equal(restored.draft.title.length, 500);
  assert.equal(restored.draft.description, "Caption");
  assert.equal(restored.draft.profiles.fanslyPrefill.message, "#tags");
  assert.equal(restored.catalogue.row, 42);
  assert.equal(restored.platforms.onlyfans.tabId, 7);
  assert.equal(restored.platforms.onlyfans.submitAttempted, true);
  assert.equal(Object.hasOwn(restored, "cookie"), false);
  assert.equal(Object.hasOwn(restored.draft, "cookie"), false);
  assert.equal(Object.hasOwn(restored.platforms.onlyfans, "token"), false);
  assert.equal(Object.hasOwn(restored.platforms, "unknown"), false);
});

test("upload session writes cannot clear attempted submits or captured IDs and URLs", async () => {
  const { store } = loadStore();
  const id = "upload-session-abcdefgh";
  await store.save({
    id,
    draft: { title: "Episode", description: "Caption" },
    platforms: {
      onlyfans: {
        platform: "onlyfans",
        submitAttempted: true,
        commitArmed: true,
        status: "submitted",
        postUrl: "https://onlyfans.com/1/johnny_guides",
      },
      manyvids: {
        platform: "manyvids",
        manyvidsId: "7783271",
        postUrl: "https://www.manyvids.com/Video/7783271",
      },
    },
  });
  await store.save({
    id,
    platforms: {
      onlyfans: {
        platform: "onlyfans",
        submitAttempted: false,
        commitArmed: false,
        status: "prepared",
        postUrl: "",
      },
      manyvids: { platform: "manyvids", manyvidsId: "", postUrl: "" },
    },
  });

  const restored = plain(await store.load(id));
  assert.equal(restored.platforms.onlyfans.submitAttempted, true);
  assert.equal(restored.platforms.onlyfans.commitArmed, true);
  assert.equal(
    restored.platforms.onlyfans.postUrl,
    "https://onlyfans.com/1/johnny_guides",
  );
  assert.equal(restored.platforms.manyvids.manyvidsId, "7783271");
  assert.equal(
    restored.platforms.manyvids.postUrl,
    "https://www.manyvids.com/Video/7783271",
  );
});

test("concurrent upload checkpoints cannot erase a sibling submit flag", async () => {
  const { store, interceptSet } = loadStore();
  const id = "upload-session-concurrent";
  await store.save({
    id,
    platforms: {
      onlyfans: { platform: "onlyfans", submitAttempted: false },
      fansly: { platform: "fansly", submitAttempted: false },
    },
  });

  let releaseFirstWrite;
  let writeCount = 0;
  interceptSet(async (next, values) => {
    writeCount += 1;
    if (writeCount === 1) {
      await new Promise((resolve) => {
        releaseFirstWrite = resolve;
        setTimeout(resolve, 0);
      });
      Object.assign(values, next);
      return;
    }
    Object.assign(values, next);
    releaseFirstWrite();
  });

  await Promise.all([
    store.save({
      id,
      platforms: {
        onlyfans: { platform: "onlyfans", submitAttempted: true },
        fansly: { platform: "fansly", submitAttempted: false },
      },
    }),
    store.save({
      id,
      platforms: {
        onlyfans: { platform: "onlyfans", submitAttempted: true },
        fansly: { platform: "fansly", submitAttempted: true },
      },
    }),
  ]);

  const restored = plain(await store.load(id));
  assert.equal(restored.platforms.onlyfans.submitAttempted, true);
  assert.equal(restored.platforms.fansly.submitAttempted, true);
});

test("upload session list and remove operate only on the store prefix", async () => {
  const { store, values } = loadStore();
  values.unrelated = { keep: true };
  await store.save({ id: "upload-session-one11111", platforms: {} });
  await store.save({ id: "upload-session-two22222", platforms: {} });

  assert.deepEqual(
    plain(await store.list()).map((record) => record.id),
    ["upload-session-one11111", "upload-session-two22222"],
  );
  await store.remove("upload-session-one11111");
  assert.equal(await store.load("upload-session-one11111"), null);
  assert.deepEqual(values.unrelated, { keep: true });
});
