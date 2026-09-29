"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const personalRoot = require("../support/paths.cjs").personalRoot;

function element() {
  const listeners = {};
  return {
    listeners,
    disabled: false,
    value: "",
    textContent: "",
    files: [],
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
    async fire(type) {
      for (const listener of listeners[type] || []) await listener({});
    },
    replaceChildren() {},
    add() {},
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function load() {
  const elements = {
    "#teaserFile": element(),
    "#catalogueRow": element(),
    "#confirm": element(),
    "#fileStatus": element(),
    "#summary": element(),
    "#result": element(),
  };
  const sent = [];
  let captured = null;
  const frameGates = new Map();
  const context = vm.createContext({
    document: { querySelector: (selector) => elements[selector] },
    Option: function Option(text, value) {
      return { text, value };
    },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: {
          addListener(listener) {
            captured = listener;
          },
        },
        sendMessage(payload, callback) {
          sent.push(payload);
          if (payload.type === "GET_X_TEASER_SESSIONS") {
            return callback({ ok: true, sessions: [], rebind: null });
          }
          if (payload.type === "PAIR_X_TEASER") {
            return callback({ ok: true, xTeaser: { id: "pairing-a" } });
          }
          return callback({
            ok: true,
            xTeaser: {
              stage: "moved",
              capture: { statusUrl: "https://x.com" },
            },
          });
        },
      },
      permissions: { request: async () => true },
    },
    CreatorCatalogueClient: {
      getCatalogueSnapshot: async () => ({
        rows: [{ row: 125, id: "claire", title: "Claire", fingerprint: "ab" }],
      }),
    },
    CreatorXTeaserContract: {
      rankCatalogueRows: (proof, rows) => ({
        rows: rows.map((row) => ({ ...row, score: 100 })),
      }),
      freezePairing: (file, catalogue) => ({ file, catalogue }),
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(personalRoot, "x-teaser.js"), "utf8"),
    context,
    { filename: "x-teaser.js" },
  );
  context.proofOf = async (file) => ({
    basename: file.name,
    size: 1,
    lastModified: 1,
    duration: 2,
    sha256: file.name.padEnd(64, "0"),
  });
  context.framesOf = (file) => {
    const gate = frameGates.get(file.name);
    const frames = [0, 1, 2].map((index) => `data:${file.name}:${index}`);
    return gate ? gate.then(() => frames) : Promise.resolve(frames);
  };
  return {
    elements,
    sent,
    frameGates,
    capture: (message) => captured(message),
    async select(name) {
      elements["#teaserFile"].files = [{ name }];
      await elements["#teaserFile"].fire("change");
    },
    async pair() {
      elements["#catalogueRow"].value = "125";
      await elements["#catalogueRow"].fire("change");
      await elements["#confirm"].fire("click");
      await settle();
    },
    reconciles: () => sent.filter((item) => item.type === "RECONCILE_X_TEASER"),
  };
}

test("a captured status reconciles with the paired file's frames", async () => {
  const page = load();
  await page.select("a.mp4");
  await settle();
  await page.pair();
  page.capture({ type: "X_TEASER_CAPTURED", id: "pairing-a" });
  await settle();
  assert.equal(page.reconciles().length, 1);
  assert.deepEqual(page.reconciles()[0].frames, [
    "data:a.mp4:0",
    "data:a.mp4:1",
    "data:a.mp4:2",
  ]);
});

test("selecting another file after pairing never sends its frames for the paired session", async () => {
  const page = load();
  await page.select("a.mp4");
  await settle();
  await page.pair();
  await page.select("b.mp4");
  await settle();
  page.capture({ type: "X_TEASER_CAPTURED", id: "pairing-a" });
  await settle();
  assert.equal(page.reconciles().length, 0);
});

test("a capture for a foreign pairing id is ignored by this page", async () => {
  const page = load();
  await page.select("a.mp4");
  await settle();
  await page.pair();
  page.capture({ type: "X_TEASER_CAPTURED", id: "someone-else" });
  await settle();
  assert.equal(page.reconciles().length, 0);
});

test("a new selection wins while older frames are still arriving", async () => {
  const page = load();
  let release;
  page.frameGates.set(
    "a.mp4",
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const first = page.select("a.mp4");
  await settle();
  await page.select("b.mp4");
  await settle();
  release();
  await first;
  await settle();
  await page.pair();
  page.capture({ type: "X_TEASER_CAPTURED", id: "pairing-a" });
  await settle();
  const pairing = page.sent.find((item) => item.type === "PAIR_X_TEASER");
  assert.equal(pairing.pairing.file.basename, "b.mp4");
  assert.equal(page.reconciles().length, 1);
  assert.deepEqual(page.reconciles()[0].frames, [
    "data:b.mp4:0",
    "data:b.mp4:1",
    "data:b.mp4:2",
  ]);
});
