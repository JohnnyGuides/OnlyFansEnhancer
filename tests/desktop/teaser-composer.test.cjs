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
<button id="open-day">Open Tuesday</button><script src="/app/dialog-dismiss.js" data-app-dialogs></script><script src="/app/teaser-draft-store.js"></script><script src="/app/teaser-render-handoff.js"></script><script src="/app/teaser-composer.js"></script><script>
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

async function mount(
  page,
  linked = false,
  delaySettings = false,
  catalogueLinks = { onlyfansLink: "https://onlyfans.com/1/preview" },
  extraRows = [],
) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(12_000);
  await page.addInitScript(
    ({ linked, delaySettings, catalogueLinks, extraRows }) => {
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
              if (delaySettings && keys === "creatorToolkitActionLogV1") {
                return new Promise((resolve) => {
                  globalThis.releaseSettings = () => {
                    callback?.(result);
                    resolve(result);
                  };
                });
              }
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
              onMessage: {
                addListener: (listener) => listeners.push(listener),
              },
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
              message?.type === "START_NEW_CREATOR_UPLOAD"
                ? { ok: true, reset: true }
                : message?.type === "CHECK_CREATOR_UPLOAD_AVAILABILITY"
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
                  ...catalogueLinks,
                },
                ...extraRows,
              ]
            : [],
          emptyRow: { row: 3 },
        }),
      };
    },
    { linked, delaySettings, catalogueLinks, extraRows },
  );
  await page.goto(`${origin}/host`);
  await page.locator("#open-day").click();
  await page.locator(".xt-clip-choices, .xt-composer-frame").waitFor();
  return errors;
}

async function folderButton(page) {
  if (
    (await page
      .getByRole("button", { name: "File actions", exact: true })
      .isVisible()) &&
    !(await page
      .locator(".xt-composer-tools")
      .evaluate((menu) => menu.matches(":popover-open")))
  )
    await page
      .getByRole("button", { name: "File actions", exact: true })
      .click();
  return page.getByRole("button", { name: "Open episode folder", exact: true });
}

async function chooseReplyLink(frame, value) {
  await frame
    .getByRole("button", { name: "Choose reply link", exact: true })
    .click();
  await frame.locator(`.teaser-link-picker [data-choice="${value}"]`).click();
}

