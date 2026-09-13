"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

const repositoryRoot = require("../support/paths.cjs").personalRoot;

function rawSettings(toolId, profile = {}) {
  return {
    creatorToolkitV2: {
      schemaVersion: 2,
      tools: {
        [toolId]: { enabled: true, autorun: false },
      },
      profiles: {
        [toolId]: profile,
      },
    },
  };
}

async function preparePage(browser, { url, html, settings, scripts }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((initialStorage) => {
    const data = structuredClone(initialStorage);
    const listeners = new Set();
    globalThis.__toolkitTestStorage = data;
    globalThis.chrome = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.hasOwn(data, key)) {
                result[key] = structuredClone(data[key]);
              }
            }
            queueMicrotask(() => callback(result));
          },
          set(values, callback) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
              changes[key] = {
                oldValue: data[key],
                newValue: structuredClone(value),
              };
              data[key] = structuredClone(value);
            }
            queueMicrotask(() => {
              for (const listener of listeners) listener(changes, "local");
              callback?.();
            });
          },
        },
        onChanged: {
          addListener(listener) {
            listeners.add(listener);
          },
          removeListener(listener) {
            listeners.delete(listener);
          },
        },
      },
    };
  }, settings);
  await page.route(url, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }),
  );
  await page.goto(url);
  for (const script of ["registry.js", "common.js", ...scripts]) {
    await page.addScriptTag({
      path: path.join(repositoryRoot, "workflows", script),
    });
  }
  return { context, page };
}

async function waitForPanel(page, toolId) {
  await page.waitForFunction((id) => {
    const stack = document.getElementById("creator-toolkit-panel-stack");
    return Boolean(
      stack?.shadowRoot
        ?.querySelector(".stack")
        ?.querySelector(`[data-creator-toolkit-panel="${id}"]`),
    );
  }, toolId);
}

async function assertNoStandalonePanel(page, adapterId) {
  await page.waitForFunction(
    (id) => typeof globalThis.CreatorToolkitAdapters?.[id] === "object",
    adapterId,
  );
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator("#creator-toolkit-panel-stack").count(),
    0,
    `${adapterId} must stay inside the Master Uploader`,
  );
}

async function clickPanelButton(page, toolId, label) {
  await page.evaluate(
    ({ id, text }) => {
      const stack = document
        .getElementById("creator-toolkit-panel-stack")
        .shadowRoot.querySelector(".stack");
      const host = stack.querySelector(`[data-creator-toolkit-panel="${id}"]`);
      const button = Array.from(
        host.shadowRoot.querySelectorAll("button"),
      ).find((candidate) => candidate.textContent.trim() === text);
      if (!button) throw new Error(`Panel button not found: ${text}`);
      button.click();
    },
    { id: toolId, text: label },
  );
}

