"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
const root = require("../support/paths.cjs").personalRoot;

// Whole-page harness: the built upload console runs against a scripted
// extension runtime so tests can gate asynchronous results and reorder them.
async function mount(page, { init, seed } = {}) {
  if (seed)
    await page.addInitScript((value) => {
      globalThis.storageSeed = value;
    }, seed);
  await page.addInitScript(() => {
    const values = { ...(globalThis.storageSeed || {}) };
    globalThis.calls = [];
    globalThis.ports = [];
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
        connect(info) {
          const listeners = [];
          const port = {
            name: info?.name,
            disconnected: false,
            onMessage: { addListener: (listener) => listeners.push(listener) },
            onDisconnect: { addListener() {} },
            postMessage(message) {
              port.sent = [...(port.sent || []), message];
              if (message.type === "bind-session")
                queueMicrotask(() =>
                  listeners.forEach((listener) =>
                    listener({
                      type: "session-bound",
                      sessionId: message.sessionId,
                      existing: true,
                    }),
                  ),
                );
            },
            disconnect() {
              port.disconnected = true;
            },
          };
          globalThis.ports.push(port);
          return port;
        },
        sendMessage(message, callback) {
          calls.push(message);
          if (globalThis.fixtureSend)
            return globalThis.fixtureSend(message, callback);
          if (message.type === "CHECK_CREATOR_UPLOAD_AVAILABILITY")
            return callback({ ok: true, availability: { ready: true } });
          callback({
            ok: true,
            sessions: [],
            creatorTools: { registered: [], skipped: [] },
          });
        },
      },
      permissions: { request: async () => true },
    };
    globalThis.gate = () => {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
  });
  if (init) await page.addInitScript(init);
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
}

async function withPage(run, options) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await mount(page, options);
    await run(page, errors);
  } finally {
    await browser.close();
  }
}

function desktopRow(overrides = {}) {
  return {
    row: 42,
    id: "studio",
    itemId: "studio",
    title: "Studio tour",
    description: "Original description",
    releaseDate: "2026-09-25",
    fingerprint: "a".repeat(64),
    publicationState: {},
    ...overrides,
  };
}

async function installDesktopCatalogue(page, rows = [], evidence = {}) {
  await page.evaluate(
    ({ initial, evidence }) => {
      globalThis.catalogueWrites = [];
      globalThis.CreatorCatalogueClient = {
        loadConfig: async () => ({ source: "desktop", connected: true }),
        getCatalogueSnapshot: async () => ({
          status: "snapshot",
          source: "desktop",
          rows: catalogueWrites.length
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
            : initial,
          emptyRow: { row: 43, fingerprint: "e".repeat(64) },
        }),
        writeUploadCatalogueEntry: async (value) => {
          catalogueWrites.push(value);
          return { id: "created", row: 43, status: "created" };
        },
      };
      globalThis.CreatorUploadQueueEvidence = { snapshot: () => evidence };
    },
    { initial: rows, evidence },
  );
}

test("snapshot fetches resolving out of order leave the newer rows current", async () => {
  await withPage(async (page, errors) => {
    await page.evaluate(() => {
      const fetches = [];
      globalThis.fetches = fetches;
      const rows = (title) => [
        {
          row: 42,
          id: title,
          itemId: title,
          title,
          description: "",
          releaseDate: "2026-09-25",
          fingerprint: "a".repeat(64),
          publicationState: {},
        },
      ];
      globalThis.CreatorCatalogueClient = {
        loadConfig: async () => ({ source: "desktop", connected: true }),
        getCatalogueSnapshot() {
          const entry = gate();
          fetches.push(entry);
          return entry.promise;
        },
      };
      globalThis.snapshotOf = (title) => ({
        status: "snapshot",
        source: "desktop",
        rows: rows(title),
      });
    });
    await page.locator("#uploadFullVideo").setInputFiles({
      name: "Studio walk.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("benign fixture"),
    });
    await page.waitForFunction(() => fetches.length === 1);
    // A refresh starts a newer fetch while the first is still pending.
    await page.evaluate(() =>
      document.querySelector("#refreshCatalogue").click(),
    );
    await page.waitForFunction(() => fetches.length === 2);
    await page.evaluate(() => fetches[1].release(snapshotOf("NewerRow")));
    await page.waitForFunction(() =>
      document.querySelector("#catalogueRow").textContent.includes("NewerRow"),
    );
    // A later edit supersedes the first match before its fetch settles.
    await page.locator("#uploadTitle").fill("Studio walk two");
    await page.waitForTimeout(500);
    await page.evaluate(() => fetches[0].release(snapshotOf("OlderRow")));
    await page.waitForTimeout(200);
    await page.locator("#catalogueSearch").fill("row");
    const options = await page.locator("#catalogueRow").textContent();
    assert.match(options, /NewerRow/);
    assert.doesNotMatch(options, /OlderRow/);
    assert.deepEqual(errors, []);
  });
});

