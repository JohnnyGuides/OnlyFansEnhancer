"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { chromium } = require("playwright");

const repositoryRoot = path.resolve(__dirname, "..");
const hash = (character) => character.repeat(64);

function loadConsoleContract() {
  const context = vm.createContext({
    Date,
    Intl,
    URL,
    crypto,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(
    fs.readFileSync(path.join(repositoryRoot, "upload-console.js"), "utf8"),
    context,
    { filename: "upload-console.js" },
  );
  return context.CreatorUploadConsole;
}

function socialInput(overrides = {}) {
  return {
    file: {
      name: "ashley-social-teaser.mp4",
      type: "video/mp4",
      size: 12345,
    },
    caption: "Ashley found the wrong kind of mod",
    paidUrl: "https://onlyfans.com/1/johnny_guides",
    paidLinkSource: "",
    mode: "manual",
    targets: ["x", "reddit"],
    subreddits: [
      {
        subreddit: "GamesGoneWild",
        presetId: "gamesgonewild",
        presetRevision: "c0ffee00",
        status: "Approved",
        title: "",
        body: "",
        flair: "Cosplay",
        nsfw: true,
      },
    ],
    catalogue: {
      row: 125,
      id: "resident-evil-ashley",
      title: "gooning to Ashley",
      fingerprint: "1234abcd",
    },
    evidence: {
      x: hash("a"),
      redgifs: hash("b"),
      reddit: hash("c"),
    },
    ...overrides,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("social draft is optional until a social file or destination is selected", () => {
  const contract = loadConsoleContract();
  assert.deepEqual(
    plain(
      contract.normalizeSocialDraft({
        file: null,
        targets: [],
        subreddits: [],
      }),
    ),
    {
      enabled: false,
      valid: true,
      errors: [],
      caption: "",
      mode: "manual",
      targets: [],
      paidLink: null,
      subreddits: [],
    },
  );
});

test("social draft accepts a future paid-platform result and enforces trace evidence", () => {
  const contract = loadConsoleContract();
  const valid = plain(
    contract.normalizeSocialDraft({
      ...socialInput(),
      paidUrl: "",
      paidLinkSource: "onlyfans",
    }),
  );
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.paidLink, {
    kind: "upload-result",
    platform: "onlyfans",
  });

  const missingEvidence = plain(
    contract.normalizeSocialDraft({ ...socialInput(), evidence: {} }),
  );
  assert.equal(missingEvidence.valid, false);
  assert.match(missingEvidence.errors.join(" "), /record.*X.*Redgifs.*Reddit/i);
});

test("autonomous mode rejects review-only subreddit presets", () => {
  const contract = loadConsoleContract();
  const manual = plain(
    contract.normalizeSocialDraft({
      ...socialInput(),
      targets: ["reddit"],
      mode: "manual",
      subreddits: [
        {
          ...socialInput().subreddits[0],
          subreddit: "ReviewSub",
          status: "Needs review",
        },
      ],
    }),
  );
  assert.equal(manual.valid, true);
  const autonomous = plain(
    contract.normalizeSocialDraft({
      ...socialInput(),
      targets: ["reddit"],
      mode: "autonomous",
      subreddits: manual.subreddits,
    }),
  );
  assert.equal(autonomous.valid, false);
  assert.match(autonomous.errors.join(" "), /approved.*autonomous/i);
});

test("social draft rejects credentialed paid links and over-limit effective copy", () => {
  const contract = loadConsoleContract();
  const credentialed = plain(
    contract.normalizeSocialDraft({
      ...socialInput(),
      targets: ["x"],
      subreddits: [],
      paidUrl: "https://user:pass@onlyfans.com/1/johnny_guides",
    }),
  );
  assert.equal(credentialed.valid, false);
  assert.match(credentialed.errors.join(" "), /paid-video link/i);

  const longX = plain(
    contract.normalizeSocialDraft({
      ...socialInput(),
      targets: ["x"],
      subreddits: [],
      caption: "x".repeat(281),
    }),
  );
  assert.equal(longX.valid, false);
  assert.match(longX.errors.join(" "), /X caption.*280/i);

  const longRedditDefault = plain(
    contract.normalizeSocialDraft({
      ...socialInput(),
      targets: ["reddit"],
      caption: "r".repeat(301),
    }),
  );
  assert.equal(longRedditDefault.valid, false);
  assert.match(longRedditDefault.errors.join(" "), /Reddit title.*300/i);
});

async function mountConsole(page, options = {}) {
  const defaultPresets = [
    {
      subreddit: "r/GamesGoneWild",
      status: "Approved",
      notes: "flair: Cosplay · NSFW",
    },
    {
      subreddit: "ReviewSub",
      status: "Needs review",
      notes: "Double-check the title.",
    },
  ];
  const html = fs
    .readFileSync(path.join(repositoryRoot, "upload-console.html"), "utf8")
    .replace(/<script[^>]+><\/script>/gi, "");
  await page.setContent(html);
  await page.evaluate(
    ({ presetSnapshots, runtimeReady, traceEvidence }) => {
      let presetRequest = 0;
      globalThis.__socialUiMessages = [];
      const stored = {
        creatorSocialSubredditSelectionV1: ["GamesGoneWild"],
      };
      globalThis.__socialUiStorage = stored;
      globalThis.chrome = {
        storage: {
          local: {
            get(keys, callback) {
              const result = {};
              for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(stored, key)) result[key] = stored[key];
              }
              const value = structuredClone(result);
              queueMicrotask(() => callback?.(value));
              return Promise.resolve(value);
            },
            set(next, callback) {
              Object.assign(stored, structuredClone(next));
              queueMicrotask(() => callback?.());
              return Promise.resolve();
            },
          },
          onChanged: { addListener() {}, removeListener() {} },
        },
        runtime: {
          lastError: null,
          connect() {
            return {
              onMessage: { addListener() {} },
              onDisconnect: { addListener() {} },
              postMessage() {},
              disconnect() {},
            };
          },
          sendMessage(message, callback) {
            globalThis.__socialUiMessages.push(structuredClone(message));
            callback(
              message.type === "PREPARE_CREATOR_UPLOAD"
                ? { ok: true, uploadSession: { platforms: [] } }
                : message.type === "START_CREATOR_UPLOAD"
                  ? { ok: true, results: [] }
                  : message.type === "SYNC_CREATOR_TOOLS"
                    ? {
                        ok: true,
                        creatorTools: { registered: [], skipped: [] },
                      }
                    : { ok: true },
            );
          },
        },
        permissions: { request: async () => true },
      };
      globalThis.CreatorCatalogueClient = {
        async loadConfig() {
          return {
            endpoint: "https://script.google.com/fixture",
            secret: "set",
          };
        },
        async getCatalogueSnapshot() {
          return {
            status: "snapshot",
            rows: [
              {
                row: 125,
                id: "resident-evil-ashley",
                releaseDate: "2026-09-04",
                title: "gooning to Ashley",
                description: "Catalogue description",
                seasonArc: "Resident Evil",
                episode: "",
                pornhubLink: "",
                onlyfansLink: "https://onlyfans.com/1/johnny_guides",
                fanslyLink: "https://fansly.com/post/2",
                manyvidsLink: "",
                fingerprint: "1234abcd",
              },
            ],
            emptyRow: { row: 126, fingerprint: "8765dcba" },
          };
        },
        async getSubredditPresetSnapshot() {
          const rows =
            presetSnapshots[
              Math.min(presetRequest, presetSnapshots.length - 1)
            ];
          presetRequest += 1;
          return { status: "snapshot", rows: structuredClone(rows) };
        },
      };
      globalThis.CreatorSocialDistributionRuntimeReady = runtimeReady;
      globalThis.CreatorSocialTraceEvidence = traceEvidence;
      globalThis.CreatorUploadQueueEvidence = {
        snapshot() {
          return {
            manyvids: { verified: true, scheduled: [], occupiedFridays: [] },
          };
        },
      };
    },
    {
      presetSnapshots: options.presetSnapshots || [defaultPresets],
      runtimeReady: options.runtimeReady === true,
      traceEvidence: options.traceEvidence || null,
    },
  );
  for (const relative of [
    "creator-tools/registry.js",
    "creator-tools/common.js",
    "creator-tools/fansly-prefill.js",
    "creator-tools/ph-uploader.js",
    "creator-tools/catalogue-contract.js",
    "creator-tools/catalogue-proposal.js",
    "creator-tools/subreddit-presets.js",
    "upload-console.js",
  ]) {
    await page.addScriptTag({ path: path.join(repositoryRoot, relative) });
  }
  await page.locator("#uploadFullVideo").setInputFiles({
    name: "Ashley full.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("full"),
  });
  await page.locator("#uploadTitle").fill("gooning to Ashley");
  try {
    await page.getByText(/Likely episode/i).waitFor({ timeout: 5000 });
  } catch (error) {
    const status = await page.locator("#matchStatus").textContent();
    const errors = await page.locator("#draftErrors").textContent();
    throw new Error(`Catalogue match did not render: ${status} ${errors}`, {
      cause: error,
    });
  }
}

test("workflow helpers are active and configured only inside the uploader Settings tab", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  try {
    await mountConsole(page);

    const uploaderTab = page.getByRole("tab", { name: "Uploader" });
    const settingsTab = page.getByRole("tab", { name: "Settings" });
    assert.equal(await uploaderTab.getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#settingsPanel").isHidden(), true);
    assert.equal(
      await page.locator("#confirmation").getAttribute("hidden"),
      null,
    );

    await settingsTab.click();
    assert.equal(await settingsTab.getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#settingsPanel").isVisible(), true);

    const switches = page.locator('#settingsPanel input[role="switch"]');
    assert.equal(await switches.count(), 9);
    for (const helper of await switches.all()) {
      assert.equal(await helper.isChecked(), true);
    }

    await page.locator("#toolC4sUpload").uncheck();
    assert.match(
      await page.locator("#workflowSettingsStatus").innerText(),
      /unsaved/i,
    );
    await page.locator("#saveWorkflowSettings").click();
    await page.getByText(/Helper settings saved/i).waitFor();
    assert.equal(
      await page.locator("#confirmation").getAttribute("hidden"),
      "",
    );

    const persisted = await page.evaluate(() => ({
      settings: structuredClone(__socialUiStorage.creatorToolkitV2),
      messages: structuredClone(__socialUiMessages),
      fileName: document.querySelector("#uploadFullVideo").files[0]?.name || "",
    }));
    assert.equal(persisted.settings.schemaVersion, 3);
    assert.equal(persisted.settings.tools.c4sUpload.enabled, false);
    assert.equal(persisted.settings.tools.fanslyPrefill.enabled, true);
    assert.equal(
      persisted.messages.some(
        (message) => message.type === "SYNC_CREATOR_TOOLS",
      ),
      true,
    );

    await uploaderTab.click();
    assert.equal(await page.locator("#uploaderPanel").isVisible(), true);
    assert.equal(persisted.fileName, "Ashley full.mp4");

    await uploaderTab.focus();
    await uploaderTab.press("ArrowRight");
    assert.equal(await settingsTab.getAttribute("aria-selected"), "true");
    assert.equal(await settingsTab.getAttribute("tabindex"), "0");
    assert.equal(await uploaderTab.getAttribute("tabindex"), "-1");
    await settingsTab.press("Home");
    assert.equal(await uploaderTab.getAttribute("aria-selected"), "true");

    const optionsPage = await browser.newPage();
    const optionsHtml = fs
      .readFileSync(path.join(repositoryRoot, "options.html"), "utf8")
      .replace(/<script[^>]+><\/script>/gi, "");
    await optionsPage.setContent(optionsHtml);
    assert.equal(await optionsPage.locator("#toolC4sUpload").count(), 0);
    assert.equal(
      await optionsPage
        .getByRole("heading", { name: "Workflow helpers" })
        .count(),
      0,
    );
  } finally {
    await browser.close();
  }
});

test("Yes rechecks selected subreddit revisions before any platform mutation", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  try {
    await mountConsole(page, {
      runtimeReady: true,
      traceEvidence: {
        x: hash("a"),
        redgifs: hash("b"),
        reddit: hash("c"),
      },
      presetSnapshots: [
        [
          {
            subreddit: "GamesGoneWild",
            status: "Approved",
            notes: "Stable",
          },
        ],
        [
          {
            subreddit: "GamesGoneWild",
            status: "Needs review",
            notes: "Rules changed",
          },
        ],
      ],
    });
    await page.locator("#uploadTeaser").setInputFiles({
      name: "Ashley paid teaser.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("paid-teaser"),
    });
    await page.locator("#targetSocialReddit").check();
    await page.locator("#uploadSocialTeaser").setInputFiles({
      name: "Ashley social teaser.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("social"),
    });
    await page.locator("#socialCaption").fill("Ashley cosplay");
    await page.getByText("GamesGoneWild", { exact: true }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#confirmUpload").disabled,
      null,
      { timeout: 3000 },
    );

    await page.locator("#confirmUpload").click();
    await page.waitForTimeout(100);
    assert.match(
      await page.locator("#matchStatus").textContent(),
      /subreddit presets changed.*review.*Yes again/i,
    );
    const messages = await page.evaluate(() => globalThis.__socialUiMessages);
    assert.equal(
      messages.some((message) => message.type === "PREPARE_CREATOR_UPLOAD"),
      false,
    );
  } finally {
    await browser.close();
  }
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`social distributor renders and gates unrecorded adapters at ${viewport.name}`, async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await mountConsole(page);
      await page.locator("#targetSocialX").check();
      await page.locator("#targetSocialReddit").check();
      await page.locator("#uploadSocialTeaser").setInputFiles({
        name: "Ashley social teaser.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.from("social"),
      });
      await page
        .locator("#socialCaption")
        .fill("Ashley found the wrong kind of mod");
      await page.getByText("GamesGoneWild", { exact: true }).waitFor();
      await page
        .locator('[data-subreddit="gamesgonewild"]')
        .locator("xpath=ancestor::div[contains(@class, 'subreddit-preset')]")
        .locator('[data-field="title"]')
        .fill("Ashley cosplay title");
      await page
        .locator('[data-subreddit="gamesgonewild"]')
        .locator("xpath=ancestor::div[contains(@class, 'subreddit-preset')]")
        .locator('[data-field="body"]')
        .fill("Exact Reddit body");
      await page
        .locator('[data-subreddit="gamesgonewild"]')
        .locator("xpath=ancestor::div[contains(@class, 'subreddit-preset')]")
        .locator('[data-field="flair"]')
        .fill("Cosplay");

      assert.equal(
        await page.locator('[data-subreddit="gamesgonewild"]').isChecked(),
        true,
        "last subreddit selection should be restored",
      );
      assert.match(
        await page.locator("#socialTraceStatus").textContent(),
        /record.*X.*Redgifs.*Reddit/i,
      );
      assert.equal(await page.locator("#confirmUpload").isDisabled(), true);
      const exactSummary = await page.locator("#uploadSummary").textContent();
      assert.match(exactSummary, /Ashley found the wrong kind of mod/);
      assert.match(exactSummary, /Title: Ashley cosplay title/);
      assert.match(exactSummary, /Body: Exact Reddit body/);
      assert.match(exactSummary, /Flair: Cosplay/);
      assert.match(exactSummary, /NSFW: Yes/);
      assert.equal(await page.locator("#subredditSearch").count(), 1);
      await page.locator("#subredditSearch").fill("Review");
      assert.equal(
        await page
          .locator('[data-subreddit="gamesgonewild"]')
          .locator("xpath=ancestor::div[contains(@class, 'subreddit-preset')]")
          .isHidden(),
        true,
      );
      assert.equal(
        await page
          .locator('[data-subreddit="reviewsub"]')
          .locator("xpath=ancestor::div[contains(@class, 'subreddit-preset')]")
          .isVisible(),
        true,
      );
      await page.locator("#subredditSearch").fill("");
      await page
        .locator('input[name="socialMode"][value="autonomous"]')
        .check();
      assert.equal(
        await page.locator('[data-subreddit="reviewsub"]').isDisabled(),
        true,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
