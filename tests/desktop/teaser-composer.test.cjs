"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { chromium } = require("../support/browser.cjs");
const { repositoryRoot, personalRoot } = require("../support/paths.cjs");

const DAY = "2026-10-06";
const SESSION = "a".repeat(48);
const VIDEO =
  process.env.OFENHANCER_TEASER_REVIEW_VIDEO ||
  path.join(repositoryRoot, "tests/fixtures/teaser-hub/preview-test.mp4");
let server;
let origin;
let browser;

const hostPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app/teaser-dashboard.css"></head><body>
<button id="open-day">Open Tuesday</button><script src="/app/teaser-draft-store.js"></script><script src="/app/teaser-composer.js"></script><script>
document.querySelector('#open-day').addEventListener('click', () => OFEnhancerTeaserComposer.open({date:'${DAY}',episodes:[],request:async op=>op==='getTeaserClips'?{clips:[]}:{ok:true}}));
</script></body></html>`;

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

before(async () => {
  if (!fs.existsSync(VIDEO))
    throw new Error(`Missing generated benign test video: ${VIDEO}`);
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/host") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(hostPage);
      return;
    }
    const file = path.resolve(personalRoot, `.${decodeURIComponent(pathname)}`);
    if (
      !file.startsWith(`${personalRoot}${path.sep}`) ||
      !fs.existsSync(file) ||
      fs.statSync(file).isDirectory()
    ) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": contentType(file) });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function mount(page, linked = false) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(12_000);
  await page.addInitScript((linked) => {
    const values = {};
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
        lastError: null,
        getManifest: () => ({ version: "test" }),
        getURL: (path) => `${location.origin}/${path}`,
        connect(info) {
          const listeners = [];
          return {
            name: info?.name,
            onMessage: { addListener: (listener) => listeners.push(listener) },
            onDisconnect: { addListener() {} },
            postMessage(message) {
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
            disconnect() {},
          };
        },
        sendMessage(message, callback) {
          const result =
            message?.type === "CHECK_CREATOR_UPLOAD_AVAILABILITY"
              ? { ok: true, availability: { ready: true } }
              : {
                  ok: true,
                  sessions: [],
                  creatorTools: { registered: [], skipped: [] },
                };
          queueMicrotask(() => callback?.(result));
          return Promise.resolve(result);
        },
      },
      permissions: {
        request: async () => true,
        contains(_permissions, callback) {
          callback?.(true);
          return Promise.resolve(true);
        },
      },
    };
    globalThis.CreatorCatalogueClient = {
      loadConfig: async () => ({ connected: linked }),
      getCatalogueSnapshot: async () => ({
        source: "desktop",
        status: "snapshot",
        rows: linked
          ? [
              {
                row: 2,
                id: "preview-test",
                itemId: "preview-test",
                title: "Preview test",
                description: "A synthetic episode",
                releaseDate: "2026-10-01",
                fingerprint: "a".repeat(64),
                publicationState: {},
                onlyfansLink: "https://onlyfans.com/1/preview",
              },
            ]
          : [],
        emptyRow: { row: 3 },
      }),
    };
  }, linked);
  await page.goto(`${origin}/host`);
  await page.locator("#open-day").click();
  await page.locator(".xt-clip-choices").waitFor();
  return errors;
}

async function chooseSyntheticVideo(page) {
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".xt-clip-add").click();
  await (await chooser).setFiles(VIDEO);
  await page.locator(".xt-composer-frame").waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(".xt-composer-frame")
      ?.contentWindow?.location.href.includes("upload-console.html?teaserDay="),
  );
  const frame = page
    .frames()
    .find((item) => item.url().includes("upload-console.html?teaserDay="));
  assert.ok(frame, "real built Upload Hub iframe should load");
  await frame.waitForFunction(() =>
    document
      .querySelector("#socialFileSummary")
      ?.textContent.includes("preview-test.mp4"),
  );
  await frame.waitForFunction(
    () =>
      document.querySelector(".teaser-thumbnail-panel img")?.naturalWidth > 0,
    null,
    { timeout: 20_000 },
  );
  await frame.waitForFunction(
    () => document.querySelector(".teaser-video-preview")?.readyState >= 2,
  );
  return frame;
}

test("day chooser embeds the real Upload Hub, saves a first-frame teaser, and restores the same day", async () => {
  const page = await browser.newPage({
    viewport: { width: 1365, height: 960 },
  });
  try {
    const errors = await mount(page, true);
    const frame = await chooseSyntheticVideo(page);
    assert.equal(
      await frame.locator("#socialHeading").textContent(),
      "Twitter teaser",
    );
    assert.match(
      await page.locator(".xt-composer-heading h2").textContent(),
      /Preview test/,
    );
    const layout = await frame
      .locator(".teaser-video-preview")
      .evaluate((video) => {
        const media = video.getBoundingClientRect();
        const posts = document
          .querySelector(".teaser-planner-posts")
          .getBoundingClientRect();
        return {
          square: Math.abs(media.width - media.height) < 1,
          postsOnRight: posts.left > media.right,
        };
      });
    assert.equal(layout.square, true, "video preview remains square");
    await frame
      .getByRole("button", { name: "Choose frame", exact: true })
      .click();
    await frame.locator("#useThumbnailFrame").waitFor();
    await frame.waitForFunction(
      () => !document.querySelector("#useThumbnailFrame").disabled,
    );
    assert.ok(
      await frame.locator("#thumbnailFrameStrip").evaluate((strip) => {
        const bounds = strip.getBoundingClientRect();
        const footer = strip
          .closest("dialog")
          .querySelector(".file-actions")
          .getBoundingClientRect();
        return bounds.bottom <= footer.top && bounds.top >= 0;
      }),
      "frame timeline remains visible above the action row",
    );
    if (process.env.OFENHANCER_TEASER_SCREENSHOTS) {
      await page.screenshot({
        path: path.join(
          process.env.OFENHANCER_TEASER_SCREENSHOTS,
          "frame-picker-desktop.png",
        ),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await frame
          .locator("#thumbnailFrameDialog")
          .evaluate(
            (dialog) => dialog.getBoundingClientRect().right <= innerWidth,
          ),
      );
      await page.screenshot({
        path: path.join(
          process.env.OFENHANCER_TEASER_SCREENSHOTS,
          "frame-picker-phone.png",
        ),
      });
      await page.setViewportSize({ width: 1365, height: 960 });
    }
    await frame.locator("#useThumbnailFrame").click();
    await frame.waitForFunction(
      () => !document.querySelector("#thumbnailFrameDialog").open,
    );
    assert.equal(
      layout.postsOnRight,
      true,
      "destination posts use the space beside the preview",
    );
    assert.equal(
      await frame
        .locator(".teaser-thumbnail-panel img")
        .evaluate((image) => image.naturalWidth),
      640,
    );
    assert.equal(
      await frame
        .locator(".teaser-thumbnail-panel img")
        .evaluate((image) => image.naturalHeight),
      640,
      "first-frame poster matches the square teaser layout",
    );
    assert.equal(
      await frame.locator(".teaser-thumbnail-panel .hint").count(),
      0,
    );
    assert.equal(
      await frame
        .getByRole("button", { name: "Send to Twitter", exact: true })
        .evaluate(
          (button) => button.getBoundingClientRect().bottom <= innerHeight,
        ),
      true,
      "Send stays visible without scrolling",
    );
    const row = await frame
      .locator(".teaser-schedule-row > *")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().bottom),
      );
    assert.equal(
      new Set(row.map(Math.round)).size,
      1,
      "time, reply and link share one row",
    );
    await frame.locator("#socialCaption").fill("A benign scheduled teaser");
    await frame.getByLabel("Posting time", { exact: true }).fill("19:20");
    await frame.getByLabel("Reply (min)", { exact: true }).fill("23");
    await frame.locator("#saveTeaserDraft").click();
    await page.waitForFunction(
      () =>
        document.querySelector(".xt-composer-status")?.textContent ===
        "Draft saved for this day.",
    );
    const saved = await frame.evaluate(async () => {
      const draft = await OFEnhancerTeaserDrafts.get("2026-10-06");
      return {
        date: draft.date,
        name: draft.file.name,
        caption: draft.caption,
        time: draft.time,
        thumbnailType: draft.thumbnail.type,
        thumbnailSize: draft.thumbnail.size,
        episodeKey: draft.episodeKey,
      };
    });
    assert.deepEqual(
      { ...saved, thumbnailSize: undefined },
      {
        date: DAY,
        name: "preview-test.mp4",
        caption: "A benign scheduled teaser",
        time: "19:20",
        thumbnailType: "image/png",
        thumbnailSize: undefined,
        episodeKey: "preview-test",
      },
    );
    assert.equal(
      await frame.locator("#socialPaidLink").inputValue(),
      "https://onlyfans.com/1/preview",
    );
    assert.ok(saved.thumbnailSize > 0);
    assert.match(
      await page.locator(".xt-composer-dialog").getAttribute("aria-label"),
      /Tuesday, Oct 6/,
    );

    const screenshotDir = path.join(
      repositoryRoot,
      "artifacts",
      "teaser-hub-review",
    );
    fs.mkdirSync(screenshotDir, { recursive: true });
    await frame.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
    await page.screenshot({
      path: path.join(screenshotDir, "upload-hub-desktop.png"),
      fullPage: true,
    });
    await frame.locator("#uploadActions").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(screenshotDir, "upload-hub-details.png"),
      fullPage: true,
    });
    assert.deepEqual(
      errors,
      [],
      "actual embedded Upload Hub should not produce page errors",
    );

    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#open-day").click();
    await page.locator(".xt-composer-frame").waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector(".xt-composer-frame")
        ?.contentWindow?.location.href.includes(
          "upload-console.html?teaserDay=",
        ),
    );
    const restored = page
      .frames()
      .find((item) =>
        new URL(item.url()).pathname.endsWith("/upload-console.html"),
      );
    assert.ok(restored);
    await restored.waitForFunction(
      () =>
        document.querySelector("#socialCaption")?.value ===
        "A benign scheduled teaser",
    );
    assert.equal(
      await restored.getByLabel("Posting time", { exact: true }).inputValue(),
      "19:20",
    );
    assert.match(
      await page.locator(".xt-composer-dialog").getAttribute("aria-label"),
      /Tuesday, Oct 6/,
    );
    assert.deepEqual(errors, []);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".xt-composer-dialog").waitFor({ state: "detached" });
    await page.evaluate(() =>
      OFEnhancerTeaserComposer.open({
        date: "2026-10-07",
        request: async () => ({ clips: [] }),
      }),
    );
    await page.locator(".xt-clip-choices").waitFor();
    const nextDay = await chooseSyntheticVideo(page);
    assert.equal(
      await nextDay.getByLabel("Posting time", { exact: true }).inputValue(),
      "19:20",
      "new day remembers the last posting time",
    );
    assert.equal(
      await nextDay.getByLabel("Reply (min)", { exact: true }).inputValue(),
      "23",
    );
    assert.equal(
      await nextDay.locator("#socialPaidLink").inputValue(),
      "https://onlyfans.com/1/preview",
    );
    assert.notEqual(
      await nextDay.locator("#socialCaption").inputValue(),
      "A benign scheduled teaser",
      "caption belongs to the day draft",
    );
  } finally {
    await page.close();
  }
});

test("indexed clip opens editing before transfer and keeps caption edits when the verified file arrives", async () => {
  const page = await browser.newPage();
  try {
    const errors = await mount(page, true);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".xt-composer-dialog").waitFor({ state: "detached" });
    const bytes = fs.readFileSync(VIDEO);
    const sha256 = require("node:crypto")
      .createHash("sha256")
      .update(bytes)
      .digest("hex");
    await page.evaluate(
      ({ day, size, sha256 }) => {
        const episode = { sourceKey: "preview-test", title: "Preview test" };
        const clip = {
          clipId: 1,
          name: "preview-test.mp4",
          episodeKey: episode.sourceKey,
          size,
          sha256,
          lastModified: 1,
        };
        globalThis.__clipTransfer = new Promise((resolve) => {
          globalThis.__finishClip = resolve;
        });
        void OFEnhancerTeaserComposer.open({
          date: day,
          episode,
          episodes: [episode],
          request: async (operation) =>
            operation === "getTeaserClips"
              ? { clips: [clip] }
              : globalThis.__clipTransfer,
        });
      },
      { day: DAY, size: bytes.length, sha256 },
    );
    await page
      .locator('.xt-clip-choice[data-episode-key="preview-test"]')
      .click();
    const frame = page.frameLocator(".xt-composer-frame");
    await frame
      .locator("#socialCaption")
      .fill("Caption written while the clip loads");
    assert.equal(
      await frame
        .getByRole("button", { name: "Save draft", exact: true })
        .isDisabled(),
      true,
    );
    await page.evaluate(
      ({ chunk, size, sha256 }) =>
        globalThis.__finishClip({
          offset: 0,
          size,
          sha256,
          name: "preview-test.mp4",
          token: "test",
          chunk,
          done: true,
        }),
      { chunk: bytes.toString("base64"), size: bytes.length, sha256 },
    );
    await frame.locator(".teaser-video-preview").waitFor({ state: "visible" });
    assert.equal(
      await frame.locator("#socialCaption").inputValue(),
      "Caption written while the clip loads",
    );
    assert.equal(
      await frame
        .getByRole("button", { name: "Save draft", exact: true })
        .isEnabled(),
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("teaser editor fits a phone viewport and keeps draft actions reachable", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    const errors = await mount(page, true);
    const frame = await chooseSyntheticVideo(page);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.equal(
      await frame.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.ok(
      await page
        .locator(".xt-composer-heading h2")
        .evaluate(
          (title) =>
            title.getBoundingClientRect().width > 100 &&
            title.getBoundingClientRect().height > 0,
        ),
      "episode title remains visible above mobile header actions",
    );
    await frame.locator("#saveTeaserDraft").scrollIntoViewIfNeeded();
    assert.equal(await frame.locator("#saveTeaserDraft").isVisible(), true);
    await page.screenshot({
      path: path.join(
        repositoryRoot,
        "artifacts/teaser-hub-review/upload-hub-mobile.png",
      ),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("main uploader uses one compact social publishing checkbox", async () => {
  const page = await browser.newPage({
    viewport: { width: 1365, height: 960 },
  });
  try {
    const errors = await mount(page, true);
    await page.goto(`${origin}/upload-console.html`);
    await page.locator('input[name="workflowMode"][value="teaser"]').check();
    const automatic = page.getByRole("checkbox", {
      name: "Send automatically",
      exact: true,
    });
    await automatic.waitFor();
    assert.equal(await page.locator('input[name="socialMode"]').count(), 1);
    assert.equal(await automatic.isChecked(), false);
    await automatic.check();
    assert.equal(await automatic.isChecked(), true);
    await automatic.uncheck();
    await page.locator("#uploadSocialTeaser").setInputFiles(VIDEO);
    await automatic.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(
        repositoryRoot,
        "artifacts/teaser-hub-review/main-uploader-checkbox.png",
      ),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("episode without a teaser opens its folder and accepts a video in the same day modal", async () => {
  const page = await browser.newPage({
    viewport: { width: 1365, height: 960 },
  });
  try {
    const errors = await mount(page, true);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".xt-composer-dialog").waitFor({ state: "detached" });
    await page.evaluate(() => {
      window.folderRequests = [];
      window.OFEnhancerHost = {
        request: async (op, payload) => {
          window.folderRequests.push({ op, payload });
          return op === "getTeaserClips" ? { clips: [] } : { ok: true };
        },
      };
      return OFEnhancerTeaserComposer.open({
        date: "2026-10-06",
        episodes: [{ sourceKey: "preview-test", title: "Preview test" }],
        request: OFEnhancerHost.request,
      });
    });
    await page.locator(".xt-episode-choice").click();
    await page.locator(".xt-composer-frame").waitFor();
    const frame =
      page
        .frames()
        .find((item) =>
          item.url().includes("upload-console.html?teaserDay="),
        ) ||
      (await new Promise((resolve) => page.once("framenavigated", resolve)));
    await page.getByRole("button", { name: "Open episode folder" }).waitFor();
    assert.equal(
      await frame
        .getByRole("button", { name: "Link episode", exact: true })
        .isVisible(),
      false,
    );
    const automatic = frame.getByRole("checkbox", {
      name: "Send automatically",
      exact: true,
    });
    await automatic.check();
    assert.equal(await automatic.isChecked(), true);
    await automatic.uncheck();
    assert.equal(await automatic.isChecked(), false);
    await page.getByRole("button", { name: "Open episode folder" }).click();
    assert.deepEqual(
      await page.evaluate(() =>
        window.folderRequests.filter(
          (item) => item.op === "openTeaserEpisodeFolder",
        ),
      ),
      [
        {
          op: "openTeaserEpisodeFolder",
          payload: { episodeKey: "preview-test" },
        },
      ],
    );
    assert.equal(
      await frame.locator(".teaser-video-preview").isVisible(),
      false,
    );
    assert.equal(await frame.locator("#socialErrors").textContent(), "");
    assert.equal(await frame.locator("#matchStatus").textContent(), "");
    assert.ok(
      await page
        .locator(".xt-episode-folder")
        .evaluate(
          (folder) =>
            folder.parentElement.classList.contains("xt-composer-heading") &&
            folder.nextElementSibling.textContent === "Close",
        ),
      "episode folder shortcut sits at the top right beside Close",
    );
    await page.screenshot({
      path: path.join(
        repositoryRoot,
        "artifacts/teaser-hub-review/episode-without-teaser.png",
      ),
      fullPage: true,
    });
    await frame.locator("#uploadSocialTeaser").setInputFiles(VIDEO);
    await frame.waitForFunction(
      () =>
        document.querySelector(".teaser-thumbnail-panel img")?.naturalWidth > 0,
    );
    await frame.locator("#saveTeaserDraft").click();
    await page.waitForFunction(
      () =>
        document.querySelector(".xt-composer-status")?.textContent ===
        "Draft saved for this day.",
    );
    assert.equal(
      await frame.evaluate(
        async () => (await OFEnhancerTeaserDrafts.get("2026-10-06")).episodeKey,
      ),
      "preview-test",
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("unavailable indexed teaser offers the linked episode folder", async () => {
  const page = await browser.newPage();
  try {
    await mount(page, true);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".xt-composer-dialog").waitFor({ state: "detached" });
    await page.evaluate(() => {
      window.OFEnhancerHost = {
        request: async (op) => {
          if (op === "getTeaserClips")
            return {
              clips: [
                {
                  clipId: 1,
                  episodeKey: "preview-test",
                  name: "missing.mp4",
                  size: 100,
                  state: "ready",
                },
              ],
            };
          if (op === "getTeaserClipChunk")
            throw new Error("This teaser is unavailable.");
          return { ok: true };
        },
      };
      return OFEnhancerTeaserComposer.open({
        date: "2026-10-06",
        episodes: [{ sourceKey: "preview-test", title: "Preview test" }],
        request: OFEnhancerHost.request,
      });
    });
    await page
      .locator('.xt-clip-choice[data-episode-key="preview-test"]')
      .click();
    await page.locator(".xt-composer-frame").waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector(".xt-composer-status")
        ?.textContent.includes("Open the episode folder"),
    );
    const frame =
      page
        .frames()
        .find((item) =>
          item.url().includes("upload-console.html?teaserDay="),
        ) ||
      (await new Promise((resolve) => page.once("framenavigated", resolve)));
    await page.getByRole("button", { name: "Open episode folder" }).waitFor();
    await frame
      .getByRole("button", { name: "Choose replacement video" })
      .waitFor({ state: "visible" });
  } finally {
    await page.close();
  }
});

test("draft store rejects impossible days and times and locks a draft after execution starts", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/host`);
    const result = await page.evaluate(async (sessionId) => {
      const file = new File(["synthetic video"], "safe.mp4", {
        type: "video/mp4",
      });
      const attempt = async (draft) => {
        try {
          await OFEnhancerTeaserDrafts.save({
            date: "2026-10-06",
            file,
            caption: "safe",
            ...draft,
          });
          return false;
        } catch {
          return true;
        }
      };
      const impossibleDay = await attempt({ date: "2026-02-30" });
      const impossibleTime = await attempt({ time: "25:99" });
      await OFEnhancerTeaserDrafts.save({
        date: "2026-10-06",
        file,
        caption: "safe",
      });
      await OFEnhancerTeaserDrafts.checkpoint(
        "2026-10-06",
        "preparing",
        sessionId,
      );
      const lockedOverwrite = await attempt({ caption: "overwrite" });
      return { impossibleDay, impossibleTime, lockedOverwrite };
    }, SESSION);
    assert.deepEqual(result, {
      impossibleDay: true,
      impossibleTime: true,
      lockedOverwrite: true,
    });
  } finally {
    await page.close();
  }
});