const fullProof = {
  name: "Studio walk.mp4",
  size: 14,
  lastModified: 1789812000000,
  type: "video/mp4",
};

function resumeInit() {
  globalThis.fixtureSend = (message, callback) => {
    if (message.type === "GET_CREATOR_UPLOAD_RESUMABLE")
      return callback({
        ok: true,
        resumable: {
          id: "a".repeat(48),
          platforms: [{ platform: "onlyfans", status: "prepared" }],
          draft: {
            fullFilename: "Studio walk.mp4",
            hasTeaser: true,
            manyvidsThumbnail: true,
            pornhubMode: "free",
            publishMode: "manual",
            title: "Studio walk",
            description: "A benign description.",
            releaseDate: "2026-09-25",
            mediaFiles: [],
            fileProof: {
              full: {
                name: "Studio walk.mp4",
                size: 14,
                lastModified: 1789812000000,
                type: "video/mp4",
              },
            },
          },
        },
      });
    if (message.type === "CHECK_CREATOR_UPLOAD_AVAILABILITY")
      return callback({ ok: true, availability: { ready: true } });
    if (message.type === "START_NEW_CREATOR_UPLOAD")
      return callback({ ok: true, reset: true });
    if (message.type === "ASSOCIATE_CREATOR_UPLOAD_CATALOGUE") {
      const entry = gate();
      globalThis.associations = [...(globalThis.associations || []), entry];
      return void entry.promise.then(() => callback({ ok: true }));
    }
    callback({
      ok: true,
      sessions: [],
      records: [],
      creatorTools: { registered: [], skipped: [] },
    });
  };
}

