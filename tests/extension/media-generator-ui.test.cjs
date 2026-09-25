"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { chromium } = require("../support/browser.cjs");
const { createUploadFixture } = require("../support/upload-action-fixture.cjs");

test("a selected video yields a 640 by 360 frame and an MP4 teaser", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ofenhancer-media-test-"));
  const videoPath = path.join(work, "neutral-full.mp4");
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x480:rate=30:duration=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  const browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await browser.newPage();
    await page.route("https://media.test/**", (route) =>
      route.fulfill({
        body: '<input id="source" type="file">',
        contentType: "text/html",
      }),
    );
    await page.goto("https://media.test/");
    await page.addScriptTag({
      path: path.join(
        require("../support/paths.cjs").personalRoot,
        "workflows",
        "media-generator.js",
      ),
    });
    await page.locator("#source").setInputFiles(videoPath);
    const result = await page.evaluate(async () => {
      const source = document.querySelector("#source").files[0];
      const thumbnail = await CreatorMediaGenerator.thumbnailFromVideo(
        source,
        2,
      );
      const bitmap = await createImageBitmap(thumbnail);
      const thumbnailResult = {
        name: thumbnail.name,
        type: thumbnail.type,
        size: thumbnail.size,
        width: bitmap.width,
        height: bitmap.height,
      };
      bitmap.close();
      const teaser = await CreatorMediaGenerator.teaserFromVideo(source);
      window.generatedTeaser = teaser;
      await CreatorMediaGenerator.saveGeneratedMedia(
        "a".repeat(48),
        "teaser",
        source,
        teaser,
      );
      await CreatorMediaGenerator.saveGeneratedMedia(
        "a".repeat(48),
        "thumbnail",
        source,
        thumbnail,
      );
      const preview = document.createElement("video");
      const previewUrl = URL.createObjectURL(teaser);
      const duration = await new Promise((resolve, reject) => {
        preview.onloadedmetadata = () => resolve(preview.duration);
        preview.onerror = () =>
          reject(new Error("Generated MP4 cannot be decoded."));
        preview.src = previewUrl;
      });
      URL.revokeObjectURL(previewUrl);
      return {
        thumbnail: thumbnailResult,
        teaser: {
          name: teaser.name,
          type: teaser.type,
          size: teaser.size,
          duration,
        },
      };
    });
    assert.equal(result.thumbnail.type, "image/png");
    assert.equal(result.thumbnail.width, 640);
    assert.equal(result.thumbnail.height, 360);
    assert.ok(result.thumbnail.size > 0 && result.thumbnail.size < 2_000_000);
    assert.equal(result.teaser.type, "video/mp4");
    assert.ok(result.teaser.size > 0 && result.teaser.size < 50 * 1024 * 1024);
    assert.ok(result.teaser.duration > 2 && result.teaser.duration < 5);
    const downloadPromise = page.waitForEvent("download");
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(window.generatedTeaser);
      link.download = "generated-preview.mp4";
      link.click();
    });
    const download = await downloadPromise;
    const generatedPath = path.join(work, "generated-preview.mp4");
    await download.saveAs(generatedPath);
    const streams = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        generatedPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(streams.status, 0, streams.stderr);
    assert.match(streams.stdout, /video/);
    assert.match(streams.stdout, /audio/);
    await page.reload();
    await page.addScriptTag({
      path: path.join(
        require("../support/paths.cjs").personalRoot,
        "workflows",
        "media-generator.js",
      ),
    });
    await page.locator("#source").setInputFiles(videoPath);
    const recovered = await page.evaluate(async () => {
      const source = document.querySelector("#source").files[0];
      const teaser = await CreatorMediaGenerator.loadGeneratedMedia(
        "a".repeat(48),
        "teaser",
        source,
      );
      const thumbnail = await CreatorMediaGenerator.loadGeneratedMedia(
        "a".repeat(48),
        "thumbnail",
        source,
      );
      await CreatorMediaGenerator.clearGeneratedMedia();
      return { teaser: teaser?.name, thumbnail: thumbnail?.name };
    });
    assert.equal(recovered.teaser, result.teaser.name);
    assert.equal(recovered.thumbnail, result.thumbnail.name);
  } finally {
    await browser.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("Upload Hub frame picker uses a chosen video frame", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ofenhancer-frame-test-"));
  const videoPath = path.join(work, "neutral-full.mp4");
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x480:rate=30:duration=4",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  const fixture = await createUploadFixture();
  try {
    const page = fixture.page;
    await page.locator("#uploadFullVideo").setInputFiles(videoPath);
    await page.locator("#chooseThumbnailFrame").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#thumbnailFrameStatus")
        .textContent.includes("Choose the frame"),
    );
    await page.locator("#thumbnailFrameTime").evaluate((slider) => {
      slider.value = "500";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#useThumbnailFrame").click();
    await page.waitForFunction(
      () => !document.querySelector("#thumbnailFrameDialog").open,
    );
    assert.match(
      await page.locator("#manyvidsThumbnailSummary").textContent(),
      /frame 640x360/,
    );
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("desktop Upload Hub stages browser-generated media before native file delivery", async () => {
  const fixture = await createUploadFixture({ desktop: true });
  try {
    await fixture.page.evaluate(async () => {
      const file = new File(
        [new Uint8Array(300_000).fill(7)],
        "neutral (teaser).mp4",
        {
          type: "video/mp4",
        },
      );
      file.source = "generated";
      await OFEnhancerDesktopUpload.deliverFile(
        { port: { postMessage() {} } },
        {
          requestId: "request-1",
          sessionId: "a".repeat(48),
          platform: "fansly",
          role: "teaser",
          token: "token-1",
        },
        file,
      );
    });
    const chunks = fixture.generatedChunks;
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].offset, 0);
    assert.equal(chunks[0].final, false);
    assert.equal(chunks[1].offset, 256 * 1024);
    assert.equal(chunks[1].final, true);
    assert.equal(chunks[2].delivered.name, "neutral (teaser).mp4");
    assert.equal(chunks[2].delivered.size, 300_000);
  } finally {
    await fixture.close();
  }
});
