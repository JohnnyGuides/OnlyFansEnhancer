"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
const source = path.resolve(
  __dirname,
  "../../extensions/personal/workflows/upload-trace-recorder.js",
);
// Offline DOM fixture. No authenticated browser, network upload or platform action.
test("recorder captures bounded page visibility changes without reading page content", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<main><textarea>DO-NOT-RECORD-PRIVATE-CAPTION</textarea></main>",
      }),
    );
    await page.goto("https://www.manyvids.com/upload-video");
    await page.evaluate(() => {
      window.stored = {};
      window.chrome = {
        runtime: { sendMessage: async () => ({ ownerId: "fixture-tab" }) },
        storage: {
          local: {
            get: async (key) => ({ [key]: stored[key] }),
            set: async (values) =>
              Object.assign(stored, structuredClone(values)),
            remove: async (key) => delete stored[key],
          },
          onChanged: { addListener() {} },
        },
      };
      window.fixtureVisible = true;
      Object.defineProperty(document, "visibilityState", {
        get: () => (fixtureVisible ? "visible" : "hidden"),
        configurable: true,
      });
      Object.defineProperty(document, "hasFocus", {
        value: () => fixtureVisible,
        configurable: true,
      });
    });
    await page.addScriptTag({ path: source });
    await page.evaluate(() => CreatorUploadTraceRecorder.showPanel());
    await page
      .getByRole("button", { name: "Start trace", exact: true })
      .click();
    await page.waitForFunction(() =>
      Object.values(stored).some((value) => value?.active === true),
    );
    await page.evaluate(() => {
      fixtureVisible = false;
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("blur"));
    });
    await page.waitForFunction(
      () =>
        Object.values(stored).some((value) =>
          value?.events?.some(
            (event) =>
              event.type === "page-visibility" &&
              event.data.visibility === "hidden",
          ),
        ),
      {},
      { timeout: 1500 },
    );
    await page.evaluate(() => {
      fixtureVisible = true;
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(() =>
      Object.values(stored).some(
        (value) =>
          value?.events?.filter((event) => event.type === "page-visibility")
            .length === 3,
      ),
    );
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Stop and download", exact: true })
      .click();
    await download;
    const states = await page.evaluate(() =>
      Object.values(stored)
        .find((value) => value?.events)
        ?.events.filter((event) => event.type === "page-visibility")
        .map((event) => event.data),
    );
    assert.deepEqual(
      states.map((state) => [state.visibility, state.focused]),
      [
        ["visible", true],
        ["hidden", false],
        ["visible", true],
      ],
    );
    assert.ok(
      states.every(
        (state) =>
          state.frame === "top" && typeof state.documentGeneration === "string",
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(states),
      /DO-NOT-RECORD|PRIVATE-CAPTION|textarea|https:/,
    );
    await page.evaluate(() => {
      fixtureVisible = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const count = await page.evaluate(
      () =>
        Object.values(stored)
          .find((value) => value?.events)
          ?.events.filter((event) => event.type === "page-visibility").length,
    );
    assert.equal(
      count,
      3,
      "Stopped recorder must not capture further visibility events",
    );
  } finally {
    await browser.close();
  }
});
