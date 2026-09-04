"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const appRoot = path.resolve(__dirname, "..", "app");
const populated = {
  items: [
    {
      itemId: "11111111-1111-1111-1111-111111111111",
      sourceKey: "ashley-04",
      sourceRow: 42,
      title: "Ashley episode 04",
      description: "Description",
      plannedDate: "2026-09-11",
      series: "Ashley",
      episode: "04",
      xTeasers: 2,
      redditTeasers: 1,
      platformLinks: {
        onlyfans: "https://onlyfans.com/123/johnny_guides",
        fansly: "https://fansly.com/post/1",
      },
      archived: false,
      thumbnailAssetId: null,
      thumbnailStatus: "missing",
      candidates: null,
    },
    {
      itemId: "22222222-2222-2222-2222-222222222222",
      sourceKey: "ashley-05",
      sourceRow: 43,
      title: "Ashley episode 05",
      description: "Description",
      plannedDate: "2026-09-18",
      series: "Ashley",
      episode: "05",
      xTeasers: 0,
      redditTeasers: 0,
      platformLinks: {},
      archived: false,
      thumbnailAssetId: null,
      thumbnailStatus: "missing",
      candidates: null,
    },
  ],
  unmatchedAssets: [],
  availableThumbnails: 0,
  inventoryStatus: "not-scanned",
};

const googleClientId =
  "123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com";
const secondGoogleClientId =
  "987654321098-zyxwvutsrqponmlkjihgfedcba654321.apps.googleusercontent.com";
const firstPlanHash = "a".repeat(64);
const secondPlanHash = "b".repeat(64);
const workbookName = "Creator Catalogue";
const sheetName = "2026 Video Catalogue";