test("Sheer works without jQuery, appends exact tags, and refuses incomplete replacement", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await preparePage(browser, {
      url: "https://my.sheer.com/content/update/1",
      html: `
        <style>select { display:block; width:200px; height:30px }</style>
        <select id="contentproform-genres" multiple>
          <option value="a" selected>Tag A</option>
          <option value="b">Tag B</option>
          <option value="c">Tag C</option>
        </select>
      `,
      settings: rawSettings("sheerTags", {
        mode: "append",
        tags: ["Tag B", "Missing"],
        requireAllForReplace: true,
      }),
      scripts: ["sheer-tags.js"],
    });
    await waitForPanel(page, "sheerTags");
    assert.equal(await page.evaluate(() => typeof window.jQuery), "undefined");
    await clickPanelButton(page, "sheerTags", "Preview tags");
    await page.waitForTimeout(650);
    await clickPanelButton(page, "sheerTags", "Append exact tags");
    await page.waitForFunction(
      () =>
        document.querySelector('option[value="a"]').selected &&
        document.querySelector('option[value="b"]').selected,
    );
    assert.deepEqual(
      await page.evaluate(() =>
        Array.from(
          document.querySelector("#contentproform-genres").selectedOptions,
        ).map((option) => option.textContent),
      ),
      ["Tag A", "Tag B"],
    );

    const replacement = await page.evaluate(() => {
      const select = document.querySelector("#contentproform-genres");
      const profile = {
        mode: "replace",
        tags: ["Tag B", "Missing"],
        requireAllForReplace: true,
      };
      const plan = CreatorToolkitAdapters.sheerTags.inspectSelect(
        select,
        profile,
      );
      try {
        CreatorToolkitAdapters.sheerTags.validatePlan(plan, profile);
        return {
          threw: false,
          selected: [...select.selectedOptions].map((o) => o.value),
        };
      } catch (error) {
        return {
          threw: true,
          code: error.code,
          selected: [...select.selectedOptions].map((o) => o.value),
        };
      }
    });
    assert.equal(replacement.threw, true);
    assert.equal(replacement.code, "INCOMPLETE_REPLACE");
    assert.deepEqual(replacement.selected, ["a", "b"]);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("Fansly stays inside the Master Uploader, preserves text, applies toggles, and never focuses Post", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await preparePage(browser, {
      url: "https://fansly.com/home",
      html: `
        <style>
          app-post-creation,.post-option,.checkbox,textarea,button { display:block; width:220px; min-height:24px }
        </style>
        <app-post-creation>
          <textarea>My existing draft</textarea>
          <div class="post-option"><span class="label">Post to FYP</span><button class="checkbox"></button></div>
          <div class="post-option"><span class="label">Post to Walls</span><button class="checkbox"></button></div>
          <div class="post-option"><span class="label">Lock Replies</span><button class="checkbox"></button></div>
          <button class="new-post-btn">Post</button>
        </app-post-creation>
        <script>
          for (const box of document.querySelectorAll(".checkbox")) {
            box.addEventListener("click", () => box.classList.toggle("selected"));
          }
        </script>
      `,
      settings: rawSettings("fanslyPrefill", {
        message: "Configured message",
        fillMode: "empty-only",
        toggles: {
          "Post to FYP": false,
          "Post to Walls": true,
          "Lock Replies": false,
        },
      }),
      scripts: ["fansly-prefill.js"],
    });
    await assertNoStandalonePanel(page, "fanslyPrefill");
    const master = await page.evaluate(async () => {
      const api = CreatorToolkitAdapters.fanslyPrefill;
      const profile = {
        message: "#one #two",
        fillMode: "empty-only",
        toggles: {
          "Post to FYP": false,
          "Post to Walls": true,
          "Lock Replies": false,
        },
      };
      const composer = document.querySelector("app-post-creation");
      const plan = api.inspectComposer(composer, profile, {
        desiredText: "Master caption",
        forceWrite: true,
        finalAction: "Master confirmation owns Post.",
      });
      const result = await api.applyPlan(
        plan,
        profile,
        new AbortController().signal,
        { step() {} },
      );
      return {
        composed: api.composeMasterCaption("Episode description", "#one #two"),
        deduplicated: api.composeMasterCaption(
          "Episode description\n\n#one #two",
          "#one #two",
        ),
        caption: composer.querySelector("textarea").value,
        status: result.status,
        fyp: composer
          .querySelectorAll(".checkbox")[0]
          .classList.contains("selected"),
        walls: composer
          .querySelectorAll(".checkbox")[1]
          .classList.contains("selected"),
        replies: composer
          .querySelectorAll(".checkbox")[2]
          .classList.contains("selected"),
        postFocused:
          document.activeElement === composer.querySelector(".new-post-btn"),
      };
    });
    assert.deepEqual(master, {
      composed: "Episode description\n\n#one #two",
      deduplicated: "Episode description\n\n#one #two",
      caption: "Master caption",
      status: "success",
      fyp: false,
      walls: true,
      replies: false,
      postFocused: false,
    });
    await context.close();
  } finally {
    await browser.close();
  }
});

