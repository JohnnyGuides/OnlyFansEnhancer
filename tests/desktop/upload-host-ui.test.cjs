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
      const back = page.getByRole("link", { name: "Back to workspace" });
      assert.equal(await back.count(), desktop ? 1 : 0);
      if (desktop) assert.equal(await back.getAttribute("href"), "index.html");
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

async function mountPill(page, initial) {
  await page.setContent(uploader);
  await page.addStyleTag({
    path: path.join(repositoryRoot, "extensions/personal/upload-console.css"),
  });
  await page.evaluate((initial) => {
    Object.defineProperty(crypto, "randomUUID", {
      value: () => String(Math.random()).slice(2),
    });
    globalThis.hostState = initial;
    let receive;
    globalThis.chrome = {
      webview: {
        addEventListener(_name, listener) {
          receive = listener;
        },
        postMessage(message) {
          const request = JSON.parse(message);
          queueMicrotask(() => {
            const reply = hostState[request.operation] ?? hostState.default;
            receive({
              data: reply?.error
                ? { requestId: request.requestId, ok: false, error: reply }
                : { requestId: request.requestId, ok: true, result: reply },
            });
          });
        },
      },
    };
  }, initial);
  await page.addScriptTag({ content: hostScript });
}

test("two live browsers keep the switch select visible while connected; one hides it", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 400 },
    });
    await mountPill(page, {
      getChromeReadiness: { state: "connected", message: "Ready." },
      getUploadBrowsers: {
        browsers: ["aaaaaaaa1111", "bbbbbbbb2222"],
        selected: "aaaaaaaa1111",
        connected: true,
        selectionRequired: false,
      },
    });
    await page.waitForSelector(
      '.desktop-upload-connection[data-state="connected"]',
    );
    const select = page.locator(".desktop-upload-connection select");
    assert.equal(await select.isVisible(), true);
    assert.equal(await select.inputValue(), "aaaaaaaa1111");
    await page.evaluate(() => {
      hostState.getUploadBrowsers = {
        browsers: ["aaaaaaaa1111"],
        selected: "aaaaaaaa1111",
        connected: true,
        selectionRequired: false,
      };
      dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(
      () => document.querySelector(".desktop-upload-connection select").hidden,
    );
  } finally {
    await browser.close();
  }
});

test("a lost connection turns the pill off and a reconnect fires the event again", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 400 },
    });
    await mountPill(page, {
      getChromeReadiness: { state: "connected", message: "Ready." },
      getUploadBrowsers: {
        browsers: ["a1"],
        selected: "a1",
        connected: true,
        selectionRequired: false,
      },
    });
    await page.evaluate(() => {
      globalThis.connectedEvents = 0;
      addEventListener("ofenhancer:browser-connected", () => connectedEvents++);
    });
    await page.waitForSelector(
      '.desktop-upload-connection[data-state="connected"]',
    );
    await page.evaluate(() => {
      hostState.getUploadBrowsers = { error: true, code: "lost" };
      dispatchEvent(new Event("focus"));
    });
    await page.waitForSelector(
      '.desktop-upload-connection[data-connected="false"]',
    );
    assert.equal(
      await page
        .locator(".desktop-upload-connection")
        .getAttribute("data-state"),
      "offline",
    );
    await page.evaluate(() => {
      hostState.getUploadBrowsers = {
        browsers: ["a1"],
        selected: "a1",
        connected: true,
        selectionRequired: false,
      };
      dispatchEvent(new Event("focus"));
    });
    await page.waitForSelector(
      '.desktop-upload-connection[data-state="connected"]',
    );
    assert.equal(await page.evaluate(() => connectedEvents), 1);
  } finally {
    await browser.close();
  }
});
