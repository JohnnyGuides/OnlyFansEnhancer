"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = require("../support/paths.cjs").personalRoot;

function load(file) {
  const context = vm.createContext({ URL, TextEncoder, Date });
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, {
    filename: file,
  });
  return context;
}

const sync = load("workflows/sync-script.js").CreatorSyncScript;
const plain = (value) => JSON.parse(JSON.stringify(value));
const script = {
  version: "1.0",
  inverted: false,
  actions: [
    { at: 0, pos: 10 },
    { at: 1500, pos: 90 },
  ],
};
const links = [
  {
    platform: "onlyfans",
    postUrl: "https://onlyfans.com/123456/johnny_guides",
  },
  { platform: "fansly", postUrl: "https://fansly.com/post/987654321" },
  {
    platform: "pornhub",
    postUrl: "https://www.pornhub.com/view_video.php?viewkey=ph634de69359881",
  },
  {
    platform: "manyvids",
    postUrl: "https://www.manyvids.com/Video/5550123/episode-title/",
  },
];

test("a script must be .funscript JSON with {at, pos} actions", () => {
  assert.deepEqual(
    plain(sync.parseFunscript(JSON.stringify(script))).actions,
    script.actions,
  );
  for (const bad of [
    "not json",
    "[]",
    "{}",
    '{"actions":[]}',
    '{"actions":[{"at":-1,"pos":5}]}',
    '{"actions":[{"at":5,"pos":101}]}',
    '{"actions":[{"at":"5","pos":50}]}',
  ])
    assert.throws(() => sync.parseFunscript(bad), /script/, bad);
  assert.equal(sync.isScriptFile({ name: "a.funscript", size: 10 }), true);
  assert.equal(sync.isScriptFile({ name: "a.json", size: 10 }), false);
  assert.equal(sync.isScriptFile({ name: "a.funscript", size: 0 }), false);
  assert.equal(
    sync.isScriptFile({ name: "a.funscript", size: 8 * 1024 * 1024 + 1 }),
    false,
  );
});

test("each platform link yields the website's video key", () => {
  assert.deepEqual(
    links.map(({ platform, postUrl }) => sync.scriptKey(platform, postUrl)),
    ["123456", "987654321", "ph634de69359881", "5550123"],
  );
  assert.equal(
    sync.scriptKey("onlyfans", "https://onlyfans.com/123456"),
    "123456",
  );
  assert.equal(
    sync.scriptKey(
      "pornhub",
      "https://www.pornhub.com/video/show?viewkey=ph634de69359881",
    ),
    "ph634de69359881",
  );
  for (const [platform, url] of [
    ["onlyfans", "http://onlyfans.com/123456/x"],
    ["onlyfans", "https://fansly.com/post/1"],
    ["fansly", "https://fansly.com/johnny"],
    ["pornhub", "https://www.pornhub.com/view_video.php?viewkey=bad%20key"],
    ["manyvids", "https://www.manyvids.com/Profile/1/x"],
    ["x", "https://x.com/a/status/1"],
  ])
    assert.equal(sync.scriptKey(platform, url), "", url);
});

