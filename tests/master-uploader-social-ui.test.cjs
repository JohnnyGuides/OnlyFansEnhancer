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
    TextEncoder,
    setTimeout,
    clearTimeout,
  });
  for (const relative of [
    "creator-tools/social-distribution-contract.js",
    "upload-console.js",
  ]) {
    vm.runInContext(
      fs.readFileSync(path.join(repositoryRoot, relative), "utf8"),
      context,
      { filename: relative },
    );
  }
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

test("production social evidence enables X while Redgifs and Reddit stay gated", () => {
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "creator-tools/social-trace-evidence.js"),
      "utf8",
    ),
    context,
    { filename: "creator-tools/social-trace-evidence.js" },
  );
  assert.deepEqual(plain(context.CreatorSocialTraceEvidence), {
    x: "07b91df0ef1e7c2b99e3f2e9c77b3507d4b27809ec689f4945ec0246f51e2dab",
    redgifs: "",
    reddit: "",
  });
  assert.deepEqual(plain(context.CreatorSocialDistributionRuntimeReady), {
    x: true,
    redgifs: false,
    reddit: false,
  });
});

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

test("builds one frozen X plan from the exact teaser bytes without persisting caption text", async () => {
  const contract = loadConsoleContract();
  const plan = plain(
    await contract.buildSocialDistributionPlan({
      id: "0123456789abcdef0123456789abcdef0123456789abcdef",
      file: {
        name: "ashley-social-teaser.mp4",
        size: 6,
        lastModified: 1_788_244_200_000,
        async arrayBuffer() {
          return new TextEncoder().encode("social").buffer;
        },
      },
      caption: "Caption",
      paidLink: {
        kind: "url",
        url: "https://onlyfans.com/1/johnny_guides",
      },
      mode: "manual",
      targets: ["x"],
      subreddits: [],
      catalogue: {
        row: 125,
        id: "resident-evil-ashley",
        title: "gooning to Ashley",
        fingerprint: "1234abcd",
      },
      evidence: { x: "f".repeat(64) },
      authorizationAt: 1_788_280_000_000,
    }),
  );
  assert.deepEqual(plan.socialFile, {
    basename: "ashley-social-teaser.mp4",
    size: 6,
    lastModified: 1_788_244_200_000,
    sha256: "3e860f41a5ea92c49803d6ec96d452693b6dcefb0e8c0bf0125b0e3debac5281",
  });
  assert.deepEqual(plan.caption, {
    state: "nonempty",
    sha256: "87d296ec94898c86baf805dbcc47af48e618ec25df0441f7471c60a7d6b05b4e",
  });
  assert.equal(plan.paidUrl, "https://onlyfans.com/1/johnny_guides");
  assert.equal(plan.targets.x, true);
  assert.deepEqual(plan.targets.reddit, []);
  assert.match(plan.authorization.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(plan).includes("Caption"), false);
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
  await page.route("http://localhost/**", (route) =>
    route.request().url().endsWith("/upload-console.html")
      ? route.fulfill({ status: 200, contentType: "text/html", body: html })
      : route.fulfill({ status: 204 }),
  );
  await page.goto("http://localhost/upload-console.html");
  await page.evaluate(
    ({
      presetSnapshots,
      runtimeReady,
      traceEvidence,
      catalogueRows,
      socialPollDelayMs,
    }) => {
      let presetRequest = 0;
      globalThis.__socialUiMessages = [];
      globalThis.__socialUiPortMessages = [];
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
              postMessage(message) {
                globalThis.__socialUiPortMessages.push(
                  structuredClone(message),
                );
              },
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
                  : message.type === "PREPARE_CREATOR_SOCIAL_DISTRIBUTION"
                    ? {
                        ok: true,
                        socialDistribution: {
                          sessionId: message.plan.id,
                          targets: {
                            x: { platform: "x", status: "ready", tabId: 77 },
                          },
                        },
                      }
                    : message.type === "START_CREATOR_SOCIAL_DISTRIBUTION"
                      ? {
                          ok: true,
                          socialDistribution: {
                            id: message.sessionId,
                            jobs: {
                              x: {
                                stage: "prepared",
                                submitAttempted: false,
                              },
                            },
                          },
                        }
                      : message.type === "RESUME_CREATOR_SOCIAL_DISTRIBUTION"
                        ? {
                            ok: true,
                            socialDistribution: {
                              id: message.sessionId,
                              jobs: {
                                x: {
                                  stage: "sheet-complete",
                                  submitAttempted: true,
                                  resultUrl:
                                    "https://x.com/johnny_guides/status/1",
                                },
                              },
                            },
                          }
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
            rows: catalogueRows || [
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
      globalThis.CreatorSocialPollDelayMs = socialPollDelayMs;
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
      runtimeReady: options.runtimeReady ?? false,
      traceEvidence: options.traceEvidence || null,
      catalogueRows: options.catalogueRows || null,
      socialPollDelayMs: options.socialPollDelayMs ?? 10,
    },
  );
  for (const relative of [
    "creator-tools/registry.js",
    "creator-tools/common.js",
    "creator-tools/fansly-prefill.js",
    "creator-tools/ph-uploader.js",
    "creator-tools/catalogue-contract.js",
    "creator-tools/catalogue-proposal.js",
    "creator-tools/social-distribution-contract.js",
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

test("one Yes starts an X-only social run even when paid catalogue links already exist", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  try {
    await mountConsole(page, {
      runtimeReady: { x: true, redgifs: false, reddit: false },
      traceEvidence: { x: hash("f") },
      catalogueRows: [
        {
          row: 125,
          id: "resident-evil-ashley",
          releaseDate: "2026-09-04",
          title: "gooning to Ashley",
          description: "Catalogue description",
          seasonArc: "Resident Evil",
          episode: "",
          pornhubLink: "https://pornhub.com/view_video.php?viewkey=3",
          onlyfansLink: "https://onlyfans.com/1/johnny_guides",
          fanslyLink: "https://fansly.com/post/2",
          manyvidsLink: "https://manyvids.com/Video/4",
          fingerprint: "1234abcd",
        },
      ],
    });
    await page.locator("#targetSocialX").check();
    await page.locator("#uploadSocialTeaser").setInputFiles({
      name: "Ashley social teaser.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("social"),
    });
    await page.locator("#socialCaption").fill("Caption");
    try {
      await page.waitForFunction(
        () => !document.querySelector("#confirmUpload").disabled,
        null,
        { timeout: 5000 },
      );
    } catch (error) {
      const state = await page.evaluate(() => ({
        socialErrors:
          document.querySelector("#socialErrors")?.textContent || "",
        draftErrors: document.querySelector("#draftErrors")?.textContent || "",
        traceStatus:
          document.querySelector("#socialTraceStatus")?.textContent || "",
        paidLink: document.querySelector("#socialPaidLink")?.value || "",
        paidOptions: [...document.querySelector("#socialPaidLink").options].map(
          (option) => ({ value: option.value, label: option.textContent }),
        ),
        question: document.querySelector("#matchQuestion")?.textContent || "",
      }));
      throw new Error(
        `Social confirmation stayed disabled: ${JSON.stringify(state)}`,
        {
          cause: error,
        },
      );
    }
    await page.locator("#confirmUpload").click();
    try {
      await page.waitForFunction(
        () =>
          __socialUiMessages.some(
            (message) => message.type === "START_CREATOR_SOCIAL_DISTRIBUTION",
          ),
        null,
        { timeout: 5000 },
      );
    } catch (error) {
      const state = await page.evaluate(() => ({
        status: document.querySelector("#matchStatus")?.textContent || "",
        errors: document.querySelector("#draftErrors")?.textContent || "",
        messages: structuredClone(__socialUiMessages),
      }));
      throw new Error(`Social run did not start: ${JSON.stringify(state)}`, {
        cause: error,
      });
    }
    await page.waitForFunction(
      () =>
        __socialUiMessages.some(
          (message) => message.type === "RESUME_CREATOR_SOCIAL_DISTRIBUTION",
        ),
      null,
      { timeout: 5000 },
    );

    const captured = await page.evaluate(() => ({
      messages: structuredClone(__socialUiMessages),
      portMessages: structuredClone(__socialUiPortMessages),
    }));
    const prepared = captured.messages.find(
      (message) => message.type === "PREPARE_CREATOR_SOCIAL_DISTRIBUTION",
    );
    assert.ok(prepared);
    assert.equal(prepared.caption, "Caption");
    assert.equal(
      prepared.plan.caption.sha256,
      "87d296ec94898c86baf805dbcc47af48e618ec25df0441f7471c60a7d6b05b4e",
    );
    assert.equal(
      prepared.plan.socialFile.sha256,
      "3e860f41a5ea92c49803d6ec96d452693b6dcefb0e8c0bf0125b0e3debac5281",
    );
    assert.equal(JSON.stringify(prepared.plan).includes("Caption"), false);
    assert.equal(
      captured.messages.some(
        (message) => message.type === "PREPARE_CREATOR_UPLOAD",
      ),
      false,
    );
    assert.equal(
      captured.portMessages.some(
        (message) =>
          message.type === "bind-social-session" &&
          message.sessionId === prepared.plan.id,
      ),
      true,
    );
    assert.equal(
      captured.messages.some(
        (message) =>
          message.type === "RESUME_CREATOR_SOCIAL_DISTRIBUTION" &&
          message.sessionId === prepared.plan.id,
      ),
      true,
    );
  } finally {
    await browser.close();
  }
});

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
  { name: "compact", width: 768, height: 900 },
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
