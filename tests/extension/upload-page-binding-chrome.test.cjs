"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

test("real Chrome accepts Fansly's stale sender URL only with the live owned homepage composer", async () => {
  const root = path.resolve(__dirname, "../..");
  const source = fs.readFileSync(
    path.join(root, "extensions/personal/background.js"),
    "utf8",
  );
  const start = source.indexOf(
    "async function assertCreatorUploadPageBinding(",
  );
  const end = source.indexOf("\nfunction creatorUploadSessionRecord", start);
  assert.ok(start >= 0 && end > start);
  const base = path.join(root, ".local");
  fs.mkdirSync(base, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(base, "fansly-binding-"));
  const extension = path.join(scratch, "extension");
  fs.mkdirSync(extension);
  fs.writeFileSync(
    path.join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Inert SPA binding fixture",
      version: "1.0",
      permissions: ["tabs", "webNavigation", "scripting"],
      host_permissions: ["https://fansly.com/*"],
      background: { service_worker: "background.js" },
      content_scripts: [
        { matches: ["https://fansly.com/*"], js: ["content.js"] },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(extension, "background.js"),
    `
    const port = {}; const creatorUploadPort = () => port;
    const session = { id: "fixture", executionPort: port }; let target;
    ${source.slice(start, end)}
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      (async () => {
        const frames = await chrome.webNavigation.getAllFrames({tabId: sender.tab.id});
        const frame = frames.find(item => item.frameId === 0);
        target ||= { platform: "fansly", tabId: sender.tab.id, documentId: sender.documentId, boundUrl: frame.url };
        try {
          await assertCreatorUploadPageBinding(session, target, sender);
          reply({ ok: true, senderUrl: sender.url, frameUrl: frame.url, boundUrl: target.boundUrl });
        } catch (error) { reply({ ok: false, error: error.message }); }
      })();
      return true;
    });
  `,
  );
  fs.writeFileSync(
    path.join(extension, "content.js"),
    `
    globalThis.CreatorFanslyComposers = new Map([["fixture", document.querySelector("app-post-creation")]]);
    document.documentElement.dataset.ready = "true";
    document.addEventListener("check-binding", () => chrome.runtime.sendMessage({}, result => {
      document.documentElement.dataset.result = JSON.stringify(result);
    }));
  `,
  );
  let context;
  try {
    context = await chromium.launchPersistentContext(
      path.join(scratch, "profile"),
      {
        headless: true,
        args: [
          "--disable-extensions-except=" + extension,
          "--load-extension=" + extension,
        ],
      },
    );
    // All requests are fulfilled locally: no account, login or live site is used.
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><style>app-post-creation{display:block}</style><app-post-creation><textarea></textarea></app-post-creation>",
      }),
    );
    const page = await context.newPage();
    await page.goto("https://fansly.com/");
    await page.waitForFunction(() => document.documentElement.dataset.ready);
    async function check(route, replace = false) {
      await page.evaluate(
        ({ route, replace }) => {
          delete document.documentElement.dataset.result;
          history.pushState({}, "", route);
          if (replace) {
            const composer = document.querySelector("app-post-creation");
            composer.replaceWith(composer.cloneNode(true));
          }
          document.dispatchEvent(new Event("check-binding"));
        },
        { route, replace },
      );
      await page.waitForFunction(() => document.documentElement.dataset.result);
      return page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.result),
      );
    }
    const accepted = await check("/home");
    assert.deepEqual(accepted, {
      ok: true,
      senderUrl: "https://fansly.com/",
      frameUrl: "https://fansly.com/home",
      boundUrl: "https://fansly.com/home",
    });
    const foreign = await check("/settings");
    assert.equal(foreign.ok, false);
    assert.match(foreign.error, /binding-changed/);
    const replaced = await check("/home", true);
    assert.equal(replaced.ok, false);
    assert.match(replaced.error, /composer-changed/);
  } finally {
    await context?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