test("OnlyFans selection Stop prevents the next mutation and Follow obeys its cap", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const selectionPage = await preparePage(browser, {
      url: "https://onlyfans.com/my/collections/user-lists/expired",
      html: `
        <style>.b-selection-user,input,button,h1 { display:block; width:200px; min-height:24px }</style>
        <h1>Expired users</h1>
        <div class="b-selection-user"><span data-fim-masked-handle="user:1"></span><input type="checkbox"></div>
        <div class="b-selection-user"><span data-fim-masked-handle="user:2"></span><input type="checkbox"></div>
      `,
      settings: rawSettings("onlyfansAutoSelect", {
        batchLimit: 5,
        delayMs: 500,
        maxDurationMs: 10000,
        maxRetries: 0,
      }),
      scripts: ["onlyfans-list-common.js", "onlyfans-auto-select.js"],
    });
    await waitForPanel(selectionPage.page, "onlyfansAutoSelect");
    await clickPanelButton(
      selectionPage.page,
      "onlyfansAutoSelect",
      "Preview bounded all",
    );
    await clickPanelButton(
      selectionPage.page,
      "onlyfansAutoSelect",
      "Select up to 5",
    );
    await selectionPage.page.waitForFunction(
      () => document.querySelectorAll('input[type="checkbox"]')[0].checked,
    );
    await clickPanelButton(selectionPage.page, "onlyfansAutoSelect", "Stop");
    await selectionPage.page.waitForTimeout(650);
    assert.deepEqual(
      await selectionPage.page.evaluate(() =>
        Array.from(document.querySelectorAll('input[type="checkbox"]')).map(
          (input) => input.checked,
        ),
      ),
      [true, false],
    );
    await selectionPage.context.close();

    const followPage = await preparePage(browser, {
      url: "https://onlyfans.com/my/collections/user-lists/expired-follow",
      html: `
        <style>.b-users__item,button,h1 { display:block; width:200px; min-height:24px }</style>
        <h1>Expired users</h1>
        ${[1, 2, 3]
          .map(
            (id) => `
              <div class="b-users__item m-fans">
                <span data-fim-masked-handle="user:${id}"></span>
                <button onclick="setTimeout(() => this.textContent='Following', 40)">Follow</button>
              </div>`,
          )
          .join("")}
      `,
      settings: rawSettings("onlyfansAutoFollow", {
        batchLimit: 2,
        delayMs: 1000,
        maxDurationMs: 10000,
        maxRetries: 0,
      }),
      scripts: ["onlyfans-list-common.js", "onlyfans-auto-follow.js"],
    });
    await waitForPanel(followPage.page, "onlyfansAutoFollow");
    await clickPanelButton(
      followPage.page,
      "onlyfansAutoFollow",
      "Preview bounded all",
    );
    await clickPanelButton(
      followPage.page,
      "onlyfansAutoFollow",
      "Follow up to 2",
    );
    await followPage.page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".b-users__item button")).filter(
          (button) => button.textContent === "Following",
        ).length === 2,
    );
    assert.deepEqual(
      await followPage.page.evaluate(() =>
        Array.from(document.querySelectorAll(".b-users__item button")).map(
          (button) => button.textContent,
        ),
      ),
      ["Following", "Following", "Follow"],
    );
    const blocker = await followPage.page.evaluate(() => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.textContent = "Subscribe";
      dialog.style.cssText = "display:block;width:200px;height:100px";
      document.body.appendChild(dialog);
      try {
        CreatorToolkitAdapters.onlyfansAutoFollow.assertNoBlockers();
        return "";
      } catch (error) {
        return error.code;
      }
    });
    assert.equal(blocker, "BLOCKING_MODAL");
    await followPage.context.close();
  } finally {
    await browser.close();
  }
});