async function selectSavedFull(page) {
  await page.evaluate((proof) => {
    const file = new File(["benign fixture"], proof.name, {
      type: proof.type,
      lastModified: proof.lastModified,
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector("#uploadFullVideo");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, fullProof);
}

function mockGeneratedMedia({ failThumbnail }) {
  globalThis.mediaLoads = [];
  globalThis.mediaGate = gate();
  const generator = { ...globalThis.CreatorMediaGenerator };
  generator.loadGeneratedMedia = async (_id, role) => {
    mediaLoads.push(role);
    await mediaGate.promise;
    if (role === "thumbnail" && failThumbnail)
      throw new Error("Saved generated media load was cancelled.");
    const file = new File(["teaser"], `${role}.mp4`, {
      type: "video/mp4",
      lastModified: 1789812000000,
    });
    file.source = role === "thumbnail" ? "catalogue-thumbnail" : "generated";
    return file;
  };
  globalThis.CreatorMediaGenerator = generator;
}

test("a double click on Resume during the media load connects exactly one session", async () => {
  await withPage(
    async (page, errors) => {
      await page.locator("#resumeUpload").waitFor({ state: "visible" });
      await page.evaluate(mockGeneratedMedia, { failThumbnail: false });
      await selectSavedFull(page);
      await page.evaluate(() => {
        globalThis.mediaGate.release();
        const button = document.querySelector("#resumeUpload");
        button.click();
        button.click();
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#matchStatus")
          .textContent.includes("Reconnected"),
      );
      await page.waitForTimeout(200);
      const uploadPorts = await page.evaluate(() =>
        ports
          .filter((port) => port.name === "creator-upload-console")
          .map((port) => port.disconnected),
      );
      assert.deepEqual(uploadPorts, [false]);
      assert.deepEqual(errors, []);
    },
    { init: resumeInit },
  );
});

test("a cancelled media load on Resume restores the selections and releases ownership", async () => {
  await withPage(
    async (page, errors) => {
      await page.locator("#resumeUpload").waitFor({ state: "visible" });
      await page.evaluate(mockGeneratedMedia, { failThumbnail: true });
      await selectSavedFull(page);
      await page.evaluate(() => {
        mediaGate.release();
        document.querySelector("#resumeUpload").click();
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#resumeError")
          .textContent.includes("cancelled"),
      );
      assert.equal(await page.locator("#resumeUpload").isEnabled(), true);
      await page.evaluate(() => {
        globalThis.mediaLoads.length = 0;
        document.querySelector("#resumeUpload").click();
      });
      // A released claim lets the second attempt load the teaser again.
      await page.waitForFunction(() => mediaLoads.includes("thumbnail"));
      assert.deepEqual(await page.evaluate(() => mediaLoads), [
        "teaser",
        "thumbnail",
      ]);
      assert.equal(
        await page.evaluate(
          () =>
            ports.filter((port) => port.name === "creator-upload-console")
              .length,
        ),
        0,
      );
      assert.deepEqual(errors, []);
    },
    { init: resumeInit },
  );
});

async function openSubredditPresets(page, names) {
  await page.evaluate((rows) => {
    globalThis.CreatorCatalogueClient = {
      ...globalThis.CreatorCatalogueClient,
      getSubredditPresetSnapshot: async () => ({
        status: "snapshot",
        rows: rows.map((subreddit) => ({
          subreddit,
          status: "Approved",
          notes: "",
        })),
      }),
    };
  }, names);
  await page
    .locator('input[name="workflowMode"][value="teaser"]')
    .check({ force: true });
  await page.locator("#targetSocialReddit").check({ force: true });
  await page.locator(".subreddit-preset").first().waitFor();
}

test("stored subreddit selection contains only unique subreddit names", async () => {
  await withPage(async (page, errors) => {
    await openSubredditPresets(page, ["GamesGoneWild", "Cosplay"]);
    for (const name of ["gamesgonewild", "cosplay"])
      await page.locator(`input[data-subreddit="${name}"]`).check();
    // The per-row NSFW toggle is checked by default and must not be stored.
    assert.equal(await page.locator('[data-field="nsfw"]:checked').count(), 2);
    await page.locator('input[data-subreddit="cosplay"]').uncheck();
    await page.locator('input[data-subreddit="cosplay"]').check();
    const stored = await page.evaluate(
      async () =>
        (await chrome.storage.local.get("creatorSocialSubredditSelectionV1"))
          .creatorSocialSubredditSelectionV1,
    );
    assert.deepEqual(stored, ["gamesgonewild", "cosplay"]);
    assert.deepEqual(errors, []);
  });
});

test("a legacy stored selection containing the string null is dropped on read", async () => {
  await withPage(
    async (page, errors) => {
      await openSubredditPresets(page, ["Null", "Cosplay"]);
      assert.equal(
        await page.locator('input[data-subreddit="null"]').isChecked(),
        false,
      );
      assert.equal(
        await page.locator('input[data-subreddit="cosplay"]').isChecked(),
        true,
      );
      assert.deepEqual(errors, []);
    },
    { seed: { creatorSocialSubredditSelectionV1: ["null", "cosplay"] } },
  );
});

// Fake decoded video geometry and a gated media generator for the frame dialog.
async function mockFrameDialog(page) {
  await page.evaluate(() => {
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
    globalThis.metadataGates = [];
    globalThis.thumbnailGates = [];
    globalThis.thumbnailRequests = [];
    const generator = { ...globalThis.CreatorMediaGenerator };
    generator.waitForMetadata = (video) => {
      if (video.id !== "thumbnailFrameVideo") return Promise.resolve(10);
      const entry = gate();
      metadataGates.push(entry);
      return entry.promise;
    };
    generator.seek = async (video, time) => {
      video.currentTime = time;
    };
    generator.thumbnailFromVideo = (source, time) => {
      const entry = gate();
      thumbnailGates.push(entry);
      thumbnailRequests.push({ name: source.name, time });
      return entry.promise;
    };
    globalThis.CreatorMediaGenerator = generator;
  });
}

async function chooseFull(page, name) {
  await page.locator("#uploadFullVideo").setInputFiles({
    name,
    mimeType: "video/mp4",
    buffer: Buffer.from("benign fixture " + name),
  });
}

test("a late frame result cannot become the thumbnail of a different full video", async () => {
  await withPage(async (page, errors) => {
    await mockFrameDialog(page);
    await chooseFull(page, "First video.mp4");
    await page.locator("#chooseThumbnailFrame").click({ force: true });
    await page.waitForFunction(() => metadataGates.length === 1);
    await page.evaluate(() => metadataGates[0].release(10));
    await page.waitForFunction(
      () => !document.querySelector("#useThumbnailFrame").disabled,
    );
    await page.evaluate(() => {
      document.querySelector("#thumbnailFrameVideo").currentTime = 4;
      document.querySelector("#useThumbnailFrame").click();
    });
    await page.waitForFunction(() => thumbnailGates.length === 1);
    await page.evaluate(() => {
      document.querySelector("#thumbnailFrameVideo").currentTime = 7;
    });
    await chooseFull(page, "Second video.mp4");
    await page.evaluate(() =>
      thumbnailGates[0].release(
        new File(["stale"], "stale-thumb.png", { type: "image/png" }),
      ),
    );
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => thumbnailRequests), [
      { name: "First video.mp4", time: 4 },
    ]);
    assert.doesNotMatch(
      await page.locator("#manyvidsThumbnailSummary").textContent(),
      /stale-thumb/,
    );
    assert.deepEqual(errors, []);
  });
});

test("a stale frame dialog open cannot reset the newer dialog session", async () => {
  await withPage(async (page, errors) => {
    await mockFrameDialog(page);
    await chooseFull(page, "First video.mp4");
    await page.locator("#chooseThumbnailFrame").click({ force: true });
    await page.waitForFunction(() => metadataGates.length === 1);
    await page.locator("#cancelThumbnailFrame").click();
    await page.locator("#chooseThumbnailFrame").click({ force: true });
    await page.waitForFunction(() => metadataGates.length === 2);
    // The first open finishes late while the second is still loading.
    await page.evaluate(() => metadataGates[0].release(10));
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator("#thumbnailFrameDuration").textContent(),
      "0:00",
    );
    assert.equal(await page.locator("#useThumbnailFrame").isDisabled(), true);
    assert.equal(
      await page.locator("#thumbnailFrameStatus").textContent(),
      "Loading video timeline…",
    );
    await page.evaluate(() => metadataGates[1].release(10));
    await page.waitForFunction(
      () => !document.querySelector("#useThumbnailFrame").disabled,
    );
    assert.deepEqual(errors, []);
  });
});

test("a pending catalogue association cannot touch the next draft after New upload draft", async () => {
  await withPage(
    async (page, errors) => {
      await page.locator("#resumeUpload").waitFor({ state: "visible" });
      await page.evaluate(mockGeneratedMedia, { failThumbnail: false });
      await selectSavedFull(page);
      await page.evaluate(() => {
        mediaGate.release();
        document.querySelector("#resumeUpload").click();
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#matchStatus")
          .textContent.includes("Reconnected"),
      );
      await page.evaluate(async () => {
        globalThis.CreatorCatalogueClient = {
          loadConfig: async () => ({ source: "desktop", connected: true }),
          getCatalogueSnapshot: async () => ({
            status: "snapshot",
            source: "desktop",
            rows: [
              {
                row: 42,
                id: "studio",
                title: "Studio tour",
                fingerprint: "a".repeat(64),
                publicationState: {},
              },
            ],
          }),
        };
        document.querySelector("#loadAssociationRows").click();
      });
      await page.waitForFunction(
        () => document.querySelector("#savedCatalogueRow").options.length > 1,
      );
      await page.evaluate(() => {
        const select = document.querySelector("#savedCatalogueRow");
        select.value = "42";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        document.querySelector("#associateSavedResults").click();
      });
      await page.waitForFunction(() => globalThis.associations?.length === 1);
      await page.evaluate(() =>
        document.querySelector("#newUploadDraft").click(),
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#neutralTestStatus")
          .textContent.includes("New upload ready"),
      );
      await page.evaluate(() => associations[0].release());
      await page.waitForTimeout(300);
      assert.doesNotMatch(
        await page.locator("#savedAssociationStatus").textContent(),
        /Cannot read|Association saved/i,
      );
      assert.equal(
        await page.evaluate(() =>
          calls.some(
            (call) => call.type === "ASSOCIATE_CREATOR_SOCIAL_CATALOGUE",
          ),
        ),
        false,
      );
      assert.deepEqual(errors, []);
    },
    { init: resumeInit },
  );
});

function uploadInit() {
  globalThis.fixtureSend = (message, callback) => {
    if (message.type === "CHECK_CREATOR_UPLOAD_AVAILABILITY")
      return callback({ ok: true, availability: { ready: true } });
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
    callback({
      ok: true,
      sessions: [],
      records: [],
      creatorTools: { registered: [], skipped: [] },
    });
  };
}

async function draftPornhubUpload(page) {
  await chooseFull(page, "GameSync Episode Four.mp4");
  await page.locator(".catalogue-card").first().click();
  await page.waitForFunction(
    () => document.querySelector("#catalogueSelectionStatus")?.textContent,
  );
  for (const id of ["targetOnlyfans", "targetFansly", "targetManyvids"]) {
    const box = page.locator(`#${id}`);
    if (await box.isChecked()) await box.uncheck({ force: true });
  }
  await page.locator("#targetPornhubPaid").check({ force: true });
  await page.locator("#contentPreset").selectOption("Straight");
  await page.waitForFunction(
    () => !document.querySelector("#uploadButton").disabled,
  );
}

test("a learned series preset does not make the next Upload fail on changed profiles", async () => {
  await withPage(
    async (page, errors) => {
      await page.evaluate(() => {
        globalThis.CreatorCatalogueClient = {
          loadConfig: async () => ({
            endpoint: "https://script.google.com/fixture",
            secret: "x",
          }),
          getCatalogueSnapshot: async () => ({
            status: "snapshot",
            rows: [
              {
                row: 44,
                id: "gamesync-ep04",
                releaseDate: "2026-12-04",
                title: "GameSync Episode Four",
                description: "Catalogue description",
                seasonArc: "GameSync",
                episode: "4",
                pornhubLink: "",
                onlyfansLink: "",
                fanslyLink: "",
                manyvidsLink: "",
                fingerprint: "1234abcd",
              },
            ],
            emptyRow: { row: 45, fingerprint: "empty-row" },
          }),
        };
        globalThis.CreatorUploadQueueEvidence = { snapshot: () => ({}) };
      });
      await draftPornhubUpload(page);
      await page.locator("#uploadButton").click();
      await page.waitForFunction(() =>
        calls.some((call) => call.type === "START_CREATOR_UPLOAD"),
      );
      await page.waitForFunction(async () => {
        const stored = await chrome.storage.local.get("creatorToolkitV2");
        return Boolean(
          stored.creatorToolkitV2?.profiles?.phUploader?.seriesPresets
            ?.GameSync,
        );
      });
      await page.evaluate(() =>
        document.querySelector("#newUploadDraft").click(),
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#neutralTestStatus")
          .textContent.includes("New upload ready"),
      );
      await draftPornhubUpload(page);
      await page.locator("#uploadButton").click();
      await page.waitForFunction(
        () =>
          calls.filter((call) => call.type === "PREPARE_CREATOR_UPLOAD")
            .length === 2 ||
          /Workflow profiles changed/.test(
            document.querySelector("#uploadError").textContent,
          ),
      );
      assert.doesNotMatch(
        await page.locator("#uploadError").textContent(),
        /Workflow profiles changed/,
      );
      assert.deepEqual(errors, []);
    },
    { init: uploadInit },
  );
});

const queueBlocker =
  "Verify the selected platform queues before automatic publishing, or turn off Publish immediately to prepare drafts.";

async function draftNewClip(page, { pastDate, publishNow, onlyOnlyfans }) {
  await page.locator("#uploadFullVideo").setInputFiles({
    name: "Brand new clip.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("benign fixture"),
  });
  await page.locator("#uploadTitle").fill("Brand new clip");
  await page.locator("#uploadDescription").fill("A benign description.");
  if (onlyOnlyfans)
    for (const id of ["targetFansly", "targetManyvids", "targetPornhub"]) {
      const box = page.locator(`#${id}`);
      if (await box.isChecked()) await box.uncheck({ force: true });
    }
  if (pastDate) await page.locator("#releaseDate").fill("2026-01-02");
  if (publishNow) await page.locator("#mainPublishMode").check();
  await page.waitForFunction(
    () =>
      document.querySelector("#uploadButton").textContent ===
        "Create & upload" && !document.querySelector("#uploadButton").disabled,
  );
}

test("the pre-write queue refusal uses the existing blocker text and writes nothing", async () => {
  await withPage(async (page, errors) => {
    await installDesktopCatalogue(page);
    await draftNewClip(page, { pastDate: true, publishNow: true });
    await page.locator("#uploadButton").click();
    await page.waitForFunction(() =>
      document.querySelector("#uploadError").textContent.startsWith("Verify"),
    );
    assert.equal(await page.evaluate(() => catalogueWrites.length), 0);
    assert.equal(
      await page.evaluate(() =>
        calls.some((call) => call.type === "PREPARE_CREATOR_UPLOAD"),
      ),
      false,
    );
    assert.match(
      await page.locator("#uploadError").textContent(),
      new RegExp("^" + queueBlocker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.deepEqual(errors, []);
  });
});

test("a queue-verified draft that the post-write check would refuse also writes nothing", async () => {
  await withPage(async (page, errors) => {
    await installDesktopCatalogue(page, [], {
      onlyfans: { verified: true, scheduled: [], occupiedFridays: [] },
    });
    await draftNewClip(page, { pastDate: true, publishNow: true });
    await page.locator("#uploadButton").click();
    await page.waitForFunction(() =>
      document.querySelector("#uploadError").textContent.startsWith("Verify"),
    );
    assert.equal(await page.evaluate(() => catalogueWrites.length), 0);
    assert.deepEqual(errors, []);
  });
});

test("a new-pending draft narrower than the default platforms still writes and proceeds", async () => {
  await withPage(async (page, errors) => {
    // Only OnlyFans is selected (the default), the release is a future Friday
    // and Publish immediately is off: admitted before and after this change.
    await installDesktopCatalogue(page);
    await draftNewClip(page, {
      pastDate: false,
      publishNow: false,
      onlyOnlyfans: true,
    });
    await page.locator("#uploadButton").click();
    await page.waitForFunction(
      () =>
        catalogueWrites.length === 1 &&
        document.querySelector("#uploadError").textContent,
    );
    assert.doesNotMatch(
      await page.locator("#uploadError").textContent(),
      /needs review|Verify the selected/,
    );
    assert.deepEqual(errors, []);
  });
});

test("a teaser draft still carrying the main-mode new selection cannot start and writes nothing", async () => {
  await withPage(async (page, errors) => {
    await page.evaluate(() => {
      globalThis.CreatorSocialDistributionRuntimeReady = { x: true };
      globalThis.CreatorSocialTraceEvidence = { x: "f".repeat(64) };
    });
    await installDesktopCatalogue(page);
    await draftNewClip(page, {
      pastDate: false,
      publishNow: false,
      onlyOnlyfans: true,
    });
    await page.evaluate(() => {
      const select = document.querySelector("#catalogueRow");
      select.value = "new";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page
      .locator('input[name="workflowMode"][value="teaser"]')
      .check({ force: true });
    await page.locator("#uploadSocialTeaser").setInputFiles({
      name: "teaser.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("benign fixture"),
    });
    await page.locator("#socialCaption").fill("A benign caption");
    await page.locator("#targetSocialX").check({ force: true });
    await page.evaluate(() => {
      const select = document.querySelector("#socialPaidLink");
      select.value = "custom";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page
      .locator("#socialCustomPaidLink")
      .fill("https://onlyfans.com/1/johnny_guides");
    await page.locator("#findCatalogueEntry").click({ force: true });
    await page.waitForFunction(() =>
      document
        .querySelector("#matchStatus")
        .textContent.includes("Confirm one exact catalogue episode"),
    );
    // The pending row has no sheet row yet, so the social draft is invalid
    // and Upload stays unavailable, exactly as before this change.
    assert.equal(await page.locator("#uploadButton").isDisabled(), true);
    assert.equal(await page.evaluate(() => catalogueWrites.length), 0);
    assert.deepEqual(errors, []);
  });
});

test("the console source carries no schedule wording that was not there before", async () => {
  for (const file of [
    "../../extensions/personal/upload-console.js",
    "../../dist/extensions/personal/upload-console.js",
  ])
    assert.equal(
      fs
        .readFileSync(path.join(__dirname, file), "utf8")
        .includes(
          "The upload schedule needs review. Check the selected destinations before clicking Upload again",
        ),
      false,
    );
});

async function refreshFixture(page) {
  await page.evaluate(() => {
    globalThis.refreshGates = [];
    globalThis.catalogueWrites = [];
    const created = {
      row: 43,
      id: "created",
      itemId: "created",
      title: "Brand new clip",
      description: "A benign description.",
      releaseDate: "2026-01-02",
      fingerprint: "b".repeat(64),
      publicationState: {},
    };
    globalThis.CreatorCatalogueClient = {
      loadConfig: async () => ({ source: "desktop", connected: true }),
      getCatalogueSnapshot() {
        if (globalThis.gateNextSnapshot) {
          globalThis.gateNextSnapshot = false;
          const entry = gate();
          refreshGates.push(entry);
          return entry.promise;
        }
        return Promise.resolve({
          status: "snapshot",
          source: "desktop",
          rows: catalogueWrites.length ? [created] : [],
        });
      },
      writeUploadCatalogueEntry: async (value) => {
        catalogueWrites.push(value);
        return { id: "created", row: 43, status: "created" };
      },
    };
    globalThis.CreatorUploadQueueEvidence = { snapshot: () => ({}) };
  });
}

test("a refresh resolving during Upload cannot replace the snapshot or re-enable Refresh", async () => {
  await withPage(
    async (page, errors) => {
      await refreshFixture(page);
      await draftNewClip(page, {
        pastDate: false,
        publishNow: false,
        onlyOnlyfans: true,
      });
      await page.evaluate(() => {
        globalThis.gateNextSnapshot = true;
        document.querySelector("#refreshCatalogue").click();
      });
      await page.waitForFunction(() => refreshGates.length === 1);
      await page.locator("#uploadButton").click();
      await page.waitForFunction(() =>
        calls.some((call) => call.type === "PREPARE_CREATOR_UPLOAD"),
      );
      const before = await page.locator("#catalogueRow").textContent();
      assert.match(before, /Brand new clip/);
      await page.evaluate(() =>
        refreshGates[0].release({
          status: "snapshot",
          source: "desktop",
          rows: [],
        }),
      );
      await page.waitForTimeout(300);
      assert.equal(await page.locator("#catalogueRow").textContent(), before);
      assert.equal(await page.locator("#refreshCatalogue").isDisabled(), true);
      await page.evaluate(() => globalThis.prepareGate.release());
      await page.waitForFunction(() =>
        document
          .querySelector("#matchStatus")
          .textContent.includes("Run accepted"),
      );
      assert.equal(await page.locator("#refreshCatalogue").isDisabled(), true);
      assert.deepEqual(errors, []);
    },
    {
      init: () => {
        globalThis.prepareGate = gate();
        globalThis.fixtureSend = (message, callback) => {
          if (message.type === "CHECK_CREATOR_UPLOAD_AVAILABILITY")
            return callback({ ok: true, availability: { ready: true } });
          if (message.type === "PREPARE_CREATOR_UPLOAD")
            return void prepareGate.promise.then(() =>
              callback({
                ok: true,
                uploadSession: {
                  sessionId: message.sessionId,
                  platforms: message.targets.map((platform) => ({
                    platform,
                    status: "prepared",
                  })),
                },
              }),
            );
          if (message.type === "START_CREATOR_UPLOAD")
            return callback({ ok: true, accepted: true, results: [] });
          callback({
            ok: true,
            sessions: [],
            records: [],
            creatorTools: { registered: [], skipped: [] },
          });
        };
      },
    },
  );
});

test("a refresh with no upload running updates the snapshot and re-enables Refresh", async () => {
  await withPage(async (page, errors) => {
    await refreshFixture(page);
    await page.locator("#uploadFullVideo").setInputFiles({
      name: "Studio walk.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("benign fixture"),
    });
    await page.waitForFunction(
      () => !document.querySelector("#cataloguePicker").hidden,
    );
    await page.evaluate(() => {
      globalThis.gateNextSnapshot = true;
      document.querySelector("#refreshCatalogue").click();
    });
    await page.waitForFunction(() => refreshGates.length === 1);
    assert.equal(await page.locator("#refreshCatalogue").isDisabled(), true);
    await page.evaluate(() =>
      refreshGates[0].release({
        status: "snapshot",
        source: "desktop",
        rows: [
          {
            row: 50,
            id: "refreshed",
            itemId: "refreshed",
            title: "RefreshedRow",
            description: "",
            releaseDate: "2026-09-25",
            fingerprint: "c".repeat(64),
            publicationState: {},
          },
        ],
      }),
    );
    await page.waitForFunction(() =>
      document
        .querySelector("#catalogueRow")
        .textContent.includes("RefreshedRow"),
    );
    await page.waitForFunction(
      () => !document.querySelector("#refreshCatalogue").disabled,
    );
    assert.deepEqual(errors, []);
  });
});

test("Use this frame records the opening-frame time captured at click", async () => {
  await withPage(
    async (page, errors) => {
      await mockFrameDialog(page);
      await installDesktopCatalogue(page);
      await page.evaluate(() => {
        globalThis.openingFrames = [];
        globalThis.OFEnhancerDesktopUpload = {
          prepareOpeningFrame: async (_file, frame) => {
            openingFrames.push(frame.seconds);
            return "a".repeat(48);
          },
          deliverFile: async () => {},
        };
      });
      await draftNewClip(page, {
        pastDate: false,
        publishNow: false,
        onlyOnlyfans: true,
      });
      await page.locator("#chooseThumbnailFrame").click({ force: true });
      await page.waitForFunction(() => metadataGates.length === 1);
      await page.evaluate(() => metadataGates[0].release(10));
      await page.waitForFunction(
        () => !document.querySelector("#useThumbnailFrame").disabled,
      );
      await page.evaluate(() => {
        document.querySelector("#useOpeningFrame").checked = true;
        document.querySelector("#thumbnailFrameVideo").currentTime = 4;
        document.querySelector("#useThumbnailFrame").click();
      });
      await page.waitForFunction(() => thumbnailGates.length === 1);
      await page.evaluate(() => {
        document.querySelector("#thumbnailFrameVideo").currentTime = 7;
        thumbnailGates[0].release(
          new File(["frame"], "frame.png", { type: "image/png" }),
        );
      });
      await page.waitForFunction(
        () => !document.querySelector("#thumbnailFrameDialog").open,
      );
      await page.waitForFunction(
        () => !document.querySelector("#uploadButton").disabled,
      );
      await page.locator("#uploadButton").click();
      await page.waitForFunction(() => openingFrames.length === 1);
      assert.deepEqual(await page.evaluate(() => openingFrames), [4]);
      assert.deepEqual(errors, []);
    },
    { init: uploadInit },
  );
});

test("a social association save cannot apply to a session that replaced it", async () => {
  await withPage(
    async (page, errors) => {
      await page.evaluate(() => {
        globalThis.CreatorSocialDistributionRuntimeReady = { x: true };
        globalThis.CreatorSocialTraceEvidence = { x: "f".repeat(64) };
        globalThis.CreatorCatalogueClient = {
          loadConfig: async () => ({ source: "desktop", connected: true }),
          getCatalogueSnapshot: async () => ({
            status: "snapshot",
            source: "desktop",
            rows: [
              {
                row: 42,
                id: "studio",
                title: "Studio tour",
                fingerprint: "a".repeat(64),
                publicationState: {},
              },
            ],
          }),
        };
      });
      await page
        .locator('input[name="workflowMode"][value="teaser"]')
        .check({ force: true });
      await page.locator("#uploadSocialTeaser").setInputFiles({
        name: "teaser.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.from("benign fixture"),
      });
      await page.locator("#socialCaption").fill("A benign caption");
      await page.locator("#targetSocialX").check({ force: true });
      await page.evaluate(() => {
        const select = document.querySelector("#socialPaidLink");
        select.value = "custom";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page
        .locator("#socialCustomPaidLink")
        .fill("https://onlyfans.com/1/johnny_guides");
      await page.waitForFunction(
        () => !document.querySelector("#uploadButton").disabled,
      );
      await page.locator("#uploadButton").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#matchStatus")
          .textContent.includes("Run accepted"),
      );
      await page.evaluate(() => {
        document.querySelector("#loadAssociationRows").click();
      });
      await page.waitForFunction(
        () => document.querySelector("#savedCatalogueRow").options.length > 1,
      );
      await page.evaluate(() => {
        const select = document.querySelector("#savedCatalogueRow");
        select.value = "42";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        document.querySelector("#associateSavedResults").click();
      });
      await page.waitForFunction(
        () => globalThis.socialAssociations?.length === 1,
      );
      await page.evaluate(() =>
        document.querySelector("#newUploadDraft").click(),
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#neutralTestStatus")
          .textContent.includes("New upload ready"),
      );
      await page.evaluate(() => socialAssociations[0].release());
      await page.waitForTimeout(300);
      assert.equal(await page.locator("#results").textContent(), "");
      assert.doesNotMatch(
        await page.locator("#savedAssociationStatus").textContent(),
        /Association saved/,
      );
      assert.equal(
        await page.evaluate(
          () =>
            calls.filter(
              (call) => call.type === "ASSOCIATE_CREATOR_SOCIAL_CATALOGUE",
            ).length,
        ),
        1,
      );
      assert.deepEqual(errors, []);
    },
    {
      init: () => {
        globalThis.fixtureSend = (message, callback) => {
          if (message.type === "ASSOCIATE_CREATOR_SOCIAL_CATALOGUE") {
            const entry = gate();
            globalThis.socialAssociations = [
              ...(globalThis.socialAssociations || []),
              entry,
            ];
            return void entry.promise.then(() =>
              callback({
                ok: true,
                socialDistribution: {
                  jobs: { x: { stage: "sheet-complete" } },
                },
              }),
            );
          }
          if (message.type === "START_NEW_CREATOR_UPLOAD")
            return callback({ ok: true, reset: true });
          if (message.type === "CHECK_CREATOR_UPLOAD_AVAILABILITY")
            return callback({ ok: true, availability: { ready: true } });
          callback({
            ok: true,
            sessions: [],
            records: [],
            creatorTools: { registered: [], skipped: [] },
          });
        };
      },
    },
  );
});

test("a ready pre-write proposal does not hide a post-write queue refusal", async () => {
  await withPage(async (page, errors) => {
    // Only OnlyFans is selected and its queue is verified, so the pending
    // proposal is ready. Fansly is unverified and the write step's own
    // inputs still need queue evidence, which must be refused before the write.
    await installDesktopCatalogue(page, [], {
      onlyfans: { verified: true, scheduled: [], occupiedFridays: [] },
      fansly: { verified: false, scheduled: [], occupiedFridays: [] },
    });
    // Unchecked without a change event, so the destination list the proposal
    // uses for executable platforms is still the default one.
    await page.evaluate(() => {
      for (const id of ["targetFansly", "targetManyvids", "targetPornhub"])
        document.querySelector("#" + id).checked = false;
    });
    await draftNewClip(page, { pastDate: true, publishNow: true });
    await page.locator("#uploadButton").click();
    await page.waitForFunction(() =>
      document.querySelector("#uploadError").textContent.startsWith("Verify"),
    );
    assert.equal(await page.evaluate(() => catalogueWrites.length), 0);
    assert.equal(
      (await page.locator("#uploadError").textContent()).startsWith(
        queueBlocker,
      ),
      true,
    );
    assert.deepEqual(errors, []);
  });
});

test("a refresh resolving during Resume cannot replace the snapshot or re-enable Refresh", async () => {
  await withPage(
    async (page, errors) => {
      await page.locator("#resumeUpload").waitFor({ state: "visible" });
      await page.evaluate(mockGeneratedMedia, { failThumbnail: false });
      await refreshFixture(page);
      await selectSavedFull(page);
      await page.waitForFunction(
        () => !document.querySelector("#cataloguePicker").hidden,
      );
      const before = await page.locator("#catalogueRow").textContent();
      await page.evaluate(() => {
        globalThis.gateNextSnapshot = true;
        document.querySelector("#refreshCatalogue").click();
      });
      await page.waitForFunction(() => refreshGates.length === 1);
      // Resume keeps its media load pending, so it holds the busy claim.
      await page.evaluate(() =>
        document.querySelector("#resumeUpload").click(),
      );
      await page.waitForFunction(() => mediaLoads.length === 1);
      await page.evaluate(() =>
        refreshGates[0].release({
          status: "snapshot",
          source: "desktop",
          rows: [
            {
              row: 50,
              id: "refreshed",
              itemId: "refreshed",
              title: "RefreshedRow",
              description: "",
              releaseDate: "2026-09-25",
              fingerprint: "c".repeat(64),
              publicationState: {},
            },
          ],
        }),
      );
      await page.waitForTimeout(300);
      const after = await page.locator("#catalogueRow").textContent();
      assert.equal(after, before);
      assert.doesNotMatch(after, /RefreshedRow/);
      // Once Resume finishes it locks the draft, and Refresh stays disabled.
      await page.evaluate(() => globalThis.mediaGate.release());
      await page.waitForFunction(() =>
        document
          .querySelector("#matchStatus")
          .textContent.includes("Reconnected"),
      );
      assert.equal(await page.locator("#refreshCatalogue").isDisabled(), true);
      assert.deepEqual(errors, []);
    },
    { init: resumeInit },
  );
});

test("the queue refusal text is written once in the console source", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../extensions/personal/upload-console.js"),
    "utf8",
  );
  assert.equal(source.split(`"${queueBlocker}"`).length - 1, 1);
});
