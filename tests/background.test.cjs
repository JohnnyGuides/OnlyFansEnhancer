"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backgroundPath = path.resolve(__dirname, "..", "background.js");
const manifestPath = path.resolve(__dirname, "..", "manifest.json");
const gelbooruRulesPath = path.resolve(__dirname, "..", "gelbooru-rules.json");
const storage = {};
let messageListener;
let installListener;
let lastFetchUrl = "";
const fetchedFingerprints = new Set();

const gelbooruPosts = [
  {
    id: 1001,
    md5: "11111111111111111111111111111111",
    rating: "general",
    tags: "1girl selfie solo looking_at_viewer smile",
    preview_url: "https://img.example/1001.jpg"
  },
  {
    id: 1002,
    md5: "22222222222222222222222222222222",
    rating: "general",
    tags: "1girl selfie solo looking_at_viewer trans",
    preview_url: "https://img.example/1002.jpg"
  },
  {
    id: 1003,
    md5: "33333333333333333333333333333333",
    rating: "general",
    tags: "1girl selfie solo looking_at_viewer outdoors",
    preview_url: "https://img.example/1003.jpg"
  },
  {
    id: 1004,
    md5: "44444444444444444444444444444444",
    rating: "explicit",
    tags: "1girl selfie solo looking_at_viewer lingerie",
    preview_url: "https://img.example/1004.jpg"
  },
  {
    id: 1005,
    md5: "11111111111111111111111111111111",
    rating: "explicit",
    tags: "1girl selfie solo looking_at_viewer lingerie",
    preview_url: "https://img.example/1005-duplicate.jpg"
  }
];

const realbooruPosts = [
  {
    source: "realbooru",
    id: "9001",
    url: "https://realbooru.com/images/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg",
    postUrl: "https://realbooru.com/index.php?page=post&s=view&id=9001",
    fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tags: ["1girl", "female", "selfie", "solo", "looking_at_viewer", "topless"]
  },
  {
    source: "realbooru",
    id: "9002",
    url: "https://realbooru.com/images/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg",
    postUrl: "https://realbooru.com/index.php?page=post&s=view&id=9002",
    fingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    tags: ["female", "selfie", "solo", "looking_at_viewer", "lingerie"]
  },
  {
    source: "realbooru",
    id: "9003",
    url: "https://realbooru.com/images/cc/cccccccccccccccccccccccccccccccc.jpg",
    postUrl: "https://realbooru.com/index.php?page=post&s=view&id=9003",
    fingerprint: "cccccccccccccccccccccccccccccccc",
    tags: ["female_only", "selfie", "solo", "looking_at_viewer", "nude"]
  },
  {
    source: "realbooru",
    id: "9004",
    url: "https://realbooru.com/images/dd/dddddddddddddddddddddddddddddddd.jpg",
    postUrl: "https://realbooru.com/index.php?page=post&s=view&id=9004",
    fingerprint: "dddddddddddddddddddddddddddddddd",
    tags: ["1girl", "selfie", "solo", "looking_at_viewer", "trans"]
  }
];

const chrome = {
  permissions: {
    contains: async () => true
  },
  runtime: {
    onInstalled: {
      addListener(listener) {
        installListener = listener;
      }
    },
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      }
    }
  },
  storage: {
    local: {
      async get(keys) {
        const selected = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (Object.hasOwn(storage, key)) selected[key] = structuredClone(storage[key]);
        }
        return selected;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) {
          storage[key] = structuredClone(value);
        }
      }
    }
  }
};

