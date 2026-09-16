"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
const adapter = path.resolve(
  __dirname,
  "../../extensions/personal/workflows/upload-platform-adapters.js",
);
// Reconstructed ownership contract, not live upload acceptance.
for (const variant of [
  "owned",
  "replaced-card",
  "duplicate-card",
  "duplicate-edit",
  "foreign-route",
  "changed-destination",
]) {
  test(`ManyVids completed upload to exact editor ownership: ${variant}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<div class="uppy-Dashboard"><input class="uppy-Dashboard-input" type="file" hidden><button type="button" class="uppy-StatusBar-actionBtn--upload" hidden>Upload 1 file</button></div><a id="foreign-edit" href="https://www.manyvids.com/Edit-vid/999">Edit</a>',
      );
      await page.addScriptTag({ path: adapter });
      const result = await page.evaluate(async (variant) => {
        const events = [];
        const checkpoints = [];
        const dashboard = document.querySelector(".uppy-Dashboard");
        const upload = dashboard.querySelector("button");
        let current;
        document.querySelector("#foreign-edit").onclick = (event) => {
          event.preventDefault();
          events.push("foreign-edit");
        };
        upload.onclick = () => {
          events.push("upload");
          current.dataset.state = "uploading";
          setTimeout(() => {
            if (variant === "replaced-card") {
              const replacement = current.cloneNode(true);
              replacement.dataset.uploadId = "foreign-upload";
              current.replaceWith(replacement);
              current = replacement;
            }
            current.dataset.state = "upload-complete";
            current.insertAdjacentHTML(
              "beforeend",
              '<a href="https://www.manyvids.com/Edit-vid/123456">Edit</a>',
            );
            const edit = current.querySelector("a");
            if (variant === "foreign-route")
              edit.href = "https://www.manyvids.com/Edit-vid/123456?foreign=1";
            edit.onclick = (event) => {
              event.preventDefault();
              events.push("edit:" + edit.href);
            };
            if (variant === "duplicate-edit")
              current.append(edit.cloneNode(true));
          }, 120);
        };
        const result = await CreatorUploadPlatformAdapters.runManyVidsUpload({
          signal: AbortSignal.timeout(5000),
          draft: {
            fullFilename: "neutral-verification.mp4",
            publishMode: "manual",
          },
          attachFile: async (role, selector) => {
            events.push("file:" + role);
            const input = document.querySelector(selector);
            const transfer = new DataTransfer();
            transfer.items.add(
              new File(["fixture bytes"], "neutral-verification.mp4", {
                type: "video/mp4",
              }),
            );
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            dashboard.insertAdjacentHTML(
              "beforeend",
              '<article class="uppy-Dashboard-Item" data-upload-id="owned-upload"><span class="uppy-Dashboard-Item-name">neutral-verification.mp4</span></article>',
            );
            current = dashboard.querySelector("article");
            upload.hidden = false;
            if (variant === "duplicate-card")
              dashboard.append(current.cloneNode(true));
            return {
              role: "full",
              name: "neutral-verification.mp4",
              size: input.files[0].size,
            };
          },
          checkpointStep: async (step, id, phase, details) => {
            checkpoints.push({ step, id, phase, details });
            if (
              variant === "changed-destination" &&
              step === "open-editor" &&
              phase === "intent"
            )
              current.querySelector("a").href =
                "https://www.manyvids.com/Edit-vid/999";
          },
        }).catch((error) => ({ status: "failed", error: error.message }));
        return { result, events, checkpoints };
      }, variant);
      assert.equal(
        result.events.filter((event) => event === "file:full").length,
        1,
      );
      assert.equal(result.events.includes("foreign-edit"), false);
      assert.equal(
        result.events.filter((event) => event === "upload").length,
        variant === "duplicate-card" ? 0 : 1,
      );
      if (variant === "owned") {
        assert.equal(result.result.status, "edit-requested");
        assert.deepEqual(result.events, [
          "file:full",
          "upload",
          "edit:https://www.manyvids.com/Edit-vid/123456",
        ]);
        assert.deepEqual(
          result.checkpoints.map(({ step, phase }) => [step, phase]),
          [
            ["start-upload", "intent"],
            ["start-upload", "observed"],
            ["open-editor", "intent"],
          ],
        );
        assert.deepEqual(result.checkpoints.at(-1).details, {
          destinationUrl: "https://www.manyvids.com/Edit-vid/123456",
          videoId: "123456",
        });
      } else {
        assert.equal(result.result.status, "failed");
        assert.match(result.result.error, /ambiguous|identity|changed/);
        assert.equal(
          result.events.some((event) => event.startsWith("edit:")),
          false,
        );
      }
    } finally {
      await browser.close();
    }
  });
}
