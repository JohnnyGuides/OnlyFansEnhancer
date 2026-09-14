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
            dashboard.querySelector("input:not([webkitdirectory])").remove();
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

test("ManyVids clicks an enabled queued upload even during a transient uploading class", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div class="uppy-Dashboard"><input class="uppy-Dashboard-input" type="file" hidden></div>',
    );
    await page.addScriptTag({ path: source });
    const result = await page.evaluate(async () => {
      if (!crypto.randomUUID) {
        Object.defineProperty(crypto, "randomUUID", {
          value: () => "11111111-1111-4111-8111-111111111111",
        });
      }
      let uploads = 0;
      let edits = 0;
      const dashboard = document.querySelector(".uppy-Dashboard");
      const outcome = await CreatorUploadPlatformAdapters.runManyVidsUpload({
        draft: { fullFilename: "neutral-full.mp4" },
        async attachFile() {
          dashboard.insertAdjacentHTML(
            "beforeend",
            '<article class="uppy-Dashboard-Item"><span class="uppy-Dashboard-Item-name">neutral-...mp4</span><button>Edit</button></article><div class="uppy-StatusBar is-uploading"><button class="uppy-StatusBar-actionBtn--upload">Upload 1 file</button></div>',
          );
          const card = dashboard.querySelector(".uppy-Dashboard-Item");
          card.querySelector("button").onclick = () => edits++;
          setTimeout(() => {
            card.dataset.state = "upload-complete";
            card.querySelector(".uppy-Dashboard-Item-name").textContent =
              "neutral-full.mp4";
          }, 250);
          dashboard.querySelector(".uppy-StatusBar-actionBtn--upload").onclick =
            () => {
              uploads++;
              dashboard.querySelector(".uppy-StatusBar").className =
                "uppy-StatusBar is-waiting";
            };
          return { role: "full", name: "neutral-full.mp4", size: 100 };
        },
        async checkpointStep() {},
      });
      return { uploads, edits, outcome };
    });
    assert.equal(result.uploads, 1);
    assert.equal(result.edits, 1);
    assert.equal(result.outcome.status, "edit-requested");
  } finally {
    await browser.close();
  }
});

test("ManyVids waits for delayed acceptance without repeating its upload click", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div class="uppy-Dashboard"><input class="uppy-Dashboard-input" type="file" hidden></div>',
    );
    await page.addScriptTag({ path: source });
    const result = await page.evaluate(async () => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), 1500);
      let uploads = 0;
      let edits = 0;
      const dashboard = document.querySelector(".uppy-Dashboard");
      try {
        const outcome = await CreatorUploadPlatformAdapters.runManyVidsUpload({
          draft: { fullFilename: "neutral-full.mp4" },
          signal: controller.signal,
          async attachFile() {
            dashboard.insertAdjacentHTML(
              "beforeend",
              '<article class="uppy-Dashboard-Item"><span class="uppy-Dashboard-Item-name">neutral-...mp4</span><button>Edit</button></article><div class="uppy-StatusBar is-waiting"><button class="uppy-StatusBar-actionBtn--upload">Upload 1 file</button></div>',
            );
            const card = dashboard.querySelector(".uppy-Dashboard-Item");
            card.querySelector("button").onclick = () => edits++;
            dashboard.querySelector(
              ".uppy-StatusBar-actionBtn--upload",
            ).onclick = () => {
              uploads++;
              setTimeout(() => {
                card.dataset.state = "upload-complete";
                card.querySelector(".uppy-Dashboard-Item-name").textContent =
                  "neutral-full.mp4";
              }, 900);
            };
            return { role: "full", name: "neutral-full.mp4", size: 100 };
          },
          async checkpointStep() {},
        });
        return { uploads, edits, outcome };
      } finally {
        clearTimeout(abort);
      }
    });
    assert.equal(result.uploads, 1);
    assert.equal(result.edits, 1);
    assert.equal(result.outcome.status, "edit-requested");
  } finally {
    await browser.close();
  }
});

test("Pornhub uploads the approved file before applying its metadata preset", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>input,custom-dropdown,.customSelectTrigger { display:block; width:200px; min-height:24px }</style>
      <input class="dz-hidden-input" type="file" accept=".mp4" hidden>
    `);
    for (const script of [
      "registry.js",
      "common.js",
      "ph-uploader.js",
      "upload-platform-adapters.js",
    ]) {
      await page.addScriptTag({
        path: path.resolve(
          __dirname,
          `../../extensions/personal/workflows/${script}`,
        ),
      });
    }
    const result = await page.evaluate(async () => {
      const attached = [];
      const outcome = await CreatorUploadPlatformAdapters.runPornhub({
        draft: {
          title: "Neutral approved title",
          contentPreset: "Straight",
          pornhubFilename: "neutral-limited.mp4",
          profiles: {
            phUploader: {
              presets: {
                Straight: {
                  orientation: "Straight",
                  tags: [],
                  categories: [],
                },
              },
            },
          },
        },
        async attachFile(role, selector) {
          attached.push({ role, selector });
          document.body.insertAdjacentHTML(
            "beforeend",
            '<input name="title"><custom-dropdown data-key="orientation"><div class="customSelectTrigger">Straight</div></custom-dropdown><div><input name="tags"><ul id="inputTag"></ul></div><div><input name="category"><ul id="f2vCategory"></ul></div>',
          );
        },
        async progress() {},
      });
      return { attached, outcome };
    });
    assert.deepEqual(result.attached, [
      { role: "pornhub", selector: "input.dz-hidden-input[type='file']" },
    ]);
    assert.deepEqual(result.outcome, {
      platform: "pornhub",
      status: "manual-submit-required",
      effectiveFilename: "neutral-limited.mp4",
      preset: "Straight",
    });
  } finally {
    await browser.close();
  }
});

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
              return { role: "full", name: "large.mp4", size: 100 };
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