const context = vm.createContext({
  Blob,
  btoa,
  chrome,
  console,
  fetch: async (url) => {
    lastFetchUrl = String(url);
    if (/^http:\/\/127\.0\.0\.1:47831\/random/.test(lastFetchUrl)) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ ok: true, posts: structuredClone(realbooruPosts) })
      };
    }
    if (/^https:\/\/realbooru\.com\/images\//.test(lastFetchUrl)) {
      const post = realbooruPosts.find((item) => item.url === lastFetchUrl);
      assert.equal(
        storage.fimStateV1?.usedRealbooruIds?.[post.id],
        true,
        "A Realbooru ID must be durably reserved before its image bytes are fetched."
      );
      assert.equal(storage.fimStateV1?.usedAvatarUrls?.[post.url], true);
      assert.equal(
        storage.fimStateV1?.usedAvatarFingerprints?.[post.fingerprint],
        true
      );
      assert.equal(fetchedFingerprints.has(post.fingerprint), false);
      fetchedFingerprints.add(post.fingerprint);
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["real-image"], { type: "image/jpeg" })
      };
    }
    if (/^https:\/\/img\.example\//.test(lastFetchUrl)) {
      const imageId = lastFetchUrl.match(/\/(\d+)/)?.[1];
      const post = gelbooruPosts.find((item) => String(item.id) === imageId);
      assert.equal(
        storage.fimStateV1?.usedAvatarIds?.[imageId],
        true,
        "A Gelbooru ID must be durably reserved before its image bytes are fetched."
      );
      assert.equal(
        storage.fimStateV1?.usedAvatarUrls?.[lastFetchUrl],
        true,
        "A Gelbooru source URL must be durably reserved before its image bytes are fetched."
      );
      assert.equal(
        storage.fimStateV1?.usedAvatarFingerprints?.[post.md5],
        true,
        "A Gelbooru MD5 must be durably reserved before its image bytes are fetched."
      );
      assert.equal(
        fetchedFingerprints.has(post.md5),
        false,
        "The same Gelbooru asset fingerprint must never be fetched twice."
      );
      fetchedFingerprints.add(post.md5);
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["fake-image"], { type: "image/jpeg" })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: {
        get: () => "application/json"
      },
      text: async () => JSON.stringify({ post: structuredClone(gelbooruPosts) })
    };
  },
  structuredClone,
  URL,
  URLSearchParams
});

vm.runInContext(fs.readFileSync(backgroundPath, "utf8"), context, {
  filename: backgroundPath
});

