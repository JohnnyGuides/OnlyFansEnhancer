"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

const appRoot = require("../support/paths.cjs").workspaceRoot;

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function withServer(run) {
  const server = http.createServer((request, response) => {
    const requested = new URL(request.url, "http://127.0.0.1").pathname;
    const relative = requested === "/" ? "index.html" : requested.slice(1);
    const file = path.resolve(appRoot, relative);
    if (!file.startsWith(`${appRoot}${path.sep}`) || !fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": contentType(file) });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Every asynchronous host reply is held until the test releases it, so the
// test decides the order in which replies arrive.
async function installHost(page) {
  await page.addInitScript(() => {
    const items = [1, 2].map((number) => ({
      itemId: `${number}${number}${number}${number}1111-1111-1111-1111-111111111111`,
      sourceKey: `video-${number}`,
      sourceRow: 40 + number,
      title: `Video ${number}`,
      description: "",
      plannedDate: "2026-09-11",
      series: "",
      episode: "",
      xTeasers: 0,
      redditTeasers: 0,
      platformLinks: {},
      archived: false,
      thumbnailAssetId: null,
      thumbnailStatus: "missing",
      candidates: null,
    }));
    const assets = [1, 2].map((number) => ({
      assetId: `aaaaaaa${number}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
      fileName: `cover_${number}.png`,
      role: "curated",
      candidates: items.map((item, index) => ({
        itemId: item.itemId,
        title: item.title,
        plannedDate: item.plannedDate,
        score: 100 - index,
        thumbnailAssetId: null,
      })),
    }));
    let unmatched = assets;
    globalThis.__held = { google: [], confirm: [] };
    globalThis.__confirmCalls = 0;
    globalThis.__OFENHANCER_TEST_HOST__ = (operation, payload) => {
      if (operation === "getStatus")
        return Promise.resolve({
          productVersion: "0.20.85",
          protocolVersion: 1,
          capabilities: ["desktop-shell"],
          testData: true,
        });
      if (operation === "getCatalogue")
        return Promise.resolve({
          items,
          unmatchedAssets: unmatched,
          availableThumbnails: 2,
          inventoryStatus: "ready",
        });
      if (operation === "getBrowserOptions")
        return Promise.resolve({
          selectedId: "system",
          options: [{ id: "system", name: "System default" }],
        });
      if (operation === "getGoogleCatalogueStatus")
        return new Promise((resolve) => globalThis.__held.google.push(resolve));
      if (operation === "confirmAssetBinding") {
        globalThis.__confirmCalls += 1;
        return new Promise((resolve) =>
          globalThis.__held.confirm.push(() => {
            unmatched = unmatched.filter(
              (asset) => asset.assetId !== payload.assetId,
            );
            resolve({ ...payload, changed: true });
          }),
        );
      }
      return Promise.reject(new Error("unsupported-test-operation"));
    };
  });
}

async function newPage(browser, port) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installHost(page);
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  return { page, errors };
}

async function openMatchDialog(page, index) {
  await page.getByRole("button", { name: "Choose video" }).nth(index).click();
  await page.getByRole("dialog", { name: "Match thumbnail" }).waitFor();
}

async function testReversedGoogleStatus(browser, port) {
  const { page, errors } = await newPage(browser, port);
  await page.getByRole("button", { name: "Catalogue" }).click();
  await page.waitForFunction(() => __held.google.length >= 1);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForFunction(() => __held.google.length >= 2);
  const count = await page.evaluate(() => __held.google.length);
  await page.evaluate((last) => {
    __held.google[last - 1]({
      state: "ready",
      workbookName: "Newer workbook",
      sheetName: "Sheet",
      pendingCount: 0,
      conflictCount: 0,
      lastVerifiedSync: "2026-09-04T12:00:00Z",
    });
  }, count);
  await page.getByText("Newer workbook").first().waitFor();
  await page.evaluate(() => {
    __held.google[0]({ state: "disconnected" });
  });
  await page.waitForTimeout(150);
  assert.ok(
    (await page.getByText("Newer workbook").count()) > 0,
    "an older Google status reply replaced the newer one",
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function testMatchCompletionKeepsSecondDialog(browser, port) {
  const { page, errors } = await newPage(browser, port);
  await page.getByRole("button", { name: "Catalogue" }).click();
  await page.getByRole("button", { name: "Needs thumbnail" }).click();
  await openMatchDialog(page, 0);
  const dialog = page.getByRole("dialog", { name: "Match thumbnail" });
  await dialog.getByRole("button", { name: "Use Video 1" }).click();
  await page.waitForFunction(() => __confirmCalls === 1);
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "hidden" });
  await openMatchDialog(page, 1);
  await page.evaluate(() => __held.confirm[0]());
  await page.waitForTimeout(300);
  assert.equal(
    await dialog.isVisible(),
    true,
    "the first match completion closed the second dialog",
  );
  assert.notEqual(
    await page.locator("#catalogueStatus").innerText(),
    "Thumbnail matched.",
    "the first match completion announced into the second dialog",
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function testPendingMatchSendsOneConfirmation(browser, port) {
  const { page, errors } = await newPage(browser, port);
  await page.getByRole("button", { name: "Catalogue" }).click();
  await page.getByRole("button", { name: "Needs thumbnail" }).click();
  await openMatchDialog(page, 0);
  const dialog = page.getByRole("dialog", { name: "Match thumbnail" });
  await dialog.getByRole("button", { name: "Use Video 1" }).click();
  await page.waitForFunction(() => __confirmCalls === 1);
  await dialog
    .getByRole("button", { name: "Use Video 2" })
    .evaluate((button) => {
      button.click();
    });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => __confirmCalls), 1);
  assert.equal(
    await dialog.getByRole("button", { name: "Use Video 2" }).isDisabled(),
    true,
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function main() {
  await withServer(async (port) => {
    const browser = await chromium.launch({ headless: true });
    try {
      await testReversedGoogleStatus(browser, port);
      await testMatchCompletionKeepsSecondDialog(browser, port);
      await testPendingMatchSendsOneConfirmation(browser, port);
    } finally {
      await browser.close();
    }
  });
  console.log("PASS: workspace completions stay bound to their operation");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