test("Pornhub and ManyVids stay inside the Master Uploader and select only fresh exact autocomplete values", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const ph = await preparePage(browser, {
      url: "https://pornhub.mainhub.com/upload/uploader",
      html: `
        <style>input,ul,li,.chip { display:block; width:200px; min-height:24px }</style>
        <input id="solo" type="radio" value="solo">
        <div class="field">
          <input name="tags">
          <div class="selected"></div>
          <ul id="inputTag"><li id="wrong-ph">Wrong</li></ul>
        </div>
        <script>
          const phInput = document.querySelector('input[name="tags"]');
          phInput.addEventListener("input", () => {
            if (!phInput.value) return;
            setTimeout(() => {
              document.querySelector("#inputTag").innerHTML = "<li>Wanted</li>";
            }, 40);
          });
          document.querySelector("#inputTag").addEventListener("click", (event) => {
            if (event.target.tagName !== "LI") return;
            const chip = document.createElement("span");
            chip.className = "chip";
            chip.textContent = event.target.textContent;
            document.querySelector(".selected").appendChild(chip);
          });
        </script>
      `,
      settings: rawSettings("phUploader"),
      scripts: ["ph-uploader.js"],
    });
    await assertNoStandalonePanel(ph.page, "phUploader");
    const phResult = await ph.page.evaluate(async () => {
      const controller = new AbortController();
      const result = await CreatorToolkitAdapters.phUploader.selectExactToken({
        input: document.querySelector('input[name="tags"]'),
        token: "Wanted",
        suggestionListId: "inputTag",
        signal: controller.signal,
        budget: { step() {} },
      });
      const plan = CreatorToolkitAdapters.phUploader.inspectPreset("Straight", {
        orientation: "Straight",
        tags: [],
        categories: [],
      });
      await CreatorToolkitAdapters.phUploader.applyPreset(
        plan,
        controller.signal,
        {
          step() {},
        },
      );
      return {
        result,
        wrongClicked:
          document.querySelector("#wrong-ph")?.dataset.clicked === "1",
        selected: document.querySelector(".chip")?.textContent,
        resolved: CreatorToolkitAdapters.phUploader.resolvePreset(
          {
            presets: {
              Straight: {
                orientation: "Straight",
                tags: [],
                categories: [],
              },
            },
            seriesPresets: { "Resident Evil": "Straight" },
          },
          "resident  evil",
          "",
        ),
        unresolved: CreatorToolkitAdapters.phUploader.resolvePreset(
          { presets: { Straight: {} }, seriesPresets: {} },
          "Unknown",
          "",
        ),
        applyExport: typeof CreatorToolkitAdapters.phUploader.applyPreset,
        soloChecked: document.querySelector("#solo").checked,
      };
    });
    assert.equal(phResult.result.status, "changed");
    assert.equal(phResult.wrongClicked, false);
    assert.equal(phResult.selected, "Wanted");
    assert.equal(phResult.resolved.name, "Straight");
    assert.equal(phResult.resolved.source, "series");
    assert.equal(phResult.unresolved, null);
    assert.equal(phResult.applyExport, "function");
    assert.equal(phResult.soloChecked, false);
    await ph.context.close();

    const mv = await preparePage(browser, {
      url: "https://www.manyvids.com/Edit-vid/1",
      html: `
        <style>form,input,ul,li,.multi-dropdown-list { display:block; width:240px; min-height:24px }</style>
        <form>
          <div class="multi-dropdown-list"></div>
          <input id="input-new-custom-tag-filter">
          <div id="dropdown-items-custom-tags"><li id="wrong-mv">Wrong</li></div>
          <input id="appendedPrependedInput" value="8.00">
          <select id="co-performer"><option>No</option></select>
          <select id="available_time"><option value="15:00">03:00 PM</option></select>
          <input id="free_vid_0" type="radio"><label for="free_vid_0">Unknown price mode</label>
          <input id="launchCustom" type="radio"><label for="launchCustom">Unknown launch mode</label>
          <input id="membership3" type="radio"><label for="membership3">Unknown membership mode</label>
          <input id="premium2" type="radio"><label for="premium2">Include this Vid to Premium</label>
        </form>
        <script>
          const mvInput = document.querySelector("#input-new-custom-tag-filter");
          mvInput.addEventListener("input", () => {
            if (!mvInput.value) return;
            setTimeout(() => {
              document.querySelector("#dropdown-items-custom-tags").innerHTML = "<li>ExactTag</li>";
            }, 40);
          });
          document.querySelector("#dropdown-items-custom-tags").addEventListener("click", (event) => {
            if (event.target.tagName !== "LI") return;
            const item = document.createElement("div");
            item.textContent = event.target.textContent;
            const hidden = document.createElement("input");
            hidden.name = "tags[]";
            hidden.type = "hidden";
            item.appendChild(hidden);
            document.querySelector(".multi-dropdown-list").appendChild(item);
          });
        </script>
      `,
      settings: rawSettings("manyvidsAutofill", {
        tags: ["ExactTag"],
      }),
      scripts: ["manyvids-autofill.js"],
    });
    await assertNoStandalonePanel(mv.page, "manyvidsAutofill");
    const mvResult = await mv.page.evaluate(async () => {
      const form = document.querySelector("form");
      const result = await CreatorToolkitAdapters.manyvidsAutofill.addExactTag(
        form,
        "ExactTag",
        new AbortController().signal,
        { step() {} },
      );
      const mode = CreatorToolkitAdapters.manyvidsAutofill.inspectModeControl(
        form,
        "#free_vid_0",
        "",
      );
      const profile = CreatorToolkitRegistry.DEFAULT_PROFILES.manyvidsAutofill;
      const plan = CreatorToolkitAdapters.manyvidsAutofill.inspectForm(
        form,
        profile,
      );
      return {
        result,
        selected: CreatorToolkitAdapters.manyvidsAutofill
          .selectedTags(form)
          .has("exacttag"),
        unsafeMode: mode.safe,
        premiumSafe: plan.premium.safe,
        applyExport: typeof CreatorToolkitAdapters.manyvidsAutofill.applyPlan,
      };
    });
    assert.equal(mvResult.result.status, "changed");
    assert.equal(mvResult.selected, true);
    assert.equal(mvResult.unsafeMode, false);
    assert.equal(mvResult.premiumSafe, true);
    assert.equal(mvResult.applyExport, "function");
    await mv.context.close();
  } finally {
    await browser.close();
  }
});

