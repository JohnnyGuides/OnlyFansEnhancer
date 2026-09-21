"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = require("../support/paths.cjs").repositoryRoot;
test("Chrome native package is versioned from the personal manifest and installation stays opt-in", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(root, "extensions/personal/manifest.json"),
      "utf8",
    ),
  );
  const build = fs.readFileSync(
    path.join(root, "tools", "build-x-teaser-native-host.ps1"),
    "utf8",
  );
  const install = fs.readFileSync(
    path.join(root, "native-host", "install-current-user.ps1"),
    "utf8",
  );
  assert.equal(manifest.version, "0.20.34");
  assert.match(build, /\$manifest\.version/);
  assert.match(build, /--self-contained false/);
  assert.match(install, /\^\[a-p\]\{32\}\$/);
  assert.match(install, /allowed_origins/);
  assert.match(install, /HKCU:/);
  assert.doesNotMatch(
    build,
    /install-current-user\.ps1[^\r\n]*&|Start-Process/,
  );
});

test("Chrome-only setup documents all separately authorized live gates", () => {
  const smoke = fs.readFileSync(
    path.join(root, "docs", "acceptance.md"),
    "utf8",
  );
  assert.match(smoke, /Do not press X's final\s+Post/);
  assert.match(smoke, /live workbook/);
  assert.match(smoke, /real media roots/);
});
