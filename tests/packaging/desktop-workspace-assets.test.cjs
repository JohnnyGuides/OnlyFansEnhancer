const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = require("../support/paths.cjs").repositoryRoot;

test("desktop workspace rejects missing local scripts and styles before packaging", async () => {
  const { validateDesktopWorkspace } =
    await import("../../tools/validate-desktop-workspace.mjs");
  const fixture = fs.mkdtempSync(path.join(root, ".local", "desktop-assets-"));
  try {
    fs.mkdirSync(path.join(fixture, "app"));
    fs.writeFileSync(
      path.join(fixture, "upload.html"),
      '<script src="app/replies.js?v=1"></script><link href="upload.css"><a href="#section">Local</a><a href="https://example.com">External</a>',
    );
    assert.throws(
      () => validateDesktopWorkspace(fixture),
      /missing desktop asset: app\/replies.js/,
    );
    fs.writeFileSync(path.join(fixture, "app/replies.js"), "");
    assert.throws(
      () => validateDesktopWorkspace(fixture),
      /missing desktop asset: upload.css/,
    );
    fs.writeFileSync(path.join(fixture, "upload.css"), "");
    assert.doesNotThrow(() => validateDesktopWorkspace(fixture));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
