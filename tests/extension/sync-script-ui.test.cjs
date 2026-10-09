"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
const root = require("../support/paths.cjs").personalRoot;

const script = {
  version: "1.0",
  actions: [
    { at: 0, pos: 10 },
    { at: 1500, pos: 90 },
  ],
};

// The built console against a scripted runtime: Upload prepares and starts,
// ports expose their listeners so a test can deliver platform results.
async function withConsole(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => {
      const values = {};
      globalThis.calls = [];
      globalThis.ports = [];
      globalThis.scriptReplies = [];
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
            const port = {
              listeners: [],
              onMessage: {
                addListener: (listener) => port.listeners.push(listener),
              },
              onDisconnect: { addListener() {} },
              postMessage(message) {
                if (message.type === "bind-session") {
                  port.sessionId = message.sessionId;
                  queueMicrotask(() =>
                    port.listeners.forEach((listener) =>
                      listener({
                        type: "session-bound",
                        sessionId: message.sessionId,
                        existing: true,
                      }),
                    ),
                  );
                }
              },
              disconnect() {},
            };
            ports.push(port);
            return port;
          },
          sendMessage(message, callback) {
            calls.push(message);
            if (message.type === "PREPARE_CREATOR_UPLOAD")
              return callback({
                ok: true,
                uploadSession: {
                  sessionId: message.sessionId,
                  platforms: message.targets.map((platform) => ({
                    platform,
                    status: "prepared",
                  })),
                },
              });
            if (message.type === "START_CREATOR_UPLOAD")
              return callback({ ok: true, accepted: true, results: [] });
            if (message.type === "START_NEW_CREATOR_UPLOAD")
              return callback({ ok: true, reset: true });
            if (message.type === "UPLOAD_SYNC_SCRIPT")
              return callback(
                scriptReplies.shift() || { ok: false, error: "unexpected" },
              );
            if (message.type === "LOAD_DEVELOPMENT_TEMPLATE")
              return callback({
                ok: true,
                files: [
                  ["neutral-full.mp4", "video/mp4", "1"],
                  ["neutral-teaser.mp4", "video/mp4", "2"],
                  ["neutral-thumbnail-valid.png", "image/png", "3"],
                ].map(([name, type, digit]) => ({
                  source: "development-fixture",
                  fixtureToken: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
                  name,
                  type,
                  size: 1000,
                  lastModified: 1789812000000,
                })),
              });
            callback({
              ok: true,
              availability: { ready: true },
              sessions: [],
              records: [],
              creatorTools: { registered: [], skipped: [] },
            });
          },
        },
        permissions: { request: async () => true },
      };
      globalThis.deliverResult = (platform, result) => {
        const port = ports.find((candidate) => candidate.sessionId);
        port.listeners.forEach((listener) =>
          listener({
            type: "platform-result",
            sessionId: port.sessionId,
            platform,
            result,
          }),
        );
      };
    });
    await page.route("https://ofenhancer.test/**", (route) => {
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
    await page.goto("https://ofenhancer.test/upload-console.html");
    await page.waitForFunction(() => globalThis.CreatorUploadConsole);
    await page.evaluate(() => {
      let created = false;
      globalThis.CreatorCatalogueClient = {
        loadConfig: async () => ({ source: "desktop", connected: true }),
        getCatalogueSnapshot: async () => ({
          status: "snapshot",
          source: "desktop",
          rows: created
            ? [
                {
                  row: 43,
                  id: "created",
                  itemId: "created",
                  title: "Brand new clip",
                  description: "A benign description.",
                  releaseDate: "2026-01-02",
                  fingerprint: "b".repeat(64),
                  publicationState: {},
                },
              ]
            : [],
          emptyRow: { row: 43, fingerprint: "e".repeat(64) },
        }),
        writeUploadCatalogueEntry: async () => {
          created = true;
          return { id: "created", row: 43, status: "created" };
        },
      };
      globalThis.CreatorUploadQueueEvidence = { snapshot: () => ({}) };
    });
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

async function chooseScript(page, name, text) {
  await page.locator("#uploadScript").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(text),
  });
}

