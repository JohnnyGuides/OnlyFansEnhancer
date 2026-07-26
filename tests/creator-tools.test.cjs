"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = path.resolve(__dirname, "..");
const toolsRoot = path.join(repositoryRoot, "creator-tools");

const EXPECTED_TOOLS = Object.freeze({
  "c4s-upload.js": "c4sUpload",
  "ph-uploader.js": "phUploader",
  "fansly-prefill.js": "fanslyPrefill",
  "manyvids-autofill.js": "manyvidsAutofill",
  "sheer-tags.js": "sheerTags",
  "onlyfans-auto-select.js": "onlyfansAutoSelect",
  "onlyfans-auto-follow.js": "onlyfansAutoFollow",
  "reddit-banner-censor.js": "redditBannerCensor"
});

test("personal edition exposes all migrated creator tools without the bypasser", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "manifest.json"), "utf8")
  );
  assert.equal(manifest.name, "Creator Workflow Toolkit");
  assert.equal(manifest.version, "0.7.0");

  const manifestScripts = manifest.content_scripts
    .flatMap((entry) => entry.js || []);
  for (const fileName of Object.keys(EXPECTED_TOOLS)) {
    assert.ok(
      manifestScripts.includes(`creator-tools/${fileName}`),
      `${fileName} is missing from the manifest`
    );
  }

  const toolFiles = fs
    .readdirSync(toolsRoot)
    .filter((fileName) => fileName.endsWith(".js"));
  assert.equal(toolFiles.some((fileName) => /bypass/i.test(fileName)), false);

  const searchable = toolFiles
    .map((fileName) => fs.readFileSync(path.join(toolsRoot, fileName), "utf8"))
    .join("\n");
  assert.doesNotMatch(searchable, /Bypass All Shortlinks|bypass\.city|adbypass\.org/i);
});

test("migrated tool scripts parse and honor their individual settings", () => {
  for (const [fileName, settingKey] of Object.entries(EXPECTED_TOOLS)) {
    const source = fs.readFileSync(path.join(toolsRoot, fileName), "utf8");
    assert.doesNotThrow(() => new vm.Script(source, { filename: fileName }));
    assert.match(
      source,
      new RegExp(`CreatorToolkit\\.runWhenEnabled\\("${settingKey}"`)
    );
  }
});

test("the full Clips4Sale category file is bundled into the personal edition", () => {
  const source = fs.readFileSync(
    path.join(toolsRoot, "c4s-categories.js"),
    "utf8"
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.ok(Array.isArray(context.CreatorToolkitC4SCategories));
  assert.equal(context.CreatorToolkitC4SCategories.length, 1116);
  assert.ok(context.CreatorToolkitC4SCategories.includes("ANIMATION"));
});

test("the Chrome Web Store edition remains the narrow identity-mask product", () => {
  const storeManifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "store", "manifest.json"), "utf8")
  );
  assert.equal(storeManifest.name, "Fan Identity Mask");
  assert.deepEqual(storeManifest.host_permissions, ["https://onlyfans.com/*"]);
  assert.equal(
    storeManifest.content_scripts.some((entry) =>
      (entry.js || []).some((fileName) => fileName.includes("creator-tools"))
    ),
    false
  );
});
