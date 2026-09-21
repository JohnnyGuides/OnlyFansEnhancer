"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

// Structural fixture from the September 21 live uploader inspection; no account data.
for (const variant of ["unchanged", "change", "ambiguous", "unacknowledged"]) {
  test(`current Pornhub orientation and metadata preparation: ${variant}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<div class="c-dropdown">
        <div class="c-drop-label"><p>Video orientation?</p></div>
        <div data-error="orientation" class="c-drop-wrapper dropdownElement">
          <div class="c-drop-wrapper__selected selectedValue"><span>Straight</span></div>
          <div class="c-drop-wrapper__list" hidden><div class="menuScroll">
            <div class="c-drop-wrapper__option" data-value="Straight">Straight</div>
            <div class="c-drop-wrapper__option" data-value="Gay">Gay</div>
          </div></div>
        </div></div>
        <input name="title"><input name="tags"><input name="category">
        <button id="submit">Submit for Review</button>`);
      for (const script of [
        "registry.js",
        "common.js",
        "ph-uploader.js",
        "upload-platform-adapters.js",
      ])
        await page.addScriptTag({
          path: path.resolve(
            __dirname,
            "../../extensions/personal/workflows",
            script,
          ),
        });
      const result = await page.evaluate(async (variant) => {
        let submits = 0;
        let handoffs = 0;
        const trigger = document.querySelector(".selectedValue");
        const list = document.querySelector(".c-drop-wrapper__list");
        if (variant === "ambiguous")
          list
            .querySelector(".menuScroll")
            .append(list.querySelector('[data-value="Gay"]').cloneNode(true));
        trigger.onclick = () => {
          list.hidden = false;
        };
        list.querySelectorAll(".c-drop-wrapper__option").forEach((option) => {
          option.onclick = () => {
            if (variant !== "unacknowledged")
              trigger.textContent = option.textContent;
            list.hidden = true;
          };
        });
        document.querySelector("#submit").onclick = () => submits++;
        const outcome = await CreatorUploadPlatformAdapters.runPornhub({
          signal: AbortSignal.timeout(5000),
          draft: {
            publishMode: "manual",
            title: "Neutral verification",
            contentPreset: "Neutral",
            profiles: {
              phUploader: {
                presets: {
                  Neutral: {
                    orientation: variant === "unchanged" ? "Straight" : "Gay",
                    tags: [],
                    categories: [],
                  },
                },
              },
            },
          },
          attachFile: async () => {
            handoffs++;
          },
        }).catch((error) => ({ status: "failed", error: error.message }));
        return {
          outcome,
          submits,
          handoffs,
          title: document.querySelector('[name="title"]').value,
          selected: trigger.textContent,
        };
      }, variant);
      assert.equal(result.submits, 0);
      assert.equal(result.handoffs, 1);
      assert.equal(result.title, "Neutral verification");
      if (["unchanged", "change"].includes(variant)) {
        assert.equal(
          result.outcome.status,
          "manual-submit-required",
          result.outcome.error,
        );
        assert.equal(
          result.selected,
          variant === "unchanged" ? "Straight" : "Gay",
        );
      } else {
        assert.equal(result.outcome.status, "failed");
        assert.match(result.outcome.error, /metadata-preset.*Orientation/);
      }
    } finally {
      await browser.close();
    }
  });
}
