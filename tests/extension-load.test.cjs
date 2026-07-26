"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const extensionRoot = path.resolve(__dirname, "..");
const playwrightRoot = path.join(
  process.env.LOCALAPPDATA || "",
  "ms-playwright"
);
const chromePath = fs
  .readdirSync(playwrightRoot)
  .filter((name) => /^chromium-\d+$/.test(name))
  .sort()
  .reverse()
  .map((name) => path.join(playwrightRoot, name, "chrome-win64", "chrome.exe"))
  .find((candidate) => fs.existsSync(candidate));
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "fim-load-test-"));

(async () => {
  assert.ok(chromePath, "Google Chrome was not found.");
  const context = await chromium.launchPersistentContext(profilePath, {
    executablePath: chromePath,
    headless: false,
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      "--window-position=-32000,-32000",
      "--window-size=1,1"
    ]
  });

  try {
    let workers = context.serviceWorkers();
    if (workers.length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 10000 });
      workers = context.serviceWorkers();
    }
    assert.equal(workers.length, 1, "The extension service worker did not load.");
    assert.match(workers[0].url(), /^chrome-extension:\/\//);
    const extensionId = new URL(workers[0].url()).host;
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForFunction(
      () => document.querySelector("#realbooruEndpoint")?.value
    );
    await page.locator("#toolC4sUpload").waitFor();
    assert.equal(await page.locator("#toolC4sUpload").isChecked(), true);
    assert.equal(await page.locator("#toolOnlyfansAutoSelect").isChecked(), false);
    assert.equal(await page.locator("#toolOnlyfansAutoFollow").isChecked(), true);
    await page.locator("#toolOnlyfansAutoSelect").check();
    await page.locator("#save").click();
    await page.locator("#status").filter({ hasText: "Saved." }).waitFor();

    const toolkitSettings = await workers[0].evaluate(async () => {
      const result = await chrome.storage.local.get("creatorToolkitV1");
      return result.creatorToolkitV1;
    });
    assert.equal(toolkitSettings.c4sUpload, true);
    assert.equal(toolkitSettings.onlyfansAutoSelect, true);
    assert.equal(toolkitSettings.onlyfansAutoFollow, true);

    const modes = await page
      .locator("#avatarMode option")
      .evaluateAll((options) => options.map((option) => option.value));
    assert.ok(modes.includes("realbooru"));
    assert.ok(modes.includes("mixed"));

    const popup = await context.newPage();
    popup.on("pageerror", (error) => pageErrors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(
      () => document.querySelector("#sourceMix")?.value
    );
    const popupView = await popup.evaluate(() => {
      const slider = document.querySelector("#sourceMix");
      slider.value = "30";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        minimum: slider.min,
        maximum: slider.max,
        step: slider.step,
        value: document.querySelector("#mixValue").textContent,
        gelbooru: document.querySelector("#gelbooruChance").textContent,
        realbooru: document.querySelector("#realbooruChance").textContent,
        resetNames: Boolean(document.querySelector("#resetNames")),
        resetPictures: Boolean(document.querySelector("#resetPictures"))
      };
    });
    assert.deepEqual(popupView, {
      minimum: "0",
      maximum: "100",
      step: "10",
      value: "70 / 30",
      gelbooru: "70% anime",
      realbooru: "30% real",
      resetNames: true,
      resetPictures: true
    });
    assert.deepEqual(pageErrors, []);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8")
    );
    console.log(
      `PASS: Chrome loaded the unpacked v${manifest.version} extension and options`
    );
  } finally {
    await context.close();
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(profilePath, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
