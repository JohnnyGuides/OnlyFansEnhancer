"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require("../support/browser.cjs");

const root = require("../support/paths.cjs").personalRoot;
const chromePath = require("../support/browser.cjs").browserExecutable();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "x-teaser-ui-"));
const videoPath = path.join(profile, "Claire teaser.mp4");
const reviewRoot = path.join(
  require("../support/paths.cjs").repositoryRoot,
  "test-results",
  "x-teaser",
);

(async () => {
  assert.ok(chromePath, "Chromium is unavailable.");
  fs.mkdirSync(reviewRoot, { recursive: true });
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=640x360:d=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromePath,
    headless: false,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      "--window-position=-32000,-32000",
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          (await chrome.storage.local.get("ofenhancerInstallationV1"))
            .ofenhancerInstallationV1
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        "The test extension did not finish its first installation.",
      );
    });
    const endpoint =
      "https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789/exec";
    await worker.evaluate(
      async ({ endpoint }) =>
        chrome.storage.local.set({
          creatorUploadSheetBridgeV1: {
            source: "legacy",
            endpoint,
            secret: "fixture-secret-1234567890-abcdef",
          },
        }),
      { endpoint },
    );
    await context.route("https://script.google.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          result: {
            status: "snapshot",
            rows: [
              {
                row: 125,
                id: "claire",
                title: "Claire",
                fingerprint: "1234abcd",
                releaseDate: "2026-09-04",
                description: "",
                seasonArc: "",
                episode: "",
                pornhubLink: "",
                onlyfansLink: "",
                fanslyLink: "",
                manyvidsLink: "",
                twitterTeasers: "",
              },
            ],
          },
        }),
      }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/x-teaser.html`);
    assert.equal(await page.locator("#confirm").isDisabled(), true);
    await page.locator("#teaserFile").setInputFiles(videoPath);
    await page.locator("#catalogueRow").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => !document.querySelector("#catalogueRow").disabled,
    );
    assert.equal(
      await page.locator("#confirm").isDisabled(),
      true,
      "A ranked filename must not choose a row.",
    );
    await page.locator("#catalogueRow").selectOption("125");
    assert.equal(await page.locator("#confirm").isEnabled(), true);
    for (const [name, width, height] of [
      ["desktop", 1280, 800],
      ["compact", 800, 700],
      ["mobile", 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${name} overflows horizontally`,
      );
      await page.screenshot({
        path: path.join(reviewRoot, `x-teaser-${name}.png`),
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Chrome rendered the X teaser recorder at desktop, compact, and mobile widths with explicit selection.",
    );
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(profile, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
