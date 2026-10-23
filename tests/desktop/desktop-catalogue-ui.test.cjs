"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

const appRoot = require("../support/paths.cjs").workspaceRoot;
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
    state: "conflict",
    workbookName,
    sheetName,
    pendingCount: 2,
    conflictCount: 1,
    lastVerifiedSync: "2026-09-04T12:00:00Z",
    errorCode: "google-sync-conflict",
  },
  readyWithUncertainUpdates: {
    state: "conflict",
    workbookName,
    sheetName,
    pendingCount: 1,
    attemptedCount: 1,
    unresolvedCount: 1,
    conflictCount: 0,
    lastVerifiedSync: "2026-09-04T12:00:00Z",
    errorCode: "google-sync-unresolved",
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
  syncIncomplete: {
    state: "conflict",
    workbookName,
    sheetName,
    pendingCount: 2,
    conflictCount: 0,
    lastVerifiedSync: "2026-09-04T12:00:00Z",
    errorCode: "google-sync-incomplete",
  },
  syncUnresolved: {
    state: "conflict",
    workbookName,
    sheetName,
    pendingCount: 0,
    conflictCount: 0,
    lastVerifiedSync: null,
    errorCode: "google-sync-unresolved",
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
      let migrationError = googleFixtures.migrationErrorOnce || "";
      globalThis.__catalogueImportCalls = 0;
      globalThis.__catalogueConfirmCalls = 0;
      globalThis.__googleHostCalls = [];
      globalThis.__browserHostCalls = [];
      globalThis.__workflowHostCalls = [];
      globalThis.__recoveryHostCalls = [];
      globalThis.__teaserOverviewCalls = [];
      globalThis.__setGoogleState = (next) => {
        googleStatus = structuredClone(next);
        googleStatusQueue.length = 0;
      };
      globalThis.__OFENHANCER_TEST_HOST__ = async (operation, payload) => {
        if (operation === "getStatus") {
          return {
            productVersion: "0.20.130",
            protocolVersion: 1,
            capabilities: ["desktop-shell", "chrome-readiness"],
            testData: true,
          };
        }
        if (operation === "getChromeReadiness")
          return {
            state: "not-found",
            chromeFound: false,
            message:
              "Chrome is unavailable in this synthetic Google/catalogue fixture.",
          };
        if (operation === "getCatalogue") return structuredClone(catalogue);
        if (operation === "getCreatorWorkflows") {
          globalThis.__workflowHostCalls.push({
            operation,
            payload: structuredClone(payload),
          });
          if (payload?.unboundOnly)
            return structuredClone(
              googleFixtures.unassignedPage || {
                items: [],
                totalCount: 0,
                offset: payload.offset || 0,
                limit: payload.limit || 25,
              },
            );
          return structuredClone(
            googleFixtures.workflowSnapshots?.[payload.sourceKey] || [],
          );
        }
        if (operation === "getUploadCatalogueSnapshot") {
          globalThis.__recoveryHostCalls.push({
            operation,
            payload: structuredClone(payload),
          });
          return structuredClone(
            googleFixtures.uploadCatalogueSnapshot || {
              rows: catalogue.items.map((item) => ({
                id: item.sourceKey,
                fingerprint: "f".repeat(64),
              })),
            },
          );
        }
        if (operation === "associateCreatorWorkflow") {
          globalThis.__recoveryHostCalls.push({
            operation,
            payload: structuredClone(payload),
          });
          return structuredClone(
            googleFixtures.associationResult || {
              status: "associated",
              snapshot: {},
              results: [],
              code: null,
            },
          );
        }
        if (operation === "getUploadWritebacks") {
          globalThis.__recoveryHostCalls.push({
            operation,
            payload: structuredClone(payload),
          });
          return structuredClone(googleFixtures.uploadWritebacks || []);
        }
        if (operation === "getCreatorWorkflowWritebacks") {
          globalThis.__recoveryHostCalls.push({
            operation,
            payload: structuredClone(payload),
          });
          return structuredClone(googleFixtures.workflowWritebacks || []);
        }
        if (operation === "rebaseUploadWriteback") {
          globalThis.__recoveryHostCalls.push({
            operation,
            payload: structuredClone(payload),
          });
          return { ...(googleFixtures.rebasedIntent || {}), state: "pending" };
        }
        if (operation === "retryUploadWritebacks") {
          globalThis.__recoveryHostCalls.push({
            operation,
            payload: structuredClone(payload),
          });
          googleStatus = structuredClone(
            googleFixtures.afterWritebackRetry || googleStatus,
          );
          return structuredClone(googleStatus);
        }
        if (operation === "getTeaserOverview") {
          globalThis.__teaserOverviewCalls.push({ operation });
          return structuredClone(googleFixtures.teaserOverview || {});
        }
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
        if (operation === "getBrowserOptions") {
          globalThis.__browserHostCalls.push({ operation, payload });
          return structuredClone(
            googleFixtures.browserOptions || {
              selectedId: "system",
              options: [{ id: "system", name: "System default" }],
            },
          );
        }
        if (operation === "saveBrowserPreference") {
          globalThis.__browserHostCalls.push({ operation, payload });
          if (globalThis.__failBrowserSave)
            throw new Error("browser-not-installed");
          if (globalThis.__holdBrowserSave) {
            await new Promise((resolve) => {
              globalThis.__releaseBrowserSave = resolve;
            });
          }
          return structuredClone({
            ...(googleFixtures.browserOptions || {
              selectedId: "system",
              options: [{ id: "system", name: "System default" }],
            }),
            selectedId: payload.browserId,
          });
        }
        if (
          [
            "getGoogleCatalogueStatus",
            "saveGoogleClientId",
            "saveGoogleSheetTarget",
            "importGoogleClientConfiguration",
            "importGoogleCatalogue",
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
            if (globalThis.__settingsUnreadable)
              throw new Error("invalid-settings");
            googleStatus = { state: "disconnected" };
            return structuredClone(googleStatus);
          }
          if (operation === "saveGoogleSheetTarget") {
            googleStatus = {
              ...googleStatus,
              preferredSheetUrl: payload.sheetUrl,
            };
            return structuredClone(googleStatus);
          }
          if (operation === "importGoogleClientConfiguration") {
            if (globalThis.__cancelGoogleSetupImport)
              return structuredClone(googleStatus);
            googleStatus = { state: "disconnected" };
            return structuredClone(googleStatus);
          }
          if (operation === "importGoogleCatalogue") {
            catalogue = structuredClone(populatedState);
            return {
              status: structuredClone(googleStatus),
              sheetName: "2026 Video Catalogue",
              importedItems: catalogue.items.length,
              issues: googleFixtures.importIssues || [],
            };
          }
          if (operation === "startGoogleCatalogueConnection") {
            if (googleFixtures.connectionStartError)
              throw new Error(googleFixtures.connectionStartError);
            googleStatus = { state: "connecting" };
            return structuredClone(googleStatus);
          }
          if (operation === "cancelGoogleCatalogueConnection") {
            googleStatus = { state: "disconnected" };
            return structuredClone(googleStatus);
          }
          if (operation === "inspectGoogleWorkbook") {
            if (googleFixtures.importOnInspect)
              catalogue = structuredClone(populatedState);
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
            if (migrationError) {
              const code = migrationError;
              migrationError = "";
              throw new Error(code);
            }
            if (googleFixtures.importOnApply)
              catalogue = structuredClone(populatedState);
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
    .getByText("This copy needs Google setup.", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#googleCatalogue").count(), 1);
  assert.equal(await strip.locator('[role="status"]').count(), 1);
  await tabTo(
    page,
    strip.getByRole("button", { name: "Developer setup" }),
    "Developer setup focus",
  );

  await setGoogleState(page, googleStates.disconnected);
  await strip
    .getByText("Connect the workbook you use for your catalogue.", {
      exact: true,
    })
    .waitFor();
  await tabTo(
    page,
    strip.getByRole("button", { name: "Connect Google account" }),
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
    .getByText(
      `${workbookName} is connected. Import videos without changing your sheet.`,
      {
        exact: true,
      },
    )
    .waitFor();
  await tabTo(
    page,
    strip.getByRole("button", { name: "Set up sheet sync" }),
    "Sheet sync focus",
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
  assert.equal(
    await dialog
      .getByText("5 workbook changes for publishing, assets, and history", {
        exact: true,
      })
      .count(),
    1,
  );
  assert.equal(
    await dialog
      .getByText("2 catalogue rows to OFEnhancer", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await dialog
      .getByText(
        "Existing tabs, rows, formulas, links, formatting, and distribution history",
        { exact: true },
      )
      .count(),
    1,
  );
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
      .getByRole("button", { name: "Check workbook", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await strip
      .getByRole("button", { name: "Sync pending updates", exact: true })
      .count(),
    1,
  );

  await setGoogleState(page, googleStates.readyWithUncertainUpdates);
  await strip
    .getByText("2 updates need verification. 1 update waiting.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await strip.getByText("No updates waiting.", { exact: true }).count(),
    0,
  );
  assert.equal(
    await strip
      .getByRole("button", { name: "Verify updates", exact: true })
      .count(),
    1,
  );

  await setGoogleState(page, googleStates.syncIncomplete);
  await strip
    .getByText(
      "2 updates waiting. The last sync could not reach Google Sheet. Check your connection, then sync again.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await strip
      .getByRole("button", { name: "Sync again", exact: true })
      .count(),
    1,
  );

  await setGoogleState(page, googleStates.conflict);
  await strip
    .getByText("The workbook changed. Check it before syncing.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await strip.getByRole("button", { name: "Check workbook" }).count(),
    1,
  );
  assert.equal(
    await strip
      .getByRole("button", { name: "Sync pending updates", exact: true })
      .count(),
    1,
  );

  await setGoogleState(page, googleStates.syncUnresolved);
  await strip
    .getByText(
      "OFEnhancer could not confirm the last Google Sheet update. Sync again to check it.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await strip.getByRole("button", { name: "Sync again" }).count(),
    1,
  );

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

async function testGoogleDesktopSetupImport(browser, port) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = captureErrors(page);
  await installHost(page, null, {
    initial: {
      state: "error",
      errorCode: "google-client-configuration-required",
    },
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Finish Google setup", exact: true })
    .filter({ visible: true })
    .click();
  assert.equal(await page.locator("#googleSetup").getAttribute("open"), "");
  assert.equal(
    (await googleCalls(page, "startGoogleCatalogueConnection")).length,
    0,
  );
  const setupImport = page.getByRole("button", {
    name: "Import Google setup file",
    exact: true,
  });
  await page.evaluate(() => {
    globalThis.__cancelGoogleSetupImport = true;
  });
  await setupImport.click();
  await page.waitForFunction(() =>
    __googleHostCalls.some(
      (call) => call.operation === "importGoogleClientConfiguration",
    ),
  );
  assert.equal(
    (await googleCalls(page, "startGoogleCatalogueConnection")).length,
    0,
  );
  assert.equal(await setupImport.isVisible(), true);
  await page.evaluate(() => {
    globalThis.__cancelGoogleSetupImport = false;
  });
  await setupImport.click();
  await page.getByText("Not connected", { exact: true }).waitFor();
  assert.deepEqual(
    (await googleCalls(page, "importGoogleClientConfiguration")).at(-1),
    { operation: "importGoogleClientConfiguration", payload: {} },
  );
  await setGoogleState(page, googleStates.needsInspection);
  await page.getByRole("button", { name: "Catalogue", exact: true }).click();
  await page
    .locator("#googleCatalogue")
    .getByRole("button", { name: "Import catalogue", exact: true })
    .click();
  await page.getByText("Ashley episode 04", { exact: true }).waitFor();
  await page
    .getByText(`Imported 2 videos from ${sheetName}.`, { exact: true })
    .waitFor();
  assert.equal(
    (await googleCalls(page, "applyGoogleWorkbookMigration")).length,
    0,
  );
  assert.equal((await googleCalls(page, "inspectGoogleWorkbook")).length, 0);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function testPreservedCatalogueLinks(browser, port) {
  const data = structuredClone(populated);
  data.items[0].sourceLinkCells = {
    x: {
      text: "",
      hyperlink: null,
      urls: [
        "https://x.com/example/status/123",
        "https://x.com/example/status/456",
      ],
      issueCode: null,
    },
    onlyfans: {
      text: "https://onlyfans.com/123/example",
      hyperlink: "https://onlyfans.com/456/example",
      urls: [
        "https://onlyfans.com/123/example",
        "https://onlyfans.com/456/example",
      ],
      issueCode: "conflicting-link-target",
    },
  };
  delete data.items[0].platformLinks.onlyfans;
  for (const width of [1440, 800, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    const errors = captureErrors(page);
    await installHost(page, data, { initial: googleStates.needsInspection });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.getByRole("button", { name: "Catalogue", exact: true }).click();
    const row = page.locator("[data-catalogue-row]").first();
    await row.getByText("X · 2 saved links", { exact: true }).click();
    await row
      .getByText("https://x.com/example/status/456", { exact: true })
      .waitFor();
    await row
      .getByText("OnlyFans link needs review · sheet row 42", { exact: true })
      .click();
    await row
      .getByText("Displayed: https://onlyfans.com/123/example", { exact: true })
      .waitFor();
    await row
      .getByText("Clickable destination: https://onlyfans.com/456/example", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
}

async function testGoogleSettings(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = captureErrors(page);
  await installHost(page, populated, { initial: googleStates.notConfigured });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Settings" }).click();
  const setup = page.locator("#googleSetup");
  assert.equal(await setup.isVisible(), true, "developer setup is unavailable");
  assert.equal(
    await setup.getAttribute("open"),
    null,
    "developer setup starts expanded",
  );
  await setup.getByText("Developer setup", { exact: true }).click();
  const input = setup.getByRole("textbox", { name: "Google client ID" });
  await input.fill("not-a-client-id");
  await setup.getByRole("button", { name: "Save setup" }).click();
  await setup
    .getByText("Enter a valid Google client ID.", { exact: true })
    .waitFor();
  assert.equal(await input.getAttribute("aria-invalid"), "true");
  assert.equal((await googleCalls(page, "saveGoogleClientId")).length, 0);

  await page.evaluate(() => {
    globalThis.__settingsUnreadable = true;
  });
  await input.fill(googleClientId);
  await setup.getByRole("button", { name: "Save setup" }).click();
  await setup
    .getByText(
      "OFEnhancer couldn't read its saved settings, so this change wasn't saved. The settings file was left as it is. (invalid-settings)",
      { exact: true },
    )
    .waitFor();
  await page.evaluate(() => {
    globalThis.__settingsUnreadable = false;
  });

  await input.fill(`  ${googleClientId}  `);
  await setup.getByRole("button", { name: "Save setup" }).click();
  await page.getByText("Not connected", { exact: true }).waitFor();
  assert.equal(await setup.isVisible(), true);
  assert.equal(await setup.getAttribute("open"), null);
  assert.deepEqual((await googleCalls(page, "saveGoogleClientId")).at(-1), {
    operation: "saveGoogleClientId",
    payload: { clientId: googleClientId },
  });
  assert.equal(
    await page.locator("#googleClientId").getAttribute("aria-invalid"),
    "false",
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function testGoogleEndUserSettings(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 760 } });
  const errors = captureErrors(page);
  await installHost(page, populated, { initial: googleStates.disconnected });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const settings = page.locator('[data-panel="settings"]');
  await settings
    .getByRole("heading", { name: "Google account", exact: true })
    .waitFor();
  assert.equal(
    await settings
      .getByRole("button", { name: "Connect Google account", exact: true })
      .count(),
    1,
  );
  await settings.getByText("Not connected", { exact: true }).waitFor();

  const sheetUrl = settings.getByRole("textbox", {
    name: "Google Sheet URL",
    exact: true,
  });
  assert.equal(
    await sheetUrl.getAttribute("placeholder"),
    "https://docs.google.com/spreadsheets/d/…",
  );
  assert.equal(
    await settings
      .getByText(
        "This is the destination spreadsheet, not a password or credential. Your catalogue can be on any worksheet, not only the first tab.",
        { exact: true },
      )
      .count(),
    1,
  );

  const developerSetup = settings.locator("#googleSetup");
  assert.equal(await developerSetup.isVisible(), true);
  assert.equal(await developerSetup.getAttribute("open"), null);
  assert.equal(
    await developerSetup
      .getByRole("textbox", { name: "Google client ID" })
      .isVisible(),
    false,
  );
  await developerSetup.getByText("Developer setup", { exact: true }).click();
  await developerSetup
    .getByText(
      "Import the Google Desktop client setup file once on this PC. OFEnhancer encrypts it locally and preserves it during updates.",
      { exact: true },
    )
    .waitFor();

  await sheetUrl.fill("https://docs.google.com/document/d/not-a-sheet/edit");
  await settings
    .getByRole("button", { name: "Use this sheet", exact: true })
    .click();
  await settings
    .getByText(
      "Paste a Google Sheets URL like https://docs.google.com/spreadsheets/d/…",
      { exact: true },
    )
    .waitFor();
  assert.equal(await sheetUrl.getAttribute("aria-invalid"), "true");
  assert.equal(
    (await googleCalls(page, "startGoogleCatalogueConnection")).length,
    0,
  );

  await sheetUrl.fill(
    " https://docs.google.com/spreadsheets/d/workbook-123/edit?usp=sharing#gid=2126708696 ",
  );
  await settings
    .getByRole("button", { name: "Use this sheet", exact: true })
    .click();
  await page.waitForFunction(() =>
    __googleHostCalls.some(
      (call) => call.operation === "startGoogleCatalogueConnection",
    ),
  );
  assert.deepEqual(
    (await googleCalls(page, "startGoogleCatalogueConnection")).at(-1),
    {
      operation: "startGoogleCatalogueConnection",
      payload: {
        sheetUrl:
          "https://docs.google.com/spreadsheets/d/workbook-123/edit#gid=2126708696",
      },
    },
  );
  assert.equal(await sheetUrl.getAttribute("aria-invalid"), "false");

  await settings
    .getByText("Waiting for Google authorization…", { exact: true })
    .waitFor();
  await page.evaluate(
    (next) => __setGoogleState(next),
    googleStates.needsInspection,
  );
  await page.getByRole("button", { name: "Uploads", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings
    .getByText(`Connected to Google · ${workbookName}`, { exact: true })
    .waitFor();
  await page.evaluate((next) => __setGoogleState(next), googleStates.error);
  await page.getByRole("button", { name: "Uploads", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings
    .getByText("Authorization failed or expired", { exact: true })
    .waitFor();
  assert.equal(
    await settings.getByRole("button", { name: "Reconnect" }).count(),
    1,
  );
  await page.evaluate((next) => __setGoogleState(next), {
    state: "error",
    errorCode: "authorization_timed_out",
  });
  await page.getByRole("button", { name: "Uploads", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings
    .getByText(
      "Google sign-in timed out. Use a new browser tab to reconnect.",
      {
        exact: true,
      },
    )
    .waitFor();
  // The controller sends the hyphenated form of the same code.
  await page.evaluate((next) => __setGoogleState(next), {
    state: "error",
    errorCode: "authorization-timed-out",
  });
  await page.getByRole("button", { name: "Uploads", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings
    .getByText(
      "Google sign-in timed out. Use a new browser tab to reconnect.",
      {
        exact: true,
      },
    )
    .waitFor();
  assert.equal(
    await settings.getByRole("button", { name: "Reconnect" }).count(),
    1,
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function testGoogleSettingsConnection(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = captureErrors(page);
  await installHost(page, populated, { initial: googleStates.disconnected });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.locator('[data-panel="settings"]');
  await settings.getByText("Not connected", { exact: true }).waitFor();
  assert.equal(
    await settings
      .getByRole("button", { name: "Connect Google account" })
      .count(),
    1,
  );
  assert.equal(
    await page.locator("#googleSetup").isVisible(),
    true,
    "collapsed developer setup is unavailable",
  );
  assert.equal(await page.locator("#googleSetup").getAttribute("open"), null);
  await settings
    .getByRole("button", { name: "Connect Google account" })
    .click();
  await page.waitForFunction(() =>
    __googleHostCalls.some(
      (call) => call.operation === "startGoogleCatalogueConnection",
    ),
  );
  assert.deepEqual(
    (await googleCalls(page, "startGoogleCatalogueConnection")).at(-1),
    { operation: "startGoogleCatalogueConnection", payload: {} },
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function testBrowserSelection(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = captureErrors(page);
  await installHost(page, populated, {
    initial: googleStates.disconnected,
    browserOptions: {
      selectedId: "firefox",
      options: [
        { id: "system", name: "System default" },
        { id: "chrome", name: "Google Chrome" },
        { id: "firefox", name: "Mozilla Firefox" },
      ],
    },
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Settings" }).click();

  const browserSelect = page.locator("#browserPreference");
  await browserSelect.waitFor();
  assert.equal(await browserSelect.inputValue(), "firefox");
  assert.deepEqual(await browserSelect.locator("option").allTextContents(), [
    "System default",
    "Google Chrome",
    "Mozilla Firefox",
  ]);

  await browserSelect.selectOption("chrome");
  await page.getByText("Browser choice saved.", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    __browserHostCalls.some(
      (call) => call.operation === "saveBrowserPreference",
    ),
  );
  assert.deepEqual(await page.evaluate(() => __browserHostCalls.at(-1)), {
    operation: "saveBrowserPreference",
    payload: { browserId: "chrome" },
  });
  assert.deepEqual(errors, []);
  await page.close();
}

async function testConnectBrowserDialog(browser, port) {
  for (const width of [1440, 800, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    const errors = captureErrors(page);
    await installHost(page, null, {
      initial: googleStates.disconnected,
      browserOptions: {
        selectedId: "firefox",
        options: [
          { id: "system", name: "System default" },
          { id: "chrome", name: "Google Chrome" },
          { id: "firefox", name: "Mozilla Firefox" },
        ],
      },
    });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page
      .getByRole("button", {
        name: width === 800 ? "Settings" : "Catalogue",
        exact: true,
      })
      .click();
    const connect = page
      .getByRole("button", { name: "Connect Google account", exact: true })
      .filter({ visible: true });
    await connect.click();
    const dialog = page.getByRole("dialog", {
      name: "Connect Google account",
    });
    await dialog.waitFor({ timeout: 3000 });
    assert.equal(
      (await googleCalls(page, "startGoogleCatalogueConnection")).length,
      0,
    );
    assert.equal(
      await dialog.getByLabel("Browser", { exact: true }).inputValue(),
      "firefox",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await connect.evaluate((el) => el === document.activeElement),
      true,
    );
    assert.equal(
      (await googleCalls(page, "startGoogleCatalogueConnection")).length,
      0,
    );
    await connect.click();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(
      (await googleCalls(page, "startGoogleCatalogueConnection")).length,
      0,
    );
    await connect.click();
    await dialog.getByLabel("Browser", { exact: true }).selectOption("system");
    await page.evaluate(() => {
      globalThis.__failBrowserSave = true;
    });
    await dialog.getByRole("button", { name: "Continue in browser" }).click();
    await dialog
      .getByText(
        "Could not save that browser choice. Choose another browser or try again.",
      )
      .waitFor();
    assert.equal(
      (await googleCalls(page, "startGoogleCatalogueConnection")).length,
      0,
    );
    await page.evaluate(() => {
      globalThis.__failBrowserSave = false;
    });
    if (width === 1440) {
      await page.evaluate(() => {
        globalThis.__holdBrowserSave = true;
      });
      await dialog.getByRole("button", { name: "Continue in browser" }).click();
      await page.waitForFunction(
        () => typeof __releaseBrowserSave === "function",
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await connect.click();
      await dialog.waitFor();
      await page.evaluate(async () => {
        globalThis.__holdBrowserSave = false;
        globalThis.__releaseBrowserSave();
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      });
      assert.equal(
        await dialog.isVisible(),
        true,
        "cancelled save closed a newer chooser",
      );
      assert.equal(
        (await googleCalls(page, "startGoogleCatalogueConnection")).length,
        0,
      );
      await dialog
        .getByLabel("Browser", { exact: true })
        .selectOption("system");
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await dialog.getByRole("button", { name: "Continue in browser" }).click();
    await page.waitForFunction(() =>
      __googleHostCalls.some(
        (call) => call.operation === "startGoogleCatalogueConnection",
      ),
    );
    assert.equal(
      (await googleCalls(page, "startGoogleCatalogueConnection")).length,
      1,
    );
    assert.deepEqual(await page.evaluate(() => __browserHostCalls.at(-1)), {
      operation: "saveBrowserPreference",
      payload: { browserId: "system" },
    });
    assert.equal(await dialog.isVisible(), false);
    assert.deepEqual(errors, []);
    await page.close();
  }
}

async function testConnectBrowserFailureStaysInChooser(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = captureErrors(page);
  await installHost(page, null, {
    initial: googleStates.disconnected,
    connectionStartError: "browser-launch-failed",
    browserOptions: {
      selectedId: "firefox",
      options: [
        { id: "system", name: "System default" },
        { id: "chrome", name: "Google Chrome" },
        { id: "firefox", name: "Mozilla Firefox" },
      ],
    },
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect Google account", exact: true })
    .filter({ visible: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Connect Google account" });
  await dialog.getByLabel("Browser", { exact: true }).selectOption("firefox");
  await dialog.getByRole("button", { name: "Continue in browser" }).click();

  await dialog
    .getByText(
      "Mozilla Firefox could not open. Choose another browser or try again.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(
    (await googleCalls(page, "startGoogleCatalogueConnection")).length,
    1,
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function testCancelledBrowserSaveDoesNotStartConnection(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  await installHost(page, null, {
    initial: googleStates.disconnected,
    browserOptions: {
      selectedId: "firefox",
      options: [
        { id: "system", name: "System default" },
        { id: "chrome", name: "Google Chrome" },
        { id: "firefox", name: "Mozilla Firefox" },
      ],
    },
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect Google account", exact: true })
    .filter({ visible: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Connect Google account" });
  await page.evaluate(() => {
    globalThis.__holdBrowserSave = true;
  });
  await dialog.getByRole("button", { name: "Continue in browser" }).click();
  await page.waitForFunction(() => typeof __releaseBrowserSave === "function");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    globalThis.__holdBrowserSave = false;
    globalThis.__releaseBrowserSave();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });

  assert.equal(
    (await googleCalls(page, "startGoogleCatalogueConnection")).length,
    0,
  );
  await page.close();
}

async function testGoogleImportRefresh(browser, port) {
  for (const action of ["inspect", "apply"]) {
    const page = await browser.newPage();
    await installHost(page, null, {
      initial:
        action === "inspect"
          ? googleStates.needsInspection
          : googleStates.migrationReady,
      inspected: googleStates.ready,
      applied: googleStates.ready,
      importOnInspect: action === "inspect",
      importOnApply: action === "apply",
    });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.getByRole("button", { name: "Catalogue", exact: true }).click();
    await page.getByRole("heading", { name: "Start your catalogue" }).waitFor();
    if (action === "inspect") {
      await page
        .getByRole("button", { name: "Set up sheet sync", exact: true })
        .click();
    } else {
      await page
        .getByRole("button", { name: "Review changes", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Yes, update the workbook" })
        .click();
    }
    await page
      .getByText("Ashley episode 04", { exact: true })
      .waitFor({ timeout: 3000 });
    assert.equal(await page.locator("[data-catalogue-row]").count(), 2);
    await page.close();
  }
}

async function testGoogleActionCalls(browser, port) {
  const fixtures = [
    {
      state: googleStates.disconnected,
      button: "Connect Google account",
      operation: "startGoogleCatalogueConnection",
    },
    {
      state: googleStates.connecting,
      button: "Cancel",
      operation: "cancelGoogleCatalogueConnection",
    },
    {
      state: googleStates.needsInspection,
      button: "Set up sheet sync",
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
      button: "Check workbook",
      operation: "inspectGoogleWorkbook",
      options: { inspected: googleStates.readyWithConflicts },
    },
    {
      state: googleStates.readyWithConflicts,
      button: "Sync pending updates",
      operation: "syncGoogleCatalogue",
      options: { synced: googleStates.readyWithConflicts },
    },
    {
      state: googleStates.readyWithUncertainUpdates,
      button: "Verify updates",
      operation: "syncGoogleCatalogue",
      options: { synced: googleStates.ready },
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
      code: "workbook-profile-not-found",
      workbookName,
      message:
        "This workbook does not match the optional sheet-sync layout. You can still import its catalogue without changing the sheet.",
      action: "Import catalogue",
      operation: "importGoogleCatalogue",
      disconnect: true,
    },
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
      message: "This copy needs Google setup.",
      action: "Developer setup",
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
        "OFEnhancer could not confirm the last Google Sheet update. Sync again to check it.",
      action: "Sync again",
      operation: "syncGoogleCatalogue",
      disconnect: true,
    },
    {
      code: "google-sync-incomplete",
      message:
        "The last sync could not reach Google Sheet. Check your connection, then sync again.",
      action: "Sync again",
      operation: "syncGoogleCatalogue",
      disconnect: true,
    },
    {
      code: "google-client-secret-rejected",
      message:
        "Google rejected the saved OAuth client secret. Import a current Desktop client setup file; an older downloaded JSON may contain a disabled secret.",
      action: "Import current setup",
      focus: "#importGoogleSetup",
      disconnect: false,
    },
    {
      code: "authorization_timed_out",
      message:
        "Google sign-in took longer than 20 minutes. The local callback closed; start a new connection and use its newest browser tab.",
      action: "Reconnect",
      operation: "startGoogleCatalogueConnection",
      disconnect: false,
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
      code: "token-exchange-failed",
      message:
        "Google didn't accept the sign-in. Check that the imported Google setup file is the right one, then reconnect. (token-exchange-failed)",
      action: "Reconnect",
      operation: "startGoogleCatalogueConnection",
      disconnect: false,
    },
    {
      code: "token-exchange-unreachable",
      message:
        "Google sign-in couldn't reach Google to finish. Check your internet connection, then reconnect. (token-exchange-unreachable)",
      action: "Reconnect",
      operation: "startGoogleCatalogueConnection",
      disconnect: false,
    },
    {
      code: "authorization-timed-out",
      message:
        "Google sign-in took longer than 20 minutes. The local callback closed; start a new connection and use its newest browser tab.",
      action: "Reconnect",
      operation: "startGoogleCatalogueConnection",
      disconnect: false,
    },
    {
      code: "invalid-settings",
      message:
        "OFEnhancer couldn't read its saved settings, so this change wasn't saved. The settings file was left as it is. (invalid-settings)",
      action: "Check status",
      operation: "getGoogleCatalogueStatus",
      disconnect: false,
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
        (focus) => document.querySelector(focus) === document.activeElement,
        fixture.focus || "#googleClientId",
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
  await setup.getByText("Developer setup", { exact: true }).click();
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

async function testGoogleMigrationFailure(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = captureErrors(page);
  await installHost(page, populated, {
    initial: googleStates.migrationReady,
    migrationErrorOnce: "google-migration-unresolved",
    inspected: googleStates.refreshedMigration,
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Catalogue" }).click();
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Yes, update the workbook" }).click();

  const strip = page.locator("#googleCatalogue");
  await strip
    .getByText(
      "OFEnhancer could not confirm the workbook update. Check the workbook before trying again.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("dialog", { name: "Update Google Sheet?" })
      .isVisible(),
    false,
    "migration failure retained the stale dialog",
  );
  assert.equal(
    await page.getByRole("button", { name: "Review changes" }).count(),
    0,
    "migration failure retained the stale review action",
  );
  assert.deepEqual(
    (await googleCalls(page, "applyGoogleWorkbookMigration")).at(-1),
    {
      operation: "applyGoogleWorkbookMigration",
      payload: { planHash: firstPlanHash },
    },
  );

  await strip.getByRole("button", { name: "Check workbook" }).click();
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Yes, update the workbook" }).click();
  assert.deepEqual(
    (await googleCalls(page, "applyGoogleWorkbookMigration")).at(-1),
    {
      operation: "applyGoogleWorkbookMigration",
      payload: { planHash: secondPlanHash },
    },
    "migration failure reused the stale plan hash",
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
      settledText: `${workbookName} is connected. Import videos without changing your sheet.`,
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
    await page
      .locator("#googleCatalogue")
      .getByText("Finish in your browser.", { exact: true })
      .waitFor();
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
    const firstRow = await page
      .locator("[data-catalogue-row]")
      .first()
      .boundingBox();
    assert.ok(
      firstRow.y < viewport.height,
      `${viewport.name} catalogue content starts below the first viewport`,
    );
    for (const control of await page.locator("nav button").all()) {
      const box = await control.boundingBox();
      assert.ok(
        box.height >= 44,
        `${viewport.name} navigation target is too small`,
      );
    }
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

async function testCatalogueResultAnnouncements(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = captureErrors(page);
  await installHost(page, populated, { initial: googleStates.conflict });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Catalogue" }).click();

  const googleStatus = page.locator("#googleCatalogueStatus");
  const catalogueStatus = page.locator("#catalogueStatus");
  await googleStatus
    .getByText("The workbook changed. Check it before syncing.", {
      exact: true,
    })
    .waitFor();

  await page
    .getByRole("searchbox", { name: "Search catalogue" })
    .fill("episode 04");
  await catalogueStatus.getByText("1 video shown.", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Bound" }).click();
  await catalogueStatus.getByText("0 videos shown.", { exact: true }).waitFor();
  assert.equal(
    await googleStatus.textContent(),
    "The workbook changed. Check it before syncing.",
    "catalogue result announcement overwrote Google recovery status",
  );
  assert.deepEqual(errors, []);
  await page.close();
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
    .getByRole("button", { name: "Developer setup" })
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
  await page.getByText("Not connected", { exact: true }).waitFor();
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

async function testCatalogueLoadingRecovery(browser, port) {
  const page = await browser.newPage();
  await installHost(page);
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.evaluate(() => {
    const original = globalThis.__OFENHANCER_TEST_HOST__;
    let first = true;
    globalThis.__OFENHANCER_TEST_HOST__ = (operation, payload) => {
      if (operation === "getCatalogue" && first) {
        first = false;
        return new Promise((_resolve, reject) => {
          globalThis.__rejectCatalogue = reject;
        });
      }
      return original(operation, payload);
    };
  });
  await page.getByRole("button", { name: "Catalogue", exact: true }).click();
  await page.locator("#catalogueLoading").waitFor();
  assert.equal(await page.locator("#catalogueEmpty").isVisible(), false);
  await page.evaluate(() =>
    __rejectCatalogue(new Error("transient-fixture-failure")),
  );
  await page
    .getByRole("heading", { name: "Catalogue could not load" })
    .waitFor();
  assert.equal(await page.locator("#catalogueEmpty").isVisible(), false);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("heading", { name: "Start your catalogue" }).waitFor();
  assert.equal(await page.locator("#importCatalogue").isEnabled(), true);
  for (const selector of [
    "#catalogueSummary",
    "#catalogueSearch",
    ".filter-group",
    "#scanThumbnails",
    "#thumbnailReview",
  ])
    assert.equal(await page.locator(selector).isVisible(), false, selector);
  await page.close();
}

async function testCatalogueWorkflowAndPromotionDetails(browser, port) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const errors = captureErrors(page);
  const catalogue = clone(populated);
  catalogue.items[0].scriptStatus = "partial";
  catalogue.items[1].platformLinks.script =
    "https://script.example.test/episode-05";
  const snapshots = {
    "ashley-04": [
      {
        runId: "run-a",
        kind: "upload",
        revision: 2,
        sourceKey: "ashley-04",
        targets: [
          {
            platform: "onlyfans",
            status: "partial",
            postUrl: "https://onlyfans.com/123/johnny_guides",
            error: null,
            submitted: true,
            googleError: "sync-pending",
          },
          {
            platform: "reddit",
            status: "partial",
            postUrl:
              "https://www.reddit.com/r/first_community/comments/abc123/posted",
            postUrls: [
              "https://www.reddit.com/r/first_community/comments/abc123/posted",
              "https://www.reddit.com/r/second_community/comments/def456/posted",
            ],
            submitted: true,
          },
        ],
        assets: [
          {
            role: "video",
            name: "episode-04.mp4",
            size: 2097152,
            lastModified: "2026-09-01T12:00:00Z",
            sha256: "a".repeat(64),
          },
        ],
        script: {
          status: "partial",
          writebackState: "pending",
          filename: "episode-04.funscript",
          sha256: "b".repeat(64),
          links: [],
          sentKeys: [],
          error: "link-missing",
        },
        reply: {
          paidUrl: "https://onlyfans.com/123/johnny_guides",
          autoReply: true,
          replyDelayMinutes: 15,
          wordingTemplate: "New clip: {{link}}",
          mainStatusUrl: "https://x.com/owner/status/1001",
          replyStatusUrl: null,
          dueAt: "2026-09-12T12:15:00Z",
          attempted: false,
        },
        clip: {
          clipId: "clip-1",
          sha256: "c".repeat(64),
          episodeKey: "ashley-04",
        },
      },
    ],
    "ashley-05": [],
  };
  const overview = {
    episodes: [
      {
        itemId: catalogue.items[0].itemId,
        sourceKey: "ashley-04",
        incomingOwnerTeasers: [],
      },
      {
        itemId: catalogue.items[1].itemId,
        sourceKey: "ashley-05",
        incomingOwnerTeasers: [
          {
            statusId: "1001",
            postedUtc: "2026-09-12T12:00:00Z",
            sourceItemId: catalogue.items[0].itemId,
            sourceKey: "ashley-04",
            sourceTitle: "Ashley episode 04",
            replyStatusId: "1002",
            replyLink: "https://onlyfans.com/456/johnny_guides",
            replyLinkKind: "onlyfans",
          },
          {
            statusId: "1003",
            postedUtc: "2026-09-13T12:00:00Z",
            sourceItemId: null,
            sourceKey: null,
            sourceTitle: null,
            replyStatusId: "1004",
            replyLink: "https://onlyfans.com/456/johnny_guides",
            replyLinkKind: "onlyfans",
          },
        ],
      },
    ],
    posts: [
      {
        statusId: "1001",
        itemId: catalogue.items[0].itemId,
        sourceKey: "ashley-04",
        firstReply: {
          statusId: "1002",
          link: "https://onlyfans.com/456/johnny_guides",
          kind: "onlyfans",
          promotedItemId: catalogue.items[1].itemId,
          promotedSourceKey: "ashley-05",
          promotedTitle: "Ashley episode 05",
        },
      },
    ],
  };
  await installHost(page, catalogue, {
    workflowSnapshots: snapshots,
    teaserOverview: overview,
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Catalogue" }).click();
  await page.getByText("Ashley episode 04", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Script partial", { exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByText("Script uploaded", { exact: true }).count(),
    1,
  );
  assert.deepEqual(
    await page.evaluate(() =>
      __workflowHostCalls.filter((call) => call.payload.sourceKey),
    ),
    [],
  );
  assert.deepEqual(await page.evaluate(() => __teaserOverviewCalls), []);

  const firstRow = page.locator(
    '[data-catalogue-row][data-source-key="ashley-04"]',
  );
  const secondRow = page.locator(
    '[data-catalogue-row][data-source-key="ashley-05"]',
  );
  await firstRow.locator(".catalogue-workflow-details summary").click();
  await firstRow.getByText("Google: sync-pending", { exact: true }).waitFor();
  await firstRow.getByText("Script: partial", { exact: true }).waitFor();
  await firstRow
    .getByText("Catalogue link: pending", { exact: true })
    .waitFor();
  await firstRow
    .getByText(
      "Reply destination: https://onlyfans.com/123/johnny_guides · 15 min delay",
    )
    .waitFor();
  for (const url of [
    "https://www.reddit.com/r/first_community/comments/abc123/posted",
    "https://www.reddit.com/r/second_community/comments/def456/posted",
  ])
    await firstRow.locator(`a[href="${url}"]`).waitFor();
  await firstRow.getByText("Own source posts", { exact: true }).waitFor();
  await firstRow
    .getByText("Ashley episode 05", { exact: true })
    .last()
    .waitFor();
  assert.deepEqual(
    await page.evaluate(() =>
      __workflowHostCalls
        .filter((call) => call.payload.sourceKey)
        .map((call) => call.payload.sourceKey),
    ),
    ["ashley-04"],
  );
  assert.equal(await page.evaluate(() => __teaserOverviewCalls.length), 1);

  await secondRow.locator(".catalogue-workflow-details summary").click();
  await secondRow
    .getByText("source not identified", { exact: false })
    .waitFor();
  await secondRow.getByText("Incoming promotions", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => __teaserOverviewCalls.length), 1);
  assert.deepEqual(
    await page.evaluate(() =>
      __workflowHostCalls
        .filter((call) => call.payload.sourceKey)
        .map((call) => call.payload.sourceKey),
    ),
    ["ashley-04", "ashley-05"],
  );

  const screenshotDir = process.env.OFENHANCER_TEASER_SCREENSHOTS;
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "catalogue-workflow-desktop.png"),
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  await page.close();

  if (screenshotDir) {
    const compact = await browser.newPage({
      viewport: { width: 800, height: 900 },
    });
    await installHost(compact, catalogue, {
      workflowSnapshots: snapshots,
      teaserOverview: overview,
    });
    await compact.goto(`http://127.0.0.1:${port}/index.html`);
    await compact.getByRole("button", { name: "Catalogue" }).click();
    const row = compact.locator(
      '[data-catalogue-row][data-source-key="ashley-05"]',
    );
    await row.locator(".catalogue-workflow-details summary").click();
    await row.getByText("Incoming promotions", { exact: true }).waitFor();
    assert.equal(
      await compact.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "compact workflow details overflow",
    );
    await compact.screenshot({
      path: path.join(screenshotDir, "catalogue-workflow-compact.png"),
      fullPage: true,
    });
    await compact.close();
  }
}

async function testGoogleUploadWritebackCounts(browser, port) {
  const page = await browser.newPage();
  const state = {
    ...googleStates.ready,
    uploadWritebackPendingCount: 2,
    uploadWritebackConflictCount: 1,
    uploadWritebackAttemptedCount: 3,
    uploadWritebackUnresolvedCount: 4,
  };
  await installHost(page, populated, { initial: state });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Catalogue" }).click();
  await page
    .getByText(
      "Upload links: 2 pending · 1 conflict · 3 attempted · 4 unresolved.",
    )
    .waitFor();
  await page.close();
}

async function testCatalogueRecoveryControls(browser, port) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = captureErrors(page);
  const pendingRun = {
    runId: "upload-run-20261023",
    kind: "upload",
    revision: 2,
    sourceKey: null,
    targets: [
      {
        platform: "onlyfans",
        status: "uploaded",
        postUrl: "https://onlyfans.com/123/johnny_guides",
        submitted: true,
      },
      {
        platform: "reddit",
        status: "partial",
        postUrl:
          "https://www.reddit.com/r/first_community/comments/abc123/posted",
        postUrls: [
          "https://www.reddit.com/r/first_community/comments/abc123/posted",
          "https://www.reddit.com/r/second_community/comments/def456/posted",
        ],
        submitted: true,
      },
    ],
    assets: [],
    script: {
      status: "uploaded",
      writebackState: "not-associated",
      filename: "episode.funscript",
      links: ["https://johnnyguides.com/sync/scripts/hash.funscript"],
    },
  };
  const writebacks = [
    {
      intent: {
        key: "metadata-conflict-key",
        sourceKey: "ashley-04",
        platform: "onlyfans",
        url: "https://onlyfans.com/123/johnny_guides",
        title: "Old episode title",
        description: "Old description",
        state: "conflict",
        errorCode: "catalogue-entry-changed",
      },
      currentFingerprint: "e".repeat(64),
    },
    {
      intent: {
        key: "attempted-key",
        sourceKey: "ashley-05",
        platform: "fansly",
        url: "https://fansly.com/post/1",
        title: "Ashley episode 05",
        description: "Description",
        state: "attempted",
        errorCode: "google-write-unresolved",
      },
      currentFingerprint: "d".repeat(64),
    },
    {
      intent: {
        key: "layout-conflict-key",
        sourceKey: "ashley-04",
        platform: "script",
        url: "https://johnnyguides.com/sync/scripts/episode.funscript",
        state: "conflict",
        errorCode: "catalogue-layout-changed",
      },
      currentFingerprint: "e".repeat(64),
    },
  ];
  await installHost(page, populated, {
    initial: googleStates.ready,
    unassignedPage: {
      items: [pendingRun],
      totalCount: 1,
      offset: 0,
      limit: 25,
    },
    uploadWritebacks: writebacks,
    workflowWritebacks: [
      {
        key: "workflow-attempted",
        runId: "teaser-run-04",
        revision: 3,
        sourceTitle: "Ashley episode 04",
        state: "attempted",
        errorCode: "google-write-unresolved",
        snapshot: {
          runId: "teaser-run-04",
          sourceKey: "ashley-04",
          targets: [
            {
              platform: "x",
              status: "uploaded",
              postUrl: "https://x.com/owner/status/1001",
              postUrls: [
                "https://x.com/owner/status/1001",
                "https://x.com/owner/status/1002",
              ],
            },
          ],
          reply: { paidUrl: "https://onlyfans.com/456/johnny_guides" },
        },
      },
    ],
    afterWritebackRetry: googleStates.ready,
  });
  await routeThumbnails(page);
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.getByRole("button", { name: "Catalogue" }).click();

  const unassigned = page.locator("#unassignedCreatorWorkflows");
  await unassigned.locator("summary").click();
  await unassigned
    .getByText("Unassigned uploads (1)", { exact: true })
    .waitFor();
  await unassigned
    .getByText("Script: uploaded · catalogue link: not-associated", {
      exact: true,
    })
    .waitFor();
  await unassigned
    .getByText("https://johnnyguides.com/sync/scripts/hash.funscript", {
      exact: true,
    })
    .waitFor();
  await unassigned
    .getByText(
      "https://www.reddit.com/r/first_community/comments/abc123/posted",
      {
        exact: true,
      },
    )
    .waitFor();
  await unassigned
    .getByText(
      "https://www.reddit.com/r/second_community/comments/def456/posted",
      {
        exact: true,
      },
    )
    .waitFor();
  const episode = unassigned.getByRole("combobox", {
    name: /Link Upload · upload-run/,
  });
  await episode.selectOption("ashley-04");
  await unassigned.getByRole("button", { name: "Link workflow" }).click();
  await unassigned
    .getByText(/Record this saved run on “Ashley episode 04”/)
    .waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        __recoveryHostCalls.filter(
          (call) => call.operation === "associateCreatorWorkflow",
        ).length,
    ),
    0,
    "association happened before explicit owner confirmation",
  );
  await unassigned.getByRole("button", { name: "Confirm link" }).click();
  await page.waitForFunction(() =>
    __recoveryHostCalls.some(
      (call) => call.operation === "associateCreatorWorkflow",
    ),
  );
  const association = await page.evaluate(
    () =>
      __recoveryHostCalls.find(
        (call) => call.operation === "associateCreatorWorkflow",
      ).payload,
  );
  assert.deepEqual(association, {
    runId: pendingRun.runId,
    sourceKey: "ashley-04",
    expectedFingerprint: "f".repeat(64),
    confirmSource: true,
  });

  const recovery = page.locator("#googleUploadWritebacks");
  assert.equal(
    await page.evaluate(() =>
      __recoveryHostCalls.some(
        (call) => call.operation === "getCreatorWorkflowWritebacks",
      ),
    ),
    false,
    "workflow writeback detail is not requested while its panel is collapsed",
  );
  await recovery.locator("summary").click();
  await recovery
    .getByText("Writeback recovery (uploads 3 · workflows 1)", { exact: true })
    .waitFor();
  await recovery.getByText("Workflow · attempted", { exact: true }).waitFor();
  assert.equal(
    await recovery.locator(".workflow-history-row").getByRole("button").count(),
    0,
    "attempted workflow history exposes no reset or replay action",
  );
  await recovery
    .getByText("Run teaser-run-04 · revision 3", { exact: true })
    .waitFor();
  await recovery
    .locator(".workflow-history-row")
    .getByText("Code: google-write-unresolved", { exact: true })
    .waitFor();
  await recovery
    .getByText("X: https://x.com/owner/status/1001", { exact: true })
    .waitFor();
  await recovery
    .getByText("X: https://x.com/owner/status/1002", { exact: true })
    .waitFor();
  await recovery
    .getByText("Promoted destination: https://onlyfans.com/456/johnny_guides", {
      exact: true,
    })
    .waitFor();
  await recovery
    .getByText("Sheet details: Old episode title · Old description", {
      exact: true,
    })
    .waitFor();
  await recovery
    .getByText("Current details: Ashley episode 04 · Description", {
      exact: true,
    })
    .waitFor();
  await recovery
    .getByText("Check the destination column in your sheet before retrying.", {
      exact: true,
    })
    .waitFor();
  const layoutRow = recovery.locator(".google-writeback-row").nth(3);
  await layoutRow.getByLabel("I checked the destination column").check();
  await layoutRow
    .getByRole("button", { name: "Retry after checking the sheet" })
    .click();
  await page.waitForFunction(
    () =>
      __recoveryHostCalls.filter(
        (call) => call.operation === "rebaseUploadWriteback",
      ).length === 1,
  );
  assert.deepEqual(
    await page.evaluate(
      () =>
        __recoveryHostCalls
          .filter((call) => call.operation === "rebaseUploadWriteback")
          .at(-1).payload,
    ),
    {
      key: "layout-conflict-key",
      expectedFingerprint: "e".repeat(64),
      confirmCurrentDetails: true,
    },
  );
  const screenshotDir = process.env.OFENHANCER_TEASER_SCREENSHOTS;
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "catalogue-recovery-desktop.png"),
      fullPage: true,
    });
    const compact = await browser.newPage({
      viewport: { width: 800, height: 900 },
    });
    await installHost(compact, populated, {
      initial: googleStates.ready,
      unassignedPage: {
        items: [pendingRun],
        totalCount: 1,
        offset: 0,
        limit: 25,
      },
      uploadWritebacks: writebacks,
      workflowWritebacks: [
        {
          key: "workflow-attempted",
          runId: "teaser-run-04",
          revision: 3,
          sourceTitle: "Ashley episode 04",
          state: "attempted",
          errorCode: "google-write-unresolved",
          snapshot: {
            runId: "teaser-run-04",
            sourceKey: "ashley-04",
            targets: [
              {
                platform: "x",
                status: "uploaded",
                postUrl: "https://x.com/owner/status/1001",
                postUrls: [
                  "https://x.com/owner/status/1001",
                  "https://x.com/owner/status/1002",
                ],
              },
            ],
            reply: { paidUrl: "https://onlyfans.com/456/johnny_guides" },
          },
        },
      ],
      afterWritebackRetry: googleStates.ready,
    });
    await routeThumbnails(compact);
    await compact.goto(`http://127.0.0.1:${port}/index.html`);
    await compact.getByRole("button", { name: "Catalogue" }).click();
    const compactUnassigned = compact.locator("#unassignedCreatorWorkflows");
    await compactUnassigned.locator("summary").click();
    await compactUnassigned
      .getByText("Unassigned uploads (1)", { exact: true })
      .waitFor();
    const compactRecovery = compact.locator("#googleUploadWritebacks");
    await compactRecovery.locator("summary").click();
    await compactRecovery
      .getByText("Writeback recovery (uploads 3 · workflows 1)", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await compact.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await compact.screenshot({
      path: path.join(screenshotDir, "catalogue-recovery-compact.png"),
      fullPage: true,
    });
    await compact.close();
  }
  assert.equal(
    await recovery
      .getByRole("button", { name: "Use current details and retry" })
      .isDisabled(),
    true,
  );
  await recovery.getByLabel("I reviewed the current details").check();
  await recovery
    .getByRole("button", { name: "Use current details and retry" })
    .click();
  await page.waitForFunction(() =>
    __recoveryHostCalls.some(
      (call) => call.operation === "retryUploadWritebacks",
    ),
  );
  const rebase = await page.evaluate(
    () =>
      __recoveryHostCalls
        .filter((call) => call.operation === "rebaseUploadWriteback")
        .at(-1).payload,
  );
  assert.deepEqual(rebase, {
    key: "metadata-conflict-key",
    expectedFingerprint: "e".repeat(64),
    confirmCurrentDetails: true,
  });
  assert.equal(
    await recovery
      .locator(".google-writeback-row")
      .nth(2)
      .getByRole("button", { name: "Use current details and retry" })
      .count(),
    0,
    "attempted intent exposed the rebase action",
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function main() {
  await withServer(async (port) => {
    const browser = await chromium.launch({ headless: true });
    try {
      await testGoogleDesktopSetupImport(browser, port);
      await testPreservedCatalogueLinks(browser, port);
      await testGoogleImportRefresh(browser, port);
      await testConnectBrowserDialog(browser, port);
      await testConnectBrowserFailureStaysInChooser(browser, port);
      await testCancelledBrowserSaveDoesNotStartConnection(browser, port);
      await testGoogleStates(browser, port);
      await testGoogleSettings(browser, port);
      await testGoogleEndUserSettings(browser, port);
      await testGoogleSettingsConnection(browser, port);
      await testCatalogueLoadingRecovery(browser, port);
      await testBrowserSelection(browser, port);
      await testGoogleSettingsInFlight(browser, port);
      await testGoogleActionCalls(browser, port);
      await testGoogleErrorRecovery(browser, port);
      await testGoogleMigration(browser, port);
      await testGoogleMigrationFailure(browser, port);
      await testGoogleBusyStates(browser, port);
      await testGooglePolling(browser, port);
      await testGoogleResponsive(browser, port);
      await testCatalogueResultAnnouncements(browser, port);
      await testCatalogueWorkflowAndPromotionDetails(browser, port);
      await testGoogleUploadWritebackCounts(browser, port);
      await testCatalogueRecoveryControls(browser, port);
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
      await page
        .getByRole("heading", { name: "Start your catalogue" })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Import file", exact: true })
          .count(),
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