test("composer ignores forged messages and prevents closing while upload is running", async () => {
  const page = await browser.newPage();
  try {
    const errors = await mount(page);
    const frame = await chooseSyntheticVideo(page);
    await frame.evaluate(() => {
      window.__contextMessages = 0;
      addEventListener("message", (event) => {
        if (event.data?.type === "ofenhancer:teaser-context")
          window.__contextMessages++;
      });
    });
    await page.evaluate(() => {
      const sibling = document.createElement("iframe");
      sibling.hidden = true;
      sibling.src = "/host";
      document.body.append(sibling);
      sibling.addEventListener(
        "load",
        () =>
          sibling.contentWindow.postMessage(
            { type: "ofenhancer:teaser-ready" },
            location.origin,
          ),
        { once: true },
      );
    });
    await page.waitForTimeout(50);
    assert.equal(await frame.evaluate(() => window.__contextMessages), 0);
    await frame.evaluate(() =>
      parent.postMessage(
        { type: "ofenhancer:teaser-running", running: true },
        location.origin,
      ),
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(
      await page
        .locator(".xt-composer-dialog")
        .evaluate((dialog) => dialog.open),
      true,
    );
    assert.match(
      await page.locator(".xt-composer-status").textContent(),
      /Keep this window open/,
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("dropping a video opens the inherited calendar day without a date picker", async () => {
  const page = await browser.newPage();
  try {
    const errors = await mount(page);
    const bytes = fs.readFileSync(VIDEO);
    await page.locator(".xt-clip-choices").evaluate((grid, encoded) => {
      const binary = atob(encoded);
      const payload = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      const data = new DataTransfer();
      data.items.add(
        new File([payload], "preview-test.mp4", { type: "video/mp4" }),
      );
      grid.dispatchEvent(
        new DragEvent("dragover", {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
        }),
      );
      grid.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, bytes.toString("base64"));
    await page.locator(".xt-composer-frame").waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector(".xt-composer-frame")
        ?.src.includes("upload-console.html?teaserDay="),
    );
    const frame = page
      .frames()
      .find((item) =>
        new URL(item.url()).pathname.endsWith("/upload-console.html"),
      );
    assert.ok(
      frame,
      `upload hub frame should be attached: ${JSON.stringify(page.frames().map((item) => item.url()))}`,
    );
    await frame.waitForFunction(() =>
      document
        .querySelector("#socialFileSummary")
        ?.textContent.includes("preview-test.mp4"),
    );
    assert.match(
      await page.locator(".xt-composer-dialog").getAttribute("aria-label"),
      /Tuesday, Oct 6/,
    );
    assert.equal(
      await page.locator('.xt-composer-content input[type="date"]').count(),
      0,
    );
    assert.equal(await frame.locator("#teaserDay").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Reddit drafts keep separate clips and titles without replacing the Twitter checkpoint", async () => {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 950 },
  });
  try {
    const errors = await mount(page, true);
    const x = await chooseSyntheticVideo(page);
    await x.locator("#socialCaption").fill("Twitter caption");
    await x.locator("#saveTeaserDraft").click();
    await page.waitForFunction(() =>
      document
        .querySelector(".xt-composer-status")
        .textContent.includes("Draft saved"),
    );
    await page.evaluate(
      async ({ DAY, SESSION }) => {
        await OFEnhancerTeaserDrafts.checkpoint(DAY, "preparing", SESSION);
        await OFEnhancerTeaserDrafts.checkpoint(DAY, "prepared", SESSION);
      },
      { DAY, SESSION },
    );
    await x.evaluate(() => {
      CreatorCatalogueClient.getSubredditPresetSnapshot = async () => ({
        rows: [
          {
            subreddit: "example_community",
            status: "Approved",
            notes: "Synthetic community",
          },
        ],
      });
    });
    await x
      .getByRole("button", { name: "Choose communities", exact: true })
      .click();
    await x.locator(".xt-planner-community input").check();
    await x
      .getByRole("button", { name: "Add selected (1)", exact: true })
      .click();
    await x
      .getByRole("button", {
        name: "Edit r/example_community post",
        exact: true,
      })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".xt-composer-frame")
        ?.contentWindow?.document.body?.classList.contains(
          "calendar-reddit-draft",
        ),
    );
    const reddit = page
      .frames()
      .find((item) => item.url().includes("upload-console.html?teaserDay="));
    assert.match(
      await reddit.locator("#socialFileSummary").textContent(),
      /preview-test.mp4/,
      "selected community starts with the current clip",
    );
    assert.equal(
      await reddit.getByLabel("Subreddit", { exact: true }).count(),
      0,
      "community selection only appears in the destination list",
    );
    await reddit.locator("#socialCaption").fill("Independent community title");
    assert.equal(
      await reddit.locator("#socialCaption").getAttribute("maxlength"),
      "300",
    );
    assert.equal(await reddit.locator("#uploadButton").isVisible(), false);
    await reddit
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await reddit
      .getByRole("button", {
        name: "Edit r/example_community post",
        exact: true,
      })
      .waitFor();
    const stored = await page.evaluate(
      async (DAY) => ({
        x: await OFEnhancerTeaserDrafts.get(DAY),
        posts: await OFEnhancerTeaserDrafts.listPosts(DAY),
      }),
      DAY,
    );
    assert.equal(stored.x.caption, "Twitter caption");
    assert.equal(stored.x.status, "prepared");
    assert.equal(stored.x.sessionId, SESSION);
    assert.equal(stored.posts.length, 1);
    assert.equal(stored.posts[0].caption, "Independent community title");
    assert.equal(stored.posts[0].date, DAY);
    assert.equal(stored.posts[0].platform, "reddit");
    assert.equal(stored.posts[0].status, "draft");
    assert.equal(
      stored.posts[0].file,
      undefined,
      "summaries never return media",
    );
    const second = await page.evaluate(async (DAY) => {
      const draft = await OFEnhancerTeaserDrafts.savePost({
        id: crypto.randomUUID(),
        date: DAY,
        subreddit: "other_community",
        file: new File(["different clip"], "second.mp4", { type: "video/mp4" }),
        caption: "Different title",
        time: "21:00",
      });
      return { id: draft.id, name: draft.file.name, size: draft.file.size };
    }, DAY);
    assert.notEqual(second.id, stored.posts[0].id);
    assert.equal(second.name, "second.mp4");
    await reddit.evaluate(() => {
      CreatorCatalogueClient.getSubredditPresetSnapshot = async () => ({
        rows: [{ subreddit: "example_community", status: "Approved" }],
      });
      const original = chrome.runtime.sendMessage;
      window.redditPreparationRequests = [];
      chrome.runtime.sendMessage = (message, callback) => {
        if (message.type !== "PREPARE_CREATOR_SOCIAL_DISTRIBUTION")
          return original(message, callback);
        window.redditPreparationRequests.push(message);
        const result = {
          ok: true,
          socialDistribution: {
            sessionId: message.plan.id,
            targets: {
              redgifs: { platform: "redgifs", status: "review-required" },
              "reddit:example_community": {
                platform: "reddit",
                status: "waiting-for-redgifs",
              },
            },
          },
        };
        queueMicrotask(() => callback?.(result));
        return Promise.resolve(result);
      };
    });
    if (process.env.OFENHANCER_TEASER_SCREENSHOTS) {
      fs.mkdirSync(process.env.OFENHANCER_TEASER_SCREENSHOTS, {
        recursive: true,
      });
      await page.locator(".xt-composer-dialog").screenshot({
        path: path.join(
          process.env.OFENHANCER_TEASER_SCREENSHOTS,
          "reddit-before-preparation.png",
        ),
      });
    }
    await reddit
      .getByRole("button", { name: "Prepare Reddit", exact: true })
      .click();
    await reddit.locator("#redditLinkStep").waitFor({ state: "visible" });
    const request = await reddit.evaluate(
      () => window.redditPreparationRequests[0],
    );
    assert.equal(request.plan.preparationOnly, true);
    assert.equal(request.plan.mode, "manual");
    assert.equal(request.plan.targets.x, false);
    assert.equal(request.subreddits[0].title, "Independent community title");
    assert.equal(request.plan.socialFile.basename, "preview-test.mp4");
    const prepared = await page.evaluate(
      async (id) => OFEnhancerTeaserDrafts.getPost(id),
      stored.posts[0].id,
    );
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.sessionId, request.plan.id);
    assert.equal(
      await reddit.locator("#prepareCalendarReddit").isDisabled(),
      true,
    );
    assert.equal(
      await page.evaluate(
        async (day) => (await OFEnhancerTeaserDrafts.get(day)).sessionId,
        DAY,
      ),
      SESSION,
    );
    assert.equal(
      await page.evaluate(async (draft) => {
        try {
          await OFEnhancerTeaserDrafts.savePost(draft);
          return false;
        } catch {
          return true;
        }
      }, prepared),
      true,
      "a saved Reddit run cannot be overwritten",
    );
    const captures = process.env.OFENHANCER_TEASER_SCREENSHOTS;
    await reddit.waitForFunction(
      () => document.querySelector(".teaser-video-preview").readyState >= 2,
    );
    if (captures) {
      fs.mkdirSync(captures, { recursive: true });
      await page.screenshot({
        path: path.join(captures, "reddit-desktop.png"),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 390, height: 950 });
    if (captures)
      await page.screenshot({
        path: path.join(captures, "reddit-phone.png"),
        fullPage: true,
      });
    assert.equal(
      await reddit.locator("#socialPaidLinkFields").isVisible(),
      false,
    );
    assert.equal(
      await reddit.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await reddit
      .getByRole("button", { name: "Edit Twitter post", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".xt-composer-frame")
          ?.contentWindow?.document.querySelector("#socialCaption")?.value ===
        "Twitter caption",
    );
    const id = stored.posts[0].id;
    const twitter = page
      .frames()
      .find((item) => item.url().includes("upload-console.html?teaserDay="));
    await twitter.locator(".xt-planner-post").nth(2).waitFor();
    assert.equal(
      await twitter.locator(".xt-planner-post").count(),
      3,
      "all destination posts are visible together",
    );
    await twitter.locator(`[data-post-id="${id}"]`).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".xt-composer-frame")
          ?.contentWindow?.document.querySelector("#socialCaption")?.value ===
        "Independent community title",
    );
    const restored = page
      .frames()
      .find((item) => item.url().includes("upload-console.html?teaserDay="));
    assert.equal(
      await restored.getByLabel("Subreddit", { exact: true }).count(),
      0,
    );
    await restored
      .getByRole("button", { name: "Edit r/other_community post", exact: true })
      .waitFor();
    if (captures) {
      await restored.evaluate(async () => {
        const video = document.querySelector(".teaser-video-preview");
        video.muted = true;
        await video.play();
        video.pause();
        video.currentTime = 0;
      });
      await page.setViewportSize({ width: 1100, height: 950 });
      await page
        .locator(".xt-composer-dialog")
        .screenshot({ path: path.join(captures, "unified-planner.png") });
      await page.setViewportSize({ width: 390, height: 950 });
      await page
        .locator(".xt-composer-dialog")
        .screenshot({ path: path.join(captures, "unified-planner-phone.png") });
    }
    assert.equal(
      await restored
        .getByRole("button", { name: "Remove post", exact: true })
        .isDisabled(),
      true,
      "saved runs cannot be removed",
    );
    await restored
      .getByRole("button", { name: "Edit r/other_community post", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".xt-composer-frame")
          ?.contentWindow?.document.querySelector("#socialCaption")?.value ===
        "Different title",
    );
    const other = page
      .frames()
      .find((item) => item.url().includes("upload-console.html?teaserDay="));
    await other.locator("#socialCaption").waitFor();
    page.once("dialog", (dialog) => dialog.accept());
    await other
      .getByRole("button", { name: "Remove post", exact: true })
      .click();
    await page.waitForFunction(
      async (DAY) => (await OFEnhancerTeaserDrafts.listPosts(DAY)).length === 1,
      DAY,
    );
    assert.equal(
      await page.evaluate(
        async (id) => (await OFEnhancerTeaserDrafts.getPost(id)).caption,
        stored.posts[0].id,
      ),
      "Independent community title",
    );
    assert.equal(
      (await page.evaluate((DAY) => OFEnhancerTeaserDrafts.get(DAY), DAY))
        .sessionId,
      SESSION,
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("worksheet targets share Reddit batch timing, survive midnight and keep a bounded destination list", async () => {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 950 },
  });
  try {
    const errors = await mount(page, true);
    const frame = await chooseSyntheticVideo(page);
    await frame.locator("#socialCaption").fill("A community teaser");
    await frame.locator("#saveTeaserDraft").click();
    await page.waitForFunction(() =>
      document
        .querySelector(".xt-composer-status")
        .textContent.includes("Draft saved"),
    );
    await frame.evaluate(() => {
      CreatorCatalogueClient.getSubredditPresetSnapshot = async () => ({
        rows: Array.from({ length: 30 }, (_, index) => ({
          subreddit: `community_${String(index + 1).padStart(2, "0")}`,
          status: index === 29 ? "Rejected" : "Approved",
          notes: "Synthetic worksheet target",
        })),
      });
    });
    await frame
      .getByRole("button", { name: "Choose communities", exact: true })
      .click();
    await frame.locator(".xt-planner-community").nth(29).waitFor();
    assert.equal(await frame.locator(".xt-planner-community").count(), 30);
    assert.ok(
      await frame.locator(".xt-planner-community-picker").evaluate((picker) => {
        const panel = picker
          .closest(".xt-composer-destinations")
          .getBoundingClientRect();
        const bounds = picker.getBoundingClientRect();
        const actions = picker.previousElementSibling.getBoundingClientRect();
        return bounds.width >= panel.width - 2 && bounds.top >= actions.bottom;
      }),
      "community picker spans the settings panel below destination actions",
    );
    const pickerCaptures = path.join(
      repositoryRoot,
      "artifacts/community-picker-review",
    );
    fs.mkdirSync(pickerCaptures, { recursive: true });
    await page
      .locator(".xt-composer-dialog")
      .screenshot({ path: path.join(pickerCaptures, "community-pills.png") });

    assert.equal(
      await frame
        .locator(".xt-planner-community")
        .nth(29)
        .locator("input")
        .isDisabled(),
      true,
    );
    await frame.getByLabel("Search worksheet communities").fill("community_01");
    assert.equal(
      await frame.locator(".xt-planner-community:visible").count(),
      1,
    );
    await frame.locator(".xt-planner-community:visible input").check();
    await frame.getByLabel("Search worksheet communities").fill("community_02");
    await frame.locator(".xt-planner-community:visible input").check();
    await frame.getByLabel("Search worksheet communities").fill("");
    await page.locator(".xt-composer-dialog").screenshot({
      path: path.join(pickerCaptures, "community-pills-selected.png"),
    });
    await frame
      .getByRole("button", { name: "Add selected (2)", exact: true })
      .click();
    await page.waitForFunction(
      async (day) => (await OFEnhancerTeaserDrafts.listPosts(day)).length === 2,
      DAY,
    );
    await frame.getByLabel("Reddit starts", { exact: true }).fill("23:50");
    await frame
      .getByLabel("Reddit starts", { exact: true })
      .dispatchEvent("change");
    await page.waitForFunction(
      async (day) =>
        (await OFEnhancerTeaserDrafts.getBatch(day))?.start === "23:50",
      DAY,
    );
    assert.equal(
      await frame.getByLabel("Gap (min)", { exact: true }).count(),
      0,
      "pacing is internal to the planner",
    );
    await page.evaluate(
      (day) =>
        OFEnhancerTeaserDrafts.saveBatch({
          date: day,
          start: "23:50",
          gapMinutes: 20,
        }),
      DAY,
    );
    await page.waitForFunction(
      async (day) =>
        (await OFEnhancerTeaserDrafts.getBatch(day))?.gapMinutes === 20,
      DAY,
    );
    const result = await page.evaluate(async (day) => {
      const posts = (await OFEnhancerTeaserDrafts.listPosts(day)).sort(
        (a, b) => a.order - b.order,
      );
      const twitter = await OFEnhancerTeaserDrafts.get(day);
      await OFEnhancerTeaserDrafts.savePost({
        ...(await OFEnhancerTeaserDrafts.getPost(posts[0].id)),
        time: "09:00",
        caption: "Edited title",
      });
      const edited = await OFEnhancerTeaserDrafts.getPost(posts[0].id);
      await OFEnhancerTeaserDrafts.saveBatch({
        date: day,
        start: "18:00",
        gapMinutes: 0,
      }).then(
        () => {
          throw new Error("invalid gap accepted");
        },
        () => {},
      );
      await OFEnhancerTeaserDrafts.savePosts({ ...twitter, time: "18:00" }, [
        "community_01",
        "community_new",
      ]).then(
        () => {
          throw new Error("duplicate batch accepted");
        },
        () => {},
      );
      const afterRejected = await OFEnhancerTeaserDrafts.listPosts(day);
      const targets = Array.from(
        { length: 27 },
        (_, index) => `community_${String(index + 3).padStart(2, "0")}`,
      );
      await OFEnhancerTeaserDrafts.savePosts(twitter, targets);
      return {
        slots: posts.map(({ time, scheduledDate }) => ({
          time,
          scheduledDate,
        })),
        editedTime: edited.time,
        twitterTime: twitter.time,
        afterRejected: afterRejected.length,
      };
    }, DAY);
    assert.deepEqual(result.slots, [
      { time: "23:50", scheduledDate: DAY },
      { time: "00:10", scheduledDate: "2026-10-07" },
    ]);
    assert.equal(
      result.editedTime,
      "23:50",
      "editing a title cannot override batch timing",
    );
    assert.equal(result.twitterTime, "18:00");
    assert.equal(result.afterRejected, 2, "duplicate target failure is atomic");
    await frame
      .getByRole("button", { name: "Edit r/community_01 post", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".xt-composer-frame")
        ?.contentDocument?.body?.classList.contains("calendar-reddit-draft"),
    );
    const reddit = page
      .frames()
      .find((item) => item.url().includes("upload-console.html?teaserDay="));
    await reddit.locator(".xt-planner-post").nth(29).waitFor();
    assert.equal(
      await reddit.locator(".xt-planner-post-list").evaluate((list) => {
        const first = list.children[0].getBoundingClientRect();
        const second = list.children[1].getBoundingClientRect();
        return (
          Math.abs(first.top - second.top) < 1 && second.left > first.right
        );
      }),
      true,
      "destinations wrap as compact pills instead of full-width rows",
    );
    assert.equal(
      await reddit.getByLabel("Posting time", { exact: true }).isVisible(),
      false,
    );
    assert.equal(
      await reddit
        .locator(".xt-planner-post-list")
        .evaluate(
          (list) =>
            list.clientHeight <= 190 && list.scrollHeight > list.clientHeight,
        ),
      true,
    );
    await reddit.getByLabel("Find a destination").fill("community_27");
    assert.equal(await reddit.locator(".xt-planner-post:visible").count(), 1);
    await reddit.getByLabel("Find a destination").fill("");
    await reddit
      .getByRole("checkbox", { name: "Include r/community_02", exact: true })
      .uncheck();
    await page.waitForFunction(
      async (day) =>
        (await OFEnhancerTeaserDrafts.listPosts(day)).find(
          (post) => post.subreddit === "community_02",
        )?.enabled === false,
      DAY,
    );
    const unchecked = await page.evaluate(async (day) => {
      const posts = await OFEnhancerTeaserDrafts.listPosts(day);
      const disabled = posts.find((post) => post.subreddit === "community_02");
      const draft = await OFEnhancerTeaserDrafts.getPost(disabled.id);
      await OFEnhancerTeaserDrafts.savePost({
        ...draft,
        caption: "Retained community title",
      });
      const retained = await OFEnhancerTeaserDrafts.getPost(disabled.id);
      return {
        caption: retained.caption,
        enabled: retained.enabled,
        clipName: retained.file.name,
        next: posts.find((post) => post.subreddit === "community_03"),
      };
    }, DAY);
    assert.equal(unchecked.caption, "Retained community title");
    assert.equal(
      unchecked.enabled,
      false,
      "editing an unchecked draft does not reselect it",
    );
    assert.equal(unchecked.clipName, "preview-test.mp4");
    assert.equal(
      unchecked.next.time,
      "00:10",
      "unchecked targets do not occupy a planned slot",
    );
    await reddit
      .getByRole("checkbox", { name: "Include r/community_02", exact: true })
      .check();
    await page.waitForFunction(
      async (day) =>
        (await OFEnhancerTeaserDrafts.listPosts(day)).find(
          (post) => post.subreddit === "community_02",
        )?.enabled === true,
      DAY,
    );
    const captures = process.env.OFENHANCER_TEASER_SCREENSHOTS;
    if (captures) {
      await reddit
        .locator(".xt-planner-post-list")
        .evaluate((list) => (list.scrollTop = 0));
      await reddit.locator(".teaser-video-preview").evaluate(async (video) => {
        video.muted = true;
        await video.play();
        video.pause();
        video.currentTime = 0;
      });
      await page
        .locator(".xt-composer-dialog")
        .screenshot({ path: path.join(captures, "reddit-batch.png") });
    }
    await page.setViewportSize({ width: 390, height: 950 });
    assert.equal(
      await reddit.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "large target list fits a phone without horizontal scrolling",
    );
    assert.equal(
      await reddit
        .locator(".xt-planner-post-list")
        .evaluate((list) => list.clientHeight <= 190),
      true,
    );
    if (captures)
      await page
        .locator(".xt-composer-dialog")
        .screenshot({ path: path.join(captures, "reddit-batch-phone.png") });
    await page.evaluate(async (day) => {
      const posts = (await OFEnhancerTeaserDrafts.listPosts(day)).sort(
        (a, b) => a.order - b.order,
      );
      await OFEnhancerTeaserDrafts.removePost(posts[0].id);
      const next = await OFEnhancerTeaserDrafts.getPost(posts[1].id);
      if (next.time !== "23:50" || next.scheduledDate !== day)
        throw new Error("removal did not close batch gap");
    }, DAY);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("version-two Reddit drafts retain their existing times until batch timing is chosen", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/host`);
    const id = await page.evaluate(async (day) => {
      const id = crypto.randomUUID();
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("OFEnhancerTeaserDraftsV1", 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("drafts", { keyPath: "date" });
          request.result.createObjectStore("posts", { keyPath: "id" });
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("posts", "readwrite");
          tx.objectStore("posts").put({
            id,
            date: day,
            platform: "reddit",
            subreddit: "existing_community",
            caption: "Existing Reddit title",
            time: "21:35",
            updatedAt: 1,
            file: new File(["old"], "old.mp4", { type: "video/mp4" }),
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
      return id;
    }, DAY);
    const migrated = await page.evaluate(
      async ({ id, day }) => ({
        post: await OFEnhancerTeaserDrafts.getPost(id),
        batch: await OFEnhancerTeaserDrafts.getBatch(day),
      }),
      { id, day: DAY },
    );
    assert.equal(migrated.post.caption, "Existing Reddit title");
    assert.equal(migrated.post.time, "21:35");
    assert.equal(migrated.batch, null);
    assert.equal(
      await page.evaluate(
        async (id) => (await OFEnhancerTeaserDrafts.getPost(id)).file.name,
        id,
      ),
      "old.mp4",
    );
  } finally {
    await page.close();
  }
});

test("version-one Twitter drafts survive the destination-store upgrade", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/host`);
    await page.evaluate(async (DAY) => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("OFEnhancerTeaserDraftsV1", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("drafts", { keyPath: "date" });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("drafts", "readwrite");
          tx.objectStore("drafts").put({
            date: DAY,
            caption: "Existing Twitter draft",
            status: "draft",
            file: new File(["old"], "old.mp4", { type: "video/mp4" }),
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    }, DAY);
    const result = await page.evaluate(
      async (DAY) => ({
        x: await OFEnhancerTeaserDrafts.get(DAY),
        posts: await OFEnhancerTeaserDrafts.listPosts(DAY),
      }),
      DAY,
    );
    assert.equal(result.x.caption, "Existing Twitter draft");
    assert.deepEqual(result.posts, []);
    assert.equal(
      await page.evaluate(
        async (DAY) => (await OFEnhancerTeaserDrafts.get(DAY)).file.name,
        DAY,
      ),
      "old.mp4",
    );
  } finally {
    await page.close();
  }
});
