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
const VIDEO = path.join(
  repositoryRoot,
  "tests/fixtures/teaser-hub/preview-test.mp4",
);
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
    assert.equal(
      await frame
        .locator(".teaser-thumbnail-panel img")
        .evaluate((image) => image.naturalWidth),
      640,
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
    await frame.locator('input[type="time"]').fill("19:20");
    await frame
      .locator('.teaser-schedule-field input[type="number"]')
      .fill("23");
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
      await page.locator(".xt-composer-heading h2").textContent(),
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

    await page.locator(".xt-composer-heading button").click();
    await page.locator("#open-day").click();
    await page.locator(".xt-composer-frame").waitFor();
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
      await restored.locator('input[type="time"]').inputValue(),
      "19:20",
    );
    assert.match(
      await page.locator(".xt-composer-heading h2").textContent(),
      /Tuesday, Oct 6/,
    );
    assert.deepEqual(errors, []);
    await page.locator(".xt-composer-heading button").click();
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
      await nextDay.locator('input[type="time"]').inputValue(),
      "19:20",
      "new day remembers the last posting time",
    );
    assert.equal(
      await nextDay.locator('input[type="number"]').inputValue(),
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

test("episode without a teaser opens its folder and accepts a video in the same day modal", async () => {
  const page = await browser.newPage({
    viewport: { width: 1365, height: 960 },
  });
  try {
    const errors = await mount(page, true);
    await page.locator(".xt-composer-heading button").click();
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
    await frame
      .getByRole("button", {
        name: "Change episode: Preview test",
        exact: true,
      })
      .waitFor();
    const automatic = frame.getByRole("checkbox", {
      name: "Send automatically",
      exact: true,
    });
    await automatic.check();
    assert.equal(
      await frame
        .locator('input[name="socialMode"][value="manual"]')
        .isChecked(),
      false,
    );
    await automatic.uncheck();
    assert.equal(
      await frame
        .locator('input[name="socialMode"][value="manual"]')
        .isChecked(),
      true,
    );
    await frame.getByRole("button", { name: "Open episode folder" }).click();
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
    const actionRows = await frame
      .locator(".teaser-association button, #saveTeaserDraft, #uploadButton")
      .evaluateAll((buttons) =>
        buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
      );
    assert.equal(
      new Set(actionRows).size,
      1,
      "episode and draft actions share one row",
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
    await page.locator(".xt-composer-heading button").click();
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
    await frame.getByRole("button", { name: "Open episode folder" }).waitFor();
    assert.equal(
      await frame
        .getByRole("button", { name: "Choose or drop teaser video" })
        .isVisible(),
      true,
    );
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
    await page.locator(".xt-composer-heading button").click();
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
      await page.locator(".xt-composer-heading h2").textContent(),
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
