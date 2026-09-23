"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");
const root = path.resolve(__dirname, "../../extensions/personal");

test("Pornhub production bridge accepts video and owned thumbnail roles on its manifest origin", async () => {
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
    await page.setContent(
      '<input type="file" class="dz-hidden-input"><div class="custom-thumbnails pcView"><input type="file" class="uploadFile"></div>',
    );
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
          thumbnail: {
            selector: ".custom-thumbnails.pcView input.uploadFile",
            kind: "image",
            token: "approved-thumbnail-token-123456",
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
    assert.deepEqual(result, {
      roles: ["pornhub", "thumbnail"],
      rejected: true,
    });
  } finally {
    await browser.close();
  }
});

test("Pornhub bridge assigns the approved thumbnail to its own input", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<input id="video" type="file"><div class="custom-thumbnails pcView"><input id="thumbnail" type="file"></div>',
    );
    await page.addScriptTag({
      path: path.join(root, "workflows/upload-file-bridge.js"),
    });
    await page.evaluate(() =>
      CreatorUploadFileBridge.install({
        sessionId: "pornhub-thumbnail-12345678",
        platform: "pornhub",
        bridgeUrl: "about:blank",
        bridgeOrigin: "null",
        roles: {
          pornhub: {
            selector: "#video",
            kind: "video",
            token: "video-token-123456",
          },
          thumbnail: {
            selector: "#thumbnail",
            kind: "image",
            token: "thumbnail-token-123456",
          },
        },
      }),
    );
    const frame = page
      .frames()
      .find((candidate) => candidate !== page.mainFrame());
    assert.ok(frame);
    await frame.evaluate(() => {
      parent.postMessage(
        {
          source: "creator-upload-file-bridge",
          sessionId: "pornhub-thumbnail-12345678",
          platform: "pornhub",
          role: "thumbnail",
          token: "thumbnail-token-123456",
          file: new File(["image"], "neutral-thumbnail.png", {
            type: "image/png",
          }),
        },
        "*",
      );
    });
    await page.waitForFunction(
      () => document.querySelector("#thumbnail").files.length === 1,
    );
    assert.equal(
      await page.locator("#thumbnail").evaluate((input) => input.files[0].name),
      "neutral-thumbnail.png",
    );
    assert.equal(
      await page.locator("#video").evaluate((input) => input.files.length),
      0,
    );
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