async function draftOnlyFansClip(page, { fansly = false } = {}) {
  await page.locator("#uploadFullVideo").setInputFiles({
    name: "Brand new clip.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("benign fixture"),
  });
  await page.locator("#uploadTitle").fill("Brand new clip");
  await page.locator("#uploadDescription").fill("A benign description.");
  for (const id of ["targetFansly", "targetManyvids", "targetPornhub"]) {
    const box = page.locator(`#${id}`);
    if (id === "targetFansly" && fansly) await box.check({ force: true });
    else if (await box.isChecked()) await box.uncheck({ force: true });
  }
  await page.waitForFunction(
    () =>
      document.querySelector("#uploadButton").textContent ===
        "Create & upload" && !document.querySelector("#uploadButton").disabled,
  );
}

// Reassembles each committed script from its relayed parts, as the worker does.
const sentScripts = (page) =>
  page.evaluate(() =>
    calls
      .filter((call) => call.type === "UPLOAD_SYNC_SCRIPT")
      .map((commit) => {
        const assembler = CreatorSyncScript.createScriptAssembler();
        for (const part of calls.filter(
          (call) =>
            call.type === "UPLOAD_SYNC_SCRIPT_PART" &&
            call.uploadId === commit.uploadId,
        ))
          assembler.add(part);
        return assembler.take(commit.uploadId);
      }),
  );

const scriptCard = (page) =>
  page.locator(".result-card", {
    has: page.locator("h3", { hasText: "Script" }),
  });

test("Script card validates, sends after the links exist and fails on its own", async () => {
  await withConsole(async (page) => {
    const jg = page.locator("#targetJohnnyGuides");
    assert.equal(await jg.isDisabled(), true);
    assert.equal(await jg.isChecked(), false);
    assert.match(
      await page.locator("label:has(#targetJohnnyGuides)").textContent(),
      /JohnnyGuides Website\s*Coming soon/,
    );
    assert.equal(
      await page.locator('label[for="uploadScript"]').textContent(),
      "Script",
    );

    await chooseScript(page, "broken.funscript", "{ not json");
    await page.waitForFunction(() =>
      /not valid/.test(
        document.querySelector("#scriptFileSummary").textContent,
      ),
    );
    assert.equal(
      await page.locator('[data-remove-file="uploadScript"]').isHidden(),
      true,
    );
    await chooseScript(page, "clip.json", JSON.stringify(script));
    await page.waitForFunction(() =>
      /\.funscript/.test(
        document.querySelector("#scriptFileSummary").textContent,
      ),
    );
    await chooseScript(
      page,
      "Brand new clip.funscript",
      JSON.stringify(script),
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#scriptFileSummary").title ===
        "Brand new clip.funscript",
    );
    assert.equal(
      await page.locator('[data-remove-file="uploadScript"]').isVisible(),
      true,
    );

    await draftOnlyFansClip(page);
    await page.locator("#uploadButton").click();
    await page.waitForFunction(() =>
      calls.some((call) => call.type === "START_CREATOR_UPLOAD"),
    );
    assert.equal(await jg.isDisabled(), true, "locked run");
    assert.equal(await page.locator("#uploadScript").isDisabled(), true);
    assert.match(
      await scriptCard(page).textContent(),
      /Waiting for platform links/,
    );
    assert.equal(
      await page.evaluate(() =>
        calls.some((call) => call.type === "UPLOAD_SYNC_SCRIPT"),
      ),
      false,
    );

    await page.evaluate(() => {
      scriptReplies.push({
        ok: false,
        error:
          "Add the JohnnyGuides site and upload token in the toolkit settings, then retry the script.",
      });
      deliverResult("onlyfans", {
        status: "catalogue-updated",
        postUrl: "https://onlyfans.com/123456/johnny_guides",
      });
    });
    await page.waitForFunction(() =>
      /Failed/.test(
        [...document.querySelectorAll(".result-card")].at(-1).textContent,
      ),
    );
    const sent = await sentScripts(page);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "Brand new clip");
    // Only {actions, inverted?} travel; other script fields are dropped.
    assert.deepEqual(sent[0].uploads, [
      { keys: ["123456"], funscript: { actions: script.actions } },
    ]);
    const onlyfans = page.locator(".result-card", {
      has: page.locator("h3", { hasText: "OnlyFans" }),
    });
    assert.match(await onlyfans.textContent(), /Sheet updated and verified/);
    assert.equal(
      await onlyfans.locator("a").getAttribute("href"),
      "https://onlyfans.com/123456/johnny_guides",
    );
    assert.match(await scriptCard(page).textContent(), /toolkit settings/);

    await page.evaluate(() =>
      scriptReplies.push({
        ok: true,
        scripts: [
          {
            url: "https://johnnyguides.com/sync/scripts/brand-new-clip.funscript",
            keys: ["123456"],
            sheetError: "",
          },
        ],
      }),
    );
    await scriptCard(page)
      .getByRole("button", { name: "Retry script" })
      .click();
    await page.waitForFunction(() =>
      /Uploaded to JohnnyGuides/.test(
        [...document.querySelectorAll(".result-card")].at(-1).textContent,
      ),
    );
    assert.equal(
      await scriptCard(page).locator("a").getAttribute("href"),
      "https://johnnyguides.com/sync/scripts/brand-new-clip.funscript",
    );
    assert.equal(await scriptCard(page).getByRole("button").count(), 0);
    assert.match(await onlyfans.textContent(), /Sheet updated and verified/);

    await page.evaluate(() =>
      document.querySelector("#newUploadDraft").click(),
    );
    await page.waitForFunction(() =>
      document
        .querySelector("#neutralTestStatus")
        .textContent.includes("New upload ready"),
    );
    assert.equal(await jg.isDisabled(), true, "after unlock and reset");
    assert.equal(await jg.isChecked(), false);
    assert.equal(await page.locator("#uploadScript").isDisabled(), false);
    assert.equal(await page.locator("#scriptFileSummary").textContent(), "");
    await page.locator("#loadTemplate").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#fullFileSummary").textContent ===
        "neutral-full.mp4",
    );
    assert.equal(await jg.isDisabled(), true, "after template load");
    assert.equal(await jg.isChecked(), false);
  });
});

