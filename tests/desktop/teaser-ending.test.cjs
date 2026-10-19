"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { chromium } = require("../support/browser.cjs");
const { repositoryRoot } = require("../support/paths.cjs");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function makeVideo(file, size, duration = 2.4) {
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=white:s=${size}:r=30:d=${duration}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=44100:duration=${duration}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
}

function decodedFrame(file, at) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(at),
    "-i",
    file,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  return result.stdout;
}

function whiteCentroidX(frame, width) {
  let count = 0;
  let totalX = 0;
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      if (frame[offset] > 100) {
        count++;
        totalX += x;
      }
    }
  }
  assert.ok(count > 0, "decoded frame contains visible white source pixels");
  return totalX / count / width;
}

async function withPage(callback) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<canvas id="render"></canvas><input id="source" type="file">',
    );
    await page.addScriptTag({
      path: path.join(repositoryRoot, "shared/workspace/teaser-ending.js"),
    });
    await callback(page);
  } finally {
    await browser.close();
  }
}

async function makeScratch() {
  const root = path.join(repositoryRoot, ".local");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, "teaser-ending-test-"));
}

async function attach(page, videoPath) {
  await page.locator("#source").setInputFiles(videoPath);
}

test("suction ending export is square, keeps audio, collapses toward aim, and preserves source", async () => {
  const work = await makeScratch();
  const sourcePath = path.join(work, "neutral-square.mp4");
  const outputPath = path.join(work, "neutral-square (suction).mp4");
  makeVideo(sourcePath, "320x320");
  const original = fs.readFileSync(sourcePath);
  const originalHash = crypto
    .createHash("sha256")
    .update(original)
    .digest("hex");
  try {
    await withPage(async (page) => {
      await attach(page, sourcePath);
      const support = await page.evaluate(() => ({
        mp4: ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"].some(
          (type) => MediaRecorder.isTypeSupported(type),
        ),
        capture: Boolean(HTMLCanvasElement.prototype.captureStream),
        audio: Boolean(globalThis.AudioContext),
      }));
      assert.ok(support.mp4, "Chromium must support MP4 MediaRecorder export");
      assert.ok(support.capture, "Chromium must support canvas captureStream");
      assert.ok(support.audio, "Chromium must support audio export");
      const downloadPromise = page.waitForEvent("download");
      const result = await page.evaluate(async () => {
        const canvas = document.querySelector("#render");
        const file = document.querySelector("#source").files[0];
        const output = await OFEnhancerTeaserEnding.process(file, {
          canvas,
          aim: 0.68,
          exportVideo: true,
        });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(output);
        link.download = output.name;
        link.click();
        return {
          name: output.name,
          type: output.type,
          source: output.source,
        };
      });
      assert.equal(result.name, "neutral-square (suction).mp4");
      assert.equal(result.type, "video/mp4");
      assert.equal(result.source, "generated");
      await (await downloadPromise).saveAs(outputPath);
    });

    const streams = run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height",
      "-of",
      "json",
      outputPath,
    ]);
    const probe = JSON.parse(streams);
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    assert.ok(video, "export decodes as a video stream");
    assert.equal(video.width, video.height, "encoded export is 1:1");
    assert.ok(
      probe.streams.some((stream) => stream.codec_type === "audio"),
      "tone survives export",
    );
    const duration = Number(
      run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        outputPath,
      ]).trim(),
    );
    assert.ok(
      duration > 2.25 && duration < 2.65,
      `unexpected export duration: ${duration}`,
    );

    const early = whiteCentroidX(decodedFrame(outputPath, 1.6), video.width);
    const late = whiteCentroidX(decodedFrame(outputPath, 2.15), video.width);
    assert.ok(
      late > early + 0.035,
      `funnel should move toward the 68% aim (${early} -> ${late})`,
    );
    const final = decodedFrame(outputPath, Math.max(0, duration - 0.08));
    assert.ok(
      final.every((value) => value < 80),
      "the encoded ending contains a fully collapsed dark frame",
    );
    assert.equal(
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(sourcePath))
        .digest("hex"),
      originalHash,
    );
    assert.deepEqual(
      fs.readFileSync(sourcePath),
      original,
      "source file bytes remain unchanged",
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("ending speed changes encoded warp timing without speeding up the video", async () => {
  const work = await makeScratch();
  const source = path.join(work, "square.mp4");
  const short = path.join(work, "short.mp4");
  makeVideo(source, "320x320");
  makeVideo(short, "320x320", 1.2);
  try {
    await withPage(async (page) => {
      await attach(page, source);
      for (const speed of [0.5, 3]) {
        const download = page.waitForEvent("download");
        await page.evaluate(async (speed) => {
          const output = await OFEnhancerTeaserEnding.process(
            document.querySelector("#source").files[0],
            {
              canvas: document.querySelector("#render"),
              exportVideo: true,
              speed,
            },
          );
          const link = document.createElement("a");
          link.href = URL.createObjectURL(output);
          link.download = output.name;
          link.click();
        }, speed);
        const target = path.join(work, `${speed}.mp4`);
        await (await download).saveAs(target);
        const frame = decodedFrame(target, 1.5);
        assert.ok(
          speed === 3 ? frame[0] > 230 : frame[0] < 30,
          "the faster ending starts later; slow warp is already underway at 1.5 s",
        );
        const duration = Number(
          run("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            target,
          ]).trim(),
        );
        assert.ok(
          Math.abs(duration - 2.4) < 0.3,
          "clip playback duration stays unchanged",
        );
      }
      await attach(page, short);
      const errors = await page.evaluate(async () => {
        const errors = [];
        for (const speed of [0.5, 0, 4]) {
          try {
            await OFEnhancerTeaserEnding.process(
              document.querySelector("#source").files[0],
              { canvas: document.querySelector("#render"), speed },
            );
            errors.push("");
          } catch (error) {
            errors.push(error.message);
          }
        }
        return errors;
      });
      assert.match(errors[0], /at least 1.8 seconds.*faster speed/);
      assert.match(errors[1], /0.5× to 3×/);
      assert.match(errors[2], /0.5× to 3×/);
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("suction ending rejects non-square clips, cancels export, and recovers for preview", async () => {
  const work = await makeScratch();
  const squarePath = path.join(work, "neutral-square.mp4");
  const landscapePath = path.join(work, "neutral-landscape.mp4");
  makeVideo(squarePath, "320x320");
  makeVideo(landscapePath, "320x180");
  const squareHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(squarePath))
    .digest("hex");
  const landscapeHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(landscapePath))
    .digest("hex");
  try {
    await withPage(async (page) => {
      await attach(page, landscapePath);
      const rejected = await page.evaluate(async () => {
        try {
          await OFEnhancerTeaserEnding.process(
            document.querySelector("#source").files[0],
            { canvas: document.querySelector("#render") },
          );
          return "";
        } catch (error) {
          return error.message;
        }
      });
      assert.match(rejected, /needs a square \(1:1\) video/);

      await attach(page, squarePath);
      const cancelled = await page.evaluate(async () => {
        const controller = new AbortController();
        let latestProgress = 0;
        const pending = OFEnhancerTeaserEnding.process(
          document.querySelector("#source").files[0],
          {
            canvas: document.querySelector("#render"),
            signal: controller.signal,
            exportVideo: true,
            progress: (value) => {
              latestProgress = value;
              if (value > 0.08) controller.abort();
            },
          },
        );
        try {
          await pending;
          return { error: "", progress: latestProgress };
        } catch (error) {
          return { error: error.name, progress: latestProgress };
        }
      });
      assert.equal(cancelled.error, "AbortError");
      assert.ok(
        cancelled.progress > 0.08,
        "cancellation follows active export progress",
      );

      const hiddenError = await page.evaluate(async () => {
        try {
          await OFEnhancerTeaserEnding.process(
            document.querySelector("#source").files[0],
            {
              canvas: document.querySelector("#render"),
              exportVideo: true,
              progress(value) {
                if (value > 0.08) {
                  Object.defineProperty(document, "hidden", {
                    configurable: true,
                    value: true,
                  });
                  document.dispatchEvent(new Event("visibilitychange"));
                }
              },
            },
          );
          return "";
        } catch (error) {
          return error.message;
        } finally {
          delete document.hidden;
        }
      });
      assert.match(hiddenError, /Keep OFEnhancer visible/);

      const recovered = await page.evaluate(async () => {
        let latestProgress = 0;
        const output = await OFEnhancerTeaserEnding.process(
          document.querySelector("#source").files[0],
          {
            canvas: document.querySelector("#render"),
            progress: (value) => {
              latestProgress = value;
            },
          },
        );
        return { output, progress: latestProgress };
      });
      assert.equal(
        recovered.output,
        null,
        "preview completes without exporting",
      );
      assert.ok(
        recovered.progress >= 0.99,
        "preview reaches the end after export cancellation",
      );
    });
    assert.equal(
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(squarePath))
        .digest("hex"),
      squareHash,
    );
    assert.equal(
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(landscapePath))
        .digest("hex"),
      landscapeHash,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
