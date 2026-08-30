"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = path.resolve(__dirname, "..");

function loadStore() {
  const values = {};
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
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "creator-tools/upload-session-store.js"),
      "utf8",
    ),
    context,
    { filename: "creator-tools/upload-session-store.js" },
  );
  return { store: context.CreatorUploadSessionStore, values };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

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