function send(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Message timed out.")), 1000);
    messageListener(message, {}, (response) => {
      clearTimeout(timeout);
      if (!response?.ok) {
        reject(new Error(response?.error || "Unknown extension error."));
        return;
      }
      resolve(response);
    });
  });
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const gelbooruRules = JSON.parse(fs.readFileSync(gelbooruRulesPath, "utf8"));
  assert.ok(
    manifest.permissions.includes("declarativeNetRequestWithHostAccess"),
    "Gelbooru image-header rules require declarativeNetRequestWithHostAccess."
  );
  assert.ok(manifest.optional_host_permissions.includes("https://realbooru.com/*"));
  assert.ok(manifest.optional_host_permissions.includes("http://127.0.0.1/*"));
  assert.equal(
    gelbooruRules[0].action.requestHeaders[0].value,
    "https://gelbooru.com/"
  );
  assert.equal(
    gelbooruRules[1].action.requestHeaders[0].value,
    "https://realbooru.com/"
  );
  assert.match(gelbooruRules[0].condition.regexFilter, /gelbooru/);

  assert.equal(typeof installListener, "function");
  assert.equal(typeof messageListener, "function");
  await installListener();
  assert.equal(
    vm.runInContext(
      'JSON.stringify(preferredRemoteSources({avatarMode:"mixed",realbooruPercentage:10}, 9))',
      context
    ),
    '["realbooru","gelbooru"]'
  );
  assert.equal(
    vm.runInContext(
      'JSON.stringify(preferredRemoteSources({avatarMode:"mixed",realbooruPercentage:10}, 10))',
      context
    ),
    '["gelbooru","realbooru"]'
  );
  assert.equal(
    vm.runInContext(
      'JSON.stringify(preferredRemoteSources({avatarMode:"mixed",realbooruPercentage:90}, 89))',
      context
    ),
    '["realbooru","gelbooru"]'
  );
  assert.equal(
    vm.runInContext(
      'JSON.stringify(preferredRemoteSources({avatarMode:"mixed",realbooruPercentage:90}, 90))',
      context
    ),
    '["gelbooru","realbooru"]'
  );

  const batch = await send({
    type: "RESOLVE_IDENTITIES",
    items: [
      {
        primaryKey: "user:1",
        aliases: ["handle:first"]
      },
      {
        primaryKey: "user:2",
        aliases: []
      }
    ]
  });
  const first = batch.items[0];
  const second = batch.items[1];
  const same = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "handle:first",
    aliases: []
  });

  assert.equal(
    JSON.stringify(same.identity),
    JSON.stringify(first.identity),
    "Aliases must resolve persistently."
  );
  assert.notEqual(second.identity.handle, first.identity.handle, "Handles must be unique.");
  assert.notEqual(
    second.identity.avatarId,
    first.identity.avatarId,
    "Generated avatars must remain account-specific."
  );

  await send({
    type: "SET_SETTINGS",
    patch: {
      avatarMode: "gelbooru",
      gelbooruUserId: "123",
      gelbooruApiKey: "test-key"
    }
  });

  const connection = await send({
    type: "TEST_GELBOORU",
    gelbooruUserId: "123",
    gelbooruApiKey: "test-key"
  });
  assert.equal(connection.test.returnedPosts, 5);
  assert.equal(connection.test.usablePosts, 4);
  assert.equal(connection.test.ratingMode, "any");
  const requestedUrl = new URL(lastFetchUrl);
  assert.equal(
    requestedUrl.searchParams.get("tags"),
    "1girl solo selfie score:>=50"
  );
  assert.equal(requestedUrl.searchParams.get("user_id"), "123");

  const generalConnection = await send({
    type: "TEST_GELBOORU",
    gelbooruUserId: "123",
    gelbooruApiKey: "test-key",
    gelbooruRatingMode: "general"
  });
  assert.equal(generalConnection.test.usablePosts, 2);

  await send({
    type: "SET_SETTINGS",
    patch: {
      avatarMode: "gelbooru",
      gelbooruUserId: "wrong-name",
      gelbooruApiKey: "&api_key=fragment-key&user_id=456"
    }
  });
  const fragmentSettings = await send({ type: "GET_SETTINGS" });
  assert.equal(fragmentSettings.settings.gelbooruUserId, "456");
  assert.equal(fragmentSettings.settings.gelbooruApiKey, "fragment-key");

  await send({
    type: "SET_SETTINGS",
    patch: {
      avatarMode: "gelbooru",
      gelbooruUserId: "123",
      gelbooruApiKey: "test-key"
    }
  });

  await assert.rejects(
    send({
      type: "TEST_GELBOORU",
      gelbooruUserId: "my-username",
      gelbooruApiKey: "test-key"
    }),
    /must be numeric/i
  );

  const animeOne = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "user:3",
    aliases: []
  });
  const animeTwo = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "user:4",
    aliases: []
  });
  const animeSame = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "user:3",
    aliases: []
  });

  assert.equal(animeOne.identity.avatarKind, "gelbooru");
  assert.equal(animeTwo.identity.avatarKind, "gelbooru");
  assert.match(animeOne.identity.avatarUrl, /^data:image\/jpeg;base64,/);
  assert.match(animeTwo.identity.avatarUrl, /^data:image\/jpeg;base64,/);
  assert.notEqual(
    animeOne.identity.avatarId,
    animeTwo.identity.avatarId,
    "Anime selfies must never be reused across accounts."
  );
  assert.equal(
    JSON.stringify(animeSame.identity),
    JSON.stringify(animeOne.identity),
    "The same account must keep the same anime selfie."
  );
  assert.notEqual(animeOne.identity.avatarId, "1002", "Forbidden tags must be rejected.");
  assert.notEqual(animeTwo.identity.avatarId, "1002", "Forbidden tags must be rejected.");

  const rotated = await send({
    type: "ROTATE_AVATAR",
    primaryKey: "user:3",
    aliases: []
  });
  assert.equal(rotated.result.identity.displayName, animeOne.identity.displayName);
  assert.equal(rotated.result.identity.handle, animeOne.identity.handle);
  assert.notEqual(rotated.result.identity.avatarId, animeOne.identity.avatarId);
  assert.notEqual(rotated.result.identity.avatarId, animeTwo.identity.avatarId);
  assert.match(rotated.result.identity.avatarUrl, /^data:image\/jpeg;base64,/);

  const { history } = await send({ type: "GET_GELBOORU_HISTORY" });
  assert.equal(history.length, 3);
  assert.equal(new Set(history.map((item) => item.id)).size, history.length);
  assert.equal(
    Object.keys(storage.fimStateV1.usedAvatarFingerprints).length,
    3,
    "Gelbooru MD5 fingerprints must remain unique."
  );

  await send({
    type: "SET_SETTINGS",
    patch: {
      avatarMode: "realbooru",
      realbooruEndpoint: "http://127.0.0.1:47831"
    }
  });
  const realConnection = await send({
    type: "TEST_REALBOORU",
    realbooruEndpoint: "http://127.0.0.1:47831"
  });
  assert.equal(realConnection.test.returnedPosts, 4);
  assert.equal(realConnection.test.usablePosts, 3);
  const realRequestedUrl = new URL(lastFetchUrl);
  assert.equal(
    realRequestedUrl.searchParams.get("tags"),
    "1girl solo selfie score:>=20"
  );

  const realOne = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "user:6",
    aliases: []
  });
  assert.equal(realOne.identity.avatarKind, "realbooru");
  assert.match(realOne.identity.avatarUrl, /^data:image\/jpeg;base64,/);
  assert.notEqual(realOne.identity.avatarId, "9004");

  const realRotated = await send({
    type: "ROTATE_AVATAR",
    primaryKey: "user:6",
    aliases: []
  });
  assert.equal(realRotated.result.identity.avatarKind, "realbooru");
  assert.notEqual(realRotated.result.identity.avatarId, realOne.identity.avatarId);

  const remoteHistory = await send({ type: "GET_GELBOORU_HISTORY" });
  assert.equal(remoteHistory.history.length, 5);
  assert.equal(
    remoteHistory.history.filter((item) => item.source === "realbooru").length,
    2
  );

  await send({
    type: "ADD_CUSTOM_AVATARS",
    avatars: [
      {
        id: "custom-1",
        detection: "smart",
        url: "data:image/webp;base64,AAAA"
      }
    ]
  });
  await send({
    type: "SET_SETTINGS",
    patch: {
      avatarMode: "custom"
    }
  });
  const custom = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "user:5",
    aliases: []
  });
  assert.equal(custom.identity.avatarKind, "custom");
  assert.equal(custom.identity.avatarId, "custom-1");

  const { stats } = await send({ type: "GET_STATS" });
  assert.equal(stats.mappedAccounts, 6);
  assert.equal(stats.usedAnimeSelfies, 3);
  assert.equal(stats.usedRealSelfies, 2);
  assert.equal(stats.usedRemoteSelfies, 5);
  assert.equal(stats.importedAvatars, 1);
  assert.equal(stats.usedImportedAvatars, 1);

  const beforeDimensionResets = structuredClone(storage.fimStateV1);
  const resetNameResult = await send({ type: "RESET_NAMES" });
  assert.equal(resetNameResult.resetAccounts, 6);
  const afterNameReset = structuredClone(storage.fimStateV1);
  assert.equal(storage.fimControlV1.kind, "names");
  assert.deepEqual(
    Object.keys(afterNameReset.identities),
    Object.keys(beforeDimensionResets.identities)
  );
  for (const key of Object.keys(beforeDimensionResets.identities)) {
    const before = beforeDimensionResets.identities[key];
    const after = afterNameReset.identities[key];
    assert.notEqual(after.displayName, before.displayName);
    assert.notEqual(after.handle, before.handle);
    assert.equal(after.avatarId, before.avatarId);
    assert.equal(after.avatarUrl, before.avatarUrl);
  }
  assert.deepEqual(
    afterNameReset.gelbooruHistory,
    beforeDimensionResets.gelbooruHistory
  );

  const resetPictureResult = await send({ type: "RESET_PICTURES" });
  assert.equal(resetPictureResult.resetAccounts, 6);
  const afterPictureReset = structuredClone(storage.fimStateV1);
  assert.equal(storage.fimControlV1.kind, "pictures");
  for (const key of Object.keys(afterNameReset.identities)) {
    const before = afterNameReset.identities[key];
    const after = afterPictureReset.identities[key];
    assert.equal(after.displayName, before.displayName);
    assert.equal(after.handle, before.handle);
    assert.notEqual(after.avatarId, before.avatarId);
    assert.equal(after.avatarKind, "pending");
  }
  assert.deepEqual(
    afterPictureReset.gelbooruHistory,
    beforeDimensionResets.gelbooruHistory
  );
  assert.deepEqual(
    afterPictureReset.usedAvatarIds,
    beforeDimensionResets.usedAvatarIds
  );
  assert.deepEqual(
    afterPictureReset.usedRealbooruIds,
    beforeDimensionResets.usedRealbooruIds
  );
  assert.deepEqual(
    afterPictureReset.usedAvatarFingerprints,
    beforeDimensionResets.usedAvatarFingerprints
  );

  await send({ type: "RESET_MAPPINGS" });
  const historyAfterReset = await send({ type: "GET_GELBOORU_HISTORY" });
  assert.equal(
    historyAfterReset.history.length,
    5,
    "Resetting identity mappings must not allow old remote pictures to be reused."
  );

  console.log("PASS: persistent aliases and unique avatar assignments");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
