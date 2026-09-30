"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

const repositoryRoot = require("../support/paths.cjs").personalRoot;

// The legacy Fansly composer: media cards carry their access preset on the
// card itself, and the preset menu is a page-level list.
async function runLegacyFansly(scenario) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const hourOptions = Array.from(
      { length: 24 },
      (_, index) => `<option>${String(index).padStart(2, "0")}</option>`,
    ).join("");
    await page.setContent(`
      <app-post-creation>
        <div class="default-dropdown">
          <div class="dropdown-title">Media</div>
          <div class="dropdown-item">Upload New</div>
        </div>
        <input id="fansly-file" type="file" accept="video/*">
        <div id="media"></div>
        <textarea></textarea>
        <div class="icon-stack"><i class="fa-clock"></i><i class="fa-calendar"></i></div>
        <div class="btn new-post-btn solid-blue">Post</div>
      </app-post-creation>
      <div id="preset-menu" hidden><div class="dropdown-item">default</div><div class="dropdown-item">defaulT</div><div class="dropdown-item">Other</div></div>
      <div id="schedule-modal" hidden>
        <div class="timezone">Time Zone</div><div>Europe/Zurich</div>
        <table><tr><td class="current-month-day" data-date="2026-08-28">28</td></tr></table>
        <select data-time="hour">${hourOptions}</select>
        <select data-time="minute"><option>00</option><option>30</option></select>
        <select data-time="format"><option>AM/PM</option><option>24H</option></select>
        <div class="btn outline-blue large confirm-btn">Confirm Date</div>
      </div>
      <script>
        document.querySelector(".default-dropdown .dropdown-item").addEventListener("click", () => document.querySelector("#fansly-file").click());
        let uploadRole = "";
        document.querySelector("#fansly-file").addEventListener("change", () => {
          const card = document.createElement("app-account-media-template");
          card.className = "media-container hover-border selected";
          card.dataset.role = uploadRole;
          card.dataset.locked = "false";
          card.innerHTML = '<div class="locked-text-container pointer transparent-dropdown">Access</div>';
          card.querySelector(".locked-text-container").addEventListener("click", () => document.querySelector("#preset-menu").hidden = false);
          document.querySelector("#media").append(card);
        });
        globalThis.setFanslyUploadRole = (role) => uploadRole = role;
        document.querySelectorAll("#preset-menu .dropdown-item").forEach((option) => option.addEventListener("click", (event) => {
          const card = [...document.querySelectorAll('app-account-media-template')].at(-1);
          card.dataset.locked = "true";
          card.dataset.preset = event.target.textContent;
          card.querySelector(".locked-text-container").textContent = event.target.textContent;
          document.querySelector("#preset-menu").hidden = true;
        }));
        document.querySelector(".icon-stack").addEventListener("click", () => document.querySelector("#schedule-modal").hidden = false);
        document.querySelector(".current-month-day").addEventListener("click", (event) => event.target.dataset.selected = "true");
        document.querySelector(".confirm-btn").addEventListener("click", () => {
          document.querySelector("#schedule-modal").hidden = true;
          document.querySelector(".new-post-btn").textContent = "Schedule";
        });
      </script>
    `);
    if (scenario.scopedMenu) {
      // The access control also reveals an unrelated page-level option
      // earlier in the page; only the Load Preset menu holds presets.
      await page.evaluate((names) => {
        const decoy = document.createElement("div");
        decoy.id = "decoy-menu";
        decoy.hidden = true;
        decoy.innerHTML = '<div class="dropdown-item">Decoy</div>';
        document.body.prepend(decoy);
        const menu = document.createElement("div");
        menu.className = "transparent-dropdown";
        menu.hidden = true;
        menu.innerHTML = `<div class="btn">Load Preset</div><div class="dropdown-list" hidden>${names
          .map(
            (name) =>
              `<div class="dropdown-item" style="min-height: 12px">${name}</div>`,
          )
          .join("")}</div>`;
        document.body.append(menu);
        document.querySelector("#preset-menu").replaceChildren();
        document.addEventListener(
          "click",
          (event) => {
            if (event.target.closest?.(".locked-text-container")) {
              decoy.hidden = false;
              menu.hidden = false;
            }
          },
          true,
        );
        menu.querySelector(".btn").addEventListener("click", () => {
          menu.querySelector(".dropdown-list").hidden = false;
        });
        for (const option of [
          ...menu.querySelectorAll(".dropdown-item"),
          ...decoy.querySelectorAll(".dropdown-item"),
        ])
          option.addEventListener("click", (event) => {
            const card = [
              ...document.querySelectorAll("app-account-media-template"),
            ].at(-1);
            card.dataset.locked = "true";
            card.dataset.preset = event.target.textContent;
            card.querySelector(".locked-text-container").textContent =
              event.target.textContent;
            menu.hidden = true;
            menu.querySelector(".dropdown-list").hidden = true;
            decoy.hidden = true;
          });
      }, scenario.scopedMenu);
    }
    if (scenario.mediaModal) {
      await page.evaluate(() => {
        const modal = document.createElement("div");
        modal.className = "media-upload-modal";
        modal.setAttribute("role", "dialog");
        modal.hidden = true;
        modal.append(
          document.querySelector("#fansly-file"),
          document.querySelector("#media"),
        );
        const upload = document.createElement("button");
        upload.type = "button";
        upload.textContent = "Upload";
        upload.onclick = () => {
          setTimeout(() => {
            const card = modal.querySelector("app-account-media-template");
            document.querySelector("app-post-creation").append(card);
            modal.hidden = true;
          }, 150);
        };
        modal.append(upload);
        document.body.append(modal);
        document
          .querySelector(".default-dropdown .dropdown-item")
          .addEventListener("click", () => {
            setTimeout(() => (modal.hidden = false), 100);
          });
      });
    }
    await page.evaluate(() => {
      globalThis.CreatorToolkitMasterRun = true;
    });
    for (const relativePath of [
      "workflows/registry.js",
      "workflows/common.js",
      "workflows/fansly-prefill.js",
      "workflows/upload-platform-adapters.js",
    ]) {
      await page.addScriptTag({
        path: path.join(repositoryRoot, relativePath),
      });
    }
    return await page.evaluate(async (scenario) => {
      const controller = new AbortController();
      const run = CreatorUploadPlatformAdapters.runFansly({
        signal: controller.signal,
        draft: {
          hasTeaser: false,
          publishMode: "manual",
          mediaFiles: scenario.mediaFiles,
          title: "Episode",
          description: "Episode description",
          scheduledIso: "2026-08-28T15:00:00.000Z",
          timeZone: "Europe/Zurich",
          fanslyPreset: scenario.fanslyPreset,
          fanslyPresetSelection: scenario.fanslyPresetSelection,
          fanslyCaption: "Episode description",
          profiles: {
            fanslyPrefill: { message: "", fillMode: "replace", toggles: {} },
          },
        },
        async attachFile(role, selector) {
          setFanslyUploadRole(role);
          const input = document.querySelector(selector);
          const transfer = new DataTransfer();
          transfer.items.add(
            new File([role], `episode-${role}.mp4`, { type: "video/mp4" }),
          );
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
      }).catch((error) => ({ status: "failed", error: error.message }));
      let timer;
      const result = await Promise.race([
        run,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ status: "still-waiting" });
          }, 8_000);
        }),
      ]);
      clearTimeout(timer);
      return {
        result,
        presets: Object.fromEntries(
          [...document.querySelectorAll("app-account-media-template")].map(
            (card) => [card.dataset.role, card.dataset.preset],
          ),
        ),
      };
    }, scenario);
  } finally {
    await browser.close();
  }
}

