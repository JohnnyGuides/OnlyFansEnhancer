"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
const adapter = path.resolve(
  __dirname,
  "../../extensions/personal/workflows/upload-platform-adapters.js",
);

// Adversarial contract fixtures, not a capture of the current private DOM.
// The reported failure is a schedule-labelled action opening expiration.
// September 16 accessibility inspection corroborated the two distinct names.
async function onlyFansFixture(page, variant) {
  await page.setContent(`
    <form id="composer" aria-label="NEW POST">
      <button type="button" id="attach_file_photo" aria-label="Add media"></button>
      <input type="file" id="file_upload_input" hidden>
      <div class="tiptap ProseMirror" role="textbox" contenteditable="true"></div>
      <input id="post-label-one" type="checkbox" checked><input id="post-label-two" type="checkbox">
      <div role="toolbar">
        <button type="button" id="expiration" aria-label="Expiration period" title="Schedule post"></button>
        <span id="schedule-name" hidden>Schedule post</span>
        <button type="button" id="schedule" aria-labelledby="schedule-name"></button>
      </div>
      <button type="button" id="save">Save</button>
    </form>
    <section role="dialog" id="expiration-dialog" aria-label="Expiration period" hidden>
      <h2>EXPIRATION PERIOD</h2><button>No limit</button><button>1 day</button><button>3 days</button><button>7 days</button>
    </section>
    <section role="dialog" id="scheduler" class="vdatetime-popup" aria-label="Schedule post" hidden>
      <h2>Schedule post</h2>
      <div class="vdatetime-calendar__current--month">September 2026</div>
      <div class="vdatetime-calendar__month__day">18</div>
      <div class="vdatetime-popup__tab time">Time</div>
      <div id="time" hidden>
        <div class="vdatetime-time-picker__list" data-part="hour"><div class="vdatetime-time-picker__item">16</div><div class="vdatetime-time-picker__item">17</div></div>
        <div class="vdatetime-time-picker__list" data-part="minute"><div class="vdatetime-time-picker__item">00</div><div class="vdatetime-time-picker__item">10</div></div>
        <button type="button">OK</button>
      </div>
    </section>`);
  await page.evaluate((variant) => {
    window.actions = [];
    const composer = document.querySelector("#composer");
    const scheduler = document.querySelector("#scheduler");
    const schedule = document.querySelector("#schedule");
    const expiration = document.querySelector("#expiration");
    if (variant !== "label-conflict") expiration.title = "Expiration period";
    if (
      ["wrong-surface", "generic-dialog", "existing-dialog"].includes(variant)
    ) {
      schedule.removeAttribute("aria-labelledby");
      schedule.setAttribute("aria-label", "Schedule post");
    }
    if (variant === "duplicate") composer.append(schedule.cloneNode(true));
    if (variant === "existing-dialog") scheduler.hidden = false;
    if (variant === "foreign-action") {
      const foreign = document.createElement("form");
      foreign.innerHTML =
        '<button type="button" aria-label="Schedule post">Foreign</button>';
      foreign.querySelector("button").onclick = () => actions.push("foreign");
      document.body.prepend(foreign);
    }
    expiration.onclick = () => {
      actions.push("expiration");
      document.querySelector("#expiration-dialog").hidden = false;
    };
    schedule.onclick = () => {
      actions.push("schedule");
      scheduler.hidden = false;
      if (variant === "wrong-surface") {
        scheduler.setAttribute("aria-label", "Expiration period");
        scheduler.querySelector("h2").textContent = "EXPIRATION PERIOD";
      }
      if (variant === "generic-dialog") {
        scheduler.setAttribute("aria-label", "Media settings");
        scheduler.querySelector("h2").textContent = "Media settings";
      }
    };
    document.querySelector("#file_upload_input").onchange = () => {
      composer.insertAdjacentHTML(
        "beforeend",
        '<div class="b-dropzone__preview"><button type="button" class="b-dropzone__preview__delete">Delete</button></div>',
      );
    };
    scheduler
      .querySelectorAll(
        ".vdatetime-calendar__month__day,.vdatetime-time-picker__item",
      )
      .forEach((node) => {
        node.onclick = () => actions.push("date-time:" + node.textContent);
      });
    scheduler.querySelector(".time").onclick = () =>
      (document.querySelector("#time").hidden = false);
    document.querySelector("#time button").onclick = () => {
      scheduler.hidden = true;
      composer.insertAdjacentHTML(
        "beforeend",
        '<div class="b-dropzone__preview m-schedule"><time datetime="2026-09-18T15:00:00.000Z">Scheduled September 18, 2026 17:00</time></div>',
      );
    };
    document.querySelector("#save").onclick = () => actions.push("PUBLICATION");
  }, variant);
  await page.addScriptTag({ path: adapter });
}

