"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

test("Upload Console center-crops a selected thumbnail to a 640x360 PNG before handoff", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const root = path.resolve(__dirname, "../../extensions/personal");
    await page.setContent(
      fs
        .readFileSync(path.join(root, "upload-console.html"), "utf8")
        .replace(/<script[^>]+><\/script>/gi, ""),
    );
    await page.addScriptTag({ path: path.join(root, "upload-console.js") });
    const result = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 100;
      const drawing = canvas.getContext("2d");
      drawing.fillStyle = "green";
      drawing.fillRect(0, 0, 100, 100);
      drawing.fillStyle = "red";
      drawing.fillRect(0, 0, 100, 20);
      drawing.fillStyle = "blue";
      drawing.fillRect(0, 80, 100, 20);
      const sourceBlob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      const source = new File([sourceBlob], "chosen.png", {
        type: "image/png",
      });
      const converted =
        await CreatorUploadConsole.normalizeThumbnailFile(source);
      const bitmap = await createImageBitmap(converted);
      const sample = document.createElement("canvas");
      sample.width = bitmap.width;
      sample.height = bitmap.height;
      const context = sample.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const color = (y) => [...context.getImageData(320, y, 1, 1).data];
      const invalid = await CreatorUploadConsole.normalizeThumbnailFile(
        new File(["not an image"], "invalid.png", { type: "image/png" }),
      ).then(
        () => "accepted",
        (error) => error.message,
      );
      bitmap.close();
      return {
        name: converted.name,
        type: converted.type,
        width: sample.width,
        height: sample.height,
        bytes: converted.size,
        colors: [color(0), color(180), color(359)],
        sourceName: source.name,
        invalid,
      };
    });
    assert.equal(result.name, "chosen (640x360).png");
    assert.equal(result.type, "image/png");
    assert.equal(result.width, 640);
    assert.equal(result.height, 360);
    assert.ok(result.bytes > 0 && result.bytes < 2_000_000);
    assert.deepEqual(result.colors, [
      [0, 128, 0, 255],
      [0, 128, 0, 255],
      [0, 128, 0, 255],
    ]);
    assert.equal(result.sourceName, "chosen.png");
    assert.match(result.invalid, /readable PNG or JPEG/);
  } finally {
    await browser.close();
  }
});
