"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
const root = require("../support/paths.cjs").personalRoot;

async function mount(page) {
  await page.addInitScript(() => {
    const values = {};
    globalThis.calls = [];
    globalThis.chrome = {
      storage: {
        local: {
          get(keys, callback) {
            const result = Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys])
                .filter((key) => key in values)
                .map((key) => [key, values[key]]),
            );
            queueMicrotask(() => callback?.(result));
            return Promise.resolve(result);
          },
          set(data, callback) {
            Object.assign(values, data);
            queueMicrotask(() => callback?.());
            return Promise.resolve();
          },
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
      runtime: {
        connect() {
          return {
            onMessage: { addListener() {} },
            onDisconnect: { addListener() {} },
            postMessage() {},
            disconnect() {},
          };
        },
        sendMessage(message, callback) {
          calls.push(message);
          if (message.type === "LOAD_DEVELOPMENT_TEMPLATE") {
            if (globalThis.missingFixture)
              return callback({
                ok: false,
                error:
                  "Place the three fixture files in the development folder, then click Load Template again.",
              });
            return callback({
              ok: true,
              files: [
                {
                  source: "development-fixture",
                  fixtureToken: "11111111-1111-4111-8111-111111111111",
                  name: "neutral-full.mp4",
                  type: "video/mp4",
                  size: 3429630660,
                  lastModified: 1789812000000,
                },
                {
                  source: "development-fixture",
                  fixtureToken: "22222222-2222-4222-8222-222222222222",
                  name: "neutral-teaser.mp4",
                  type: "video/mp4",
                  size: 32543668,
                  lastModified: 1789812000000,
                },
                {
                  source: "development-fixture",
                  fixtureToken: "33333333-3333-4333-8333-333333333333",
                  name: "neutral-thumbnail-valid.png",
                  type: "image/png",
                  size: 31324,
                  lastModified: 1789812000000,
                },
              ],
            });
          }
          callback({
            ok: true,
            sessions: [],
            creatorTools: { registered: [], skipped: [] },
          });
        },
      },
      permissions: { request: async () => false },
    };
  });
  await page.route("http://ofenhancer.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file))
      return route.fulfill({ status: 404 });
    return route.fulfill({
      path: file,
      contentType: file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
  });
  await page.goto("http://ofenhancer.test/upload-console.html");
  await page.waitForFunction(
    () =>
      globalThis.CreatorUploadConsole &&
      !document.querySelector("#loadTemplate").disabled,
  );
}

test("compact uploader keeps real accessible pickers, three keyboard choices and one descriptor template", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mount(page);
    assert.equal(await page.locator("h1").textContent(), "Upload");
    assert.equal(
      await page.locator('input[name="workflowMode"]:visible').count(),
      3,
    );
    assert.equal(await page.locator("[webkitdirectory]").count(), 0);
    await page.locator('input[name="workflowMode"][value="main"]').focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page
        .locator('input[name="workflowMode"][value="teaser"]')
        .isChecked(),
      true,
    );
    assert.equal(await page.locator(".draft-card").isVisible(), false);
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page
        .locator('input[name="workflowMode"][value="both"]')
        .isChecked(),
      true,
    );
    assert.equal(await page.locator(".draft-card").isVisible(), true);
    assert.equal(await page.locator(".social-card").isVisible(), true);
    await page.locator("#loadTemplate").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#fullFileSummary").textContent ===
        "neutral-full.mp4",
    );
    assert.equal(
      await page.locator("#teaserFileSummary").textContent(),
      "neutral-teaser.mp4",
    );
    assert.equal(
      await page.locator("#manyvidsThumbnailSummary").textContent(),
      "neutral-thumbnail-valid.png",
    );
    assert.equal(
      await page
        .locator("#uploadFullVideo")
        .evaluate((input) => input.files.length),
      0,
      "Descriptors do not pretend to be selected Files",
    );
    assert.equal(
      await page.evaluate(
        () =>
          calls.filter((call) => call.type === "LOAD_DEVELOPMENT_TEMPLATE")
            .length,
      ),
      1,
    );
    assert.equal(
      await page.evaluate(() =>
        calls.some((call) =>
          /START_CREATOR|PREPARE_CREATOR_UPLOAD/.test(call.type),
        ),
      ),
      false,
    );
    const inputBox = await page.locator("#uploadFullVideo").boundingBox();
    assert.ok(
      inputBox.width <= 1 && inputBox.height <= 1,
      "Native file button is not the visible picker",
    );
    for (const id of [
      "uploadFullVideo",
      "uploadTeaser",
      "uploadManyvidsThumbnail",
      "uploadPornhubVideo",
      "uploadSocialTeaser",
    ])
      assert.equal(await page.locator('label[for="' + id + '"]').count(), 1);
    await page.locator('[data-choose-file="uploadFullVideo"]').focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page
        .locator('[data-choose-file="uploadFullVideo"]')
        .evaluate((button) => getComputedStyle(button).outlineStyle),
      "solid",
    );
    const chooser = page.waitForEvent("filechooser");
    await page.locator('[data-choose-file="uploadFullVideo"]').press("Enter");
    await (
      await chooser
    ).setFiles({
      name: "manual-video.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("benign fixture"),
    });
    assert.equal(
      await page.locator("#fullFileSummary").textContent(),
      "manual-video.mp4",
    );
    assert.equal(
      await page
        .locator("#uploadFullVideo")
        .evaluate((input) => input.files.length),
      1,
    );
    await page.locator('[data-remove-file="uploadTeaser"]').click();
    assert.equal(
      await page.locator('[data-remove-file="uploadTeaser"]').isVisible(),
      false,
    );
    await page.locator("#settingsTab").click();
    assert.equal(await page.locator("#settingsPanel").isVisible(), true);
    await page.locator("#uploaderTab").click();
    assert.equal(await page.locator("#uploaderPanel").isVisible(), true);
    assert.equal(
      await page
        .locator("body")
        .evaluate((body) => /kept only in this tab/.test(body.textContent)),
      false,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

for (const [name, width, height, scale] of [
  ["desktop", 1440, 900, 1],
  ["windows-125", 1152, 720, 1.25],
  ["narrow", 390, 844, 1],
  ["minimum", 320, 640, 1],
]) {
  test("uploader layout and selected file states at " + name, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: scale,
      });
      await mount(page);
      await page.locator("#loadTemplate").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#fullFileSummary").textContent ===
          "neutral-full.mp4",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.ok(
        await page
          .locator("h1")
          .evaluate(
            (node) => parseFloat(getComputedStyle(node).fontSize) <= 26,
          ),
      );
      for (const choice of await page
        .locator(".workflow-segments label")
        .all()) {
        const box = await choice.boundingBox();
        assert.ok(
          box.width >= 70 && box.height >= 44 && box.x + box.width <= width,
        );
      }
      for (const button of await page
        .locator(".file-actions button:visible")
        .all())
        assert.ok((await button.boundingBox()).height >= 32);
      if (process.env.OFENHANCER_REVIEW_DIR) {
        fs.mkdirSync(process.env.OFENHANCER_REVIEW_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(
            process.env.OFENHANCER_REVIEW_DIR,
            "upload-" + name + ".png",
          ),
          fullPage: false,
        });
      }
    } finally {
      await browser.close();
    }
  });
}
