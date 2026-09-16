"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
const recorder = path.resolve(
  __dirname,
  "../../extensions/personal/workflows/upload-trace-recorder.js",
);
test("recorder keeps competing uploader identities and owned relationships without private values", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<form><button id="private-control-42" aria-label="Expiration period" title="Schedule post" aria-controls="private-dialog-88">Expiration period</button><section id="private-dialog-88" role="dialog" aria-labelledby="private-heading-99"><h2 id="private-heading-99">Expiration period</h2></section><button id="device">Upload from Device</button><div class="dropdown-item">Upload New</div><textarea>DO-NOT-CAPTURE-CAPTION</textarea><button id="private" aria-label="private@example.test confidential">private text</button></form>',
    );
    await page.addScriptTag({ path: recorder });
    const result = await page.evaluate(() => {
      const r = CreatorUploadTraceRecorder;
      return {
        action: r.elementSignature(document.querySelector("button")),
        dialog: r.elementSignature(document.querySelector("section")),
        device: r.elementSignature(document.querySelector("#device")),
        source: r.elementSignature(document.querySelector(".dropdown-item")),
        private: r.elementSignature(document.querySelector("#private")),
        caption: r.elementSignature(document.querySelector("textarea")),
        route: r.sanitizeUrl(
          "https://pornhub.mainhub.com/upload/uploader?site=ph&token=SECRET",
        ),
        editor: r.sanitizeUrl(
          "https://www.manyvids.com/Edit-vid/123456789?token=SECRET",
        ),
      };
    });
    assert.ok(
      result.action.identity,
      "Independent action identity evidence must be retained",
    );
    assert.equal(result.action.identity.ariaLabel, "Expiration period");
    assert.equal(result.action.identity.title, "Schedule post");
    assert.equal(result.action.relationships.controls[0], result.dialog.id);
    assert.equal(result.dialog.identity.labelledBy, "Expiration period");
    assert.equal(result.device.label, "Upload from Device");
    assert.equal(result.source.label, "Upload New");
    assert.equal(result.route, "https://pornhub.mainhub.com/upload/uploader");
    assert.equal(result.editor, "https://www.manyvids.com/edit-vid/[id]");
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-control|private-dialog|private-heading|DO-NOT-CAPTURE|private@example|confidential|SECRET|123456789/,
    );
  } finally {
    await browser.close();
  }
});

test("recorder rejects private numeric and non-ASCII suffixes in action identities", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<button aria-label="Schedule 88776655443322">Save 私有</button><button>1 day</button>',
    );
    await page.addScriptTag({ path: recorder });
    const result = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((node) =>
        CreatorUploadTraceRecorder.elementSignature(node),
      ),
    );
    assert.doesNotMatch(JSON.stringify(result), /88776655443322|私有/);
    assert.equal(result[1].label, "1 day");
  } finally {
    await browser.close();
  }
});
