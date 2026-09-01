"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const browserRoot = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
const chromePath = fs
  .readdirSync(browserRoot)
  .filter((name) => /^chromium-\d+$/.test(name))
  .sort()
  .reverse()
  .map((name) => path.join(browserRoot, name, "chrome-win64", "chrome.exe"))
  .find(fs.existsSync);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "social-trace-ui-"));

const fixtures = [
  {
    platform: "X",
    url: "https://x.com/compose/post",
    result: "https://x.com/johnny_guides/status/123456789",
    viewport: { width: 1280, height: 800 },
  },
  {
    platform: "Redgifs",
    url: "https://www.redgifs.com/upload",
    result: "https://www.redgifs.com/watch/safeslug",
    viewport: { width: 800, height: 700 },
  },
  {
    platform: "Reddit",
    url: "https://www.reddit.com/r/example/submit",
    result: "https://www.reddit.com/r/example/comments/abc123/a_title",
    viewport: { width: 390, height: 844 },
  },
];

(async () => {
  assert.ok(chromePath, "Chromium is unavailable.");
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromePath,
    headless: false,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      "--window-position=-32000,-32000",
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    await context.route(
      /https:\/\/(?:x\.com|www\.redgifs\.com|www\.reddit\.com)\/.*/,
      (route) => {
        const fixture = fixtures.find((item) =>
          route.request().url().startsWith(new URL(item.url).origin),
        );
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body>
          <input aria-label="Video" type="file" accept="video/*">
          <textarea aria-label="Caption"></textarea>
          <button type="button">Post</button>
          <div role="status">Upload complete</div>
          <a href="${fixture.result}">View post</a>
        </body></html>`,
        });
      },
    );

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator("#toolUploadTraceRecorder").waitFor();
    await options.locator("#saveWorkflow").click();
    await options
      .locator("#workflowStatus")
      .filter({ hasText: "Workflow settings saved." })
      .waitFor({ timeout: 60000 });
    await options.close();

    for (const fixture of fixtures) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(fixture.viewport);
      await page.goto(fixture.url);
      await page.getByRole("button", { name: "Start trace" }).waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${fixture.platform} recorder overflows horizontally`,
      );
      await page.getByRole("button", { name: "Start trace" }).click();
      await page.getByLabel("Caption").fill("PRIVATE CAPTION MUST NOT LEAK");
      await page.getByRole("button", { name: "Post", exact: true }).click();
      await page.waitForTimeout(400);
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Stop and download" }).click();
      const download = await downloadPromise;
      const downloadPath = await download.path();
      const trace = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
      const serialized = JSON.stringify(trace);
      assert.equal(trace.platform, fixture.platform);
      assert.doesNotMatch(serialized, /PRIVATE CAPTION MUST NOT LEAK/);
      assert.match(serialized, /"valueState":"nonempty"/);
      assert.match(
        serialized,
        new RegExp(fixture.result.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.deepEqual(errors, []);
      await page.getByRole("button", { name: "Discard saved trace" }).click();
      await page.close();
    }

    console.log(
      "PASS: Chrome rendered sanitized X, Redgifs, and Reddit trace capture without publishing.",
    );
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(profile, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
