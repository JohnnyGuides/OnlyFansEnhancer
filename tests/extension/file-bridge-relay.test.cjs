"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "../../extensions/personal/file-bridge.js"),
  "utf8",
);
const origins = {
  onlyfans: "https://onlyfans.com",
  fansly: "https://fansly.com",
  pornhub: "https://pornhub.mainhub.com",
  x: "https://x.com",
};

function relay(platform) {
  const forwarded = [];
  const posted = [];
  let listener = null;
  class File {}
  class Channel {
    addEventListener(type, callback) {
      listener = callback;
    }
    postMessage(message) {
      posted.push(message);
    }
  }
  const sessionId = "relay-session-123456789";
  const context = vm.createContext({
    BroadcastChannel: Channel,
    File,
    URLSearchParams,
    location: {
      search: `?session=${sessionId}&platform=${platform}&parentOrigin=${encodeURIComponent(origins[platform])}`,
    },
    parent: {
      postMessage(message) {
        forwarded.push(message.role);
      },
    },
    structuredClone,
    globalThis: null,
  });
  context.globalThis = context;
  context.addEventListener = () => {};
  vm.runInContext(source, context, { filename: "file-bridge.js" });
  return {
    forwarded,
    acks: () => posted.filter((message) => message.direction === "ack"),
    send(role, overrides = {}) {
      listener({
        data: {
          source: "creator-upload-console",
          sessionId,
          platform,
          role,
          requestId: "request-1",
          token: "token-1234567890",
          file: new File(),
          ...overrides,
        },
      });
    },
  };
}

test("relay forwards additional media for OnlyFans and Fansly", () => {
  for (const platform of ["onlyfans", "fansly"]) {
    const bridge = relay(platform);
    bridge.send("media1");
    bridge.send("media8");
    assert.deepEqual(bridge.forwarded, ["media1", "media8"]);
  }
});

test("relay forwards the Pornhub thumbnail and video roles", () => {
  const bridge = relay("pornhub");
  bridge.send("thumbnail");
  bridge.send("pornhub");
  assert.deepEqual(bridge.forwarded, ["thumbnail", "pornhub"]);
});

test("relay rejects media9, media0 and role/platform mismatches", () => {
  const bridge = relay("onlyfans");
  bridge.send("media9");
  bridge.send("media0");
  bridge.send("pornhub");
  assert.deepEqual(bridge.forwarded, []);
  const pornhub = relay("pornhub");
  pornhub.send("full");
  pornhub.send("media1");
  assert.deepEqual(pornhub.forwarded, []);
  const fansly = relay("fansly");
  fansly.send("social");
  assert.deepEqual(fansly.forwarded, []);
});

test("relay answers an unsupported role or pairing with a failed ack", () => {
  for (const [platform, role] of [
    ["onlyfans", "media9"],
    ["pornhub", "media1"],
    ["x", "thumbnail"],
  ]) {
    const bridge = relay(platform);
    bridge.send(role);
    assert.deepEqual(bridge.forwarded, []);
    assert.deepEqual(JSON.parse(JSON.stringify(bridge.acks())), [
      {
        source: "creator-upload-bridge",
        direction: "ack",
        sessionId: "relay-session-123456789",
        platform,
        role,
        requestId: "request-1",
        ok: false,
        error: "File transfer was not authorized.",
      },
    ]);
  }
});

test("relay requires the role to be a string", () => {
  const bridge = relay("onlyfans");
  bridge.send(["media1"]);
  assert.deepEqual(bridge.forwarded, []);
  const acks = bridge.acks();
  assert.equal(acks.length, 1);
  assert.equal(acks[0].ok, false);
  assert.equal("role" in acks[0], false);
});

test("relay ignores mismatched source, session or platform silently", () => {
  const bridge = relay("onlyfans");
  bridge.send("media9", { sessionId: "other-session-123456789" });
  bridge.send("media9", { platform: "fansly" });
  bridge.send("media9", { source: "someone-else" });
  assert.deepEqual(bridge.forwarded, []);
  assert.deepEqual(bridge.acks(), []);
});

test("relay posts no failure ack for supported pairings", () => {
  const bridge = relay("onlyfans");
  bridge.send("media1");
  bridge.send("full");
  assert.deepEqual(bridge.forwarded, ["media1", "full"]);
  assert.deepEqual(bridge.acks(), []);
});

test("relay forwards extra video teaser roles only for Fansly", () => {
  const fansly = relay("fansly");
  fansly.send("media1Teaser");
  fansly.send("media8Teaser");
  for (const role of ["media0Teaser", "media9Teaser", "media1teaser"])
    fansly.send(role);
  assert.deepEqual(fansly.forwarded, ["media1Teaser", "media8Teaser"]);
  assert.equal(fansly.acks().length, 3);
  for (const platform of ["onlyfans", "pornhub", "x"]) {
    const other = relay(platform);
    other.send("media1Teaser");
    assert.deepEqual(other.forwarded, []);
    assert.equal(other.acks()[0].ok, false);
  }
});
