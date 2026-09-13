"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

async function fixture(browser, url, html) {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto(url);
  await page.addScriptTag({
    path: path.join(
      require("../support/paths.cjs").personalRoot,
      "workflows/social-preparation-adapter.js",
    ),
  });
  return page;
}

test("Reddit preparation fills visible title, then a shadow link, and never clicks Post", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await fixture(
      browser,
      "https://www.reddit.com/r/example/submit/?type=LINK",
      `
      <input type="hidden" name="subredditName" value="example">
      <div slot="editor" contenteditable="true" role="textbox"></div>
      <faceplate-textarea-input name="link"></faceplate-textarea-input>
      <button onclick="window.postClicks=(window.postClicks||0)+1">Post</button>
      <script>document.querySelector('faceplate-textarea-input').attachShadow({mode:'open'}).innerHTML='<textarea name="link"></textarea>'</script>`,
    );
    const prepared = await page.evaluate(() =>
      CreatorSocialPreparationAdapter.run({
        platform: "reddit",
        action: "prepare",
        subreddit: "example",
        title: "Draft title",
        body: "Body needs review",
        flair: "Video",
        nsfw: true,
      }),
    );
    assert.equal(
      await page.locator('[slot="editor"]').textContent(),
      "Draft title",
    );
    assert.deepEqual(prepared.manualFields, [
      "body",
      "flair",
      "nsfw",
      "publish",
    ]);
    const linked = await page.evaluate(async () => {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("Draft title"),
      );
      const titleHash = Array.from(new Uint8Array(bytes), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      return CreatorSocialPreparationAdapter.run({
        platform: "reddit",
        action: "link",
        subreddit: "example",
        titleHash,
        redgifsUrl: "https://www.redgifs.com/watch/examplevideo",
      });
    });
    assert.equal(linked.status, "ready-for-review");
    assert.equal(
      await page.locator('textarea[name="link"]').inputValue(),
      "https://www.redgifs.com/watch/examplevideo",
    );
    assert.equal(await page.evaluate(() => window.postClicks || 0), 0);
    await assert.rejects(
      page.evaluate(() =>
        CreatorSocialPreparationAdapter.run({
          platform: "reddit",
          action: "submit",
        }),
      ),
      /Unknown|manual/,
    );
  } finally {
    await browser.close();
  }
});

test("Redgifs preparation waits for authorized file and reports unautomated metadata without publishing", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await fixture(
      browser,
      "https://studio.redgifs.com/upload",
      `<input type="file" accept="video/*"><button onclick="window.published=true">Publish</button>`,
    );
    const result = await page.evaluate(async () => {
      window.CreatorUploadFileBridge = {
        waitFor: async (id, role) => ({ name: "teaser.mp4", size: 10, role }),
      };
      return CreatorSocialPreparationAdapter.run({
        platform: "redgifs",
        action: "prepare",
        sessionId: "example-session",
        caption: "Caption",
      });
    });
    assert.equal(result.upload, "file-attached");
    assert.equal(result.status, "review-required");
    assert.deepEqual(result.manualFields, ["caption", "tags", "publish"]);
    assert.equal(await page.evaluate(() => Boolean(window.published)), false);
  } finally {
    await browser.close();
  }
});

test("Reddit preparation protects existing drafts and checks exact subreddit", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await fixture(
      browser,
      "https://www.reddit.com/r/example/submit?type=LINK",
      `<input type="hidden" name="subredditName" value="example"><div slot="editor" contenteditable="true" role="textbox">Existing user draft</div>`,
    );
    await assert.rejects(
      page.evaluate(() =>
        CreatorSocialPreparationAdapter.run({
          platform: "reddit",
          action: "prepare",
          subreddit: "example",
          title: "New title",
        }),
      ),
      /existing draft/i,
    );
    await assert.rejects(
      page.evaluate(() =>
        CreatorSocialPreparationAdapter.run({
          platform: "reddit",
          action: "inspect",
          subreddit: "other",
        }),
      ),
      /subreddit|composer/i,
    );
    assert.equal(
      await page.locator('[slot="editor"]').textContent(),
      "Existing user draft",
    );
  } finally {
    await browser.close();
  }
});
