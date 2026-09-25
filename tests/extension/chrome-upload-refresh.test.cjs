"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = require("../support/paths.cjs").repositoryRoot;
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
test("personal uploader has one development template action and two native upload choices", () => {
  const html = read("extensions/personal/upload-console.html");
  assert.equal((html.match(/>\s*Load Template\s*</g) || []).length, 1);
  for (const id of [
    "neutralTestFolder",
    "chooseNeutralTestFolder",
    "neutralTestPreset",
  ])
    assert.ok(!html.includes('id="' + id + '"'));
  assert.ok(!html.includes('select id="workflowMode"'));
  assert.equal((html.match(/name="workflowMode"/g) || []).length, 2);
  assert.ok(
    !/kept only in this tab/i.test(
      read("extensions/personal/upload-console.js"),
    ),
  );
});
test("setup has ordered human actions, copyable address, exact folder and a distinct reset", () => {
  const guide = read("packaging/windows/extension-setup.html");
  const dialog = read("shared/workspace/index.html");
  assert.ok(!guide.includes("Open OFEnhancer and select"));
  for (const text of [
    "Open Chrome extensions",
    "Developer mode",
    "Load unpacked",
    "extension-keyed",
  ])
    assert.ok(guide.includes(text), text);
  assert.ok(guide.includes('id="copy-address"'));
  assert.ok(dialog.includes('data-chrome-action="freshChromeReset"'));
  assert.ok(
    read("packaging/windows/OFEnhancer.iss").includes("Fresh reinstall"),
  );
});
test("fixture resolution stays in the trusted desktop and the store excludes it", () => {
  const host = read("shared/workspace/upload-host.js");
  assert.ok(host.includes("deliverDevelopmentFixture"));
  assert.ok(host.includes("postMessageWithAdditionalObjects"));
  const manifest = JSON.parse(read("packaging/extensions.json"));
  assert.ok(
    Object.hasOwn(manifest.personal, "workflows/extension-lifecycle.js"),
  );
  for (const p of Object.values(manifest.store))
    assert.ok(
      !/Load Template|DevelopmentFixture|upload-test-media/.test(read(p)),
      p,
    );
});
