"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
const adapter = path.resolve(
  __dirname,
  "../../extensions/personal/workflows/upload-platform-adapters.js",
);
// Derived from the Sept 16 owner trace: image icon inside dropdown-title,
// then owned Upload New and the composer's single hidden file input.
// Lazy menu construction and competing controls are adversarial reproductions,
// not claims that the sanitized trace contains unrecorded DOM details.
for (const variant of [
  "lazy",
  "duplicate-image",
  "foreign-label",
  "vault-only",
]) {
  test(`Fansly recorded image/source relationship: ${variant}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<app-post-creation><textarea></textarea><div class="default-dropdown" id="walls"><div class="dropdown-title">Post to Walls</div></div><div class="default-dropdown" id="media"><div class="dropdown-title"><i class="fa-fw fal fa-image"></i></div></div><input type="file" hidden multiple accept="video/*"></app-post-creation>`,
      );
      await page.evaluate((variant) => {
        window.actions = [];
        const composer = document.querySelector("app-post-creation");
        const menu = document.querySelector("#media");
        if (variant === "duplicate-image")
          composer.append(menu.cloneNode(true));
        if (variant === "foreign-label")
          menu.firstElementChild.title = "From Vault";
        menu.firstElementChild.onclick = () => {
          actions.push("media");
          menu.insertAdjacentHTML(
            "beforeend",
            `<div class="dropdown-list"><div class="dropdown-item"><xd-localization-string>${variant === "vault-only" ? "From Vault" : "Upload New"}</xd-localization-string></div></div>`,
          );
          menu.querySelector(".dropdown-item").onclick = () => {
            actions.push("source");
            composer.querySelector("input").click();
          };
        };
      }, variant);
      await page.addScriptTag({ path: adapter });
      const result = await page.evaluate(async () => {
        let handoffs = 0;
        let insideComposer = false;
        const result = await CreatorUploadPlatformAdapters.runFansly({
          draft: { publishMode: "manual", hasTeaser: false },
          signal: AbortSignal.timeout(1200),
          attachFile: async (_role, selector) => {
            handoffs++;
            insideComposer = !!document
              .querySelector(selector)
              ?.closest("app-post-creation");
            throw new Error("verification-boundary-before-media-transfer");
          },
        }).catch((error) => ({ error: error.message }));
        return { result, handoffs, insideComposer, actions };
      });
      if (variant === "lazy") {
        assert.equal(result.handoffs, 1, result.result.error);
        assert.equal(result.insideComposer, true);
        assert.deepEqual(result.actions, ["media", "source"]);
      } else {
        assert.equal(result.handoffs, 0);
        assert.equal(result.actions.includes("source"), false);
        if (variant !== "vault-only") assert.deepEqual(result.actions, []);
      }
    } finally {
      await browser.close();
    }
  });
}