const googleStates = Object.freeze({
  notConfigured: { state: "notConfigured" },
  disconnected: { state: "disconnected" },
  connecting: { state: "connecting" },
  needsInspection: {
    state: "needsInspection",
    workbookName,
  },
  migrationReady: {
    state: "migrationReady",
    workbookName,
    sheetName,
    planHash: firstPlanHash,
    rowsToBind: 2,
    migrationChanges: 5,
    pendingCount: 0,
    conflictCount: 0,
    lastVerifiedSync: null,
  },
  refreshedMigration: {
    state: "migrationReady",
    workbookName,
    sheetName,
    planHash: secondPlanHash,
    rowsToBind: 3,
    migrationChanges: 6,
    pendingCount: 0,
    conflictCount: 0,
    lastVerifiedSync: null,
  },
  ready: {
    state: "ready",
    workbookName,
    sheetName,
    pendingCount: 2,
    conflictCount: 0,
    lastVerifiedSync: "2026-09-04T12:00:00Z",
  },
  readyWithConflicts: {
    state: "ready",
    workbookName,
    sheetName,
    pendingCount: 2,
    conflictCount: 1,
    lastVerifiedSync: "2026-09-04T12:00:00Z",
  },
  syncing: {
    state: "syncing",
    workbookName,
    sheetName,
    pendingCount: 2,
    conflictCount: 0,
    lastVerifiedSync: "2026-09-04T12:00:00Z",
  },
  conflict: {
    state: "conflict",
    workbookName,
    sheetName,
    pendingCount: 1,
    conflictCount: 1,
    errorCode: "remote-fingerprint-changed",
    sensitiveTitle: "PRIVATE VIDEO TITLE MUST NOT LEAK",
  },
  error: {
    state: "error",
    workbookName,
    sheetName,
    errorCode: "google-token-refresh-failed",
    sensitiveTitle: "PRIVATE VIDEO TITLE MUST NOT LEAK",
  },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function routeThumbnails(page) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("https://thumbs.ofenhancer.local/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png }),
  );
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
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

async function installHost(page, initialState = null, googleOptions = {}) {
  await page.addInitScript(
    ({ initial, populatedState, googleFixtures }) => {
      let catalogue = initial || {
        items: [],
        unmatchedAssets: [],
        availableThumbnails: 0,
        inventoryStatus: "not-scanned",
      };
      let failNextScan = true;
      let googleStatus = structuredClone(
        googleFixtures.initial || { state: "notConfigured" },
      );
      const googleStatusQueue = (googleFixtures.statusQueue || []).map(
        (value) => structuredClone(value),
      );
      const inspectionQueue = (googleFixtures.inspectionQueue || []).map(
        (value) => structuredClone(value),
      );
      let staleApply = Boolean(googleFixtures.staleApplyOnce);
      globalThis.__catalogueImportCalls = 0;
      globalThis.__catalogueConfirmCalls = 0;
      globalThis.__googleHostCalls = [];
      globalThis.__setGoogleState = (next) => {
        googleStatus = structuredClone(next);
        googleStatusQueue.length = 0;
      };
      globalThis.__OFENHANCER_TEST_HOST__ = async (operation, payload) => {
        if (operation === "getStatus") {
          return {
            productVersion: "0.19.0",
            protocolVersion: 1,
            capabilities: ["desktop-shell"],
            testData: true,
          };
        }
        if (operation === "getCatalogue") return structuredClone(catalogue);
        if (operation === "importCatalogueSnapshot") {
          globalThis.__catalogueImportCalls += 1;
          JSON.parse(payload.json);
          catalogue = structuredClone(populatedState);
          return { activeItems: 2, archivedItems: 0, unchanged: false };
        }
        if (operation === "scanThumbnails") {
          if (failNextScan) {
            failNextScan = false;
            throw new Error("thumbnail-root-missing");
          }
          catalogue.inventoryStatus = "ready";
          catalogue.availableThumbnails = 1;
          catalogue.unmatchedAssets = [
            {
              assetId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              fileName: "ashley_04_cover.png",
              role: "curated",
              candidates: [
                {
                  itemId: catalogue.items[0].itemId,
                  title: catalogue.items[0].title,
                  plannedDate: catalogue.items[0].plannedDate,
                  score: 154,
                  thumbnailAssetId: null,
                },
                {
                  itemId: catalogue.items[1].itemId,
                  title: catalogue.items[1].title,
                  plannedDate: catalogue.items[1].plannedDate,
                  score: 22,
                  thumbnailAssetId: null,
                },
              ],
            },
          ];
          return { availableAssets: 1, newAssets: 1, unavailableAssets: 0 };
        }
        if (operation === "confirmAssetBinding") {
          globalThis.__catalogueConfirmCalls += 1;
          catalogue.items[0].thumbnailAssetId = payload.assetId;
          catalogue.items[0].thumbnailStatus = "bound";
          catalogue.unmatchedAssets = [];
          return { ...payload, changed: true };
        }
        if (operation === "openChromeUploader") return { opened: true };
        if (
          [
            "getGoogleCatalogueStatus",
            "saveGoogleClientId",
            "startGoogleCatalogueConnection",
            "cancelGoogleCatalogueConnection",
            "inspectGoogleWorkbook",
            "applyGoogleWorkbookMigration",
            "syncGoogleCatalogue",
            "disconnectGoogleCatalogue",
          ].includes(operation)
        ) {
          globalThis.__googleHostCalls.push({
            operation,
            payload: structuredClone(payload),
          });
          if (
            operation !== "getGoogleCatalogueStatus" &&
            googleFixtures.operationDelayMs
          ) {
            await new Promise((resolve) =>
              setTimeout(resolve, googleFixtures.operationDelayMs),
            );
          }
          if (operation === "getGoogleCatalogueStatus") {
            if (googleStatusQueue.length)
              googleStatus = googleStatusQueue.shift();
            return structuredClone(googleStatus);
          }
          if (operation === "saveGoogleClientId") {
            googleStatus = { state: "disconnected" };
            return structuredClone(googleStatus);
          }
          if (operation === "startGoogleCatalogueConnection") {
            googleStatus = { state: "connecting" };
            return structuredClone(googleStatus);
          }
          if (operation === "cancelGoogleCatalogueConnection") {
            googleStatus = { state: "disconnected" };
            return structuredClone(googleStatus);
          }
          if (operation === "inspectGoogleWorkbook") {
            if (inspectionQueue.length) googleStatus = inspectionQueue.shift();
            else
              googleStatus = structuredClone(
                googleFixtures.inspected || googleStatus,
              );
            return structuredClone(googleStatus);
          }
          if (operation === "applyGoogleWorkbookMigration") {
            if (staleApply) {
              staleApply = false;
              throw new Error("stale-migration-plan");
            }
            googleStatus = structuredClone(
              googleFixtures.applied || {
                ...googleStatus,
                state: "ready",
                planHash: null,
              },
            );
            return structuredClone(googleStatus);
          }
          if (operation === "syncGoogleCatalogue") {
            googleStatus = structuredClone(
              googleFixtures.synced || {
                ...googleStatus,
                state: "syncing",
              },
            );
            return structuredClone(googleStatus);
          }
          googleStatus = { state: "disconnected" };
          return structuredClone(googleStatus);
        }
        throw new Error("unsupported-operation");
      };
    },
    {
      initial: initialState,
      populatedState: populated,
      googleFixtures: googleOptions,
    },
  );
}

function captureErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function googleCalls(page, operation) {
  return page.evaluate(
    (name) => __googleHostCalls.filter((call) => call.operation === name),
    operation,
  );
}

async function setGoogleState(page, state) {
  await page.evaluate((next) => __setGoogleState(next), state);
  await page.getByRole("button", { name: "Uploads" }).click();
  await page.getByRole("button", { name: "Catalogue" }).click();
}

async function tabTo(page, locator, label) {
  await page.evaluate(() => document.activeElement?.blur());
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((node) => node === document.activeElement)) {
      assert.equal(await page.locator(":focus-visible").count(), 1, label);
      return;
    }
  }
  assert.fail(`${label} was not reachable with Tab`);
}