for (const variant of [
  "label-conflict",
  "foreign-action",
  "wrong-surface",
  "generic-dialog",
  "duplicate",
  "existing-dialog",
]) {
  test(`OnlyFans action and postcondition identity: ${variant}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await onlyFansFixture(page, variant);
      const result = await page.evaluate(async () => {
        const labels = () =>
          [...document.querySelectorAll("[id^='post-label-']")].map(
            (node) => node.checked,
          );
        const before = labels();
        const result = await CreatorUploadPlatformAdapters.runOnlyFans({
          signal: AbortSignal.timeout(1800),
          draft: {
            publishMode: "manual",
            description: "Neutral upload verification",
            scheduledIso: "2026-09-18T15:00:00Z",
            timeZone: "Europe/Zurich",
          },
          attachFile: async (_role, selector) => {
            actions.push("file-handoff");
            const transfer = new DataTransfer();
            transfer.items.add(
              new File(["inert"], "verification.mp4", { type: "video/mp4" }),
            );
            const input = document.querySelector(selector);
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
          },
        }).catch((error) => ({ status: "failed", error: error.message }));
        return {
          result,
          actions,
          before,
          after: labels(),
          caption: document.querySelector("[role='textbox']").textContent,
        };
      });
      assert.equal(result.actions.includes("expiration"), false);
      assert.equal(result.actions.includes("foreign"), false);
      assert.equal(result.actions.includes("PUBLICATION"), false);
      assert.deepEqual(result.before, result.after);
      assert.equal(result.caption, "Neutral upload verification");
      if (["label-conflict", "foreign-action"].includes(variant)) {
        assert.equal(
          result.result.status,
          "manual-submit-required",
          result.result.error,
        );
        assert.equal(result.actions.filter((a) => a === "schedule").length, 1);
        assert.ok(result.actions.includes("date-time:18"));
      } else {
        assert.equal(result.result.status, "failed");
        assert.equal(
          result.actions.some((a) => a.startsWith("date-time:")),
          false,
        );
        assert.match(
          result.result.error,
          variant === "wrong-surface"
            ? /expiration.*scheduler/i
            : variant === "duplicate"
              ? /schedule.*ambiguous/i
              : variant === "existing-dialog"
                ? /existing.*dialog/i
                : /scheduler.*unverified|unsupported.*scheduler/i,
        );
      }
    } finally {
      await browser.close();
    }
  });
}

// September 16 desktop inspection confirmed this unlabeled image/source dropdown.
// Delays and competing controls below are adversarial additions, not live acceptance.
async function fanslyFixture(page, variant) {
  await page.setContent(`
    <app-post-creation>
      <textarea></textarea>
      <div class="default-dropdown"><div class="dropdown-title">Post to Walls</div><div class="dropdown-item" hidden>Other wall</div></div>
      <div class="default-dropdown" id="media-source"><div class="dropdown-title"><i class="fa-fw fal fa-image hover-effect blue-1"></i></div><div class="dropdown-item" hidden>Upload New</div><div class="dropdown-item" hidden>From Vault</div></div>
      <input type="file" hidden accept="video/*">
    </app-post-creation>
    <div role="dialog" aria-label="From Vault" hidden><button>Upload New</button><input type="file"></div>`);
  await page.evaluate((variant) => {
    window.actions = [];
    const composer = document.querySelector("app-post-creation");
    const menu = document.querySelector("#media-source");
    const input = composer.querySelector("input");
    menu.querySelector(".dropdown-title").onclick = () => {
      actions.push("add-media");
      setTimeout(() => {
        if (variant === "replace-composer") {
          composer.replaceWith(composer.cloneNode(true));
          return;
        }
        menu
          .querySelectorAll(".dropdown-item")
          .forEach((node) => (node.hidden = false));
      }, 40);
    };
    menu.querySelectorAll(".dropdown-item").forEach(
      (node) =>
        (node.onclick = () => {
          actions.push("source:" + node.textContent);
          if (["no-op", "async-foreign-input"].includes(variant)) {
            const now = Date.now;
            let elapsed = 0;
            Date.now = () => now() + elapsed;
            setTimeout(() => (elapsed = 31_000), 250);
            if (variant === "async-foreign-input") {
              input.remove();
              const foreign = document.querySelector("[role='dialog']");
              foreign.setAttribute("aria-label", "Media picker");
              foreign.hidden = false;
              setTimeout(() => foreign.querySelector("input").click(), 20);
            }
            return;
          }
          if (
            node.textContent !== "Upload New" ||
            variant === "ambiguous-input"
          )
            return;
          if (variant === "foreign-input") {
            const foreign = document.querySelector("[role='dialog']");
            foreign.hidden = false;
            foreign.querySelector("input").click();
          } else input.click();
        }),
    );
    if (variant === "duplicate-source")
      menu.append(menu.querySelector(".dropdown-item").cloneNode(true));
    if (variant === "ambiguous-input") composer.append(input.cloneNode(true));
    if (variant === "foreign-source")
      composer.insertAdjacentHTML(
        "beforeend",
        '<button class="dropdown-item">Upload New</button>',
      );
    if (variant === "existing-vault")
      document.querySelector("[role='dialog']").hidden = false;
  }, variant);
  await page.addScriptTag({ path: adapter });
}

for (const variant of [
  "source-path",
  "foreign-source",
  "existing-vault",
  "duplicate-source",
  "ambiguous-input",
  "foreign-input",
  "replace-composer",
  "no-op",
  "async-foreign-input",
]) {
  test(`Fansly pre-file source ownership: ${variant}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await fanslyFixture(page, variant);
      const result = await page.evaluate(async () => {
        let delivered = 0;
        let owned = false;
        const result = await CreatorUploadPlatformAdapters.runFansly({
          signal: AbortSignal.timeout(1800),
          draft: { publishMode: "manual", hasTeaser: false },
          attachFile: async (_role, selector) => {
            delivered++;
            const input = document.querySelector(selector);
            owned = !!input.closest("app-post-creation");
            const transfer = new DataTransfer();
            transfer.items.add(
              new File(["inert"], "verification.mp4", { type: "video/mp4" }),
            );
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            throw new Error("stop-after-once-only-file-handoff");
          },
        }).catch((error) => ({ status: "failed", error: error.message }));
        return { result, delivered, owned, actions };
      });
      assert.equal(result.actions.includes("source:From Vault"), false);
      if (
        ["source-path", "foreign-source", "existing-vault"].includes(variant)
      ) {
        assert.equal(result.delivered, 1, result.result.error);
        assert.equal(result.owned, true);
        assert.deepEqual(result.actions, ["add-media", "source:Upload New"]);
        assert.match(
          result.result.error,
          /file-handoff.*stop-after-once-only-file-handoff/,
        );
      } else {
        assert.equal(result.delivered, 0);
        assert.match(
          result.result.error,
          /Fansly \[(upload-new|file-input|media-menu)\]/,
        );
        assert.match(
          result.result.error,
          /ambiguous|foreign|ownership|changed|postcondition|activated/,
        );
      }
    } finally {
      await browser.close();
    }
  });
}

