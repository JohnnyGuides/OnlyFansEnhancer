"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");
const root = path.resolve(__dirname, "../../extensions/personal");

test("Pornhub production bridge accepts only its approved role and manifest origin", async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  assert.ok(
    manifest.web_accessible_resources
      .find((entry) => entry.resources.includes("file-bridge.js"))
      .matches.includes("https://pornhub.mainhub.com/*"),
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<input type="file" class="dz-hidden-input">');
    await page.addScriptTag({
      path: path.join(root, "workflows/upload-file-bridge.js"),
    });
    const result = await page.evaluate(() => {
      const config = {
        sessionId: "pornhub-session-12345678",
        platform: "pornhub",
        bridgeUrl: "https://bridge.example/file-bridge.html",
        bridgeOrigin: "https://bridge.example",
        roles: {
          pornhub: {
            selector: "input.dz-hidden-input",
            kind: "video",
            token: "approved-role-token-123456",
          },
        },
      };
      const installed = CreatorUploadFileBridge.install(config);
      let rejected = false;
      try {
        CreatorUploadFileBridge.install({ ...config, platform: "onlyfans" });
      } catch {
        rejected = true;
      }
      return { roles: installed.roles, rejected };
    });
    assert.deepEqual(result, { roles: ["pornhub"], rejected: true });
  } finally {
    await browser.close();
  }
});

for (const existing of [false, true])
  test(`Pornhub activation owns the actual file input, existing=${existing}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button class="uploadButton">Select video</button>${existing ? '<input type="file" class="dz-hidden-input" hidden>' : ""}`,
      );
      await page.addScriptTag({
        path: path.join(root, "workflows/upload-platform-adapters.js"),
      });
      const result = await page.evaluate(async () => {
        let clicks = 0;
        document.querySelector("button").onclick = () => {
          clicks++;
          document.querySelector("input")?.remove();
          const input = document.createElement("input");
          input.type = "file";
          input.className = "dz-hidden-input";
          input.hidden = true;
          document.body.append(input);
          input.click();
        };
        const input =
          await CreatorUploadPlatformAdapters.activatePornhubUploader(
            new AbortController().signal,
          );
        return {
          clicks,
          owned: input === document.querySelector("input"),
          connected: input.isConnected,
        };
      });
      assert.deepEqual(result, { clicks: 1, owned: true, connected: true });
    } finally {
      await browser.close();
    }
  });
