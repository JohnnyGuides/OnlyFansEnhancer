"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");
const source = path.resolve(
  __dirname,
  "../../extensions/personal/workflows/upload-platform-adapters.js",
);

test("cancellation stops a waiting preparation before attachment", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: source });
    const result = await page.evaluate(async () => {
      const controller = new AbortController();
      let attached = false;
      setTimeout(() => controller.abort(), 50);
      try {
        await CreatorUploadPlatformAdapters.runOnlyFans({
          draft: {},
          signal: controller.signal,
          attachFile() {
            attached = true;
          },
        });
      } catch (error) {
        return { attached, name: error.name };
      }
    });
    assert.deepEqual(result, { attached: false, name: "AbortError" });
  } finally {
    await browser.close();
  }
});

for (const autoStart of [false, true]) {
  test(`ManyVids dynamic queued upload, autoStart=${autoStart}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<div class="uppy-Dashboard"><input class="uppy-Dashboard-input" type="file" hidden><input class="uppy-Dashboard-input" type="file" webkitdirectory></div>`,
      );
      await page.addScriptTag({ path: source });
      const result = await page.evaluate(async (autoStart) => {
        let uploads = 0;
        let edits = 0;
        const dashboard = document.querySelector(".uppy-Dashboard");
        const context = {
          draft: { fullFilename: "fixture.mp4" },
          async attachFile() {
            setTimeout(() => {
              const card = document.createElement("article");
              card.className = "uppy-Dashboard-Item";
              card.innerHTML =
                '<span class="uppy-Dashboard-Item-name">fixture.mp4</span><button>Edit</button>';
              card.querySelector("button").onclick = () => edits++;
              dashboard.append(card);
              const start = () => {
                card.dataset.state = "uploading";
                setTimeout(() => (card.dataset.state = "upload-complete"), 300);
              };
              if (autoStart) start();
              else {
                const button = document.createElement("button");
                button.className = "uppy-StatusBar-actionBtn--upload";
                button.textContent = "Upload 1 file";
                button.onclick = () => {
                  uploads++;
                  start();
                };
                dashboard.append(button);
              }
            }, 50);
          },
        };
        const outcome =
          await CreatorUploadPlatformAdapters.runManyVidsUpload(context);
        return { uploads, edits, outcome };
      }, autoStart);
      assert.equal(result.uploads, autoStart ? 0 : 1);
      assert.equal(result.edits, 1);
      assert.equal(result.outcome.status, "edit-requested");
    } finally {
      await browser.close();
    }
  });
}

test("invalid publishing mode rejects before any platform mutation", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: source });
    const results = await page.evaluate(async () => {
      let attachments = 0;
      const errors = [];
      for (const method of [
        "runFansly",
        "runOnlyFans",
        "runManyVidsUpload",
        "runManyVidsEdit",
      ]) {
        try {
          await CreatorUploadPlatformAdapters[method]({
            draft: { publishMode: "invalid" },
            attachFile() {
              attachments++;
            },
          });
        } catch (error) {
          errors.push(error.message);
        }
      }
      return { attachments, errors };
    });
    assert.equal(results.attachments, 0);
    assert.equal(results.errors.length, 4);
    for (const error of results.errors)
      assert.match(error, /Invalid publishing mode/);
  } finally {
    await browser.close();
  }
});

for (const progressKind of ["advancing", "unknown", "stalled", "resumed"]) {
  test(`ManyVids long observation: ${progressKind}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<div class="uppy-Dashboard"><input type="file" class="uppy-Dashboard-input" hidden></div>',
      );
      await page.addScriptTag({ path: source });
      const result = await page.evaluate(async (kind) => {
        const originalNow = Date.now;
        let now = originalNow();
        Date.now = () => now;
        let timer;
        let edits = 0;
        let attachments = 0;
        let resumed = false;
        const progress = [];
        try {
          await CreatorUploadPlatformAdapters.runManyVidsUpload({
            draft: { fullFilename: "large.mp4" },
            progress: (status) => progress.push(status),
            pauseObservation:
              kind === "resumed"
                ? async () => {
                    resumed = true;
                  }
                : undefined,
            attachFile: async () => {
              attachments++;
              const dashboard = document.querySelector(".uppy-Dashboard");
              dashboard.insertAdjacentHTML(
                "beforeend",
                '<div class="uppy-Dashboard-Item is-uploading">large...mp4</div>',
              );
              if (kind !== "unknown")
                dashboard.insertAdjacentHTML(
                  "beforeend",
                  '<div role="progressbar" aria-valuenow="0" aria-valuemax="100"></div>',
                );
              let tick = 0;
              timer = setInterval(() => {
                now += 9 * 60_000;
                tick++;
                if (kind === "advancing" || resumed)
                  dashboard
                    .querySelector('[role="progressbar"]')
                    .setAttribute("aria-valuenow", String(tick * 10));
                if (tick === 8) {
                  const edit = document.createElement("button");
                  edit.setAttribute(
                    "aria-label",
                    "Button edit video : large.mp4",
                  );
                  edit.onclick = () => edits++;
                  document.body.append(edit);
                  clearInterval(timer);
                }
              }, 125);
            },
          });
          return { edits, progress, attachments };
        } catch (error) {
          return { edits, progress, error: error.message };
        } finally {
          clearInterval(timer);
          Date.now = originalNow;
        }
      }, progressKind);
      if (progressKind === "stalled") {
        assert.match(result.error, /upload-stalled/);
        assert.equal(result.edits, 0);
      } else {
        assert.equal(result.error, undefined);
        assert.equal(result.edits, 1);
        assert.equal(result.attachments, 1);
        if (progressKind === "resumed")
          assert.ok(result.progress.includes("upload-attention-required"));
        assert.ok(
          result.progress.includes(
            progressKind === "unknown"
              ? "upload-progress-unknown"
              : "upload-observing",
          ),
        );
      }
    } finally {
      await browser.close();
    }
  });
}