for (const conflict of ["action-title", "surface-title"]) {
  test(`OnlyFans rejects independently conflicting ${conflict} before date mutation`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await onlyFansFixture(page, "label-conflict");
      await page.evaluate((conflict) => {
        document
          .querySelector(
            conflict === "action-title" ? "#schedule" : "#scheduler",
          )
          .setAttribute(
            "title",
            conflict === "action-title" ? "Create poll" : "Expiration period",
          );
      }, conflict);
      const result = await page.evaluate(async () => {
        const outcome = await CreatorUploadPlatformAdapters.runOnlyFans({
          signal: AbortSignal.timeout(1800),
          draft: {
            publishMode: "manual",
            description: "Neutral verification",
            scheduledIso: "2026-09-18T15:00:00Z",
            timeZone: "Europe/Zurich",
          },
          attachFile: async (_role, selector) => {
            document.querySelector(selector).dispatchEvent(new Event("change"));
          },
        }).catch((error) => ({ status: "failed", error: error.message }));
        return { outcome, actions };
      });
      assert.equal(result.outcome.status, "failed");
      assert.equal(
        result.actions.some((action) => action.startsWith("date-time:")),
        false,
      );
      assert.equal(result.actions.includes("expiration"), false);
      assert.equal(result.actions.includes("PUBLICATION"), false);
      if (conflict === "action-title")
        assert.equal(result.actions.includes("schedule"), false);
      assert.match(result.outcome.error, /schedule|scheduler/i);
    } finally {
      await browser.close();
    }
  });
}

for (const conflict of ["source-text", "source-title", "menu-title"]) {
  test(`Fansly rejects conflicting ${conflict} without clicking the foreign source`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await fanslyFixture(page, "source-path");
      await page.evaluate((conflict) => {
        const node = document.querySelector(
          conflict === "menu-title"
            ? "#media-source .dropdown-title"
            : "#media-source .dropdown-item",
        );
        node.setAttribute(
          "aria-label",
          conflict === "menu-title" ? "Add Media" : "Upload New",
        );
        if (conflict === "source-text") node.textContent = "From Vault";
        else node.setAttribute("title", "From Vault");
      }, conflict);
      const result = await page.evaluate(async () => {
        let delivered = 0;
        const outcome = await CreatorUploadPlatformAdapters.runFansly({
          signal: AbortSignal.timeout(1800),
          draft: { publishMode: "manual", hasTeaser: false },
          attachFile: async () => {
            delivered++;
            throw new Error("unexpected-file-handoff");
          },
        }).catch((error) => ({ status: "failed", error: error.message }));
        return { outcome, delivered, actions };
      });
      assert.equal(result.delivered, 0);
      assert.equal(
        result.actions.some((action) => action.startsWith("source:")),
        false,
      );
      if (conflict === "menu-title")
        assert.equal(result.actions.includes("add-media"), false);
      assert.match(result.outcome.error, /Fansly \[(media-menu|upload-new)\]/);
    } finally {
      await browser.close();
    }
  });
}
