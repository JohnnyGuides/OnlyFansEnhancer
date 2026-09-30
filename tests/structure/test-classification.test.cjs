"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function fixtureRoot(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ofe-classify-"));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(base, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return base;
}

test("test grouping follows requires transitively to the browser support module", async () => {
  const { testGroups } = await import("../../tools/run-tests.mjs");
  const base = fixtureRoot({
    "tests/support/browser.cjs": "module.exports = {};\n",
    "tests/support/one.cjs": 'module.exports = require("./browser.cjs");\n',
    "tests/support/two.cjs": 'module.exports = require("./one.cjs");\n',
    "tests/support/plain.cjs": 'module.exports = require("node:fs");\n',
    "tests/support/cycle-a.cjs": 'require("./cycle-b.cjs");\n',
    "tests/support/cycle-b.cjs": 'require("./cycle-a.cjs");\n',
    "tests/extension/direct.test.cjs": 'require("../support/browser.cjs");\n',
    "tests/extension/via-one.test.cjs": 'require("../support/one.cjs");\n',
    "tests/extension/via-two.test.cjs": "require('../support/two.cjs');\n",
    "tests/extension/plain.test.cjs":
      'require("../support/plain.cjs");\nrequire("../support/cycle-a.cjs");\n',
    "tests/structure/prefix.test.cjs": 'require("../support/one.cjs");\n',
    "tests/native/prefix.test.cjs": 'require("../support/one.cjs");\n',
  });
  try {
    const groups = testGroups(base);
    assert.deepEqual(groups.browser, [
      "tests/extension/direct.test.cjs",
      "tests/extension/via-one.test.cjs",
      "tests/extension/via-two.test.cjs",
    ]);
    assert.deepEqual(groups.unit, ["tests/extension/plain.test.cjs"]);
    assert.deepEqual(groups.structure, ["tests/structure/prefix.test.cjs"]);
    assert.deepEqual(groups.native, ["tests/native/prefix.test.cjs"]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the upload-action test that launches Chromium through its fixture is a browser test", async () => {
  const { testGroups } = await import("../../tools/run-tests.mjs");
  const groups = testGroups();
  assert.ok(groups.browser.includes("tests/extension/upload-action.test.cjs"));
  assert.ok(!groups.unit.includes("tests/extension/upload-action.test.cjs"));
});