test("reply settings edit the shared rotation with a preview and link-only choice", async () => {
  const page = await browser.newPage({
    viewport: { width: 1365, height: 900 },
  });
  try {
    const errors = await mount(page, true);
    await chooseSyntheticVideo(page);
    const frame = page
      .frames()
      .find((frame) => frame.url().includes("?teaserDay="));
    await frame.evaluate(() => {
      let config = {
        mode: "rotate",
        variants: ["full vid (no ppv)", "full session", "full vid :)"],
        nextIndex: 1,
      };
      const original = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (message, callback) => {
        if (
          !["GET_X_REPLY_POLICY", "SET_X_REPLY_POLICY"].includes(message.type)
        )
          return original(message, callback);
        if (message.type === "SET_X_REPLY_POLICY")
          config = { ...config, ...message.replyPolicy };
        const response = { ok: true, replyPolicy: config };
        queueMicrotask(() => callback?.(response));
        return Promise.resolve(response);
      };
    });
    await frame
      .getByRole("button", { name: "Reply settings", exact: true })
      .click();
    const dialog = frame.getByRole("dialog", {
      name: "Reply text",
      exact: true,
    });
    await dialog.getByLabel("Reply message", { exact: true }).waitFor();
    await frame.waitForFunction(() =>
      document
        .querySelector(".teaser-reply-dialog pre")
        .textContent.startsWith("full session"),
    );
    assert.match(
      await dialog.getByLabel("Reply preview").textContent(),
      /full session\n-> https:\/\/onlyfans.com\/1\/preview/,
    );
    await dialog
      .getByLabel("Reply message", { exact: true })
      .fill("First phrase\nA unique second line\nOnlyFans: {link}");
    assert.match(
      await dialog.getByLabel("Reply preview").textContent(),
      /^First phrase\nA unique second line/,
    );
    await dialog.locator(".teaser-reply-list button").nth(0).click();
    assert.equal(
      await dialog.getByLabel("Reply message").inputValue(),
      "full vid (no ppv)\n-> {link}",
    );
    await dialog.locator(".teaser-reply-list button").nth(1).click();
    assert.equal(
      await dialog.getByLabel("Reply message").inputValue(),
      "First phrase\nA unique second line\nOnlyFans: {link}",
    );
    await dialog
      .getByRole("button", { name: "Add reply", exact: true })
      .click();
    await dialog.getByLabel("Reply message").fill("Temporary\nReply");
    await dialog
      .getByRole("button", { name: "Remove reply", exact: true })
      .click();
    await dialog.locator(".teaser-reply-list button").nth(1).click();
    const output = path.join(repositoryRoot, ".local/reply-settings-review");
    fs.mkdirSync(output, { recursive: true });
    const downloadReady = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "Save .txt", exact: true })
      .click();
    const download = await downloadReady;
    assert.equal(download.suggestedFilename(), "x-replies.txt");
    const textFile = fs.readFileSync(await download.path(), "utf8");
    assert.match(textFile, /\n\n---\n\n/);
    assert.match(textFile, /A unique second line\nOnlyFans: \{link\}/);
    await dialog.getByLabel("Open reply text file").setInputFiles({
      name: "edited-replies.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        textFile.replace("full vid (no ppv)", "Updated first reply"),
      ),
    });
    await frame.waitForFunction(() =>
      document
        .querySelector('.teaser-reply-dialog [role="status"]')
        .textContent.startsWith("Replies loaded"),
    );
    assert.equal(await dialog.locator(".teaser-reply-list button").count(), 3);
    assert.match(
      await dialog.locator(".teaser-reply-list button").first().textContent(),
      /Updated first reply/,
    );
    await dialog.locator(".teaser-reply-list button").nth(1).click();
    await dialog.screenshot({ path: path.join(output, "desktop.png") });
    const dialogSize = await dialog.evaluate((element) => ({
      scroll: element.scrollHeight,
      visible: element.clientHeight,
    }));
    assert.equal(
      dialogSize.scroll <= dialogSize.visible,
      true,
      JSON.stringify(dialogSize),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.width <= 390);
    await dialog.screenshot({ path: path.join(output, "phone.png") });
    await dialog
      .getByLabel("Open reply text file")
      .setInputFiles({
        name: "invalid.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("x".repeat(201)),
      });
    await frame.waitForFunction(() =>
      document
        .querySelector('.teaser-reply-dialog [role="status"]')
        .textContent.includes("200 characters"),
    );
    assert.equal(await dialog.locator(".teaser-reply-list button").count(), 3);
    await dialog
      .getByLabel("Reply message")
      .fill("A reply without its link placeholder");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    assert.equal(
      await dialog.getByRole("status").textContent(),
      "Include {link} in each saved reply.",
    );
    await dialog
      .getByLabel("Reply message")
      .fill("First phrase\nA unique second line\nOnlyFans: {link}");
    await dialog
      .getByLabel("Reply wording", { exact: true })
      .selectOption("link");
    assert.equal(
      await dialog.getByLabel("Reply message", { exact: true }).isVisible(),
      false,
    );
    assert.equal(
      await dialog.getByLabel("Reply preview").textContent(),
      "https://onlyfans.com/1/preview",
    );
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await frame
      .getByRole("button", { name: "Reply settings", exact: true })
      .click();
    await frame.waitForFunction(
      () =>
        document.querySelector(".teaser-reply-dialog select").value === "link",
    );
    assert.equal(
      await dialog.getByLabel("Reply message", { exact: true }).inputValue(),
      "First phrase\nA unique second line\nOnlyFans: {link}",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

async function chooseSyntheticVideo(page) {
  const chooser = page.waitForEvent("filechooser");
  if (await page.locator(".xt-clip-add").count())
    await page.locator(".xt-clip-add").click();
  else
    await page
      .frameLocator(".xt-composer-frame")
      .getByRole("button", { name: "Choose or drop teaser video" })
      .click();
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

test("opening shows the editor layout once and never paints the unfinished Upload Hub", async () => {
  const page = await browser.newPage();
  let releaseStartup;
  const startup = new Promise((resolve) => (releaseStartup = resolve));
  let scriptRequested;
  const requested = new Promise((resolve) => (scriptRequested = resolve));
  try {
    await page.addInitScript(() => {
      globalThis.openedTeaserLayouts = [];
      new MutationObserver((records) => {
        for (const record of records)
          if (
            record.target.matches?.(".xt-composer-dialog[open]") &&
            record.attributeName === "open"
          )
            openedTeaserLayouts.push(record.target.dataset.editor || "chooser");
      }).observe(document, {
        subtree: true,
        attributes: true,
        attributeFilter: ["open"],
      });
    });
    let attempts = 0;
    await page.route("**/upload-console.js", async (route) => {
      if (++attempts === 1) {
        scriptRequested();
        await startup;
      }
      await route.continue().catch(() => {});
    });
    const opening = mount(page);
    await requested;
    const frame = page.locator(".xt-composer-frame");
    assert.equal(
      await frame.isVisible(),
      false,
      "hide the uninitialized uploader",
    );
    assert.equal(
      await page
        .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
        .getAttribute("data-editor"),
      "true",
    );
    assert.equal(await page.locator(".xt-editor-loading").count(), 0);
    assert.equal(
      await page
        .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
        .isVisible(),
      false,
      "do not open a blank modal before the form exists",
    );
    await page
      .getByRole("button", { name: "Retry", exact: true })
      .click({ timeout: 12000 });
    releaseStartup();
    const errors = await opening;
    assert.equal(await page.locator(".xt-editor-error").count(), 0);
    assert.equal(attempts, 2, "retry reloads the same editor frame");
    assert.equal(
      await frame.isVisible(),
      true,
      "show the initialized teaser editor",
    );
    assert.deepEqual(await page.evaluate(() => openedTeaserLayouts), ["true"]);
    assert.deepEqual(errors, []);
  } finally {
    releaseStartup();
    await page.close();
  }
});

test("empty catalogue opens the editor directly and accepts a chosen video", async () => {
  const page = await browser.newPage();
  try {
    const errors = await mount(page);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
    await page.evaluate(() =>
      OFEnhancerTeaserComposer.open({
        date: "2026-10-06",
        episodes: [],
        request: async () => ({ clips: [] }),
        renderCatalogue: () => {
          throw new Error("An empty catalogue must not open its selector");
        },
      }),
    );
    await page.locator(".xt-composer-frame").waitFor();
    assert.equal(await page.locator(".xt-clip-choices").count(), 0);
    const frame = await chooseSyntheticVideo(page);
    assert.equal(
      await frame.locator(".teaser-video-preview").isVisible(),
      true,
    );
    assert.equal(await (await folderButton(page)).isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("a misnamed teaser can be linked and copied with its caption and thumbnail intact", async () => {
  const page = await browser.newPage({
    viewport: { width: 1365, height: 900 },
  });
  try {
    const errors = await mount(page, true);
    const frame = page
      .frames()
      .find((item) => item.url().includes("upload-console.html?teaserDay="));
    await frame.evaluate(() => {
      globalThis.__copyCalls = [];
      globalThis.OFEnhancerDesktopUpload = {
        async copyTeaser(file, episodeKey, date) {
          __copyCalls.push({
            name: file.name,
            episodeKey,
            date,
            size: file.size,
          });
          await new Promise((resolve) => (globalThis.__finishCopy = resolve));
          return {
            name: "preview-test__t01.mp4",
            clip: {
              clipId: 45,
              lastModified: 1780000000000,
              sha256: "c".repeat(64),
            },
          };
        },
      };
    });
    await frame.locator("#uploadSocialTeaser").setInputFiles({
      name: "totally wrong filename.mp4",
      mimeType: "video/mp4",
      buffer: fs.readFileSync(VIDEO),
    });
    await frame
      .locator(".teaser-thumbnail-panel img")
      .waitFor({ state: "visible" });
    const copy = page.locator(".teaser-copy-file");
    assert.equal(
      await copy.isDisabled(),
      true,
      "episode must be explicitly linked before import",
    );
    await page
      .getByRole("button", { name: "Link episode", exact: true })
      .click();
    await frame.locator('#catalogueCards [data-row="2"]').click();
    await frame.locator("#socialCaption").fill("A caption worth keeping");
    const thumbnail = await frame
      .locator(".teaser-thumbnail-panel img")
      .getAttribute("src");
    await page.waitForFunction(
      () => !document.querySelector(".teaser-copy-file").disabled,
    );
    assert.equal(await copy.textContent(), "Copy to .TWEETS");
    await frame.waitForFunction(
      () => document.querySelector(".teaser-video-preview").readyState >= 2,
    );
    const output = path.join(repositoryRoot, ".local/teaser-copy-review");
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({
      path: path.join(output, "teaser-copy-desktop.png"),
    });
    if (
      await page
        .getByRole("button", { name: "File actions", exact: true })
        .isVisible()
    )
      await page
        .getByRole("button", { name: "File actions", exact: true })
        .click();
    await copy.click();
    await page
      .locator(".xt-composer-status")
      .filter({ hasText: "Copying to .TWEETS" })
      .waitFor();
    assert.equal(await copy.isDisabled(), true);
    await frame.evaluate(() => __finishCopy());
    await page
      .locator(".xt-composer-status")
      .filter({ hasText: "Copied as preview-test__t01.mp4" })
      .waitFor();
    assert.equal(
      await frame.locator("#socialCaption").inputValue(),
      "A caption worth keeping",
    );
    assert.equal(
      await frame.locator(".teaser-thumbnail-panel img").getAttribute("src"),
      thumbnail,
    );
    const draft = await page.evaluate(() =>
      OFEnhancerTeaserDrafts.get("2026-10-06").then((item) => ({
        name: item.file.name,
        episodeKey: item.episodeKey,
        clipId: item.clipId,
        renderHash: item.renderHash,
        caption: item.caption,
      })),
    );
    assert.deepEqual(draft, {
      name: "preview-test__t01.mp4",
      episodeKey: "preview-test",
      clipId: 45,
      renderHash: "c".repeat(64),
      caption: "A caption worth keeping",
    });
    assert.deepEqual(
      await frame.evaluate(() =>
        __copyCalls.map(({ name, episodeKey, date }) => ({
          name,
          episodeKey,
          date,
        })),
      ),
      [
        {
          name: "totally wrong filename.mp4",
          episodeKey: "preview-test",
          date: DAY,
        },
      ],
    );
    assert.equal(
      await copy.isDisabled(),
      true,
      "completed copy is not repeated",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await frame.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: path.join(output, "teaser-copy-phone.png") });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Vegas handoff resumes pending drafts and refreshes same-name renders without moving the editor", async () => {
  const page = await browser.newPage({
    viewport: { width: 1365, height: 1000 },
  });
  const waitDraft = async (predicate) => {
    for (let i = 0; i < 120; i++) {
      const draft = await page.evaluate(() =>
        OFEnhancerTeaserDrafts.get("2026-10-06"),
      );
      if (predicate(draft)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Draft did not reach the expected render state");
  };
  const bytes = fs.readFileSync(VIDEO);
  const replacement = Buffer.concat([bytes, Buffer.from("rerender-test")]);
  const fixture = (buffer) => ({
    chunk: buffer.toString("base64"),
    size: buffer.length,
    sha256: require("node:crypto")
      .createHash("sha256")
      .update(buffer)
      .digest("hex"),
  });
  try {
    const errors = await mount(page, true);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
    await page.evaluate(
      ({ first, second }) => {
        window.renderFixtures = [first, second];
        window.renderVersion = -1;
        window.renderPrepared = false;
        window.editRequests = [];
        window.openEdit = () =>
          OFEnhancerTeaserComposer.open({
            date: "2026-10-06",
            episode: { sourceKey: "preview-test", title: "Preview test" },
            episodes: [{ sourceKey: "preview-test", title: "Preview test" }],
            request: async (op, payload) => {
              editRequests.push({ op, payload });
              const meta = {
                episodeKey: "preview-test",
                projectName: "TEASR.veg",
                projects: [
                  { name: "TEASR.veg", suggested: true },
                  { name: "episode.veg", suggested: false },
                ],
                templateAvailable: true,
                renderName: renderPrepared ? "preview-test__t01.mp4" : "",
                renderFolder: "D:\\Media\\.TWEETS",
                renderPath: "D:\\Media\\.TWEETS\\preview-test__t01.mp4",
              };
              if (op === "getTeaserClips") return { clips: [] };
              if (op === "openTeaserProject") {
                renderPrepared = true;
                return { ...meta, renderName: "preview-test__t01.mp4" };
              }
              if (op === "getTeaserEdit") return meta;
              if (op === "checkTeaserRender") {
                if (renderVersion < 0) return { ...meta, status: "waiting" };
                return {
                  ...meta,
                  status: "ready",
                  clip: {
                    clipId: `render-${renderVersion}`,
                    name: "preview-test__t01.mp4",
                    lastModified: 1,
                    ...renderFixtures[renderVersion],
                  },
                };
              }
              if (op === "getTeaserClipChunk")
                return {
                  ...renderFixtures[Number(payload.clipId.slice(-1))],
                  clipId: payload.clipId,
                  offset: 0,
                  token: "fixture",
                  name: "preview-test__t01.mp4",
                  done: true,
                };
              return { ok: true };
            },
          });
        void openEdit();
      },
      { first: fixture(bytes), second: fixture(replacement) },
    );
    await page.locator(".xt-composer-frame").waitFor();
    let frame = page
      .frames()
      .find((item) => item.url().includes("?teaserDay="));
    if (!frame) {
      await page.waitForFunction(() =>
        document
          .querySelector("iframe")
          ?.contentDocument?.querySelector("#socialCaption"),
      );
      frame = page.frames().find((item) => item.url().includes("?teaserDay="));
    }
    await frame.locator("#socialCaption").fill("My edited caption");
    await frame.getByLabel("Posting time", { exact: true }).fill("19:45");
    const geometry = async () => ({
      dialog: await page
        .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
        .boundingBox(),
      actions: await frame.locator("#uploadActions").boundingBox(),
    });
    const before = await geometry();
    assert.ok(
      before.dialog.height <= 560,
      "desktop editor fits the custom URL without exceeding its fixed height",
    );
    assert.ok(
      (await page.locator(".xt-composer-heading").boundingBox()).height < 64,
      "one header row",
    );
    assert.ok(
      (await frame.locator(".teaser-media-controls").boundingBox()).height <=
        40,
      "thumbnail and suction share one row",
    );
    assert.ok(
      before.actions.height <= 64,
      "footer has no redundant status row",
    );
    await page
      .getByRole("button", { name: "Vegas project and render", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit TEASR.veg", exact: true })
      .waitFor();
    assert.equal(await page.locator(".xt-vegas-projects select").count(), 0);
    await frame.locator("#socialCaption").click();
    assert.equal(
      await page
        .locator(".xt-render-handoff:not(.xt-composer-tools)")
        .evaluate((menu) => menu.matches(":popover-open")),
      false,
      "clicking the embedded caption dismisses Vegas without closing the editor",
    );
    await page
      .getByRole("button", { name: "Vegas project and render", exact: true })
      .click();

    const vegasOutput = path.join(
      repositoryRoot,
      ".local/vegas-actions-review",
    );
    fs.mkdirSync(vegasOutput, { recursive: true });
    await page
      .locator(".xt-render-handoff:not(.xt-composer-tools)")
      .screenshot({
        path: path.join(vegasOutput, "vegas-menu.png"),
        animations: "disabled",
      });
    const originalViewport = page.viewportSize();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Vegas project and render", exact: true })
      .click();
    const vegasMenu = page.locator(
      ".xt-render-handoff:not(.xt-composer-tools)",
    );
    const menuBox = await vegasMenu.boundingBox();
    assert.ok(
      menuBox.x >= 0 && menuBox.x + menuBox.width <= 390,
      "Vegas actions fit a phone viewport",
    );
    await vegasMenu.screenshot({
      path: path.join(vegasOutput, "vegas-menu-phone.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize(originalViewport);
    await page
      .getByRole("button", { name: "Vegas project and render", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit TEASR.veg", exact: true })
      .click();
    assert.equal(
      await page.evaluate(
        () =>
          editRequests.find((item) => item.op === "openTeaserProject").payload
            .projectName,
      ),
      "TEASR.veg",
    );
    await page.keyboard.press("Escape");
    await waitDraft((draft) => draft?.renderPending);
    const pending = await page.evaluate(() =>
      OFEnhancerTeaserDrafts.get("2026-10-06"),
    );
    assert.equal(pending.file, null);
    assert.equal(pending.caption, "My edited caption");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
    await page.evaluate(() => {
      renderVersion = 0;
      void openEdit();
    });
    await waitDraft((draft) => draft?.clipId === "render-0");
    frame = page.frames().find((item) => item.url().includes("?teaserDay="));
    assert.equal(
      await frame.locator("#socialCaption").inputValue(),
      "My edited caption",
    );
    assert.equal(
      await frame.getByLabel("Posting time", { exact: true }).inputValue(),
      "19:45",
    );
    assert.deepEqual(await geometry(), before);
    await frame.locator(".teaser-thumbnail-upload input").setInputFiles({
      name: "custom.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZ8AAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await frame.locator("#saveTeaserDraft").click();
    await page.waitForFunction(
      async () =>
        (await OFEnhancerTeaserDrafts.get("2026-10-06"))?.thumbnailSelection
          ?.kind === "image",
    );
    const imageBefore = await page.evaluate(async () => [
      ...new Uint8Array(
        await (
          await OFEnhancerTeaserDrafts.get("2026-10-06")
        ).thumbnail.arrayBuffer(),
      ),
    ]);
    await page.evaluate(() => {
      renderVersion = 1;
    });
    await waitDraft((draft) => draft?.clipId === "render-1");
    const updated = await page.evaluate(async () => {
      const item = await OFEnhancerTeaserDrafts.get("2026-10-06");
      return {
        name: item.file.name,
        size: item.file.size,
        caption: item.caption,
        time: item.time,
        image: [...new Uint8Array(await item.thumbnail.arrayBuffer())],
      };
    });
    assert.equal(updated.size, replacement.length);
    assert.equal(updated.name, "preview-test__t01.mp4");
    assert.equal(updated.caption, "My edited caption");
    assert.equal(updated.time, "19:45");
    assert.deepEqual(updated.image, imageBefore);
    assert.deepEqual(await geometry(), before);
    await frame
      .getByRole("button", { name: "Choose frame", exact: true })
      .click();
    await frame.waitForFunction(
      () => !document.querySelector("#useThumbnailFrame").disabled,
    );
    await frame.locator("#thumbnailFrameTime").evaluate((input) => {
      input.value = "500";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await frame.waitForFunction(
      () => document.querySelector("#thumbnailFrameVideo").currentTime >= 0.9,
    );
    await frame.locator("#useThumbnailFrame").click();
    await frame.waitForFunction(
      () => !document.querySelector("#thumbnailFrameDialog").open,
    );
    assert.deepEqual(await geometry(), before);
    await frame.locator("#saveTeaserDraft").click();
    await waitDraft((draft) => draft?.thumbnailSelection?.kind === "frame");
    await page.evaluate(() => {
      renderVersion = 0;
    });
    await waitDraft((draft) => draft?.clipId === "render-0");
    const selection = await page.evaluate(
      async () =>
        (await OFEnhancerTeaserDrafts.get("2026-10-06")).thumbnailSelection,
    );
    assert.equal(selection.kind, "frame");
    assert.ok(selection.seconds >= 0.9);
    await frame.locator(".teaser-video-preview").evaluate(async (video) => {
      video.muted = true;
      await video.play();
      video.pause();
    });
    const output = process.env.OFENHANCER_HANDOFF_REVIEW_DIR;
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      await page
        .locator(".xt-composer-dialog")
        .screenshot({ path: path.join(output, "teaser-handoff-desktop.png") });
      await page
        .getByRole("button", { name: "Vegas project and render", exact: true })
        .click();
      await page.screenshot({
        path: path.join(output, "teaser-vegas-details.png"),
      });
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .locator(".xt-composer-dialog")
        .screenshot({ path: path.join(output, "teaser-handoff-phone.png") });
      assert.ok(
        (
          await page
            .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
            .boundingBox()
        ).width <= 390,
      );
      assert.ok(
        (await page.locator(".xt-composer-heading").boundingBox()).height < 64,
        "phone keeps one header row",
      );
      assert.ok((await frame.locator("#uploadButton").boundingBox()).y < 844);
    }
    await page.evaluate(() => {
      const f = document.querySelector("iframe");
      window.dispatchEvent(
        new MessageEvent("message", {
          source: f.contentWindow,
          origin: location.origin,
          data: { type: "ofenhancer:teaser-render-lock", locked: true },
        }),
      );
      renderVersion = 1;
    });
    await page.waitForFunction(
      () =>
        document.querySelector(".xt-render-state").textContent ===
        "New render available",
    );
    await page
      .getByRole("button", { name: "Vegas project and render", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Use updated render" })
        .isDisabled(),
      true,
    );
    assert.equal(
      (await page.evaluate(() => OFEnhancerTeaserDrafts.get("2026-10-06")))
        .clipId,
      "render-0",
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("square teaser previews its Like-directed ending before MP4 export and draft replacement", async () => {
  const work = fs.mkdtempSync(
    path.join(repositoryRoot, ".local", "suction-composer-"),
  );
  const square = path.join(work, "square-test.mp4");
  const generated = require("node:child_process").spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=480x480:rate=30:duration=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      square,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const page = await browser.newPage({
    viewport: { width: 1365, height: 1000 },
  });
  try {
    const errors = await mount(page, true);
    const frame = await chooseSyntheticVideo(page);
    const previousPoster = await frame
      .locator(".teaser-video-preview")
      .getAttribute("poster");
    await frame.locator("#uploadSocialTeaser").setInputFiles(square);
    await frame.waitForFunction(
      () => document.querySelector(".teaser-video-preview").videoWidth === 480,
    );
    await frame.waitForFunction((previous) => {
      const video = document.querySelector(".teaser-video-preview");
      return video.poster && video.poster !== previous;
    }, previousPoster);
    await frame.locator(".teaser-video-preview").evaluate(async (video) => {
      video.muted = true;
      await video.play();
      video.pause();
    });
    const editor = frame.locator(".teaser-ending");
    assert.ok(
      await editor.evaluate(
        (item) =>
          item.getBoundingClientRect().height <=
          item.querySelector(".teaser-ending-gear").getBoundingClientRect()
            .height +
            1,
      ),
      "collapsed control stays one shared-button row high",
    );
    if (process.env.OFENHANCER_SUCTION_REVIEW_DIR) {
      fs.mkdirSync(process.env.OFENHANCER_SUCTION_REVIEW_DIR, {
        recursive: true,
      });
      await page
        .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
        .screenshot({
          path: path.join(
            process.env.OFENHANCER_SUCTION_REVIEW_DIR,
            "suction-planner-compact.png",
          ),
        });
    }
    await editor
      .getByRole("checkbox", { name: "Suction ending", exact: true })
      .check();
    await editor
      .getByRole("dialog", { name: "Suction ending settings" })
      .waitFor();
    await page.keyboard.press("Escape");
    await editor
      .getByRole("dialog", { name: "Suction ending settings" })
      .waitFor({ state: "hidden" });
    await frame.waitForFunction(
      () =>
        !document.querySelector('.teaser-ending input[type="checkbox"]')
          .checked,
    );
    assert.equal(
      await editor
        .getByRole("checkbox", { name: "Suction ending", exact: true })
        .isChecked(),
      false,
    );
    await editor
      .getByRole("button", { name: "Suction ending settings", exact: true })
      .click();
    assert.equal(
      await editor
        .getByRole("button", { name: "Export MP4", exact: true })
        .isDisabled(),
      true,
    );
    await editor
      .getByRole("button", { name: "Preview ending", exact: true })
      .click();
    await frame.waitForFunction(
      () =>
        !document.querySelector('.teaser-ending [data-action="export"]')
          .disabled,
    );
    const warpTarget = editor.getByRole("slider", {
      name: "Warp target",
      exact: true,
    });
    assert.equal(await warpTarget.getAttribute("aria-valuenow"), "47");
    await editor.getByLabel("X timeline layout").selectOption("mobile");
    assert.equal(await warpTarget.getAttribute("aria-valuenow"), "50");
    await editor.getByLabel("X timeline layout").selectOption("desktop");
    assert.equal(await warpTarget.getAttribute("aria-valuenow"), "47");
    await warpTarget.press("End");
    assert.equal(await warpTarget.getAttribute("aria-valuenow"), "100");
    await warpTarget.press("Home");
    assert.equal(await warpTarget.getAttribute("aria-valuenow"), "0");
    const targetBounds = await editor
      .locator(".teaser-ending-target-track")
      .boundingBox();
    await warpTarget.fill("48");
    await warpTarget.dispatchEvent("input");
    assert.equal(await warpTarget.getAttribute("aria-valuenow"), "48");
    const funnelWidth = editor.getByRole("slider", {
      name: "Funnel width",
      exact: true,
    });
    assert.equal(await funnelWidth.getAttribute("aria-valuenow"), "0");
    await funnelWidth.press("End");
    assert.equal(await funnelWidth.getAttribute("aria-valuenow"), "40");
    await funnelWidth.press("Home");
    assert.equal(await funnelWidth.getAttribute("aria-valuenow"), "0");
    const widthBounds = await funnelWidth.boundingBox();
    await page.mouse.move(
      widthBounds.x + widthBounds.width - 2,
      widthBounds.y + 6,
    );
    await page.mouse.down();
    await page.mouse.move(
      targetBounds.x + targetBounds.width * (0.48 + 0.125),
      widthBounds.y + 6,
      { steps: 4 },
    );
    await page.mouse.up();
    assert.equal(await funnelWidth.getAttribute("aria-valuenow"), "25");
    assert.equal(
      await warpTarget.getAttribute("aria-valuenow"),
      "48",
      "width adjustment preserves the target centre",
    );
    assert.equal(
      await editor
        .getByRole("button", { name: "Export MP4", exact: true })
        .isDisabled(),
      true,
    );
    await editor
      .getByRole("button", { name: "Preview ending", exact: true })
      .click();
    await frame.waitForFunction(
      () =>
        !document.querySelector('.teaser-ending [data-action="export"]')
          .disabled,
    );
    assert.equal(
      await editor
        .getByRole("button", { name: "Export MP4", exact: true })
        .isDisabled(),
      false,
    );
    await editor.getByLabel("Ending speed", { exact: true }).fill("1.5");
    await editor
      .getByLabel("Ending speed", { exact: true })
      .dispatchEvent("input");
    assert.equal(await editor.locator("[data-speed]").textContent(), "1.5×");
    await editor
      .getByLabel("Warp mode", { exact: true })
      .selectOption("last-frame");
    assert.equal(
      await editor
        .getByRole("button", { name: "Export MP4", exact: true })
        .isDisabled(),
      true,
    );
    await editor
      .getByRole("button", { name: "Preview ending", exact: true })
      .click();
    await frame.waitForFunction(
      () =>
        !document.querySelector('.teaser-ending [data-action="export"]')
          .disabled,
    );
    const scrubbed = await editor.locator("video").evaluate(async (video) => {
      video.pause();
      const positions = [];
      for (const time of [video.duration - 0.3, 0.25]) {
        await new Promise((resolve) => {
          video.addEventListener("seeked", resolve, { once: true });
          video.currentTime = time;
        });
        positions.push(video.currentTime);
      }
      return { controls: video.controls, duration: video.duration, positions };
    });
    assert.equal(scrubbed.controls, true, "preview has normal video controls");
    assert.ok(scrubbed.duration > 3.4 && scrubbed.duration < 3.9);
    assert.ok(scrubbed.positions[0] > 3 && scrubbed.positions[1] < 0.3);
    const download = page.waitForEvent("download");
    await editor
      .getByRole("button", { name: "Export MP4", exact: true })
      .click();
    const exported = await download;
    assert.match(
      await frame.locator("#socialFileSummary").textContent(),
      /square-test/,
    );
    assert.doesNotMatch(
      await frame.locator("#socialFileSummary").textContent(),
      /suction/,
    );
    assert.equal(exported.suggestedFilename(), "square-test (suction).mp4");
    await exported.saveAs(path.join(work, "export.mp4"));
    if (process.env.OFENHANCER_SUCTION_REVIEW_DIR) {
      const captures = process.env.OFENHANCER_SUCTION_REVIEW_DIR;
      fs.mkdirSync(captures, { recursive: true });
      fs.copyFileSync(
        path.join(work, "export.mp4"),
        path.join(captures, "suction-ending-preview.mp4"),
      );
      await editor.locator("video").evaluate(async (video) => {
        video.muted = true;
        await video.play();
        video.pause();
        await new Promise((resolve) => {
          video.onseeked = resolve;
          video.currentTime = video.duration - 0.45;
        });
      });
      await page
        .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
        .screenshot({
          path: path.join(captures, "suction-editor-desktop.png"),
        });
      await page.setViewportSize({ width: 390, height: 1000 });
      assert.equal(
        await frame.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        true,
      );
      await page
        .locator(".xt-composer-dialog")
        .screenshot({ path: path.join(captures, "suction-editor-phone.png") });
    }
    await editor
      .getByRole("button", { name: "Apply ending", exact: true })
      .click();
    await editor
      .getByRole("dialog", { name: "Suction ending settings" })
      .waitFor({ state: "hidden" });
    assert.equal(
      await editor
        .getByRole("checkbox", { name: "Suction ending", exact: true })
        .isChecked(),
      true,
    );
    await frame.waitForFunction(() =>
      document
        .querySelector("#socialFileSummary")
        .textContent.includes("suction"),
    );
    await frame.locator("#saveTeaserDraft").click();
    await page.waitForFunction(() =>
      document
        .querySelector(".xt-composer-status")
        .textContent.includes("Draft saved"),
    );
    const name = await frame.evaluate(
      async (day) => (await OFEnhancerTeaserDrafts.get(day)).file.name,
      DAY,
    );
    assert.equal(name, "square-test (suction).mp4");
    await editor
      .getByRole("checkbox", { name: "Suction ending", exact: true })
      .uncheck();
    await frame.waitForFunction(
      () =>
        !document
          .querySelector("#socialFileSummary")
          .textContent.includes("suction"),
    );
    assert.match(
      await frame.locator("#socialFileSummary").textContent(),
      /square-test/,
    );
    let extraDownloads = 0;
    page.on("download", () => extraDownloads++);
    await editor
      .getByRole("checkbox", { name: "Suction ending", exact: true })
      .check();
    await editor
      .getByRole("button", { name: "Preview ending", exact: true })
      .click();
    await frame.waitForFunction(
      () =>
        !document.querySelector('.teaser-ending [data-action="use"]').disabled,
    );
    await editor
      .getByRole("button", { name: "Apply ending", exact: true })
      .click();
    await editor
      .getByRole("dialog", { name: "Suction ending settings" })
      .waitFor({ state: "hidden" });
    await frame.waitForFunction(() =>
      document
        .querySelector("#socialFileSummary")
        .textContent.includes("suction"),
    );
    assert.equal(
      extraDownloads,
      0,
      "Apply renders directly without downloading",
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("starting a new calendar draft keeps the teaser editor and selected clip", async () => {
  const page = await browser.newPage();
  try {
    const errors = await mount(page, true);
    let frame = await chooseSyntheticVideo(page);
    await frame.locator("#socialCaption").fill("Old draft caption");
    await frame.locator("#saveTeaserDraft").click();
    await page.waitForFunction(() =>
      document
        .querySelector(".xt-composer-status")
        ?.textContent.includes("Draft saved"),
    );
    await frame.locator("#newFromResume").evaluate((button) => button.click());
    await frame.waitForFunction(
      () => !document.querySelector("#newFromResume").disabled,
    );
    assert.equal(
      await frame.locator("#socialCaption").inputValue(),
      "Preview test",
      await frame.locator("#resumeError").textContent(),
    );
    assert.equal(await frame.locator("#uploadMedia").isVisible(), false);
    assert.equal(await frame.locator(".social-card").isVisible(), true);
    assert.equal(
      await frame
        .locator('input[name="workflowMode"][value="teaser"]')
        .isChecked(),
      true,
    );
    assert.equal(await frame.locator("#targetSocialX").isChecked(), true);
    assert.equal(
      await frame.getByRole("button", { name: "Review saved run" }).count(),
      0,
    );
    assert.match(
      await frame.locator("#socialFileSummary").textContent(),
      /preview-test\.mp4/,
    );
    await frame.locator("#saveTeaserDraft").click();
    await page.waitForFunction(() =>
      document
        .querySelector(".xt-composer-status")
        ?.textContent.includes("Draft saved"),
    );
    assert.equal(
      await page.evaluate(
        async (day) => (await OFEnhancerTeaserDrafts.get(day)).sessionId || "",
        DAY,
      ),
      "",
    );
    await page.evaluate(
      async ({ DAY, SESSION }) => {
        await OFEnhancerTeaserDrafts.checkpoint(DAY, "preparing", SESSION);
        await OFEnhancerTeaserDrafts.checkpoint(DAY, "prepared", SESSION);
      },
      { DAY, SESSION },
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
    frame = page
      .frames()
      .find((item) => item.url().includes("upload-console.html?teaserDay="));
    await frame.getByRole("button", { name: "Review saved run" }).waitFor();
    await frame.locator("#newUploadDraft").evaluate((button) => button.click());
    await frame.waitForFunction(
      () => !document.querySelector("#newUploadDraft").disabled,
    );
    assert.match(
      await frame.locator("#resumeError").textContent(),
      /Review saved run/,
    );
    assert.equal(await frame.locator("#uploadMedia").isVisible(), false);
    assert.equal(
      await frame.getByRole("button", { name: "Review saved run" }).count(),
      1,
    );
    assert.equal(
      await page.evaluate(
        async (day) => (await OFEnhancerTeaserDrafts.get(day)).sessionId,
        DAY,
      ),
      SESSION,
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

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
      await page
        .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
        .getAttribute("aria-label"),
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
      await page
        .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
        .getAttribute("aria-label"),
      /Tuesday, Oct 6/,
    );
    assert.deepEqual(errors, []);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
    await page.evaluate(() =>
      OFEnhancerTeaserComposer.open({
        date: "2026-10-07",
        request: async () => ({ clips: [] }),
      }),
    );
    await page.locator(".xt-composer-frame").waitFor();
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
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
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
    await (await folderButton(page)).waitFor();
    assert.equal(
      await frame
        .getByRole("button", { name: "Link episode", exact: true })
        .isVisible(),
      false,
      "an indexed clip already owns its episode while media is loading",
    );
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

for (const caption of ["Preview test", "My edited caption"])
  test(`late startup settings preserve the selected teaser episode and caption: ${caption || "empty"}`, async () => {
    const page = await browser.newPage();
    try {
      const errors = await mount(page, true, true);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page
        .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
        .waitFor({ state: "detached" });
      await page.evaluate(() =>
        OFEnhancerTeaserComposer.open({
          date: "2026-10-06",
          episodes: [{ sourceKey: "preview-test", title: "Preview test" }],
          request: async (op, payload) =>
            op === "openTeaserEpisodeFolder"
              ? window.OFEnhancerHost.request(op, payload)
              : { clips: [] },
        }),
      );
      await page.locator(".xt-episode-choice").click();
      await (await folderButton(page)).waitFor();
      await page.waitForFunction(
        () =>
          document
            .querySelector(".xt-composer-frame")
            ?.contentDocument?.querySelector("#socialCaption")?.value ===
          "Preview test",
      );
      const frame = page
        .frames()
        .find((item) => item.url().includes("?teaserDay="));
      assert.equal(
        await frame.locator("#socialCaption").inputValue(),
        "Preview test",
      );
      if (caption !== "Preview test")
        await frame.locator("#socialCaption").fill(caption);
      await frame.waitForFunction(() => typeof releaseSettings === "function");
      await frame.evaluate(() => {
        window.startupStatuses = [];
        new MutationObserver(() =>
          startupStatuses.push(
            document.querySelector("#matchStatus").textContent,
          ),
        ).observe(document.querySelector("#matchStatus"), {
          childList: true,
          subtree: true,
          characterData: true,
        });
        releaseSettings();
      });
      // Allow the startup matching debounce to run after settings completion.
      await frame.waitForTimeout(500);
      assert.deepEqual(
        await frame.evaluate(() =>
          startupStatuses.filter((text) =>
            /Waiting for edits|Loading the catalogue|Choose files and destinations/.test(
              text,
            ),
          ),
        ),
        [],
      );
      assert.equal(await frame.locator("#socialCaption").inputValue(), caption);
      assert.equal(
        await frame
          .getByRole("button", { name: "Link episode", exact: true })
          .isVisible(),
        false,
      );
      assert.equal(await (await folderButton(page)).isVisible(), true);
      await page.evaluate(() => {
        window.folderRequests = [];
        window.OFEnhancerHost = {
          request: async (op, payload) =>
            window.folderRequests.push({ op, payload }),
        };
      });
      await (await folderButton(page)).click();
      assert.deepEqual(await page.evaluate(() => window.folderRequests), [
        {
          op: "openTeaserEpisodeFolder",
          payload: { episodeKey: "preview-test" },
        },
      ]);
      await frame.locator("#uploadSocialTeaser").setInputFiles(VIDEO);
      await frame.locator("#saveTeaserDraft").click();
      await page.waitForFunction(
        () =>
          document.querySelector(".xt-composer-status")?.textContent ===
          "Draft saved for this day.",
      );
      const draft = await frame.evaluate(() =>
        OFEnhancerTeaserDrafts.get("2026-10-06"),
      );
      assert.equal(draft.episodeKey, "preview-test");
      assert.equal(draft.caption, caption);
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
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
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
    await (await folderButton(page)).waitFor();
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
    await (await folderButton(page)).click();
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
        .evaluate((folder) =>
          folder.parentElement.classList.contains("xt-composer-heading"),
        ),
      "episode folder is directly available in the desktop header",
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
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
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
    await (await folderButton(page)).waitFor();
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
      let lockedRemove = false;
      try {
        await OFEnhancerTeaserDrafts.remove("2026-10-06");
      } catch {
        lockedRemove = true;
      }
      return { impossibleDay, impossibleTime, lockedOverwrite, lockedRemove };
    }, SESSION);
    assert.deepEqual(result, {
      impossibleDay: true,
      impossibleTime: true,
      lockedOverwrite: true,
      lockedRemove: true,
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
    await page.mouse.click(1, 1);
    assert.equal(
      await page
        .locator(".xt-composer-dialog")
        .evaluate((dialog) => dialog.open),
      true,
      "outside click respects an active upload",
    );
    await frame.evaluate(() =>
      parent.postMessage(
        { type: "ofenhancer:teaser-running", running: false },
        location.origin,
      ),
    );
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="File actions"]').disabled,
    );
    await page.mouse.click(1, 1);
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
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
    await page
      .frameLocator(".xt-composer-frame")
      .locator(".teaser-preview-panel")
      .evaluate((grid, encoded) => {
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
      await page
        .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
        .getAttribute("aria-label"),
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
      await page
        .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
        .screenshot({
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
    await other
      .getByRole("button", { name: "Remove post", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove draft", exact: true })
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
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .screenshot({
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

test("clip chooser uses distinct posters and only one intent-loaded playback", async () => {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 780 },
  });
  try {
    await page.route("**/poster-*.svg", (route) => {
      const index = Number(
        route
          .request()
          .url()
          .match(/poster-(\d)/)[1],
      );
      return route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="${["#293b55", "#384c39", "#583b45"][index]}"/><circle cx="${70 + index * 80}" cy="160" r="45" fill="#81bbd7"/><text x="16" y="296" fill="white" font-size="22">Shot ${index + 1}</text></svg>`,
      });
    });
    await page.route("**/preview.mp4", (route) =>
      route.fulfill({ contentType: "video/mp4", body: fs.readFileSync(VIDEO) }),
    );
    await page.goto(`${origin}/host`);
    await page.evaluate(async () => {
      globalThis.previewRequests = [];
      const episode = { sourceKey: "sample", title: "Example episode" };
      await OFEnhancerTeaserComposer.open({
        date: "2026-10-06",
        episode,
        episodes: [episode],
        request: async (op, args) => {
          if (op === "getTeaserClips")
            return {
              clips: ["far", "closer", "close"].map((name, index) => ({
                clipId: String(index),
                name: `example-episode__t0${index + 1}-${name}.mp4`,
                episodeKey: "sample",
              })),
            };
          if (op === "getTeaserClipPreview") {
            previewRequests.push(args);
            return {
              posterUrl: `/poster-${args.clipId}.svg`,
              duration: 12 + Number(args.clipId),
              videoUrl: args.playback ? "/preview.mp4" : null,
            };
          }
          return { ok: true };
        },
      });
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".xt-clip-media[data-loaded]").length === 3,
    );
    const cards = page.locator(".xt-clip-choice[data-episode-key]");
    assert.deepEqual(await cards.locator("strong").allTextContents(), [
      "t01-far",
      "t02-closer",
      "t03-close",
    ]);
    assert.equal(
      await page.evaluate(
        () => previewRequests.filter((r) => r.playback).length,
      ),
      0,
    );
    await cards.nth(0).hover();
    await page.waitForFunction(
      () => document.querySelector(".xt-clip-video")?.readyState >= 2,
    );
    assert.equal(await page.locator(".xt-clip-video").count(), 1);
    await page.mouse.move(0, 0);
    await cards.nth(1).focus();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".xt-clip-video").length === 1 &&
        previewRequests.filter((r) => r.playback).length === 2,
    );
    assert.equal(await page.locator(".xt-clip-video").count(), 1);
    await page.getByRole("button", { name: "Close", exact: true }).focus();
    assert.equal(await page.locator(".xt-clip-video").count(), 0);
    const output = path.join(repositoryRoot, ".local/clip-preview-review");
    fs.mkdirSync(output, { recursive: true });
    await page
      .locator(".xt-composer-dialog")
      .screenshot({ path: path.join(output, "clip-choices-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .locator(".xt-composer-dialog")
      .screenshot({ path: path.join(output, "clip-choices-phone.png") });
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelector(".xt-composer-dialog").scrollWidth >
          document.querySelector(".xt-composer-dialog").clientWidth,
      ),
      false,
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector(".xt-composer-dialog"),
    );
  } finally {
    await page.close();
  }
});

test("editor is usable before catalogue lookup completes and keeps early edits", async () => {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });
  try {
    await mount(page, true);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
    await page.addInitScript(() => {
      const client = CreatorCatalogueClient;
      const get = client.getCatalogueSnapshot;
      let pending = true;
      client.getCatalogueSnapshot = async (...args) => {
        if (pending) {
          pending = false;
          await new Promise((resolve) => {
            globalThis.finishAssociation = resolve;
          });
        }
        return get(...args);
      };
    });
    await page.evaluate(() => {
      const episode = { sourceKey: "preview-test", title: "Preview test" };
      void OFEnhancerTeaserComposer.open({
        date: "2026-10-06",
        episode,
        episodes: [episode],
        request: async () => ({ clips: [] }),
      });
    });
    const editor = page.frameLocator(".xt-composer-frame");
    await editor.locator("#socialCaption").waitFor({ state: "visible" });
    assert.equal(
      await editor.locator("#socialCaption").inputValue(),
      "Preview test",
    );
    assert.equal(await page.locator(".xt-editor-loading").count(), 0);
    await editor.locator("#socialCaption").fill("Written before lookup");
    await editor.getByLabel("Posting time", { exact: true }).fill("19:45");
    assert.equal(await editor.locator("#socialPaidLink").isVisible(), false);
    assert.equal(
      await editor.locator("#socialErrors").textContent(),
      "",
      "catalogue lookup does not prematurely ask for a link",
    );
    assert.equal(
      await editor.locator("#socialCustomPaidLink").isVisible(),
      false,
    );
    const viewport = await editor
      .locator("#uploaderPanel")
      .evaluate((panel) => ({
        height: panel.clientHeight,
        content: panel.scrollHeight,
        scrollbar: getComputedStyle(panel).scrollbarWidth,
      }));
    assert.ok(
      viewport.content <= viewport.height,
      "desktop editor fits the custom URL field without scrolling",
    );
    assert.equal(viewport.scrollbar, "none");
    const output = path.join(repositoryRoot, ".local/editor-ready-review");
    fs.mkdirSync(output, { recursive: true });
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .screenshot({
        path: path.join(output, "early-editor-desktop.png"),
        animations: "disabled",
      });
    await page.evaluate(() =>
      document
        .querySelector(".xt-composer-frame")
        .contentWindow.finishAssociation(),
    );
    await page
      .getByRole("button", { name: "Change linked episode", exact: true })
      .waitFor();
    assert.equal(
      await editor.locator("#socialCaption").inputValue(),
      "Written before lookup",
    );
    assert.equal(
      await editor.getByLabel("Posting time", { exact: true }).inputValue(),
      "19:45",
    );
    assert.equal(
      await editor.locator("#socialCustomPaidLink").isVisible(),
      false,
    );
    assert.equal(
      await editor.locator("#socialPaidLink").inputValue(),
      "https://onlyfans.com/1/preview",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const mediaBox = await editor
      .locator(".teaser-planner-media")
      .boundingBox();
    const settingsBox = await editor
      .locator(".teaser-planner-settings")
      .boundingBox();
    assert.ok(
      mediaBox.y + mediaBox.height <= settingsBox.y,
      "empty media keeps its space above the phone form",
    );
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .screenshot({
        path: path.join(output, "early-editor-phone.png"),
        animations: "disabled",
      });
    assert.equal(
      await editor
        .locator("body")
        .evaluate((body) => body.scrollWidth > innerWidth),
      false,
    );
  } finally {
    await page.close();
  }
});

test("video replacement preserves post edits and discard uses an in-app dialog", async () => {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 850 },
  });
  try {
    const errors = await mount(page, true);
    const frame = await chooseSyntheticVideo(page);
    await page
      .getByRole("button", { name: "Change linked episode", exact: true })
      .waitFor();
    assert.equal(await frame.locator(".teaser-association").isVisible(), false);
    await frame.evaluate(() => {
      globalThis.OFEnhancerDesktopUpload = {
        ...globalThis.OFEnhancerDesktopUpload,
        copyTeaser: async () => ({}),
      };
    });
    await frame.locator("#socialCaption").fill("A caption to keep");
    await frame.getByLabel("Posting time", { exact: true }).fill("19:35");
    const choosing = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Replace video", exact: true })
      .click();
    await (
      await choosing
    ).setFiles({
      name: "replacement.mp4",
      mimeType: "video/mp4",
      buffer: fs.readFileSync(VIDEO),
    });
    await frame.waitForFunction(() =>
      document
        .querySelector("#socialFileSummary")
        .textContent.includes("replacement.mp4"),
    );
    assert.equal(
      await frame.locator("#socialCaption").inputValue(),
      "A caption to keep",
    );
    assert.equal(
      await frame.getByLabel("Posting time", { exact: true }).inputValue(),
      "19:35",
    );
    await frame.waitForFunction(
      () => document.querySelector(".teaser-video-preview").readyState >= 2,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "File actions", exact: true })
        .isVisible(),
      false,
    );
    assert.equal(
      await page.locator(".xt-composer-heading .teaser-copy-file").isVisible(),
      true,
    );
    assert.equal(
      await page.locator(".xt-composer-heading .xt-episode-folder").isVisible(),
      true,
    );
    assert.equal(
      await page.locator(".xt-composer-heading .xt-change-clip").isVisible(),
      true,
    );
    const output = path.join(repositoryRoot, ".local/teaser-controls-review");
    fs.mkdirSync(output, { recursive: true });
    await page.locator(".xt-composer-dialog").screenshot({
      path: path.join(output, "editor-desktop.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Discard changes?" });
    await confirm.waitFor();
    await confirm.screenshot({
      path: path.join(output, "discard-dialog.png"),
      animations: "disabled",
    });
    await confirm
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    assert.equal(
      await frame.locator("#socialCaption").inputValue(),
      "A caption to keep",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".xt-composer-dialog").screenshot({
      path: path.join(output, "editor-phone.png"),
      animations: "disabled",
    });
    assert.equal(
      await page
        .getByRole("button", { name: "File actions", exact: true })
        .isVisible(),
      true,
    );
    await page
      .getByRole("button", { name: "File actions", exact: true })
      .click();
    assert.equal(
      await page.locator(".xt-composer-tools .teaser-copy-file").isVisible(),
      true,
    );
    assert.equal(
      await page.locator(".xt-composer-tools .xt-episode-folder").isVisible(),
      true,
    );
    await page
      .getByRole("button", { name: "File actions", exact: true })
      .click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Vegas project buttons dispatch the named project or template directly", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/host`);
    await page.evaluate(async () => {
      const dialog = document.createElement("dialog"),
        heading = document.createElement("header");
      heading.append(document.createElement("button"));
      dialog.append(heading);
      document.body.append(dialog);
      dialog.showModal();
      globalThis.projectCalls = [];
      globalThis.projectBusy = false;
      const meta = {
        projectName: "teaser.veg",
        projects: [{ name: "Untitled.veg" }, { name: "teaser.veg" }],
        templateAvailable: true,
      };
      globalThis.projectHandoff = OFEnhancerTeaserRenderHandoff.mount({
        dialog,
        heading,
        date: "2026-10-06",
        getContext: () => ({}),
        getFrame: () => null,
        busy: () => projectBusy,
        loadFile: async () => null,
        status: document.createElement("p"),
        request: async (op, payload) => {
          projectCalls.push({ op, payload });
          return op === "chooseTeaserProject" ? { cancelled: true } : meta;
        },
      });
      await projectHandoff.setEpisode("example-episode");
    });
    await page
      .getByRole("button", { name: "Vegas project and render", exact: true })
      .click();
    assert.deepEqual(
      await page.locator(".xt-vegas-projects button").allTextContents(),
      [
        "Edit teaser.veg",
        "Edit Untitled.veg",
        "Create from template",
        "Open another project…",
      ],
    );
    await page
      .getByRole("button", { name: "Edit Untitled.veg", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create from template", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Open another project…", exact: true })
      .click();
    const requests = await page.evaluate(() => projectCalls.slice(1));
    assert.deepEqual(requests, [
      {
        op: "openTeaserProject",
        payload: {
          episodeKey: "example-episode",
          date: "2026-10-06",
          projectName: "Untitled.veg",
        },
      },
      {
        op: "createTeaserProject",
        payload: { episodeKey: "example-episode", date: "2026-10-06" },
      },
      {
        op: "chooseTeaserProject",
        payload: { episodeKey: "example-episode", date: "2026-10-06" },
      },
    ]);
    await page.evaluate(() => {
      projectBusy = true;
      projectHandoff.refresh();
    });
    assert.equal(
      await page.locator(".xt-vegas-projects button:enabled").count(),
      0,
    );
  } finally {
    await page.close();
  }
});

test("selected episodes use catalogue links despite stale custom preferences and drafts", async () => {
  for (const links of [
    { onlyfansLink: "https://onlyfans.com/1/preview" },
    {
      pornhubPaidLink:
        "https://www.pornhub.com/view_video.php?viewkey=phpreview",
    },
    { pornhubLink: "https://www.pornhub.com/view_video.php?viewkey=phfree" },
    {},
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1365, height: 900 },
    });
    try {
      await page.addInitScript(() =>
        localStorage.setItem(
          "OFEnhancerTeaserPreferencesV1",
          JSON.stringify({
            linkKind: "custom",
            customUrl: "https://onlyfans.com/999/wrong",
          }),
        ),
      );
      const errors = await mount(page, true, false, links);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.locator(".xt-composer-dialog").waitFor({ state: "detached" });
      await page.evaluate(
        async (bytes) => {
          await OFEnhancerTeaserDrafts.save({
            date: "2026-10-06",
            file: new File([new Uint8Array(bytes)], "preview-test.mp4", {
              type: "video/mp4",
            }),
            caption: "Preview test",
            episodeKey: "preview-test",
            paidUrl: "https://onlyfans.com/999/wrong",
          });
        },
        [...fs.readFileSync(VIDEO)],
      );
      await page.evaluate(
        () =>
          void OFEnhancerTeaserComposer.open({
            date: "2026-10-06",
            episode: { sourceKey: "preview-test", title: "Preview test" },
            episodes: [{ sourceKey: "preview-test", title: "Preview test" }],
            request: async (op) =>
              op === "getTeaserClips" ? { clips: [] } : { ok: true },
          }),
      );
      await page.locator(".xt-composer-frame").waitFor();
      const frame = page
        .frames()
        .find((frame) => frame.url().includes("?teaserDay="));
      assert.ok(frame);
      const expected =
        links.onlyfansLink || links.pornhubPaidLink || links.pornhubLink || "";
      await frame.waitForFunction(
        (expected) =>
          document.querySelector("#socialPaidLink").value === expected &&
          Boolean(document.querySelector(".teaser-catalogue-link")),
        expected,
      );
      assert.equal(await frame.locator("#socialPaidLink").isVisible(), false);
      assert.equal(
        await frame.locator("#socialCustomPaidLink").isVisible(),
        false,
      );
      const link = frame.locator(".teaser-link-trigger");
      assert.equal(await link.isVisible(), true);
      assert.equal(
        await frame.locator("#socialPaidLink").inputValue(),
        expected,
      );
      if (!expected)
        assert.equal(await link.textContent(), "Choose reply link…");
      await frame
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      await page.waitForFunction(
        async () =>
          (await OFEnhancerTeaserDrafts.get("2026-10-06"))?.paidUrl !==
          "https://onlyfans.com/999/wrong",
      );
      assert.equal(
        await page.evaluate(
          async () => (await OFEnhancerTeaserDrafts.get("2026-10-06")).paidUrl,
        ),
        expected,
      );
      if (links.onlyfansLink) {
        const output = path.join(
          repositoryRoot,
          ".local/teaser-catalogue-link-review",
        );
        fs.mkdirSync(output, { recursive: true });
        await page.keyboard.press("Tab");
        await frame
          .getByRole("button", { name: "Choose reply link", exact: true })
          .focus();
        await frame
          .locator(".teaser-schedule-row")
          .screenshot({ path: path.join(output, "link-row.png") });
        await page.screenshot({ path: path.join(output, "desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(output, "phone.png") });
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  }
});

test("unlinked random videos ask for their own URL without reusing another episode link", async () => {
  const page = await browser.newPage();
  try {
    await page.addInitScript(() =>
      localStorage.setItem(
        "OFEnhancerTeaserPreferencesV1",
        JSON.stringify({
          linkKind: "custom",
          customUrl: "https://onlyfans.com/999/wrong",
        }),
      ),
    );
    await mount(page);
    const frame = await chooseSyntheticVideo(page);
    assert.equal(await frame.locator(".teaser-link-trigger").isVisible(), true);
    assert.equal(
      await frame.locator("#socialCustomPaidLink").isVisible(),
      true,
    );
    assert.equal(await frame.locator("#socialCustomPaidLink").inputValue(), "");
    await chooseReplyLink(frame, "fallback:onlyfans");
    await chooseReplyLink(frame, "custom");
    assert.equal(
      await frame.locator("#socialCustomPaidLink").isVisible(),
      true,
    );
    await frame
      .locator("#socialCustomPaidLink")
      .fill("https://onlyfans.com/2/random");
    await frame
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await page.waitForFunction(
      async () =>
        (await OFEnhancerTeaserDrafts.get("2026-10-06"))?.paidUrl ===
        "https://onlyfans.com/2/random",
    );
  } finally {
    await page.close();
  }
});

test("missing-link fallbacks preserve the episode and freeze a random choice across reopening", async () => {
  const page = await browser.newPage({
    viewport: { width: 1365, height: 900 },
  });
  try {
    const other = (id, row, title) => ({
      id,
      row,
      itemId: id,
      title,
      fingerprint: "b".repeat(64),
      publicationState: {},
      onlyfansLink: `https://onlyfans.com/${row}/preview`,
    });
    const errors = await mount(page, true, false, {}, [
      other("other-first", 3, "Another video"),
      other("other-second", 4, "Second video"),
    ]);
    let frame = await chooseSyntheticVideo(page);
    await page
      .getByRole("button", { name: "Change linked episode", exact: true })
      .waitFor();
    const save = async (url, choice) => {
      await frame
        .getByRole("button", { name: /^(Save draft|Saved)$/, exact: true })
        .click();
      await page.waitForFunction(
        async ({ url, choice }) => {
          const draft = await OFEnhancerTeaserDrafts.get("2026-10-06");
          return (
            draft?.paidUrl === url && draft?.linkFallback?.choice === choice
          );
        },
        { url, choice },
      );
      const draft = await page.evaluate(() =>
        OFEnhancerTeaserDrafts.get("2026-10-06"),
      );
      assert.equal(
        draft.episodeKey,
        "preview-test",
        "fallback never reassigns the teaser episode",
      );
      assert.doesNotMatch(
        await frame.locator("#socialErrors").textContent(),
        /paid-video link|paid URL/,
      );
    };
    await chooseReplyLink(frame, "fallback:onlyfans");
    await save("https://onlyfans.com/johnny_guides", "onlyfans");
    await chooseReplyLink(frame, "fallback:fansly");
    await save("https://fansly.com/Johnny_Guides/posts", "fansly");
    await chooseReplyLink(frame, "fallback:video:other-second");
    await save("https://onlyfans.com/4/preview", "video:other-second");
    await frame.evaluate(() => (Math.random = () => 0));
    await chooseReplyLink(frame, "fallback:random");
    await save("https://onlyfans.com/3/preview", "random");
    await frame
      .locator("#socialCaption")
      .fill("Caption changed after choosing fallback");
    await save("https://onlyfans.com/3/preview", "random");
    const output = path.join(repositoryRoot, ".local/teaser-fallback-review");
    fs.mkdirSync(output, { recursive: true });
    await frame
      .locator(".teaser-schedule-row")
      .screenshot({ path: path.join(output, "fallback-row.png") });
    await page.screenshot({ path: path.join(output, "desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, "phone.png") });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".xt-composer-dialog").waitFor({ state: "detached" });
    await page.addInitScript(() => (Math.random = () => 0.999));
    await page.locator("#open-day").click();
    await page.locator(".xt-composer-frame").waitFor();
    frame = page.frames().find((frame) => frame.url().includes("?teaserDay="));
    await frame.waitForFunction(
      () =>
        document.querySelector("#socialPaidLink")?.value === "fallback:random",
    );
    await save("https://onlyfans.com/3/preview", "random");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("an accidental Twitter draft can be removed without deleting its video or Reddit drafts", async () => {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 850 },
  });
  try {
    const errors = await mount(page, true);
    let frame = await chooseSyntheticVideo(page);
    await frame.locator("#saveTeaserDraft").click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
    await page.evaluate(async () => {
      globalThis.removalCalls = [];
      const draft = await OFEnhancerTeaserDrafts.get("2026-10-06");
      await OFEnhancerTeaserDrafts.savePost({
        ...draft,
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        subreddit: "example_community",
      });
      void OFEnhancerTeaserComposer.open({
        date: "2026-10-06",
        request: async (op, payload) => {
          removalCalls.push({ op, payload });
          return op === "getTeaserPlan"
            ? { slots: [{ date: "2026-10-06", episodeKey: "preview-test" }] }
            : { ok: true };
        },
      });
    });
    await page.locator(".xt-composer-frame").waitFor();
    frame = page.frames().find((frame) => frame.url().includes("?teaserDay="));
    const remove = frame.getByRole("button", {
      name: "Remove draft",
      exact: true,
    });
    await remove.waitFor();
    const buttonStyles = await frame
      .locator("#uploadActions > :is(.teaser-remove-draft, #saveTeaserDraft)")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const style = getComputedStyle(button);
          return [
            style.backgroundColor,
            style.borderColor,
            style.fontSize,
            style.fontWeight,
          ];
        }),
      );
    assert.deepEqual(
      buttonStyles[0],
      buttonStyles[1],
      "remove reuses the existing footer button style",
    );
    assert.equal(
      await frame
        .locator(".xt-planner-post-actions .teaser-remove-draft")
        .count(),
      0,
    );
    assert.deepEqual(
      await frame
        .locator("#uploadActions > button")
        .evaluateAll((buttons) =>
          buttons
            .filter((button) => !button.hidden)
            .map((button) => button.textContent),
        ),
      ["Remove draft", "Save draft", "Send to Twitter"],
    );
    await remove.click();
    await page.getByRole("button", { name: "Keep draft", exact: true }).click();
    assert.ok(
      await page.evaluate(() => OFEnhancerTeaserDrafts.get("2026-10-06")),
    );
    const output = path.join(repositoryRoot, ".local/draft-removal-review");
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "remove-draft.png") });
    await frame
      .locator("#uploadActions")
      .screenshot({ path: path.join(output, "draft-actions.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const footer = await frame.locator("#uploadActions").evaluate((node) => ({
      width: node.clientWidth,
      content: node.scrollWidth,
    }));
    assert.ok(
      footer.content <= footer.width,
      "footer actions fit narrow windows",
    );
    await frame
      .locator("#uploadActions")
      .screenshot({ path: path.join(output, "draft-actions-phone.png") });
    await page.setViewportSize({ width: 1200, height: 850 });
    await remove.click();
    await page
      .locator(".xt-confirm-dialog")
      .getByRole("button", { name: "Remove draft", exact: true })
      .click();
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
    const result = await page.evaluate(async () => ({
      draft: await OFEnhancerTeaserDrafts.get("2026-10-06"),
      reddit: await OFEnhancerTeaserDrafts.getPost(
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ),
      calls: removalCalls,
    }));
    assert.equal(result.draft, null);
    assert.equal(result.reddit.id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.equal(
      await page.evaluate(
        async () =>
          (
            await OFEnhancerTeaserDrafts.getPost(
              "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            )
          ).file.name,
      ),
      "preview-test.mp4",
    );
    assert.ok(fs.existsSync(VIDEO), "the original video remains on disk");
    assert.deepEqual(
      result.calls
        .filter((call) =>
          ["getTeaserPlan", "clearTeaserPlanSlot"].includes(call.op),
        )
        .map((call) => call.op),
      ["getTeaserPlan", "clearTeaserPlanSlot"],
    );
    assert.deepEqual(
      result.calls.find((call) => call.op === "clearTeaserPlanSlot").payload,
      { date: "2026-10-06" },
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("a legacy unlinked filename resolves its catalogue Pornhub link automatically", async () => {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 850 },
  });
  try {
    const errors = await mount(page, true, false, {
      pornhubLink: "https://www.pornhub.com/view_video.php?viewkey=phlegacy",
    });
    const frame = await chooseSyntheticVideo(page);
    await frame.locator(".teaser-link-trigger").waitFor();
    assert.equal(
      await frame.locator("#socialPaidLink").inputValue(),
      "https://www.pornhub.com/view_video.php?viewkey=phlegacy",
    );
    assert.equal(await frame.locator("#socialPaidLink").isVisible(), false);
    assert.equal(
      await frame.locator("#socialCustomPaidLink").isVisible(),
      false,
    );
    assert.doesNotMatch(
      await frame.locator("#socialErrors").textContent(),
      /reply|link/,
    );
    await frame.locator("#saveTeaserDraft").click();
    await page.waitForFunction(
      async () =>
        (await OFEnhancerTeaserDrafts.get("2026-10-06"))?.episodeKey ===
        "preview-test",
    );
    const saved = await page.evaluate(async () => {
      const draft = await OFEnhancerTeaserDrafts.get("2026-10-06");
      return { episodeKey: draft.episodeKey, paidUrl: draft.paidUrl };
    });
    assert.deepEqual(saved, {
      episodeKey: "preview-test",
      paidUrl: "https://www.pornhub.com/view_video.php?viewkey=phlegacy",
    });
    const output = path.join(
      repositoryRoot,
      ".local/catalogue-resolution-review",
    );
    fs.mkdirSync(output, { recursive: true });
    await frame
      .locator(".teaser-schedule-row")
      .screenshot({ path: path.join(output, "resolved-link.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await frame
      .locator(".teaser-schedule-row")
      .screenshot({ path: path.join(output, "resolved-link-phone.png") });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("teaser validation stays quiet until Send and clears as fields are corrected", async () => {
  const page = await browser.newPage();
  try {
    const errors = await mount(page, true, false, {});
    const frame = await chooseSyntheticVideo(page);
    await page
      .getByRole("button", { name: "Change linked episode", exact: true })
      .waitFor();
    await frame.locator("#socialCaption").fill("");
    assert.equal(await frame.locator("#socialErrors").textContent(), "");
    await frame.evaluate(() => {
      globalThis.attemptMessages = [];
      const send = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (message, callback) => {
        attemptMessages.push(message.type);
        return send(message, callback);
      };
    });
    await frame
      .getByRole("button", { name: "Send to Twitter", exact: true })
      .click();
    assert.match(
      await frame.locator("#socialErrors").textContent(),
      /Enter the social caption/,
    );
    assert.match(
      await frame.locator("#socialErrors").textContent(),
      /no paid-video link/,
    );
    assert.equal(
      await frame.evaluate(() =>
        attemptMessages.some((type) =>
          /PREPARE_CREATOR|START_CREATOR/.test(type),
        ),
      ),
      false,
      "invalid input never starts publishing",
    );
    await frame.locator("#socialCaption").fill("A corrected caption");
    assert.doesNotMatch(
      await frame.locator("#socialErrors").textContent(),
      /social caption/,
    );
    await chooseReplyLink(frame, "fallback:onlyfans");
    assert.equal(await frame.locator("#socialErrors").textContent(), "");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("reply picker recommends related OnlyFans videos without changing the episode", async () => {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 850 },
  });
  try {
    const related = {
      id: "related-video",
      row: 3,
      itemId: "related-video",
      title: "River adventure continues",
      seasonArc: "River Stories",
      category: "Games",
      fingerprint: "b".repeat(64),
      onlyfansLink: "https://onlyfans.com/3/related",
      publicationState: {},
    };
    const unrelated = {
      ...related,
      id: "unrelated-video",
      row: 4,
      itemId: "unrelated-video",
      title: "A different story",
      seasonArc: "Other",
      category: "Other",
      onlyfansLink: "https://onlyfans.com/4/other",
    };
    const otherPlatform = {
      ...related,
      id: "manyvids-video",
      row: 5,
      itemId: "manyvids-video",
      onlyfansLink: "",
      manyvidsLink: "https://www.manyvids.com/Video/5/river",
    };
    const errors = await mount(
      page,
      true,
      false,
      {
        pornhubLink:
          "https://www.pornhub.com/view_video.php?viewkey=phoriginal",
        seasonArc: "River Stories",
        category: "Games",
      },
      [unrelated, otherPlatform, related],
    );
    let frame = await chooseSyntheticVideo(page);
    await frame
      .getByRole("button", { name: "Choose reply link", exact: true })
      .click();
    const picker = frame.locator(".teaser-link-picker");
    assert.equal(
      await picker.getByLabel("Reply video platform").inputValue(),
      "onlyfans",
    );
    assert.deepEqual(
      await picker
        .locator(".teaser-link-result")
        .evaluateAll((buttons) =>
          buttons.map((button) => button.dataset.choice),
        ),
      ["fallback:video:related-video", "fallback:video:unrelated-video"],
    );
    assert.match(
      await picker.locator(".teaser-link-result").first().textContent(),
      /Same series/,
    );
    const output = path.join(repositoryRoot, ".local/related-link-review");
    fs.mkdirSync(output, { recursive: true });
    await picker.screenshot({ path: path.join(output, "picker-desktop.png") });
    await picker.getByLabel("Find a reply video").fill("different");
    assert.equal(await picker.locator(".teaser-link-result").count(), 1);
    await picker.getByLabel("Find a reply video").fill("not in catalogue");
    assert.match(await picker.textContent(), /No matching OnlyFans videos/);
    await picker.getByLabel("Find a reply video").fill("");
    await picker
      .locator('[data-choice="fallback:video:related-video"]')
      .click();
    await frame.locator("#saveTeaserDraft").click();
    await page.waitForFunction(
      async () =>
        (await OFEnhancerTeaserDrafts.get("2026-10-06"))?.linkFallback
          ?.choice === "video:related-video",
    );
    const draft = await page.evaluate(async () => {
      const draft = await OFEnhancerTeaserDrafts.get("2026-10-06");
      return { episodeKey: draft.episodeKey, paidUrl: draft.paidUrl };
    });
    assert.deepEqual(draft, {
      episodeKey: "preview-test",
      paidUrl: "https://onlyfans.com/3/related",
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .locator(".xt-composer-dialog:not(.xt-confirm-dialog)")
      .waitFor({ state: "detached" });
    await page.locator("#open-day").click();
    await page.locator(".xt-composer-frame").waitFor();
    frame = page.frames().find((frame) => frame.url().includes("?teaserDay="));
    await frame.waitForFunction(
      () =>
        document.querySelector("#socialPaidLink")?.value ===
        "fallback:video:related-video",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await frame
      .getByRole("button", { name: "Choose reply link", exact: true })
      .click();
    const mobilePicker = frame.locator(".teaser-link-picker");
    const box = await mobilePicker.boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= 390,
      "picker fits a narrow window",
    );
    await mobilePicker.screenshot({
      path: path.join(output, "picker-phone.png"),
    });
    await frame.getByLabel("Find a reply video").fill("continues");
    await frame.locator("#socialCaption").click();
    assert.equal(
      await mobilePicker.evaluate((panel) => panel.matches(":popover-open")),
      false,
      "click-away dismisses the picker",
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
