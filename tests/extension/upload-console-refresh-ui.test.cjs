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
          if (message.type === "CHECK_CREATOR_UPLOAD_AVAILABILITY")
            return callback({ ok: true, availability: { ready: true } });
          if (
            message.type === "GET_CREATOR_UPLOAD_RESUMABLE" &&
            globalThis.resumeGate
          )
            return void globalThis.resumeGate.push(() =>
              callback({ ok: false, error: "Chrome is unavailable." }),
            );
          if (
            message.type === "GET_CREATOR_UPLOAD_RESUMABLE" &&
            globalThis.failResume
          )
            return callback({
              ok: false,
              error: "Chrome is unavailable or needs a browser selection.",
            });
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

test("naming advice applies only on request and preserves edits during refresh", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mount(page);
    await page.evaluate(() => {
      globalThis.CreatorCatalogueClient = {
        loadConfig: async () => ({ connected: true }),
        getCatalogueSnapshot: async () => ({
          status: "snapshot",
          source: "google",
          seasonAliases: {},
          rows: [1, 2].map((episode) => ({
            row: episode + 1,
            id: `setaria-ep0${episode}`,
            title: `Setaria Episode 0${episode}`,
            seasonArc: "Setaria",
            episode: String(episode),
            description: "Fixture",
            releaseDate: "2026-09-25",
            fingerprint: "a".repeat(64),
            publicationState: {},
          })),
          emptyRow: { row: 4, fingerprint: "b".repeat(64) },
        }),
      };
    });
    await page.locator("#uploadFullVideo").setInputFiles({
      name: "Episode 3.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("benign fixture"),
    });
    await page.locator("#cataloguePicker").waitFor({ state: "visible" });
    await page.locator("#seasonTrigger").click();
    await page.getByRole("option", { name: "Setaria", exact: true }).click();
    await page.locator("#uploadTitle").fill("Episode 3");
    await page.locator("#applyNamingAdvice").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#namingAdviceText").textContent(),
      "Setaria Episode 03",
    );
    assert.equal(await page.locator("#uploadTitle").inputValue(), "Episode 3");
    await page.locator("#applyNamingAdvice").click();
    assert.equal(
      await page.locator("#uploadTitle").inputValue(),
      "Setaria Episode 03",
    );
    await page.locator("#uploadTitle").fill("My Episode 3 title");
    await page.locator("#catalogueBrowseToggle").click();
    await page.locator("#refreshCatalogue").click();
    await page.waitForFunction(
      () => !document.querySelector("#refreshCatalogue").disabled,
    );
    await page.locator("#closeCatalogueBrowse").click();
    assert.equal(
      await page.locator("#uploadTitle").inputValue(),
      "My Episode 3 title",
    );
    await page.locator("#uploadTitle").fill("Episode 3 Episode 4");
    assert.match(
      await page.locator("#namingAdviceText").textContent(),
      /conflicting episode hints/,
    );
    assert.equal(await page.locator("#applyNamingAdvice").isVisible(), false);
    const folder = process.env.OFENHANCER_TEASER_SCREENSHOTS;
    if (folder) {
      fs.mkdirSync(folder, { recursive: true });
      await page
        .locator(".metadata-title")
        .screenshot({ path: path.join(folder, "naming-conflict.png") });
      await page.locator("#uploadTitle").fill("Episode 3");
      await page
        .locator(".metadata-title")
        .screenshot({ path: path.join(folder, "naming-suggestion.png") });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("compact uploader keeps real accessible pickers, two keyboard choices and one descriptor template", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mount(page);
    assert.equal(await page.locator("h1").textContent(), "Upload");
    assert.deepEqual(
      await page.locator("#uploadCategory option").allTextContents(),
      [
        "Select category",
        "GameSync",
        "FantasyFuck",
        "ToyFucking",
        "Gooning",
        "JohnnyVerse",
        "ManualSync",
        "Review",
        "Solo",
        "Specials",
        "QuickSync",
        "Boyfriend",
        "Compilation",
      ],
    );
    assert.deepEqual(
      (await page.locator("#uploadSeason option").allTextContents()).slice(
        0,
        4,
      ),
      ["Select season", "Legacy Solo", "Setaria", "Seal of Lutellaria"],
    );
    const metadataBefore = await page
      .locator(".description-layout")
      .boundingBox();
    await page.locator("#categoryTrigger").click();
    await page.locator("#categorySearch").fill("New Category");
    await page.locator("#categoryAdd").click();
    assert.equal(
      await page.locator("#uploadCategory").inputValue(),
      "New Category",
    );
    await page.locator("#seasonTrigger").click();
    await page.locator("#seasonSearch").fill("New Season");
    await page.locator("#seasonSearch").press("Enter");
    assert.equal(
      await page.locator("#uploadSeason").inputValue(),
      "New Season",
    );
    assert.deepEqual(
      await page.locator(".description-layout").boundingBox(),
      metadataBefore,
    );
    const fullSummary = await page.locator("#fullFileSummary").boundingBox();
    const teaserSummary = await page
      .locator("#teaserFileSummary")
      .boundingBox();
    const fullAction = await page
      .locator('[data-choose-file="uploadFullVideo"]')
      .boundingBox();
    assert.ok(Math.abs(fullSummary.y - teaserSummary.y) < 3);
    assert.ok(fullAction.y - (fullSummary.y + fullSummary.height) < 38);
    const destinations = await page
      .locator("section.card:has(#mainDestinations)")
      .boundingBox();
    const actionPanel = await page.locator("#uploadActions").boundingBox();
    const actionStatus = await page.locator("#matchStatus").boundingBox();
    assert.ok(
      actionPanel.y - (destinations.y + destinations.height) <= 24,
      JSON.stringify({ destinations, actionPanel }),
    );
    assert.ok(actionStatus.x - actionPanel.x >= 12);
    assert.equal(await page.locator("#runNotice").textContent(), "");
    assert.notEqual(
      await page
        .locator("#uploadActions")
        .evaluate((element) => getComputedStyle(element).position),
      "sticky",
    );
    const beforePicker = await page.locator(".pornhub-file-card").boundingBox();
    await page.locator("#catalogueThumbnails").evaluate((element) => {
      element.hidden = false;
      element.showPopover();
    });
    assert.equal(await page.locator("#catalogueThumbnails").isVisible(), true);
    assert.equal(
      await page
        .locator("#catalogueThumbnails")
        .evaluate((element) => getComputedStyle(element).position),
      "fixed",
    );
    assert.deepEqual(
      await page.locator(".pornhub-file-card").boundingBox(),
      beforePicker,
    );
    await page.keyboard.press("Escape");
    await page.locator("#catalogueThumbnails").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#catalogueThumbnails").isVisible(), false);
    await page.locator("#uploadManyvidsThumbnail").setInputFiles({
      name: "Sample Chess Session With A Much Longer Thumbnail Name Final.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await page.waitForFunction(
      () => document.querySelector("#selectedThumbnailImage").naturalWidth > 0,
    );
    assert.equal(
      await page.locator("#selectedThumbnailPreview").isVisible(),
      true,
    );
    assert.equal(
      await page
        .locator(".thumbnail-file-card .file-name-extension")
        .textContent(),
      ".png",
    );
    const nameStem = page.locator(".thumbnail-file-card .file-name-stem");
    assert.equal(
      await nameStem.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
      true,
    );
    const fileSizeBox = await page
      .locator("#manyvidsThumbnailSummarySize")
      .boundingBox();
    const fileNameBox = await page
      .locator("#manyvidsThumbnailSummary")
      .boundingBox();
    assert.ok(fileSizeBox.x > fileNameBox.x + fileNameBox.width);
    const previewBox = await page
      .locator("#selectedThumbnailPreview")
      .boundingBox();
    const editorBox = await page.locator("#uploadDescription").boundingBox();
    assert.ok(previewBox.x - editorBox.x < 16);
    assert.ok(
      previewBox.y - editorBox.y < 16,
      JSON.stringify({ previewBox, editorBox }),
    );
    assert.ok(
      Math.abs(previewBox.width / previewBox.height - 16 / 9) < 0.05,
      JSON.stringify(previewBox),
    );
    const cardWidths = await page
      .locator(".media-grid .file-picker")
      .evaluateAll((cards) =>
        cards.map((card) => card.getBoundingClientRect().width),
      );
    assert.ok(Math.max(...cardWidths) - Math.min(...cardWidths) < 2);
    const actionTops = await Promise.all(
      [
        '[data-choose-file="uploadFullVideo"]',
        '[data-choose-file="uploadTeaser"]',
        "#chooseThumbnailFrame",
        '[data-choose-file="uploadPornhubVideo"]',
      ].map(async (selector) => (await page.locator(selector).boundingBox()).y),
    );
    assert.ok(
      Math.max(...actionTops) - Math.min(...actionTops) < 3,
      JSON.stringify(actionTops),
    );
    await page.setViewportSize({ width: 780, height: 900 });
    await page.locator("#thumbnailMore summary").click();
    assert.equal(
      await page.locator(".thumbnail-primary-choice").isHidden(),
      true,
    );
    assert.equal(
      await page.locator(".thumbnail-menu-replace").isVisible(),
      true,
    );
    const frameAction = await page
      .locator("#chooseThumbnailFrame")
      .boundingBox();
    const moreAction = await page
      .locator("#thumbnailMore summary")
      .boundingBox();
    assert.ok(Math.abs(frameAction.y - moreAction.y) < 3);
    await page.locator('[data-remove-file="uploadManyvidsThumbnail"]').click();
    assert.equal(
      await page.locator("#selectedThumbnailPreview").isVisible(),
      true,
    );
    assert.equal(
      await page.locator("#selectedThumbnailImage").isHidden(),
      true,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    const freeChoice = page.locator("label:has(#targetPornhub)");
    const paidChoice = page.locator("label:has(#targetPornhubPaid)");
    await freeChoice.click();
    assert.equal(await page.locator("#targetPornhub").isChecked(), true);
    assert.equal(await page.locator("#pornhubVideoType").inputValue(), "free");
    assert.equal(await page.locator(".pornhub-file-card").isVisible(), true);
    await paidChoice.click();
    assert.equal(await page.locator("#targetPornhub").isChecked(), false);
    assert.equal(await page.locator("#targetPornhubPaid").isChecked(), true);
    assert.equal(await page.locator("#pornhubVideoType").inputValue(), "paid");
    assert.equal(await page.locator(".pornhub-file-card").isVisible(), false);
    await paidChoice.click();
    assert.equal(await page.locator("#chooseThumbnailFrame").isVisible(), true);
    assert.equal(
      await page.locator("#chooseThumbnailFrame").isDisabled(),
      true,
    );
    assert.equal(
      await page.locator('input[name="workflowMode"]:visible').count(),
      2,
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
    await page.keyboard.press("ArrowLeft");
    assert.equal(
      await page
        .locator('input[name="workflowMode"][value="main"]')
        .isChecked(),
      true,
    );
    assert.equal(await page.locator(".draft-card").isVisible(), true);
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
    assert.equal(await page.locator(".workflow-panel").isVisible(), false);
    assert.equal(await page.locator("#loadTemplate").isVisible(), false);
    await page.locator("#uploaderTab").click();
    assert.equal(await page.locator("#uploaderPanel").isVisible(), true);
    assert.equal(await page.locator(".workflow-panel").isVisible(), true);
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

test("description editor keeps a fixed 16:9 placeholder and plain-text value", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 850 },
  });
  try {
    await mount(page);
    const box = page.locator("#selectedThumbnailPreview");
    const editor = page.locator("#uploadDescription");
    assert.equal(await box.isVisible(), true);
    assert.equal(
      await page.locator("#selectedThumbnailImage").isHidden(),
      true,
    );
    const empty = await box.boundingBox();
    assert.ok(Math.abs(empty.width / empty.height - 16 / 9) < 0.05);
    assert.equal(
      await editor.evaluate((e) => getComputedStyle(e, "::after").content),
      '"Add a description…"',
    );
    const text = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} 😀`);
    await editor.fill(text[0]);
    for (const line of text.slice(1)) {
      await page.keyboard.press("Enter");
      await page.keyboard.insertText(line);
    }
    assert.equal(await editor.evaluate((e) => e.value), text.join("\n"));
    const grown = await box.boundingBox();
    assert.equal(grown.width, empty.width);
    assert.equal(grown.height, empty.height);
    assert.ok((await editor.boundingBox()).height > empty.height + 40);
    await editor.evaluate((e) => {
      e.value = "";
    });
    assert.equal(await editor.getAttribute("data-empty"), "true");
    await editor.evaluate((e) => {
      e.focus();
      const data = new DataTransfer();
      data.setData("text/html", "<b>bold</b><p>para</p>");
      data.setData("text/plain", "bold\npara");
      e.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.equal(await editor.evaluate((e) => e.value), "bold\npara");
    assert.equal(await editor.locator("b, p").count(), 0);
    await editor.evaluate((e) => {
      e.value = "a\r\nb";
    });
    assert.equal(await editor.evaluate((e) => e.value), "a\nb");
    assert.equal(await box.isVisible(), true);
    for (const selector of ["#loadTemplate", "#uploadButton"])
      assert.equal(
        await page
          .locator(selector)
          .evaluate((e) => getComputedStyle(e).userSelect),
        "none",
      );
    assert.notEqual(
      await editor.evaluate((e) => getComputedStyle(e).userSelect),
      "none",
    );
  } finally {
    await browser.close();
  }
});

test("new metadata remains in the picker after reopening the upload screen", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await mount(page);
    await page.locator("#categoryTrigger").click();
    await page.locator("#categorySearch").fill("Custom Category");
    await page.locator("#categorySearch").press("Escape");
    assert.equal(await page.locator("#uploadCategory").inputValue(), "");
    await page.locator("#categoryTrigger").click();
    await page.locator("#categorySearch").fill("Custom Category");
    await page.locator("#categoryAdd").click();
    await page.reload();
    await page.waitForFunction(() => globalThis.CreatorUploadConsole);
    await page.locator("#categoryTrigger").click();
    await page.locator("#categorySearch").fill("Custom Category");
    await page.locator("#categoryOptions button").first().click();
    assert.equal(
      await page.locator("#uploadCategory").inputValue(),
      "Custom Category",
    );
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
      if (name === "desktop") {
        const mode = await page.locator("#workflowMode").boundingBox();
        const uploaderTab = await page.locator("#uploaderTab").boundingBox();
        assert.ok(mode.x + mode.width < uploaderTab.x);
        assert.ok(Math.abs(mode.y - uploaderTab.y) < 24);
        const chooseFrame = await page
          .locator("#chooseThumbnailFrame")
          .boundingBox();
        const custom = await page
          .locator(".thumbnail-primary-choice")
          .boundingBox();
        assert.ok(
          Math.abs(chooseFrame.y - custom.y) < 3,
          JSON.stringify({ chooseFrame, custom }),
        );
        // Script sits in the Add media row, in the Pornhub Free column.
        const script = await page.locator(".script-file-card").boundingBox();
        const pornhubCard = await page
          .locator(".pornhub-file-card")
          .boundingBox();
        const addMedia = await page
          .locator('[data-choose-file="uploadAdditionalMedia"]')
          .boundingBox();
        assert.ok(
          Math.abs(script.x - pornhubCard.x) < 2 &&
            Math.abs(script.width - pornhubCard.width) < 2 &&
            Math.abs(script.y - addMedia.y) < 3 &&
            script.height <= 48,
          JSON.stringify({ script, pornhubCard, addMedia }),
        );
        const heading = await page.locator("#targetsHeading").boundingBox();
        const publish = await page.locator("#mainPublishFields").boundingBox();
        assert.ok(
          publish.x > heading.x && Math.abs(publish.y - heading.y) < 12,
        );
      }
      if (name === "narrow") {
        const script = await page.locator(".script-file-card").boundingBox();
        const addMedia = await page
          .locator('[data-choose-file="uploadAdditionalMedia"]')
          .boundingBox();
        assert.ok(
          script.y >= addMedia.y + addMedia.height &&
            Math.abs(script.x - addMedia.x) < 2,
          JSON.stringify({ script, addMedia }),
        );
      }
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

test("recovery notice that failed at startup clears once Chrome connects", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      globalThis.failResume = true;
      // The plain-http fixture origin has no crypto.subtle.
      Object.defineProperty(crypto, "subtle", {
        value: { digest: async () => new ArrayBuffer(32) },
      });
    });
    await mount(page);
    await page.locator("#resumePrompt").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#resumeHeading").textContent(),
      "Saved uploads not checked yet",
    );
    // Make the form otherwise complete so only recovery can block Upload.
    await page.locator("#loadTemplate").click();
    await page.locator("#uploadTitle").fill("Recovery fixture");
    await page.waitForFunction(() =>
      document.querySelector("#matchStatus").textContent.startsWith("Ready."),
    );
    assert.equal(await page.locator("#resumeError").textContent(), "");
    assert.equal(await page.locator("#resumeUpload").isVisible(), false);
    assert.equal(await page.locator("#recheckResume").isVisible(), true);
    // Upload stays blocked only because recovery is unverified: the same
    // form becomes enabled once the notice clears (checked below).
    assert.equal(await page.locator("#uploadButton").isDisabled(), true);
    // A manual check with Chrome still unavailable keeps the notice, and the
    // control is disabled while that check is in flight.
    await page.evaluate(() => {
      globalThis.resumeGate = [];
    });
    await page.locator("#recheckResume").click();
    await page.waitForFunction(
      () => document.querySelector("#recheckResume").disabled,
    );
    await page.evaluate(() => {
      for (const release of resumeGate.splice(0)) release();
      globalThis.resumeGate = null;
    });
    await page.waitForFunction(
      () => !document.querySelector("#recheckResume").disabled,
    );
    await page.locator("#resumePrompt").waitFor({ state: "visible" });
    assert.equal(await page.locator("#uploadButton").isDisabled(), true);
    // The connection indicator reports Chrome reachable: recovery re-checks.
    await page.evaluate(() => {
      globalThis.failResume = false;
      globalThis.dispatchEvent(new Event("ofenhancer:browser-connected"));
    });
    await page.locator("#resumePrompt").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#recheckResume").isVisible(), false);
    // With the notice gone nothing else blocks Upload, so the earlier
    // disabled state was caused by the unverified recovery guard.
    await page.waitForFunction(
      () => !document.querySelector("#uploadButton").disabled,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
