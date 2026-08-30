"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const parserPath = path.resolve(__dirname, "..", "realbooru-parser.js");

test("bundled Realbooru parser accepts only fixed listing and image contracts", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      globalThis.chrome = {
        runtime: {
          id: "test-extension",
          onMessage: { addListener() {} },
        },
      };
    });
    await page.goto("data:text/html,<main></main>");
    await page.addScriptTag({ path: parserPath });

    const result = await page.evaluate(() => {
      const listing = RealbooruParser.parseListing(`
        <div class="col thumb">
          <a href="https://realbooru.com/index.php?page=post&s=view&id=123">
            <img
              src="https://realbooru.com/thumbnails/aa/bb/thumbnail_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg"
              title="1girl, selfie, solo"
            >
          </a>
        </div>
        <div class="col thumb">
          <a href="https://evil.example/index.php?page=post&s=view&id=999">
            <img src="https://evil.example/thumbnail.jpg" title="selfie">
          </a>
        </div>
        <div id="paginator">
          <a href="?page=post&s=list&tags=selfie&pid=42">2</a>
          <a href="?page=post&s=list&tags=selfie&pid=420">last</a>
        </div>
      `);
      const detail = RealbooruParser.parseDetail(
        `<img id="image" src="https://realbooru.com//images/aa/bb/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpeg">`,
        "123",
      );
      let foreignRejected = false;
      try {
        RealbooruParser.parseDetail(
          `<img id="image" src="https://evil.example/images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg">`,
          "123",
        );
      } catch {
        foreignRejected = true;
      }
      return { listing, detail, foreignRejected };
    });

    assert.equal(result.listing.posts.length, 1);
    assert.equal(result.listing.posts[0].id, "123");
    assert.deepEqual(result.listing.posts[0].tags, ["1girl", "selfie", "solo"]);
    assert.equal(result.listing.maxPid, 420);
    assert.equal(
      result.detail.url,
      "https://realbooru.com//images/aa/bb/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpeg",
    );
    assert.equal(result.detail.fingerprint, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(result.foreignRejected, true);
  } finally {
    await browser.close();
  }
});
