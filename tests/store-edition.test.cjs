"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const repositoryRoot = path.resolve(__dirname, "..");
const extensionRoot = path.join(repositoryRoot, "store");
const screenshotPath = path.join(
  repositoryRoot,
  "store-listing",
  "screenshot-settings.png"
);

function allFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.name === "_metadata") return [];
    return entry.isDirectory() ? allFiles(fullPath) : [fullPath];
  });
}

function chromeExecutable() {
  const playwrightRoot = path.join(
    process.env.LOCALAPPDATA || "",
    "ms-playwright"
  );
  const installedChromium = fs.existsSync(playwrightRoot)
    ? fs
        .readdirSync(playwrightRoot)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort()
        .reverse()
        .map((name) =>
          path.join(playwrightRoot, name, "chrome-win64", "chrome.exe")
        )
        .find((candidate) => fs.existsSync(candidate))
    : "";
  const candidates = [
    process.env.CHROME_PATH,
    installedChromium,
    (() => {
      try {
        return chromium.executablePath();
      } catch {
        return "";
      }
    })(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

test("store package is remote-free and minimally scoped", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8")
  );
  assert.equal(manifest.name, "OFEnhancer");
  assert.equal(manifest.version, "0.7.0");
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://onlyfans.com/*"]);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.declarative_net_request, undefined);
  assert.ok(manifest.icons["128"]);

  const searchable = allFiles(extensionRoot)
    .filter((filePath) => /\.(?:js|json|html|md)$/i.test(filePath))
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  assert.doesNotMatch(
    searchable,
    /gelbooru|realbooru|127\.0\.0\.1|declarativeNetRequest|api[_ -]?key/i
  );
  assert.doesNotMatch(searchable, /\bfetch\s*\(|XMLHttpRequest|WebSocket/i);
});

test("store edition loads, requires consent, and renders listing screenshot", async () => {
  const executablePath = chromeExecutable();
  assert.ok(executablePath, "Chrome or Playwright Chromium was not found.");
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "fim-store-test-"));
  const context = await chromium.launchPersistentContext(profilePath, {
    executablePath,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      "--window-position=-32000,-32000",
      "--window-size=1280,800"
    ]
  });

  try {
    let workers = context.serviceWorkers();
    if (workers.length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 10000 });
      workers = context.serviceWorkers();
    }
    assert.equal(workers.length, 1);
    const extensionId = new URL(workers[0].url()).host;
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.locator("#consentAccepted").waitFor();

    assert.equal(await page.locator("#consentAccepted").isChecked(), false);
    assert.equal(await page.locator("#enabled").isDisabled(), true);
    assert.equal(await page.locator("#gelbooruFields").count(), 0);
    assert.equal(await page.locator("#realbooruFields").count(), 0);
    await page.screenshot({ path: screenshotPath });

    await page.locator("#consentAccepted").check();
    await page.locator("#enabled").check();
    await page.locator("#save").click();
    await page.locator("#status").filter({ hasText: "Saved." }).waitFor();

    const stored = await workers[0].evaluate(async () => {
      const result = await chrome.storage.local.get("fimSettingsV1");
      return result.fimSettingsV1;
    });
    assert.equal(stored.consentAccepted, true);
    assert.equal(stored.enabled, true);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
});