test("actions shift by the measured lead-in only for platforms that got it", () => {
  assert.deepEqual(plain(sync.shiftFunscript(script, 1023)).actions, [
    { at: 1023, pos: 10 },
    { at: 2523, pos: 90 },
  ]);
  assert.deepEqual(plain(sync.shiftFunscript(script, 0)), script);
  assert.equal(script.actions[0].at, 0, "the selected script is not mutated");
  assert.throws(() => sync.shiftFunscript(script, 1.5));

  const none = plain(sync.scriptUploads(links, script, {}));
  assert.equal(none.length, 1, "no lead-in: one upload for every key");
  assert.deepEqual(none[0].keys, [
    "123456",
    "987654321",
    "ph634de69359881",
    "5550123",
  ]);
  assert.deepEqual(none[0].funscript, script);

  const intro = plain(
    sync.scriptUploads(links, script, { onlyfans: 1023, fansly: 1023 }),
  );
  assert.deepEqual(
    intro.map(({ leadInMs, keys }) => ({ leadInMs, keys })),
    [
      { leadInMs: 1023, keys: ["123456", "987654321"] },
      { leadInMs: 0, keys: ["ph634de69359881", "5550123"] },
    ],
  );
  assert.deepEqual(
    intro[0].funscript.actions.map((action) => action.at),
    [1023, 2523],
  );
  assert.deepEqual(intro[1].funscript, script);
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("the upload posts keys, title and script with the bearer token", async () => {
  const requests = [];
  const result = await sync.uploadScript(
    {
      origin: "https://johnnyguides.com",
      token: "secret-token-123",
      keys: ["123456", "ph634de69359881"],
      title: "  Episode 4  ",
      funscript: script,
    },
    async (url, init) => {
      requests.push({ url, init });
      return response(200, {
        file: "episode-4.funscript",
        keys: ["123456", "ph634de69359881"],
        url: "https://johnnyguides.com/sync/scripts/episode-4.funscript",
      });
    },
  );
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests;
  assert.equal(url, "https://johnnyguides.com/sync/scripts");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer secret-token-123");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.credentials, "omit");
  assert.deepEqual(JSON.parse(init.body), {
    keys: ["123456", "ph634de69359881"],
    title: "Episode 4",
    funscript: script,
  });
  assert.deepEqual(plain(result), {
    file: "episode-4.funscript",
    keys: ["123456", "ph634de69359881"],
    url: "https://johnnyguides.com/sync/scripts/episode-4.funscript",
  });
});

test("website refusals and bad input fail the script upload only", async () => {
  const base = {
    origin: "https://johnnyguides.com",
    token: "secret-token-123",
    keys: ["123456"],
    title: "Episode",
    funscript: script,
  };
  for (const [status, message] of [
    [401, /token/],
    [400, /rejected the script/],
    [413, /too large/],
    [404, /turned off/],
    [500, /\(500\)/],
  ])
    await assert.rejects(
      sync.uploadScript(base, async () => response(status, {})),
      message,
    );
  await assert.rejects(
    sync.uploadScript(base, async () =>
      response(200, { url: "https://evil.example/sync/scripts/a.funscript" }),
    ),
    /invalid script link/,
  );
  let called = false;
  const never = async () => {
    called = true;
    return response(200, {});
  };
  await assert.rejects(sync.uploadScript({ ...base, keys: [] }, never));
  await assert.rejects(
    sync.uploadScript(
      {
        ...base,
        keys: Array(11)
          .fill(0)
          .map((_, i) => `k${i}`),
      },
      never,
    ),
  );
  await assert.rejects(sync.uploadScript({ ...base, title: " " }, never));
  await assert.rejects(sync.uploadScript({ ...base, token: "" }, never));
  await assert.rejects(
    sync.uploadScript({ ...base, origin: "https://example.com" }, never),
  );
  await assert.rejects(
    sync.uploadScript(
      {
        ...base,
        funscript: {
          actions: Array.from({ length: 400_000 }, (_, at) => ({
            at,
            pos: 50,
          })),
        },
      },
      never,
    ),
    /8 MB/,
  );
  assert.equal(called, false);
});

test("one refused upload or sheet failure does not stop the other script uploads", async () => {
  const posted = [];
  const committed = [];
  const scripts = plain(
    await sync.uploadScripts(
      {
        settings: { origin: "https://johnnyguides.com", token: "token-1234" },
        title: "Episode",
        uploads: [
          { keys: ["111"], funscript: script },
          { keys: ["222"], funscript: script },
          { keys: ["333"], funscript: script },
        ],
      },
      {
        fetchImpl: async (_url, init) => {
          const [key] = JSON.parse(init.body).keys;
          posted.push(key);
          return key === "111"
            ? response(401, {})
            : response(200, {
                url: `https://johnnyguides.com/sync/scripts/${key}.funscript`,
              });
        },
        commit: async (url) => {
          committed.push(url);
          if (url.includes("222")) throw new Error("catalogue offline");
          return "";
        },
      },
    ),
  );
  assert.deepEqual(posted, ["111", "222", "333"]);
  assert.deepEqual(committed, [
    "https://johnnyguides.com/sync/scripts/222.funscript",
    "https://johnnyguides.com/sync/scripts/333.funscript",
  ]);
  assert.deepEqual(scripts, [
    { keys: [], error: "The website rejected the upload token." },
    {
      url: "https://johnnyguides.com/sync/scripts/222.funscript",
      keys: ["222"],
      sheetError: "Script link not written to the sheet (catalogue offline).",
    },
    {
      url: "https://johnnyguides.com/sync/scripts/333.funscript",
      keys: ["333"],
      sheetError: "",
    },
  ]);
});

test("settings default to johnnyguides.com and require a token", () => {
  assert.deepEqual(plain(sync.normalizeSettings({ token: "abcdefgh" })), {
    valid: true,
    errors: [],
    value: { origin: "https://johnnyguides.com", token: "abcdefgh" },
  });
  assert.equal(
    sync.normalizeSettings({
      origin: "https://staging.johnnyguides.com/",
      token: "abcdefgh",
    }).value.origin,
    "https://staging.johnnyguides.com",
  );
  for (const origin of [
    "http://johnnyguides.com",
    "https://johnnyguides.com.evil.example",
    "https://johnnyguides.com/path",
    "https://user@johnnyguides.com",
  ])
    assert.equal(
      sync.normalizeSettings({ origin, token: "abcdefgh" }).valid,
      false,
      origin,
    );
  assert.equal(sync.normalizeSettings({}).valid, false);
});

test("the upload draft accepts only a .funscript under 8 MB as Script", () => {
  const hooks = load("upload-console.js").CreatorUploadConsole;
  const base = {
    fullFile: { name: "episode.mp4", type: "video/mp4", size: 100 },
    title: "Episode",
    scheduledIso: "2026-08-28T15:00:00.000Z",
    targets: ["onlyfans"],
  };
  assert.equal(hooks.normalizeDraft(base).valid, true);
  assert.equal(
    hooks.normalizeDraft({
      ...base,
      scriptFile: { name: "episode.funscript", size: 2000 },
    }).valid,
    true,
  );
  for (const scriptFile of [
    { name: "episode.json", size: 2000 },
    { name: "episode.funscript", size: 0 },
    { name: "episode.funscript", size: 8 * 1024 * 1024 + 1 },
  ])
    assert.deepEqual(
      [...hooks.normalizeDraft({ ...base, scriptFile }).errors],
      ["Choose a .funscript script under 8 MB or leave it blank."],
    );
});