test("legacy Fansly media upload completes for a named preset other than the default", async () => {
  const outcome = await runLegacyFansly({
    mediaModal: true,
    fanslyPreset: "Other",
  });
  assert.deepEqual(outcome.result, {
    platform: "fansly",
    status: "manual-submit-required",
  });
  assert.deepEqual(outcome.presets, { full: "Other" });
});

test("legacy Fansly media upload honours the first-preset selection", async () => {
  const outcome = await runLegacyFansly({
    mediaModal: true,
    scopedMenu: ["default", "defaulT", "Other"],
    fanslyPreset: "Other",
    fanslyPresetSelection: "first",
  });
  assert.deepEqual(outcome.result, {
    platform: "fansly",
    status: "manual-submit-required",
  });
  assert.deepEqual(outcome.presets, { full: "default" });
});

test("legacy Fansly additional media honours the first-preset selection", async () => {
  const outcome = await runLegacyFansly({
    scopedMenu: ["default", "defaulT", "Other"],
    fanslyPreset: "Other",
    fanslyPresetSelection: "first",
    mediaFiles: [{ role: "media1", name: "photo.jpg", kind: "image" }],
  });
  assert.deepEqual(outcome.result, {
    platform: "fansly",
    status: "manual-submit-required",
  });
  assert.deepEqual(outcome.presets, { full: "default", media1: "default" });
});

test("legacy Fansly first preset with an empty name stops before applying it", async () => {
  const outcome = await runLegacyFansly({
    mediaModal: true,
    scopedMenu: [" ", "Other"],
    fanslyPresetSelection: "first",
  });
  assert.deepEqual(outcome.result, {
    status: "failed",
    error: "Fansly preset identity is empty.",
  });
  assert.equal(outcome.presets.full, undefined);
});