test("the script for OnlyFans and Fansly is shifted by the measured opening frame", async () => {
  await withConsole(async (page) => {
    await page.evaluate(() => {
      globalThis.CreatorMediaGenerator = {
        ...globalThis.CreatorMediaGenerator,
        waitForMetadata: async () => 10,
        seek: async () => {},
        thumbnailFromVideo: async () =>
          new File(["frame"], "frame.png", { type: "image/png" }),
        teaserFromVideo: async () =>
          new File(["teaser"], "teaser.mp4", { type: "video/mp4" }),
        saveGeneratedMedia: async () => {},
      };
      Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
        get: () => 640,
      });
      Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
        get: () => 360,
      });
      Object.defineProperty(HTMLMediaElement.prototype, "duration", {
        get: () => 10,
      });
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
        get() {
          return this.fakeTime ?? 0;
        },
        set(value) {
          this.fakeTime = value;
        },
      });
      globalThis.OFEnhancerDesktopUpload = {
        prepareOpeningFrame: async () => "a".repeat(48),
        openingFrameLeadInMs: (token) =>
          token === "a".repeat(48) ? 1023 : undefined,
        deliverFile: async () => {},
      };
    });
    await chooseScript(
      page,
      "Brand new clip.funscript",
      JSON.stringify(script),
    );
    await draftOnlyFansClip(page, { fansly: true });
    await page.locator("#chooseThumbnailFrame").click({ force: true });
    await page.waitForFunction(
      () => !document.querySelector("#useThumbnailFrame").disabled,
    );
    await page.evaluate(() => {
      document.querySelector("#useOpeningFrame").checked = true;
      document.querySelector("#useThumbnailFrame").click();
    });
    await page.waitForFunction(
      () => !document.querySelector("#thumbnailFrameDialog").open,
    );
    await page.waitForFunction(
      () => !document.querySelector("#uploadButton").disabled,
    );
    await page.locator("#uploadButton").click();
    await page.waitForFunction(() =>
      calls.some((call) => call.type === "START_CREATOR_UPLOAD"),
    );
    await page.evaluate(() => {
      scriptReplies.push({ ok: true, scripts: [] });
      deliverResult("onlyfans", {
        status: "catalogue-updated",
        postUrl: "https://onlyfans.com/123456/johnny_guides",
      });
      deliverResult("fansly", {
        status: "catalogue-updated",
        postUrl: "https://fansly.com/post/987654321",
      });
    });
    await page.waitForFunction(() =>
      calls.some((call) => call.type === "UPLOAD_SYNC_SCRIPT"),
    );
    const [sent] = await sentScripts(page);
    assert.deepEqual(sent.uploads, [
      {
        keys: ["123456", "987654321"],
        funscript: {
          actions: [
            { at: 1023, pos: 10 },
            { at: 2523, pos: 90 },
          ],
        },
      },
    ]);
  });
});
