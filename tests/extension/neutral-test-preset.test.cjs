"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function api() {
  const sandbox = vm.createContext({ Intl, Date, URL, structuredClone });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../../extensions/personal/upload-console.js"),
      "utf8",
    ),
    sandbox,
  );
  return sandbox.CreatorUploadConsole;
}
const files = () => [
  {
    name: "neutral-full.mp4",
    size: 3429630660,
    type: "video/mp4",
    source: "development-fixture",
    fixtureToken: "11111111-1111-4111-8111-111111111111",
    lastModified: 1789812000000,
  },
  {
    name: "neutral-teaser.mp4",
    size: 32543668,
    type: "video/mp4",
    source: "development-fixture",
    fixtureToken: "22222222-2222-4222-8222-222222222222",
    lastModified: 1789812000000,
  },
  {
    name: "neutral-thumbnail-valid.png",
    size: 31324,
    type: "image/png",
    source: "development-fixture",
    fixtureToken: "33333333-3333-4333-8333-333333333333",
    lastModified: 1789812000000,
  },
];
test("template maps immutable path-backed descriptors without reading multi-gigabyte media", () => {
  const input = files();
  const result = api().neutralTestSelection(input);
  assert.deepEqual(JSON.parse(JSON.stringify(result.fullFile)), input[0]);
  assert.equal(Object.isFrozen(result.fullFile), true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.teaserFile)), input[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.thumbnailFile)), input[2]);
});
for (const kind of [
  "missing",
  "duplicate",
  "empty",
  "wrong-type",
  "nested",
  "untrusted",
  "fake-path",
]) {
  test(`neutral test selection refuses ${kind} role`, () => {
    const input = files();
    if (kind === "missing") input.pop();
    if (kind === "duplicate") input.push({ ...input[0] });
    if (kind === "empty") input[0].size = 0;
    if (kind === "wrong-type") input[0].type = "text/plain";
    if (kind === "nested")
      input[0].webkitRelativePath = "tests/other/neutral-full.mp4";
    if (kind === "untrusted") delete input[0].fixtureToken;
    if (kind === "fake-path") input[0].filePath = "C:\u005ctest.mp4";
    assert.throws(
      () => api().neutralTestSelection(input),
      /template|missing|invalid/i,
    );
  });
}
test("neutral profiles are ephemeral and do not inject saved captions or tags", () => {
  const saved = {
    fanslyPrefill: {
      message: "private caption",
      fillMode: "empty-only",
      toggles: {
        "Post to FYP": true,
        "Post to Walls": true,
        "Lock Replies": false,
      },
    },
    manyvidsAutofill: {
      tags: ["private tag"],
      price: "19.99",
      launchModeSelector: "#launchCustom",
    },
    phUploader: {
      presets: {
        Straight: {
          orientation: "Straight",
          tags: ["private tag"],
          categories: ["private category"],
        },
      },
      seriesPresets: { secret: "Straight" },
    },
  };
  const snapshot = structuredClone(saved);
  const result = api().neutralTestProfiles(saved);
  assert.deepEqual(saved, snapshot);
  assert.equal(result.fanslyPrefill.message, "");
  assert.equal(result.fanslyPrefill.toggles["Post to FYP"], false);
  assert.deepEqual(Array.from(result.manyvidsAutofill.tags), []);
  assert.equal(result.manyvidsAutofill.price, "19.99");
  assert.deepEqual(Object.keys(result.phUploader.presets), [
    "Neutral test (manual)",
  ]);
  assert.deepEqual(
    Array.from(result.phUploader.presets["Neutral test (manual)"].tags),
    [],
  );
});
