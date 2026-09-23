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

test("Pornhub preset reads and appends chips beside the live input widgets", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>v-input,input,li,.c-pill,.selectedValue { display:block; min-height:24px; width:200px }</style>
      <div hidden><div data-error="orientation" class="dropdownElement"><div class="selectedValue">Other</div></div><input name="tags"><ul id="inputTag"></ul><input name="category"></div>
      <div data-error="orientation" class="dropdownElement"><div class="selectedValue">Straight</div></div>
      <div class="form-section column">
        <div class="c-pills-container"><v-pill text="Gaming"><div class="c-pill"><span>Gaming</span></div></v-pill></div>
        <v-input><div class="c-input-wrapper"><input name="tags"></div></v-input>
        <v-autocomplete><ul id="inputTag"></ul></v-autocomplete>
      </div>
      <div class="form-section column full">
        <div class="c-pills-container"><v-pill text="fetish"><div class="c-pill"><span>fetish</span></div></v-pill></div>
        <v-input><div class="c-input-wrapper"><input name="category"></div></v-input>
        <div><ul id="f2vCategory"></ul></div>
      </div>`);
    for (const script of ["registry.js", "common.js", "ph-uploader.js"])
      await page.addScriptTag({
        path: path.resolve(
          __dirname,
          "../../extensions/personal/workflows",
          script,
        ),
      });
    const result = await page.evaluate(async () => {
      for (const [name, listId] of [
        ["tags", "inputTag"],
        ["category", "f2vCategory"],
      ]) {
        const field = CreatorToolkit.queryUnique(`input[name="${name}"]`);
        const list = field.closest(".form-section").querySelector(`#${listId}`);
        field.addEventListener("input", () => {
          list.replaceChildren();
          if (!field.value) return;
          const item = document.createElement("li");
          item.textContent = field.value;
          list.append(item);
        });
        list.addEventListener("click", (event) => {
          const pill = document.createElement("div");
          pill.className = "c-pill";
          pill.textContent = event.target.textContent;
          field
            .closest(".form-section")
            .querySelector(".c-pills-container")
            .append(pill);
        });
      }
      const adapter = CreatorToolkitAdapters.phUploader;
      const plan = adapter.inspectPreset("Straight", {
        orientation: "Straight",
        tags: ["Gaming", "Robot"],
        categories: ["fetish", "reaction"],
      });
      const applied = await adapter.applyPreset(
        plan,
        new AbortController().signal,
        { step() {} },
      );
      const freeCategories = [
        ...adapter.selectedTokenLabels(
          CreatorToolkit.queryUnique('input[name="category"]'),
          "f2vCategory",
        ),
      ];
      CreatorToolkit.queryUnique('input[name="category"]')
        .closest(".form-section")
        .remove();
      CreatorToolkit.queryUnique('input[name="tags"]')
        .closest(".form-section")
        .querySelector("#inputTag").id = "inputFancentroTag";
      const paidPlan = adapter.inspectPreset(
        "Straight",
        {
          orientation: "Straight",
          tags: [
            "Gaming",
            "Robot",
            "One",
            "Two",
            "Three",
            "Four",
            "Five",
            "Six",
          ],
          categories: ["a category unavailable in Pay To View"],
        },
        { mode: "paid" },
      );
      const paidApplied = await adapter.applyPreset(
        paidPlan,
        new AbortController().signal,
        { step() {} },
      );
      return {
        missingTags: plan.tagsToAdd,
        missingCategories: plan.categoriesToAdd,
        applied: applied.status,
        items: applied.items,
        paidStatus: paidApplied.status,
        paidItems: paidApplied.items,
        paidTagsToAdd: paidPlan.tagsToAdd,
        paidCategoriesToAdd: paidPlan.categoriesToAdd,
        tags: [
          ...adapter.selectedTokenLabels(
            CreatorToolkit.queryUnique('input[name="tags"]'),
            "inputFancentroTag",
          ),
        ],
        categories: freeCategories,
      };
    });
    assert.deepEqual(result.missingTags, ["Robot"]);
    assert.deepEqual(result.missingCategories, ["reaction"]);
    assert.equal(result.applied, "success", JSON.stringify(result.items));
    assert.equal(
      result.paidStatus,
      "success",
      JSON.stringify(result.paidItems),
    );
    assert.deepEqual(result.paidTagsToAdd, [
      "One",
      "Two",
      "Three",
      "Four",
      "Five",
    ]);
    assert.deepEqual(result.paidCategoriesToAdd, []);
    assert.deepEqual(result.tags.sort(), [
      "five",
      "four",
      "gaming",
      "one",
      "robot",
      "three",
      "two",
    ]);
    assert.deepEqual(result.categories.sort(), ["fetish", "reaction"]);
  } finally {
    await browser.close();
  }
});

test("Pornhub omits an unavailable tag only after fresh nonmatching suggestions", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>v-input,input,li,.c-pill,.selectedValue { display:block; min-height:24px; width:200px }</style>
      <div data-error="orientation" class="dropdownElement"><div class="selectedValue">Straight</div></div>
      <div class="form-section column">
        <div class="c-pills-container"><div class="c-pill">Gaming</div><div class="c-pill">Robot</div></div>
        <v-input><div class="c-input-wrapper"><input name="tags"></div></v-input>
        <v-autocomplete><ul id="inputTag"></ul></v-autocomplete>
      </div>
      <div class="form-section column full">
        <div class="c-pills-container"></div>
        <v-input><div class="c-input-wrapper"><input name="category"></div></v-input>
        <div><ul id="f2vCategory"></ul></div>
      </div>`);
    for (const script of ["registry.js", "common.js", "ph-uploader.js"])
      await page.addScriptTag({
        path: path.resolve(
          __dirname,
          "../../extensions/personal/workflows",
          script,
        ),
      });
    const result = await page.evaluate(async () => {
      const input = document.querySelector('input[name="tags"]');
      const list = document.querySelector("#inputTag");
      input.addEventListener("input", () => {
        list.replaceChildren();
        if (input.value) {
          const item = document.createElement("li");
          item.textContent = "Assisted Blowjob";
          list.append(item);
        }
      });
      const adapter = CreatorToolkitAdapters.phUploader;
      const plan = adapter.inspectPreset("Straight", {
        orientation: "Straight",
        tags: ["Gaming", "Robot", "Assisted Masturbation"],
        categories: [],
      });
      const outcome = await adapter.applyPreset(
        plan,
        new AbortController().signal,
        { step() {} },
      );
      return {
        outcome,
        input: input.value,
        labels: [...adapter.selectedTokenLabels(input, "inputTag")].sort(),
      };
    });
    assert.equal(result.outcome.status, "success");
    assert.deepEqual(
      result.outcome.items.filter((item) => item.status === "unavailable"),
      [
        {
          label: "Assisted Masturbation",
          status: "unavailable",
          detail: "No exact site suggestion; omitted from this draft",
        },
      ],
    );
    assert.deepEqual(result.labels, ["gaming", "robot"]);
    assert.equal(result.input, "");
  } finally {
    await browser.close();
  }
});
