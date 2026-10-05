"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
const { personalRoot } = require("../support/paths.cjs");

test("ManyVids actual XHR Save captures its bound video only after acceptance", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://www.manyvids.com/**", async (route) => {
      if (route.request().method() === "POST")
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: route.request().postData().includes("reject=true")
            ? '{"error":"validation failed"}'
            : "{}",
        });
      else
        await route.fulfill({
          contentType: "text/html",
          body: '<form id="videoSettingsForm"><input id="video_id" value="7470821"><button id="saveVideo" type="button">Save</button></form>',
        });
    });
    await page.goto("https://www.manyvids.com/Edit-vid/7470821");
    for (const file of ["catalogue-contract.js", "upload-response-observer.js"])
      await page.addScriptTag({
        path: path.join(personalRoot, "workflows", file),
      });
    const captured = await page.evaluate(async () => {
      const events = [];
      document.addEventListener("creator-upload-manual-publish", (event) =>
        events.push(JSON.parse(event.detail)),
      );
      if (
        !CreatorUploadResponseObserver.watch({
          sessionId: "manyvids-test-session",
          platform: "manyvids",
          videoId: "7470821",
          watchId: "0123456789abcdef0123456789abcdef",
          timeoutMs: 5000,
        })
      )
        throw new Error("watch not armed");
      const save = (body) =>
        new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/includes/saveVideo.php");
          xhr.addEventListener("loadend", () => setTimeout(resolve, 0));
          xhr.send(body);
        });
      await save("vid_id=999&edit_video=true");
      await save("vid_id=7470821&edit_video=true&reject=true");
      if (events.length)
        throw new Error("an unrelated or rejected Save produced a result");
      await save("vid_id=7470821&edit_video=true");
      await save("vid_id=7470821&edit_video=true");
      return events;
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].postUrl, "https://www.manyvids.com/Video/7470821");
  } finally {
    await browser.close();
  }
});