for (const presetOk of [false, true]) {
  test(`Pornhub title is prepared before preset result; preset success=${presetOk}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<section><custom-dropdown data-key="orientation"></custom-dropdown><input name="tags"><input name="category"><input name="title"><button id="submit">Submit</button></section>',
      );
      await page.addScriptTag({ path: adapter });
      const result = await page.evaluate(async (presetOk) => {
        let titleAtPreset = "",
          submits = 0,
          handoffs = 0;
        document.querySelector("#submit").onclick = () => submits++;
        window.CreatorToolkit = { createBudget: () => ({}) };
        window.CreatorToolkitAdapters = {
          phUploader: {
            resolvePreset: () => ({ name: "Neutral", preset: {} }),
            inspectPreset: () => ({}),
            applyPreset: async () => {
              titleAtPreset = document.querySelector('[name="title"]').value;
              return presetOk
                ? { status: "success" }
                : {
                    status: "partial",
                    summary: "Generic summary",
                    items: [
                      {
                        label: "Category verification",
                        status: "failed",
                        detail:
                          "Expected category acknowledgement did not appear",
                      },
                    ],
                  };
            },
          },
        };
        const outcome = await CreatorUploadPlatformAdapters.runPornhub({
          draft: {
            publishMode: "manual",
            title: "Neutral upload verification",
            scheduledIso: "2026-09-18T15:00:00Z",
          },
          signal: AbortSignal.timeout(1500),
          attachFile: async () => {
            handoffs++;
          },
        }).catch((error) => ({ status: "failed", error: error.message }));
        return {
          outcome,
          titleAtPreset,
          title: document.querySelector('[name="title"]').value,
          submits,
          handoffs,
        };
      }, presetOk);
      assert.equal(result.titleAtPreset, "Neutral upload verification");
      assert.equal(result.title, "Neutral upload verification");
      assert.equal(result.submits, 0);
      assert.equal(result.handoffs, 1);
      if (presetOk)
        assert.deepEqual(result.outcome.manualFields, [
          "schedule",
          "custom thumbnail (optional)",
          "site certifications",
          "final Submit",
        ]);
      else
        assert.match(
          result.outcome.error,
          /metadata-preset.*Category verification.*acknowledgement/,
        );
    } finally {
      await browser.close();
    }
  });
}

// The owner trace records a single-select preview input inside the selected full
// card, alongside two unrelated multi-select inputs. Ownership, not global input
// count or opacity tokens, determines the preview handoff.
for (const variant of [
  "owned-preview",
  "foreign-preview",
  "noop-preview",
  "double-preview",
  "conflicting-preview",
]) {
  test(
    "Fansly trace-shaped full-card preview handoff: " + variant,
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<app-post-creation><textarea></textarea><div class="default-dropdown"><div class="dropdown-title"><i class="fa-image"></i></div><div class="dropdown-item">Upload New</div></div><input id="full" type="file" hidden multiple></app-post-creation>',
        );
        await page.evaluate(() => {
          document.querySelector(".dropdown-item").onclick = () =>
            document.querySelector("#full").click();
        });
        await page.addScriptTag({ path: adapter });
        const result = await page.evaluate(async (variant) => {
          const deliveries = [];
          const activations = [];
          document.addEventListener(
            "click",
            (event) => {
              if (event.target.type === "file")
                activations.push({
                  id: event.target.id,
                  prevented: event.defaultPrevented,
                });
            },
            true,
          );
          const result = await CreatorUploadPlatformAdapters.runFansly({
            draft: { publishMode: "manual", hasTeaser: true },
            signal: AbortSignal.timeout(1600),
            attachFile: async (role, selector) => {
              deliveries.push({
                role,
                id: document.querySelector(selector)?.id,
              });
              if (role === "teaser")
                throw new Error("stop-after-owned-preview-handoff");
              const modal = document.createElement("app-account-media-upload");
              modal.className = "active-modal";
              modal.innerHTML =
                '<app-account-media-template><div class="transparent-dropdown"><xd-localization-string>Add Free Preview</xd-localization-string><div class="dropdown-item">Upload New</div></div><input id="preview" type="file" hidden></app-account-media-template><input id="foreign" type="file" multiple hidden>';
              document.body.append(modal);
              const action = modal.querySelector(".dropdown-item");
              if (variant === "conflicting-preview")
                action.title = "From Vault";
              action.onclick = () => {
                if (variant === "noop-preview") return;
                modal
                  .querySelector(
                    variant === "foreign-preview" ? "#foreign" : "#preview",
                  )
                  .click();
                if (variant === "double-preview")
                  modal.querySelector("#foreign").click();
              };
            },
          }).catch((error) => ({ status: "failed", error: error.message }));
          return { result, deliveries, activations };
        }, variant);
        assert.equal(
          result.deliveries.filter((d) => d.role === "full").length,
          1,
        );
        if (variant === "owned-preview") {
          assert.deepEqual(result.deliveries, [
            { role: "full", id: "full" },
            { role: "teaser", id: "preview" },
          ]);
          assert.match(result.result.error, /stop-after-owned-preview-handoff/);
          assert.equal(
            result.activations.find((a) => a.id === "preview")?.prevented,
            true,
          );
        } else {
          assert.equal(
            result.deliveries.some((d) => d.role === "teaser"),
            false,
            result.result.error,
          );
          assert.match(result.result.error, /preview-source|preview-input/);
        }
      } finally {
        await browser.close();
      }
    },
  );
}
