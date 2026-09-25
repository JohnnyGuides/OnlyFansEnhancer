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
  test(`${desktop ? "desktop" : "Chrome"} uploader omits legacy bridge setup from the upload flow`, async () => {
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
      assert.equal(await chromeSetup.count(), 0);
      assert.equal(await page.locator("#selectedPlatformDetails").count(), 0);
    } finally {
      await browser.close();
    }
  });
}

test("connected Chrome is shown beside upload choices without a redundant refresh control", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(uploader);
    await page.addStyleTag({
      path: path.join(repositoryRoot, "extensions/personal/upload-console.css"),
    });
    await page.evaluate(() => {
      Object.defineProperty(crypto, "randomUUID", {
        value: () => String(Math.random()).slice(2),
      });
      let receive;
      globalThis.chrome = {
        webview: {
          addEventListener(_name, listener) {
            receive = listener;
          },
          postMessage(message) {
            const request = JSON.parse(message);
            const result =
              request.operation === "getChromeReadiness"
                ? { state: "connected", message: "Ready to prepare uploads." }
                : {
                    browsers: ["chrome-1"],
                    selected: "chrome-1",
                    connected: true,
                  };
            queueMicrotask(() =>
              receive({
                data: { requestId: request.requestId, ok: true, result },
              }),
            );
          },
        },
      };
    });
    await page.addScriptTag({ content: hostScript });
    await page.waitForSelector(
      '.desktop-upload-connection[data-connected="true"]',
    );
    assert.equal(
      await page.locator(".app-header .desktop-upload-connection").count(),
      1,
    );
    assert.match(
      await page.locator(".chrome-connection-state").textContent(),
      /^Connected$/,
    );
    const titleBox = await page.locator(".app-heading").boundingBox();
    const statusBox = await page
      .locator(".desktop-upload-connection")
      .boundingBox();
    assert.ok(Math.abs(titleBox.y - statusBox.y) < 24);
    assert.equal(await page.getByText("Check again").isVisible(), false);
    assert.equal(await page.locator(".chrome-brand-mark").count(), 1);
    await page.setViewportSize({ width: 420, height: 800 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  } finally {
    await browser.close();
  }
});
