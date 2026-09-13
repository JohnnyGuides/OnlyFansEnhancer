"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");
const { repositoryRoot } = require("../support/paths.cjs");

const uploader = fs
  .readFileSync(
    path.join(repositoryRoot, "extensions/personal/upload-console.html"),
    "utf8",
  )
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
  .replace(/<link\b[^>]*>/g, "");
const hostScript = fs.readFileSync(
  path.join(repositoryRoot, "shared/workspace/upload-host.js"),
  "utf8",
);

for (const desktop of [false, true]) {
  test(`${desktop ? "desktop" : "Chrome"} uploader exposes only usable bridge setup guidance`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(uploader);
      if (desktop) {
        await page.evaluate(() => {
          let receive;
          globalThis.chrome = {
            webview: {
              addEventListener(_name, listener) {
                receive = listener;
              },
              postMessage(message) {
                const request = JSON.parse(message);
                queueMicrotask(() =>
                  receive({
                    data: {
                      requestId: request.requestId,
                      ok: true,
                      result: { browsers: [], connected: false },
                    },
                  }),
                );
              },
            },
          };
        });
      }
      await page.addScriptTag({ content: hostScript });
      const chromeSetup = page.locator(
        'a[href="options.html#catalogueBridgeHeading"]',
      );
      assert.equal(await chromeSetup.count(), desktop ? 0 : 1);
      if (desktop) {
        const guidance = page.locator("[data-desktop-only]");
        assert.equal(await guidance.count(), 1);
        assert.equal(
          await guidance.evaluate((element) => element.hidden),
          false,
        );
        assert.match(await guidance.textContent(), /Chrome\s+uploader/);
      }
    } finally {
      await browser.close();
    }
  });
}