test("C4S never confuses Assign with Unassign and Reddit censor cleans up immediately", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const c4s = await preparePage(browser, {
      url: "https://workspace.clips4sale.com/upload",
      html: `
        <style>button,div,input,textarea { display:block; width:220px; min-height:24px }</style>
        <div id="performers-dropdown-select">Johnny Guides</div>
        <button id="unassign">Unassign Performer</button>
        <input id="price-input" value="14.99">
        <textarea id="description-input"></textarea>
        <input id="keywords-input">
        <div id="mui-component-select-orientation_id">Bisexual</div>
      `,
      settings: rawSettings("c4sUpload"),
      scripts: ["c4s-upload.js"],
    });
    await waitForPanel(c4s.page, "c4sUpload");
    const performer = await c4s.page.evaluate(async () => {
      let clicked = 0;
      document.querySelector("#unassign").addEventListener("click", () => {
        clicked += 1;
      });
      const result =
        await CreatorToolkitAdapters.c4sUpload.assignPerformerExact(
          "Johnny Guides",
          new AbortController().signal,
          { step() {} },
        );
      const plan = CreatorToolkitAdapters.c4sUpload.inspectForm(
        CreatorToolkitRegistry.clone(
          CreatorToolkitRegistry.DEFAULT_PROFILES.c4sUpload,
        ),
        "Bisexual",
        "1080p",
      );
      return {
        result,
        clicked,
        planMentionsNoRandom: plan.items.some((item) =>
          item.includes("random taxonomy selection was removed"),
        ),
      };
    });
    assert.equal(performer.result.status, "unchanged");
    assert.equal(performer.clicked, 0);
    assert.equal(performer.planMentionsNoRandom, true);
    await c4s.context.close();

    const reddit = await preparePage(browser, {
      url: "https://www.reddit.com/r/example/",
      html: `
        <style>#banner { display:block; width:500px; height:120px } #subreddit-banner-img { display:block; width:500px; height:120px }</style>
        <div id="banner"><img id="subreddit-banner-img" alt="community banner"></div>
      `,
      settings: rawSettings("redditBannerCensor", {
        failClosed: true,
        label: "Banner censored",
      }),
      scripts: ["reddit-banner-censor.js"],
    });
    await reddit.page.waitForFunction(() =>
      Boolean(document.querySelector("[data-creator-toolkit-banner-cover]")),
    );
    assert.equal(
      await reddit.page.evaluate(
        () =>
          getComputedStyle(document.querySelector("#subreddit-banner-img"))
            .visibility,
      ),
      "hidden",
    );
    await reddit.page.evaluate(async () => {
      const settings = await CreatorToolkit.loadSettings();
      settings.tools.redditBannerCensor.enabled = false;
      await CreatorToolkit.saveSettings(settings);
    });
    await reddit.page.waitForFunction(
      () =>
        !document.querySelector("[data-creator-toolkit-banner-cover]") &&
        !document.querySelector("#creator-toolkit-reddit-censor-static"),
    );
    assert.equal(
      await reddit.page.evaluate(
        () =>
          getComputedStyle(document.querySelector("#subreddit-banner-img"))
            .visibility,
      ),
      "visible",
    );
    await reddit.context.close();
  } finally {
    await browser.close();
  }
});