async function testGoogleStates(browser, port) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors = captureErrors(page);
  await installHost(page, populated, { initial: googleStates.notConfigured });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Catalogue" }).click();

  const strip = page.locator("#googleCatalogue");
  await strip
    .getByText("Add your Google setup in Settings.", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#googleCatalogue").count(), 1);
  assert.equal(await strip.locator('[role="status"]').count(), 1);
  await tabTo(
    page,
    strip.getByRole("button", { name: "Settings" }),
    "Settings focus",
  );

  await setGoogleState(page, googleStates.disconnected);
  await strip
    .getByText("Connect the workbook you use for your catalogue.", {
      exact: true,
    })
    .waitFor();
  await tabTo(
    page,
    strip.getByRole("button", { name: "Connect Google Sheet" }),
    "Connect focus",
  );

  await setGoogleState(page, googleStates.connecting);
  await strip.getByText("Finish in your browser.", { exact: true }).waitFor();
  await tabTo(
    page,
    strip.getByRole("button", { name: "Cancel" }),
    "Cancel focus",
  );

  await setGoogleState(page, googleStates.needsInspection);
  await strip
    .getByText(`${workbookName} is connected. Check it before syncing.`, {
      exact: true,
    })
    .waitFor();
  await tabTo(
    page,
    strip.getByRole("button", { name: "Check workbook" }),
    "Check focus",
  );

  await setGoogleState(page, googleStates.migrationReady);
  await strip
    .getByText("2 rows need linking. 5 workbook changes are ready.", {
      exact: true,
    })
    .waitFor();
  const review = strip.getByRole("button", { name: "Review changes" });
  await tabTo(page, review, "Review focus");
  await review.click();
  const dialog = page.getByRole("dialog", { name: "Update Google Sheet?" });
  await dialog.waitFor();
  assert.equal(
    await dialog.getByText(workbookName, { exact: true }).count(),
    1,
  );
  assert.equal(await dialog.getByText(sheetName, { exact: true }).count(), 1);
  assert.equal(await dialog.getByText("2 rows", { exact: true }).count(), 1);
  assert.equal(await dialog.getByText("5 changes", { exact: true }).count(), 1);
  assert.equal(
    await dialog.getByText("0 conflicts", { exact: true }).count(),
    1,
  );
  const no = dialog.getByRole("button", { name: "No", exact: true });
  assert.equal(
    await no.evaluate((button) => button === document.activeElement),
    true,
  );
  await tabTo(
    page,
    dialog.getByRole("button", { name: "Yes, update the workbook" }),
    "Yes focus",
  );
  await no.click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    (await googleCalls(page, "applyGoogleWorkbookMigration")).length,
    0,
  );
  assert.equal(
    await review.evaluate((button) => button === document.activeElement),
    true,
  );

  await review.click();
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    (await googleCalls(page, "applyGoogleWorkbookMigration")).length,
    0,
  );
  assert.equal(
    await review.evaluate((button) => button === document.activeElement),
    true,
  );

  await setGoogleState(page, googleStates.ready);
  await strip.getByText(/2 updates waiting\./).waitFor();
  await tabTo(
    page,
    strip.getByRole("button", { name: "Sync now" }),
    "Sync focus",
  );

  await setGoogleState(page, googleStates.readyWithConflicts);
  await strip
    .getByText(/2 updates waiting\. 1 conflict needs review\./)
    .waitFor();
  assert.equal(
    await strip
      .getByRole("button", { name: "Sync pending updates", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await strip.getByRole("button", { name: "Sync now", exact: true }).count(),
    0,
  );

  await setGoogleState(page, googleStates.conflict);
  await strip
    .getByText("The workbook changed. Check it before syncing.", {
      exact: true,
    })
    .waitFor();

  await setGoogleState(page, googleStates.error);
  await strip
    .getByText(
      "Your Google connection expired or is no longer valid. Reconnect to continue.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await strip.getByRole("button", { name: "Reconnect" }).count(),
    1,
  );

  const stripText = await strip.innerText();
  assert.equal(
    /oauth|metadata|fingerprint|outbox|hash/i.test(stripText),
    false,
  );
  assert.equal(stripText.includes("PRIVATE VIDEO TITLE MUST NOT LEAK"), false);
  assert.deepEqual(errors, []);
  await page.close();

  for (const recovery of [
    {
      name: "conflict",
      state: googleStates.conflict,
      text: "The workbook changed. Check it before syncing.",
    },
    {
      name: "ready",
      state: googleStates.ready,
      text: /2 updates waiting\./,
    },
    {
      name: "error",
      state: googleStates.error,
      text: "Your Google connection expired or is no longer valid. Reconnect to continue.",
    },
  ]) {
    const recoveryPage = await browser.newPage({
      viewport: { width: 800, height: 700 },
    });
    const recoveryErrors = captureErrors(recoveryPage);
    await installHost(recoveryPage, populated, {
      initial: googleStates.migrationReady,
      staleApplyOnce: true,
      inspectionQueue: [recovery.state],
    });
    await recoveryPage.goto(`http://127.0.0.1:${port}/index.html`);
    await recoveryPage.getByRole("button", { name: "Catalogue" }).click();
    await recoveryPage.getByRole("button", { name: "Review changes" }).click();
    await recoveryPage
      .getByRole("button", { name: "Yes, update the workbook" })
      .click();
    await recoveryPage.getByText(recovery.text, { exact: true }).waitFor();
    assert.equal(
      await recoveryPage
        .getByText("The workbook changed. Review the updated changes.", {
          exact: true,
        })
        .count(),
      0,
      `${recovery.name} retained the migration-ready notice`,
    );
    assert.equal(
      await recoveryPage
        .getByRole("dialog", { name: "Update Google Sheet?" })
        .isVisible(),
      false,
      `${recovery.name} retained the stale dialog`,
    );
    assert.equal(
      await recoveryPage
        .getByRole("button", { name: "Review changes" })
        .count(),
      0,
      `${recovery.name} retained the stale review action`,
    );
    assert.deepEqual(
      (await googleCalls(recoveryPage, "applyGoogleWorkbookMigration")).at(-1),
      {
        operation: "applyGoogleWorkbookMigration",
        payload: { planHash: firstPlanHash },
      },
    );
    assert.deepEqual(recoveryErrors, []);
    await recoveryPage.close();
  }
}

async function testGoogleSettings(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = captureErrors(page);
  await installHost(page, populated, { initial: googleStates.notConfigured });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Settings" }).click();
  const setup = page.locator("#googleSetup");
  assert.equal(
    await setup.getAttribute("open"),
    null,
    "Google setup starts expanded",
  );
  await setup.getByText("Google setup", { exact: true }).click();
  const input = setup.getByRole("textbox", { name: "Google client ID" });
  await input.fill("not-a-client-id");
  await setup.getByRole("button", { name: "Save setup" }).click();
  await setup
    .getByText("Enter a valid Google client ID.", { exact: true })
    .waitFor();
  assert.equal(await input.getAttribute("aria-invalid"), "true");
  assert.equal((await googleCalls(page, "saveGoogleClientId")).length, 0);

  await input.fill(`  ${googleClientId}  `);
  await setup.getByRole("button", { name: "Save setup" }).click();
  await setup.getByText("Google setup saved.", { exact: true }).waitFor();
  assert.deepEqual((await googleCalls(page, "saveGoogleClientId")).at(-1), {
    operation: "saveGoogleClientId",
    payload: { clientId: googleClientId },
  });
  assert.equal(await input.getAttribute("aria-invalid"), "false");
  assert.deepEqual(errors, []);
  await page.close();
}

async function testGoogleActionCalls(browser, port) {
  const fixtures = [
    {
      state: googleStates.disconnected,
      button: "Connect Google Sheet",
      operation: "startGoogleCatalogueConnection",
    },
    {
      state: googleStates.connecting,
      button: "Cancel",
      operation: "cancelGoogleCatalogueConnection",
    },
    {
      state: googleStates.needsInspection,
      button: "Check workbook",
      operation: "inspectGoogleWorkbook",
      options: { inspected: googleStates.migrationReady },
    },
    {
      state: googleStates.ready,
      button: "Sync now",
      operation: "syncGoogleCatalogue",
      options: { synced: googleStates.ready },
    },
    {
      state: googleStates.readyWithConflicts,
      button: "Sync pending updates",
      operation: "syncGoogleCatalogue",
      options: { synced: googleStates.readyWithConflicts },
    },
    {
      state: googleStates.ready,
      button: "Disconnect",
      operation: "disconnectGoogleCatalogue",
    },
  ];
  for (const fixture of fixtures) {
    const page = await browser.newPage({
      viewport: { width: 800, height: 700 },
    });
    const errors = captureErrors(page);
    await installHost(page, populated, {
      initial: fixture.state,
      ...(fixture.options || {}),
    });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.getByRole("button", { name: "Catalogue" }).click();
    const button = page.locator("#googleCatalogue").getByRole("button", {
      name: fixture.button,
      exact: true,
    });
    await button.click();
    await page.waitForFunction(
      (operation) =>
        __googleHostCalls.some((call) => call.operation === operation),
      fixture.operation,
    );
    assert.deepEqual((await googleCalls(page, fixture.operation)).at(-1), {
      operation: fixture.operation,
      payload: {},
    });
    assert.deepEqual(errors, [], `${fixture.operation} console errors`);
    await page.close();
  }
}

async function testGoogleErrorRecovery(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = captureErrors(page);
  await installHost(page, populated, { initial: googleStates.error });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Catalogue" }).click();

  const cases = [
    {
      code: "google-catalogue-unavailable",
      workbookName,
      message:
        "Google Sheet is unavailable. Restart OFEnhancer, then try again.",
      action: "Try again",
      operation: "getGoogleCatalogueStatus",
      disconnect: false,
    },
    {
      code: "google-client-id-not-configured",
      message: "Add your Google setup in Settings.",
      action: "Settings",
      disconnect: false,
    },
    {
      code: "google-operation-in-progress",
      workbookName,
      message: "Google Sheet is busy. Wait for the current action to finish.",
      action: "Check status",
      operation: "getGoogleCatalogueStatus",
      disconnect: false,
    },
    {
      code: "stale-migration-plan",
      message: "The workbook changed. Check it again before reviewing.",
      action: "Check workbook",
      operation: "inspectGoogleWorkbook",
      disconnect: true,
    },
    {
      code: "google-sync-unresolved",
      message:
        "OFEnhancer could not confirm the last workbook update. Check the workbook before trying again.",
      action: "Check workbook",
      operation: "inspectGoogleWorkbook",
      disconnect: true,
    },
    {
      code: "google-authorization-required",
      message:
        "Your Google connection expired or is no longer valid. Reconnect to continue.",
      action: "Reconnect",
      operation: "startGoogleCatalogueConnection",
      disconnect: true,
    },
    {
      code: "google-token-refresh-failed",
      workbookName,
      message:
        "Your Google connection expired or is no longer valid. Reconnect to continue.",
      action: "Reconnect",
      operation: "startGoogleCatalogueConnection",
      disconnect: true,
    },
    {
      code: "google-connection-failed",
      workbookName,
      message:
        "OFEnhancer could not connect to Google Sheet. Reconnect to try again.",
      action: "Reconnect",
      operation: "startGoogleCatalogueConnection",
      disconnect: false,
    },
    {
      code: "google-session-failed",
      workbookName,
      message:
        "OFEnhancer could not connect to Google Sheet. Reconnect to try again.",
      action: "Reconnect",
      operation: "startGoogleCatalogueConnection",
      disconnect: false,
    },
    {
      code: "google-connection-cancel-failed",
      workbookName,
      message:
        "OFEnhancer could not cancel the browser connection. Check its status before trying again.",
      action: "Check status",
      operation: "getGoogleCatalogueStatus",
      disconnect: true,
    },
    {
      code: "internal-error",
      workbookName,
      message:
        "OFEnhancer could not finish the Google Sheet action. Try again.",
      action: "Try again",
      operation: "getGoogleCatalogueStatus",
      disconnect: false,
    },
  ];

  for (const fixture of cases) {
    await setGoogleState(page, {
      state: "error",
      errorCode: fixture.code,
      workbookName: fixture.workbookName,
    });
    const strip = page.locator("#googleCatalogue");
    await strip.getByText(fixture.message, { exact: true }).waitFor();
    const action = strip.getByRole("button", {
      name: fixture.action,
      exact: true,
    });
    assert.equal(await action.count(), 1, fixture.code);
    assert.equal(
      await strip
        .getByRole("button", { name: "Disconnect", exact: true })
        .count(),
      fixture.disconnect ? 1 : 0,
      `${fixture.code} disconnect action`,
    );
    if (!fixture.operation) {
      await action.click();
      assert.equal(await page.locator("#googleSetup").getAttribute("open"), "");
      await page.waitForFunction(
        () =>
          document.querySelector("#googleClientId") === document.activeElement,
      );
      continue;
    }

    const before = (await googleCalls(page, fixture.operation)).length;
    await action.click();
    await page.waitForFunction(
      ({ operation, count }) =>
        __googleHostCalls.filter((call) => call.operation === operation)
          .length > count,
      { operation: fixture.operation, count: before },
    );
    assert.deepEqual((await googleCalls(page, fixture.operation)).at(-1), {
      operation: fixture.operation,
      payload: {},
    });
  }

  assert.deepEqual(errors, []);
  await page.close();
}

async function testGoogleSettingsInFlight(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = captureErrors(page);
  await installHost(page, populated, {
    initial: googleStates.notConfigured,
    operationDelayMs: 250,
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Settings" }).click();
  const setup = page.locator("#googleSetup");
  await setup.getByText("Google setup", { exact: true }).click();
  const input = setup.getByRole("textbox", { name: "Google client ID" });
  const save = setup.getByRole("button", { name: "Save setup" });
  await input.fill(googleClientId);
  await save.click();
  await page.waitForFunction(() =>
    __googleHostCalls.some((call) => call.operation === "saveGoogleClientId"),
  );
  assert.equal(
    await input.isDisabled(),
    true,
    "client ID remains editable while saving",
  );
  assert.equal(
    await input.evaluate((control) => control.readOnly),
    true,
    "client ID is not read-only while saving",
  );
  assert.equal(
    await save.isDisabled(),
    true,
    "Save remains enabled while saving",
  );

  await input.evaluate((control, value) => {
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
  }, secondGoogleClientId);
  await setup
    .getByText(
      "Google setup changed while saving. Save the current value again.",
      {
        exact: true,
      },
    )
    .waitFor();
  assert.deepEqual((await googleCalls(page, "saveGoogleClientId")).at(-1), {
    operation: "saveGoogleClientId",
    payload: { clientId: googleClientId },
  });
  assert.equal(await input.inputValue(), secondGoogleClientId);
  assert.equal(await input.isDisabled(), false);
  assert.equal(await input.evaluate((control) => control.readOnly), false);
  assert.equal(await save.isDisabled(), false);
  assert.deepEqual(errors, []);
  await page.close();
}

async function testGoogleMigration(browser, port) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors = captureErrors(page);
  await installHost(page, populated, {
    initial: googleStates.migrationReady,
    staleApplyOnce: true,
    inspectionQueue: [googleStates.refreshedMigration],
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Catalogue" }).click();
  const review = page.getByRole("button", { name: "Review changes" });
  await review.click();
  await page.evaluate(
    (next) => __setGoogleState(next),
    googleStates.refreshedMigration,
  );
  await page.getByRole("button", { name: "Yes, update the workbook" }).click();
  await page
    .getByText("The workbook changed. Review the updated changes.", {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(
    (await googleCalls(page, "applyGoogleWorkbookMigration")).at(-1),
    {
      operation: "applyGoogleWorkbookMigration",
      payload: { planHash: firstPlanHash },
    },
  );
  assert.equal((await googleCalls(page, "inspectGoogleWorkbook")).length, 1);
  assert.equal(
    await page.getByRole("button", { name: "Review changes" }).count(),
    1,
  );

  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Yes, update the workbook" }).click();
  assert.deepEqual(
    (await googleCalls(page, "applyGoogleWorkbookMigration")).at(-1),
    {
      operation: "applyGoogleWorkbookMigration",
      payload: { planHash: secondPlanHash },
    },
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function testGoogleBusyStates(browser, port) {
  const syncPage = await browser.newPage({
    viewport: { width: 800, height: 700 },
  });
  await installHost(syncPage, populated, {
    initial: googleStates.ready,
    synced: googleStates.ready,
    operationDelayMs: 200,
  });
  await syncPage.goto(`http://127.0.0.1:${port}/index.html`);
  await syncPage.getByRole("button", { name: "Catalogue" }).click();
  const sync = syncPage.getByRole("button", { name: "Sync now" });
  await sync.click();
  await syncPage.waitForFunction(() =>
    __googleHostCalls.some((call) => call.operation === "syncGoogleCatalogue"),
  );
  assert.equal(
    await sync.isDisabled(),
    true,
    "Sync remains enabled while busy",
  );
  assert.equal(await sync.getAttribute("aria-busy"), "true");
  assert.equal(
    await syncPage.locator("#googleCatalogueStatus").getAttribute("aria-busy"),
    "true",
  );
  assert.equal(
    await syncPage.getByRole("button", { name: "Disconnect" }).isDisabled(),
    true,
  );
  await syncPage.waitForFunction(
    () => !document.querySelector("#googlePrimaryAction").disabled,
  );
  await syncPage.close();

  const migrationPage = await browser.newPage({
    viewport: { width: 800, height: 700 },
  });
  await installHost(migrationPage, populated, {
    initial: googleStates.migrationReady,
    operationDelayMs: 200,
  });
  await migrationPage.goto(`http://127.0.0.1:${port}/index.html`);
  await migrationPage.getByRole("button", { name: "Catalogue" }).click();
  await migrationPage.getByRole("button", { name: "Review changes" }).click();
  const yes = migrationPage.getByRole("button", {
    name: "Yes, update the workbook",
  });
  await yes.click();
  await migrationPage.waitForFunction(() =>
    __googleHostCalls.some(
      (call) => call.operation === "applyGoogleWorkbookMigration",
    ),
  );
  assert.equal(await yes.isDisabled(), true, "Yes remains enabled while busy");
  assert.equal(await yes.getAttribute("aria-busy"), "true");
  assert.equal(
    await migrationPage.getByRole("button", { name: "No" }).isDisabled(),
    true,
  );
  await migrationPage
    .getByRole("dialog", { name: "Update Google Sheet?" })
    .waitFor({ state: "hidden" });
  await migrationPage.close();
}

async function testGooglePolling(browser, port) {
  const cases = [
    {
      name: "connecting",
      queue: [googleStates.connecting, googleStates.needsInspection],
      settledText: `${workbookName} is connected. Check it before syncing.`,
    },
    {
      name: "syncing",
      queue: [googleStates.syncing, googleStates.ready],
      settledText: /2 updates waiting\./,
    },
  ];
  for (const fixture of cases) {
    const page = await browser.newPage({
      viewport: { width: 800, height: 700 },
    });
    const errors = captureErrors(page);
    await installHost(page, populated, {
      initial: fixture.queue[0],
      statusQueue: fixture.queue,
    });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.getByRole("button", { name: "Catalogue" }).click();
    await page
      .locator("#googleCatalogue")
      .getByText(fixture.settledText)
      .waitFor({ timeout: 4000 });
    assert.equal(
      (await googleCalls(page, "getGoogleCatalogueStatus")).length,
      2,
      fixture.name,
    );
    await page.waitForTimeout(1650);
    assert.equal(
      (await googleCalls(page, "getGoogleCatalogueStatus")).length,
      2,
      `${fixture.name} did not stop`,
    );
    assert.deepEqual(errors, []);
    await page.close();
  }

  for (const stopEvent of ["navigation", "pagehide"]) {
    const page = await browser.newPage({
      viewport: { width: 800, height: 700 },
    });
    await installHost(page, populated, { initial: googleStates.connecting });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.getByRole("button", { name: "Catalogue" }).click();
    await page.getByText("Finish in your browser.", { exact: true }).waitFor();
    if (stopEvent === "navigation")
      await page.getByRole("button", { name: "Uploads" }).click();
    else await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    await page.waitForTimeout(1650);
    assert.equal(
      (await googleCalls(page, "getGoogleCatalogueStatus")).length,
      1,
      stopEvent,
    );
    await page.close();
  }

  const ready = await browser.newPage({
    viewport: { width: 800, height: 700 },
  });
  await installHost(ready, populated, { initial: googleStates.ready });
  await ready.goto(`http://127.0.0.1:${port}/index.html`);
  await ready.getByRole("button", { name: "Catalogue" }).click();
  await ready.getByText(/2 updates waiting\./).waitFor();
  await ready.waitForTimeout(1650);
  assert.equal(
    (await googleCalls(ready, "getGoogleCatalogueStatus")).length,
    1,
  );
  await ready.close();
}

async function testGoogleResponsive(browser, port) {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "compact", width: 800, height: 700 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = captureErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installHost(page, populated, { initial: googleStates.ready });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.getByRole("button", { name: "Catalogue" }).click();
    const sync = page.getByRole("button", { name: "Sync now" });
    await sync.waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `${viewport.name} Google strip overflows`,
    );
    await tabTo(page, sync, `${viewport.name} Sync focus`);
    assert.equal(
      await sync.evaluate(
        (button) => getComputedStyle(button).transitionDuration,
      ),
      "0s",
      `${viewport.name} reduced motion`,
    );
    assert.deepEqual(errors, [], `${viewport.name} Google console errors`);
    await page.close();
  }
}

async function testGoogleMobileDialogAndSettings(browser, port) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = captureErrors(page);
  await installHost(page, populated, {
    initial: googleStates.migrationReady,
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Catalogue" }).click();
  const review = page.getByRole("button", { name: "Review changes" });
  await review.click();

  const no = page.getByRole("button", { name: "No", exact: true });
  const yes = page.getByRole("button", {
    name: "Yes, update the workbook",
  });
  const noBox = await no.boundingBox();
  const yesBox = await yes.boundingBox();
  assert.ok(
    noBox.y < yesBox.y,
    "mobile dialog visual order differs from DOM order",
  );
  assert.equal(
    await no.evaluate((button) => button === document.activeElement),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await yes.evaluate((button) => button === document.activeElement),
    true,
    "mobile dialog Tab order differs from visual order",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "Update Google Sheet?" })
    .waitFor({ state: "hidden" });
  assert.equal(
    await review.evaluate((button) => button === document.activeElement),
    true,
  );

  await setGoogleState(page, googleStates.notConfigured);
  await page
    .locator("#googleCatalogue")
    .getByRole("button", { name: "Settings" })
    .click();
  await page.waitForFunction(
    () => document.querySelector("#googleClientId") === document.activeElement,
  );
  const setup = page.locator("#googleSetup");
  assert.equal(await setup.getAttribute("open"), "");
  await setup
    .getByRole("textbox", { name: "Google client ID" })
    .fill(googleClientId);
  await setup.getByRole("button", { name: "Save setup" }).click();
  await setup.getByText("Google setup saved.", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "mobile Settings flow overflows",
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function main() {
  await withServer(async (port) => {
    const browser = await chromium.launch({ headless: true });
    try {
      await testGoogleStates(browser, port);
      await testGoogleSettings(browser, port);
      await testGoogleSettingsInFlight(browser, port);
      await testGoogleActionCalls(browser, port);
      await testGoogleErrorRecovery(browser, port);
      await testGoogleMigration(browser, port);
      await testGoogleBusyStates(browser, port);
      await testGooglePolling(browser, port);
      await testGoogleResponsive(browser, port);
      await testGoogleMobileDialogAndSettings(browser, port);

      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      const errors = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await routeThumbnails(page);
      await installHost(page);
      await page.goto(`http://127.0.0.1:${port}/index.html`);
      await page.getByRole("button", { name: "Catalogue" }).click();
      await page.getByRole("heading", { name: "No videos yet" }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Import catalogue" }).count(),
        1,
      );

      await page.locator("#catalogueFile").setInputFiles({
        name: "too-large.json",
        mimeType: "application/json",
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0x20),
      });
      await page
        .getByText("That catalogue file is too large.", { exact: true })
        .waitFor();
      assert.equal(await page.evaluate(() => __catalogueImportCalls), 0);

      await page.locator("#catalogueFile").setInputFiles({
        name: "catalogue.json",
        mimeType: "application/json",
        buffer: Buffer.from('{"version":1,"items":[]}'),
      });
      await page.getByText("Ashley episode 04", { exact: true }).waitFor();
      assert.equal(await page.getByText("X 2", { exact: true }).count(), 1);
      assert.equal(
        await page.getByText("Reddit 1", { exact: true }).count(),
        1,
      );
      assert.equal(
        await page.getByText("OnlyFans", { exact: true }).count(),
        1,
      );

      await page.getByRole("button", { name: "Needs thumbnail" }).click();
      assert.equal(await page.locator("[data-catalogue-row]").count(), 2);
      await page.getByRole("button", { name: "Scan thumbnails" }).click();
      await page
        .getByText("Thumbnail folder was not found.", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Scan thumbnails" }).click();
      await page.getByText("ashley_04_cover.png", { exact: true }).waitFor();
      const chooseVideo = page.getByRole("button", { name: "Choose video" });
      await chooseVideo.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Match thumbnail" });
      await dialog.waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Close" })
          .evaluate((button) => button === document.activeElement),
        true,
        "dialog did not focus its first control",
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await chooseVideo.evaluate(
          (button) => button === document.activeElement,
        ),
        true,
        "dialog did not restore focus to its opener",
      );
      await page.keyboard.press("Enter");
      await dialog.waitFor();
      assert.equal(
        await dialog.getByText("Ashley episode 04", { exact: true }).count(),
        1,
      );
      await page.keyboard.press("Tab");
      const firstCandidate = dialog.getByRole("button", {
        name: "Use Ashley episode 04",
      });
      assert.equal(
        await firstCandidate.evaluate(
          (button) => button === document.activeElement,
        ),
        true,
        "keyboard did not reach the first candidate",
      );
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => __catalogueConfirmCalls === 1);
      await page.getByText("Thumbnail matched.", { exact: true }).waitFor();
      assert.equal(
        await page.locator("#catalogueStatus").getAttribute("role"),
        "status",
        "match success is not announced through a status region",
      );
      await page.getByRole("button", { name: "Bound" }).click();
      assert.equal(await page.locator("[data-catalogue-row]").count(), 1);
      assert.match(
        await page.locator("[data-catalogue-row] img").getAttribute("src"),
        /^https:\/\/thumbs\.ofenhancer\.local\/[a-f0-9-]+$/,
      );

      await page
        .getByRole("searchbox", { name: "Search catalogue" })
        .fill("nothing");
      await page.getByText("No matching videos", { exact: true }).waitFor();
      assert.equal(
        (await page.locator("body").innerText()).includes("C:\\"),
        false,
      );
      assert.deepEqual(errors, []);
      await page.close();

      for (const viewport of [
        { name: "compact", width: 800, height: 700 },
        { name: "mobile", width: 390, height: 844 },
      ]) {
        const responsive = await browser.newPage({ viewport });
        const responsiveErrors = [];
        responsive.on("console", (message) => {
          if (message.type() === "error") responsiveErrors.push(message.text());
        });
        responsive.on("pageerror", (error) =>
          responsiveErrors.push(error.message),
        );
        await routeThumbnails(responsive);
        await installHost(responsive, populated);
        await responsive.goto(`http://127.0.0.1:${port}/index.html`);
        await responsive.getByRole("button", { name: "Catalogue" }).click();
        await responsive
          .getByText("Ashley episode 04", { exact: true })
          .waitFor();
        assert.equal(
          await responsive.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `${viewport.name} overflows`,
        );
        await responsive
          .getByRole("searchbox", { name: "Search catalogue" })
          .focus();
        assert.equal(
          await responsive.locator(":focus-visible").count(),
          1,
          `${viewport.name} focus`,
        );
        assert.deepEqual(
          responsiveErrors,
          [],
          `${viewport.name} console errors`,
        );
        await responsive.close();
      }
    } finally {
      await browser.close();
    }
  });
  console.log(
    "PASS: desktop catalogue works at desktop, compact, and mobile widths",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
