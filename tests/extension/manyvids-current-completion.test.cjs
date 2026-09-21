"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

for (const variant of [
  "owned",
  "wrong-size",
  "duplicate",
  "pre-existing",
  "replaced",
]) {
  test(`ManyVids current completed card outside Uppy: ${variant}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<div class="uppy-Dashboard"><input class="uppy-Dashboard-input" type="file" hidden></div>',
      );
      await page.evaluate((variant) => {
        window.completedHTML =
          '<div class="Uploaded-videos-module-scss-module__fixture__cardVideo"><span class="fixture__fileName">neutral.mp4</span><p class="fixture__videoSize">Filesize 1.00 MB</p><button aria-label="Button delete video : neutral.mp4">Delete</button><button aria-label="Button edit video : neutral.mp4"><svg data-name="edit-icon"></svg>Edit</button></div>';
        if (variant === "pre-existing")
          document.body.insertAdjacentHTML("beforeend", completedHTML);
      }, variant);
      await page.addScriptTag({
        path: path.resolve(
          __dirname,
          "../../extensions/personal/workflows/upload-platform-adapters.js",
        ),
      });
      const result = await page.evaluate(async (variant) => {
        let edits = 0,
          deletes = 0,
          proofs = 0;
        let completion;
        document.addEventListener("click", (event) => {
          if (event.target.closest('[aria-label^="Button edit"]')) edits++;
          if (event.target.closest('[aria-label^="Button delete"]')) deletes++;
        });
        const outcome = await CreatorUploadPlatformAdapters.runManyVidsUpload({
          signal: AbortSignal.timeout(2000),
          draft: { fullFilename: "neutral.mp4", publishMode: "manual" },
          attachFile: async () => {
            const dashboard = document.querySelector(".uppy-Dashboard");
            dashboard.insertAdjacentHTML(
              "beforeend",
              '<article class="uppy-Dashboard-Item" id="owned" data-state="uploading"><span class="uppy-Dashboard-Item-name">neutral.mp4</span></article>',
            );
            setTimeout(() => {
              dashboard.querySelector("article").remove();
              document.body.insertAdjacentHTML("beforeend", completedHTML);
              completion = document.body.lastElementChild;
              if (variant === "wrong-size")
                completion.querySelector("p").textContent = "Filesize 2.00 MB";
              if (variant === "duplicate")
                document.body.append(completion.cloneNode(true));
            }, 150);
            return { role: "full", name: "neutral.mp4", size: 1048576 };
          },
          checkpointStep: async (action, commandId, phase, evidence) => {
            if (action !== "open-editor") return;
            if (evidence.completedCard !== true)
              throw new Error("Missing button-only handoff");
            if (CreatorManyVidsCompletedActions.get(commandId).verify())
              proofs++;
            if (variant === "replaced")
              completion.replaceWith(completion.cloneNode(true));
          },
        }).catch((error) => ({ status: "failed", error: error.message }));
        return {
          outcome,
          edits,
          deletes,
          proofs,
          pending: globalThis.CreatorManyVidsCompletedActions?.size || 0,
        };
      }, variant);
      assert.equal(result.deletes, 0);
      assert.equal(result.pending, 0);
      assert.equal(result.edits, variant === "owned" ? 1 : 0);
      assert.equal(
        result.outcome.status,
        variant === "owned" ? "edit-requested" : "failed",
        result.outcome.error,
      );
      if (variant === "owned") assert.equal(result.proofs, 1);
    } finally {
      await browser.close();
    }
  });
}
