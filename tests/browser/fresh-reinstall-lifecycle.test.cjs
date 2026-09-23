"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");
const root = require("../support/paths.cjs").repositoryRoot;

const targetId = "aocoaajmhccmefmfebgiiogfdojciild";

async function worker(context, id) {
  const prefix = `chrome-extension://${id}/`;
  let current = context
    .serviceWorkers()
    .find((item) => item.url().startsWith(prefix));
  if (current) return current;
  current = await context.waitForEvent("serviceworker", {
    predicate: (item) => item.url().startsWith(prefix),
    timeout: 30_000,
  });
  return current;
}

async function launch(profile, target) {
  return chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${target}`,
      `--load-extension=${target}`,
      "--no-first-run",
    ],
  });
}

async function waitForInstallation(serviceWorker) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await serviceWorker.evaluate(() =>
      extensionLifecycle.getInstallation(),
    );
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

test(
  "real persistent Chromium self-removes and a genuine reinstall creates a clean new receipt",
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== "win32")
      return t.skip("Windows Chrome lifecycle regression");
    const stage = path.join(root, "dist", "ofenhancer-desktop-v0.20.58");
    const target = path.join(stage, "extension-keyed");
    if (!fs.existsSync(path.join(target, "manifest.json")))
      return t.skip(
        "Run npm run stage:desktop before the real-browser lifecycle gate.",
      );
    const profile = fs.mkdtempSync(
      path.join(os.tmpdir(), "ofe-real-lifecycle-"),
    );
    let context;
    try {
      context = await launch(profile, target);
      const targetWorker = await worker(context, targetId);
      const original = await waitForInstallation(targetWorker);
      assert.ok(
        original,
        "the genuine first load must finish installation initialization",
      );
      await targetWorker.evaluate(async () => {
        await chrome.storage.local.set({ oldLocal: true });
        await chrome.storage.session.set({ oldSession: true });
        await chrome.storage.sync.set({ oldSync: true });
      });
      assert.match(original.id, /^[a-f0-9-]{36}$/i);
      const extensionsPage = await context.newPage();
      await extensionsPage.goto("chrome://extensions/");
      const card = extensionsPage.getByText("Creator Workflow Toolkit", {
        exact: true,
      });
      await card.waitFor({ state: "visible", timeout: 20_000 });
      await targetWorker
        .evaluate(() => extensionLifecycle.uninstall())
        .catch(() => {});
      await card.waitFor({ state: "detached", timeout: 20_000 });
      const deadPage = await context.newPage();
      await assert.rejects(
        deadPage.goto(`chrome-extension://${targetId}/popup.html`),
      );

      await context.close();
      context = await launch(profile, target);
      const reinstalled = await worker(context, targetId);
      const newInstallation = await waitForInstallation(reinstalled);
      const fresh = await reinstalled.evaluate(async () => ({
        local: await chrome.storage.local.get("oldLocal"),
        session: await chrome.storage.session.get("oldSession"),
        sync: await chrome.storage.sync.get("oldSync"),
      }));
      assert.ok(
        newInstallation,
        "a genuine second load must create an install receipt",
      );
      assert.notEqual(newInstallation.id, original.id);
      assert.deepEqual(fresh.local, {});
      assert.deepEqual(fresh.session, {});
      assert.deepEqual(fresh.sync, {});
    } finally {
      await context?.close().catch(() => {});
      fs.rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 250,
      });
    }
  },
);
