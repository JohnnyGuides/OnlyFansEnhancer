"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { chromium } = require("playwright");

const repositoryRoot = path.resolve(__dirname, "..");

function loadScripts(...relativePaths) {
  const context = vm.createContext({
    AbortController,
    AbortSignal,
    Date,
    Response,
    Intl,
    URL,
    crypto,
    setTimeout,
    clearTimeout,
  });
  for (const relativePath of relativePaths) {
    vm.runInContext(
      fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
      context,
      { filename: relativePath },
    );
  }
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("Friday scheduling keeps 15:00 UTC across Zurich daylight saving time", () => {
  const context = loadScripts("upload-console.js");
  const summer = plain(
    context.CreatorUploadConsole.nextFridayUtc(
      new Date("2026-08-20T09:00:00Z"),
      "Europe/Zurich",
    ),
  );
  const winter = plain(
    context.CreatorUploadConsole.nextFridayUtc(
      new Date("2026-12-24T09:00:00Z"),
      "Europe/Zurich",
    ),
  );

  assert.deepEqual(summer, {
    iso: "2026-08-21T15:00:00.000Z",
    releaseDate: "2026-08-21",
    localValue: "2026-08-21T17:00",
    timeZone: "Europe/Zurich",
  });
  assert.deepEqual(winter, {
    iso: "2026-12-25T15:00:00.000Z",
    releaseDate: "2026-12-25",
    localValue: "2026-12-25T16:00",
    timeZone: "Europe/Zurich",
  });
});

test("Friday scheduling advances after the exact 15:00 UTC boundary", () => {
  const context = loadScripts("upload-console.js");

  assert.equal(
    context.CreatorUploadConsole.nextFridayUtc(
      new Date("2026-08-21T14:59:59Z"),
      "Europe/Zurich",
    ).iso,
    "2026-08-21T15:00:00.000Z",
  );
  assert.equal(
    context.CreatorUploadConsole.nextFridayUtc(
      new Date("2026-08-21T15:00:00Z"),
      "Europe/Zurich",
    ).iso,
    "2026-08-28T15:00:00.000Z",
  );
});

test("draft normalization maps full and teaser files without requiring a teaser", () => {
  const context = loadScripts("upload-console.js");
  const full = { name: "episode full.mp4", type: "video/mp4", size: 42 };
  const normalized = plain(
    context.CreatorUploadConsole.normalizeDraft({
      fullFile: full,
      teaserFile: null,
      title: "  Episode 42  ",
      description: "  description\n",
      scheduledIso: "2026-08-28T15:00:00.000Z",
      targets: ["onlyfans", "fansly"],
    }),
  );

  assert.deepEqual(normalized, {
    valid: true,
    errors: [],
    title: "Episode 42",
    description: "description",
    scheduledIso: "2026-08-28T15:00:00.000Z",
    releaseDate: "2026-08-28",
    targets: ["onlyfans", "fansly"],
    media: {
      onlyfans: { full: "episode full.mp4" },
      fansly: { full: "episode full.mp4", teaser: null },
    },
  });
});

test("draft normalization maps the ManyVids full, teaser, and optional thumbnail roles", () => {
  const context = loadScripts("upload-console.js");
  const normalized = plain(
    context.CreatorUploadConsole.normalizeDraft({
      fullFile: { name: "episode-full.mp4", type: "video/mp4", size: 42 },
      teaserFile: {
        name: "episode-teaser.mp4",
        type: "video/mp4",
        size: 21,
      },
      thumbnailFile: {
        name: "episode-thumb.png",
        type: "image/png",
        size: 12,
      },
      title: "Episode 42",
      description: "Description",
      scheduledIso: "2026-08-28T15:00:00.000Z",
      targets: ["manyvids"],
    }),
  );

  assert.deepEqual(normalized.media.manyvids, {
    full: "episode-full.mp4",
    teaser: "episode-teaser.mp4",
    thumbnail: "episode-thumb.png",
  });
  assert.deepEqual(normalized.errors, []);

  const missingTeaser = plain(
    context.CreatorUploadConsole.normalizeDraft({
      fullFile: { name: "episode-full.mp4", type: "video/mp4", size: 42 },
      teaserFile: null,
      thumbnailFile: null,
      title: "Episode 42",
      scheduledIso: "2026-08-28T15:00:00.000Z",
      targets: ["manyvids"],
    }),
  );
  assert.match(missingTeaser.errors.join(" "), /ManyVids teaser/);
});

test("catalogue helpers score the same Friday and protect existing platform links", () => {
  const context = loadScripts("creator-tools/catalogue-contract.js");
  const contract = context.CreatorCatalogueContract;
  const candidate = {
    row: 135,
    id: "episode-42",
    releaseDate: "2026-08-28",
    title: "Episode 42 - The Test",
    description: "A deliberately useful description",
    onlyfansLink: "",
    fanslyLink: "",
    manyvidsLink: "",
  };
  const differentFriday = { ...candidate, row: 136, releaseDate: "2026-09-04" };
  const draft = {
    filename: "Episode 42 The Test (full).mp4",
    title: "Episode 42: The Test",
    description: "A deliberately useful description",
    releaseDate: "2026-08-28",
    targets: ["onlyfans", "fansly"],
  };

  assert.ok(
    contract.scoreRow(draft, candidate) >
      contract.scoreRow(draft, differentFriday),
  );
  assert.equal(
    contract.slugify("  Episode 42: The Test!  "),
    "episode-42-the-test",
  );
  assert.equal(
    contract.canonicalPostUrl(
      "onlyfans",
      "https://onlyfans.com/123/johnny_guides?x=1",
    ),
    "https://onlyfans.com/123/johnny_guides",
  );
  assert.equal(
    contract.canonicalPostUrl("fansly", "987654321"),
    "https://fansly.com/post/987654321",
  );
  assert.equal(
    contract.canonicalPostUrl("manyvids", "7783271"),
    "https://www.manyvids.com/Video/7783271",
  );
  assert.equal(
    contract.canonicalPostUrl(
      "manyvids",
      "https://www.manyvids.com/Video/7783271/",
    ),
    "https://www.manyvids.com/Video/7783271",
  );
  assert.equal(
    contract.canonicalPostUrl(
      "manyvids",
      "https://manyvids.com/Edit-vid/7783271",
    ),
    null,
  );
  assert.deepEqual(
    plain(contract.safeLinkCommit("", "https://fansly.com/post/987654321")),
    { status: "updated", value: "https://fansly.com/post/987654321" },
  );
  assert.deepEqual(
    plain(
      contract.safeLinkCommit(
        "https://fansly.com/post/111",
        "https://fansly.com/post/987654321",
      ),
    ),
    { status: "conflict", value: "https://fansly.com/post/111" },
  );
});

test("catalogue fingerprints change when any protected catalogue cell changes", () => {
  const context = loadScripts("creator-tools/catalogue-contract.js");
  const contract = context.CreatorCatalogueContract;
  const row = {
    row: 135,
    id: "episode-42",
    releaseDate: "2026-08-28",
    title: "Episode 42",
    description: "Description",
    onlyfansLink: "",
    fanslyLink: "",
    manyvidsLink: "",
  };

  assert.notEqual(
    contract.fingerprint(row),
    contract.fingerprint({
      ...row,
      onlyfansLink: "https://onlyfans.com/123/johnny_guides",
    }),
  );
  assert.notEqual(
    contract.fingerprint(row),
    contract.fingerprint({
      ...row,
      manyvidsLink: "https://www.manyvids.com/Video/7783271",
    }),
  );
  assert.equal(contract.fingerprint(row), contract.fingerprint({ ...row }));
});

test("file bridge assigns one authorized video File with native events", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <input id="full" type="file" accept="video/*">
      <script>
        globalThis.bridgeEvents = [];
        for (const type of ["input", "change"]) {
          document.querySelector("#full").addEventListener(type, () => bridgeEvents.push(type));
        }
      </script>
    `);
    await page.addScriptTag({
      path: path.join(repositoryRoot, "creator-tools", "upload-file-bridge.js"),
    });
    await page.evaluate(() =>
      CreatorUploadFileBridge.install({
        sessionId: "session-1234567890123456",
        platform: "fansly",
        bridgeUrl: "about:blank",
        bridgeOrigin: "null",
        roles: { full: { selector: "#full", token: "full-token-123456" } },
      }),
    );
    const frame = page
      .frames()
      .find((candidate) => candidate !== page.mainFrame());
    assert.ok(frame, "bridge iframe mounted");

    await frame.evaluate(() => {
      const file = new File(["wrong"], "wrong.mp4", { type: "video/mp4" });
      parent.postMessage(
        {
          source: "creator-upload-file-bridge",
          sessionId: "session-1234567890123456",
          platform: "fansly",
          role: "full",
          token: "wrong-token",
          file,
        },
        "*",
      );
    });
    await page.waitForTimeout(30);
    assert.equal(
      await page.locator("#full").evaluate((input) => input.files.length),
      0,
    );

    await frame.evaluate(() => {
      const file = new File(["real-video"], "episode-full.mp4", {
        type: "video/mp4",
      });
      parent.postMessage(
        {
          source: "creator-upload-file-bridge",
          sessionId: "session-1234567890123456",
          platform: "fansly",
          role: "full",
          token: "full-token-123456",
          file,
        },
        "*",
      );
    });
    await page.waitForFunction(
      () => document.querySelector("#full").files.length === 1,
    );
    assert.deepEqual(
      await page.locator("#full").evaluate((input) => ({
        name: input.files[0].name,
        size: input.files[0].size,
        type: input.files[0].type,
        events: globalThis.bridgeEvents,
      })),
      {
        name: "episode-full.mp4",
        size: 10,
        type: "video/mp4",
        events: ["input", "change"],
      },
    );

    await frame.evaluate(() => {
      const file = new File(["replacement"], "replacement.mp4", {
        type: "video/mp4",
      });
      parent.postMessage(
        {
          source: "creator-upload-file-bridge",
          sessionId: "session-1234567890123456",
          platform: "fansly",
          role: "full",
          token: "full-token-123456",
          file,
        },
        "*",
      );
    });
    await page.waitForTimeout(30);
    assert.equal(
      await page.locator("#full").evaluate((input) => input.files[0].name),
      "episode-full.mp4",
      "one-use token prevents replacement",
    );
  } finally {
    await browser.close();
  }
});

test("file bridge accepts an authorized ManyVids thumbnail only for an image role", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<input id="thumbnail" type="file" accept="image/*">',
    );
    await page.addScriptTag({
      path: path.join(repositoryRoot, "creator-tools", "upload-file-bridge.js"),
    });
    await page.evaluate(() =>
      CreatorUploadFileBridge.install({
        sessionId: "session-manyvids-thumbnail",
        platform: "manyvids",
        bridgeUrl: "about:blank",
        bridgeOrigin: "null",
        roles: {
          thumbnail: {
            selector: "#thumbnail",
            token: "thumbnail-token-123456",
            kind: "image",
          },
        },
      }),
    );
    const frame = page
      .frames()
      .find((candidate) => candidate !== page.mainFrame());
    await frame.evaluate(() => {
      const file = new File(["image"], "episode-thumb.png", {
        type: "image/png",
      });
      parent.postMessage(
        {
          source: "creator-upload-file-bridge",
          sessionId: "session-manyvids-thumbnail",
          platform: "manyvids",
          role: "thumbnail",
          token: "thumbnail-token-123456",
          file,
        },
        "*",
      );
    });
    await page.waitForFunction(
      () => document.querySelector("#thumbnail").files.length === 1,
    );
    assert.equal(
      await page.locator("#thumbnail").evaluate((input) => input.files[0].name),
      "episode-thumb.png",
    );
  } finally {
    await browser.close();
  }
});

test("ManyVids upload adapter clicks only the completed file card edit control", async () => {
  const adapterSource = fs.readFileSync(
    path.join(repositoryRoot, "creator-tools", "upload-platform-adapters.js"),
    "utf8",
  );
  assert.match(adapterSource, /UPLOAD_TIMEOUT\s*=\s*45\s*\*\s*60_000/);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <input class="uppy-Dashboard-input" hidden type="file" name="files[]" multiple>
      <input class="uppy-Dashboard-input" hidden webkitdirectory type="file" name="files[]" multiple>
      <article class="uppy-Dashboard-Item" data-state="upload-complete">
        <span class="uppy-Dashboard-Item-name">episode-full.mp4</span>
        <button class="uppy-Dashboard-Item-action--remove" aria-label="Remove file"></button>
        <button class="edit-upload"></button>
      </article>
      <script>
        globalThis.manyvidsEditClicks = 0;
        globalThis.manyvidsRemoveClicks = 0;
        document.querySelector(".edit-upload").addEventListener("click", () => manyvidsEditClicks += 1);
        document.querySelector(".uppy-Dashboard-Item-action--remove").addEventListener("click", () => manyvidsRemoveClicks += 1);
      </script>
    `);
    await page.addScriptTag({
      path: path.join(
        repositoryRoot,
        "creator-tools",
        "upload-platform-adapters.js",
      ),
    });
    const state = await page.evaluate(async () => {
      const progress = [];
      const result = await CreatorUploadPlatformAdapters.runManyVidsUpload({
        draft: { fullFilename: "episode-full.mp4" },
        async attachFile(role, selector) {
          const input = document.querySelector(selector);
          const transfer = new DataTransfer();
          transfer.items.add(
            new File(["full"], "episode-full.mp4", { type: "video/mp4" }),
          );
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          progress.push(`attached:${role}`);
        },
        progress(value) {
          progress.push(value);
        },
      });
      return {
        result,
        progress,
        editClicks: manyvidsEditClicks,
        removeClicks: manyvidsRemoveClicks,
        assignedInput: document
          .querySelector("input:not([webkitdirectory])")
          .files.item(0)?.name,
      };
    });
    assert.deepEqual(state.result, {
      platform: "manyvids",
      status: "edit-requested",
    });
    assert.equal(state.assignedInput, "episode-full.mp4");
    assert.equal(state.editClicks, 1);
    assert.equal(state.removeClicks, 0);
    assert.deepEqual(state.progress, [
      "attached:full",
      "upload-ready",
      "edit-requested",
    ]);
  } finally {
    await browser.close();
  }
});

test("ManyVids edit adapter fills the verified form and clicks Save once", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const tags = [
      "MoaningFetish",
      "ASMR",
      "Masturbation",
      "FuckMachine",
      "CockTease",
      "RuinedOrgasms",
      "Toys",
      "Twink",
      "EdgePlay",
      "SoloMale",
    ];
    await page.setContent(`
      <form name="thumbnail">
        <a id="upload_screenshot" href="#">Upload</a>
        <input id="fileUploader" name="image" type="file" hidden>
        <input id="save_thumb" name="upload_thumbnail_btn" type="button" value="Save thumbnail">
      </form>
      <form id="edit-form">
        <input id="Title" name="video_title" type="text">
        <textarea id="video_description"></textarea>
        <button id="custom-preview" type="button">Custom Preview</button>
        <div id="preview-menu" hidden><button class="dropdown-item" type="button">Upload</button></div>
        <input class="noborder" name="file" type="file" hidden>
        <select id="co-performer"><option value="NO">No</option><option value="YES">Yes</option></select>
        <input id="free_vid_0" name="free_vid" type="radio"><label for="free_vid_0">Set Your Price</label>
        <input id="appendedPrependedInput" name="video_cost" type="text">
        <input id="launchCustom" name="launchOption" type="radio"><label for="launchCustom">Custom launch date</label>
        <select id="launch-month"><option value="08">August</option></select>
        <select id="launch-day"><option value="28">28</option></select>
        <select id="launch-year"><option value="2026">2026</option></select>
        <select id="available_time"><option value="15:00">03:00 PM</option></select>
        <input id="membership3" name="membership" type="radio"><label for="membership3">This vid is not included in your Vid Bundle</label>
        <input id="premium2" name="premiumState" type="radio"><label for="premium2">Include this Vid to Premium</label>
        <div class="multi-dropdown-list">
          ${tags
            .slice(0, 9)
            .map(
              (tag) =>
                `<li data-tag-name="${tag}"><input name="tags[]" value="${tag}"></li>`,
            )
            .join("")}
        </div>
        <input id="input-new-custom-tag-filter" type="text">
        <div id="dropdown-items-custom-tags"></div>
        <button id="saveVideo" class="btn btn-primary submit edit-video js-edit-video" type="button">Save</button>
      </form>
      <script>
        globalThis.manyvidsSaveClicks = 0;
        globalThis.manyvidsThumbSaveClicks = 0;
        document.querySelector("#custom-preview").addEventListener("click", () => document.querySelector("#preview-menu").hidden = false);
        document.querySelector("#preview-menu button").addEventListener("click", () => document.querySelector("#preview-menu").hidden = true);
        document.querySelector("#save_thumb").addEventListener("click", () => manyvidsThumbSaveClicks += 1);
        document.querySelector("#saveVideo").addEventListener("click", () => manyvidsSaveClicks += 1);
        document.querySelector("#input-new-custom-tag-filter").addEventListener("input", (event) => {
          const menu = document.querySelector("#dropdown-items-custom-tags");
          menu.replaceChildren();
          if (event.target.value !== "SoloMale") return;
          const option = document.createElement("li");
          option.textContent = "SoloMale";
          option.addEventListener("click", () => {
            const item = document.createElement("li");
            item.dataset.tagName = "SoloMale";
            item.innerHTML = '<input name="tags[]" value="SoloMale">';
            document.querySelector(".multi-dropdown-list").append(item);
            menu.replaceChildren();
          });
          menu.append(option);
        });
      </script>
    `);
    await page.addScriptTag({
      path: path.join(
        repositoryRoot,
        "creator-tools",
        "upload-platform-adapters.js",
      ),
    });
    const state = await page.evaluate(async (tags) => {
      const attached = [];
      const result = await CreatorUploadPlatformAdapters.runManyVidsEdit({
        draft: {
          title: "Episode 42",
          description: "Description",
          releaseDate: "2026-08-28",
          scheduledIso: "2026-08-28T15:00:00.000Z",
          manyvidsId: "7783271",
          manyvidsThumbnail: true,
          manyvids: {
            coPerformer: "No",
            price: "19.99",
            priceModeLabel: "Set Your Price",
            launchModeWords: ["custom", "launch", "date"],
            launchTimeLabel: "03:00 PM",
            membershipLabel: "This vid is not included in your Vid Bundle",
            premiumLabel: "Include this Vid to Premium",
            tags,
          },
        },
        async attachFile(role, selector) {
          const input = document.querySelector(selector);
          const transfer = new DataTransfer();
          transfer.items.add(
            new File(
              [role],
              role === "thumbnail" ? "thumb.png" : "teaser.mp4",
              {
                type: role === "thumbnail" ? "image/png" : "video/mp4",
              },
            ),
          );
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          attached.push(role);
        },
      });
      return {
        result,
        attached,
        title: document.querySelector("#Title").value,
        description: document.querySelector("#video_description").value,
        price: document.querySelector("#appendedPrependedInput").value,
        coPerformer: document.querySelector("#co-performer").value,
        priceMode: document.querySelector("#free_vid_0").checked,
        launchMode: document.querySelector("#launchCustom").checked,
        membership: document.querySelector("#membership3").checked,
        premium: document.querySelector("#premium2").checked,
        saveClicks: manyvidsSaveClicks,
        thumbSaveClicks: manyvidsThumbSaveClicks,
      };
    }, tags);

    assert.deepEqual(state.result, {
      platform: "manyvids",
      status: "save-clicked",
      manyvidsId: "7783271",
    });
    assert.deepEqual(state.attached, ["teaser", "thumbnail"]);
    assert.equal(state.title, "Episode 42");
    assert.equal(state.description, "Description");
    assert.equal(state.price, "19.99");
    assert.equal(state.coPerformer, "NO");
    assert.equal(state.priceMode, true);
    assert.equal(state.launchMode, true);
    assert.equal(state.membership, true);
    assert.equal(state.premium, true);
    assert.equal(state.thumbSaveClicks, 1);
    assert.equal(state.saveClicks, 1);
  } finally {
    await browser.close();
  }
});

test("OnlyFans adapter uploads full media, fills description, schedules, and leaves labels untouched", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="attach_file_photo" aria-label="Add media"></button>
      <input id="file_upload_input" type="file" accept="video/*">
      <div class="tiptap ProseMirror b-text-editor js-text-editor" role="textbox" contenteditable="true"></div>
      <input id="post-label-1" type="checkbox" checked>
      <input id="post-label-2" type="checkbox">
      <button id="schedule" aria-label="Schedule post"></button>
      <div id="date-dialog" hidden>
        <div class="vdatetime-calendar__month__day" data-date="2026-08-28">28</div>
        <button type="button">Next</button>
        <div id="time" hidden>
          <div class="vdatetime-time-picker__list" data-part="hour">
            <div class="vdatetime-time-picker__item">16</div>
            <div class="vdatetime-time-picker__item">17</div>
          </div>
          <div class="vdatetime-time-picker__list" data-part="minute">
            <div class="vdatetime-time-picker__item">00</div>
            <div class="vdatetime-time-picker__item">10</div>
          </div>
          <button type="button">OK</button>
        </div>
      </div>
      <button id="save" type="button">Save</button>
      <script>
        document.querySelector("#schedule").addEventListener("click", () => document.querySelector("#date-dialog").hidden = false);
        document.querySelector("#date-dialog button").addEventListener("click", () => document.querySelector("#time").hidden = false);
        document.querySelectorAll(".vdatetime-calendar__month__day,.vdatetime-time-picker__item").forEach((item) => {
          item.addEventListener("click", () => item.dataset.selected = "true");
        });
        document.querySelector("#time button").addEventListener("click", () => document.querySelector("#date-dialog").hidden = true);
        globalThis.onlyfansSaveClicks = 0;
        document.querySelector("#save").addEventListener("click", () => onlyfansSaveClicks += 1);
      </script>
    `);
    await page.addScriptTag({
      path: path.join(
        repositoryRoot,
        "creator-tools",
        "upload-platform-adapters.js",
      ),
    });
    const result = await page.evaluate(async () => {
      const labelsBefore = Array.from(
        document.querySelectorAll('[id^="post-label-"]'),
      ).map((input) => input.checked);
      const progress = [];
      const result = await CreatorUploadPlatformAdapters.runOnlyFans({
        draft: {
          title: "Catalogue title must not be posted",
          description: "Only the episode description",
          scheduledIso: "2026-08-28T15:00:00.000Z",
          timeZone: "Europe/Zurich",
        },
        async attachFile(role, selector) {
          const input = document.querySelector(selector);
          const transfer = new DataTransfer();
          transfer.items.add(
            new File(["full"], "episode-full.mp4", { type: "video/mp4" }),
          );
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          progress.push(`attached:${role}`);
        },
        progress(value) {
          progress.push(value);
        },
      });
      return {
        result,
        labelsBefore,
        labelsAfter: Array.from(
          document.querySelectorAll('[id^="post-label-"]'),
        ).map((input) => input.checked),
        caption: document.querySelector('[role="textbox"]').textContent,
        selectedDate: document.querySelector('[data-date="2026-08-28"]').dataset
          .selected,
        selectedHour: document.querySelector(
          '[data-part="hour"] [data-selected="true"]',
        )?.textContent,
        selectedMinute: document.querySelector(
          '[data-part="minute"] [data-selected="true"]',
        )?.textContent,
        saveClicks: globalThis.onlyfansSaveClicks,
        progress,
      };
    });

    assert.deepEqual(result.result, {
      platform: "onlyfans",
      status: "submitted",
    });
    assert.deepEqual(result.labelsAfter, result.labelsBefore);
    assert.equal(result.caption, "Only the episode description");
    assert.doesNotMatch(result.caption, /Catalogue title/);
    assert.equal(result.selectedDate, "true");
    assert.equal(result.selectedHour, "17");
    assert.equal(result.selectedMinute, "00");
    assert.equal(result.saveClicks, 1);
    assert.ok(
      result.progress.indexOf("attached:full") <
        result.progress.indexOf("configuring"),
    );
  } finally {
    await browser.close();
  }
});

test("Fansly adapter uploads full first, locks it with defaulT, then adds a free teaser", async () => {
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
      <div id="preview-menu" hidden><div class="dropdown-item">Upload New</div></div>
      <div id="schedule-modal" hidden>
        <table><tr><td class="current-month-day" data-date="2026-08-28">28</td></tr></table>
        <select data-time="hour">${hourOptions}</select>
        <select data-time="minute"><option>00</option><option>30</option></select>
        <select data-time="format"><option>AM/PM</option><option>24H</option></select>
        <div class="btn outline-blue large confirm-btn">Confirm Date</div>
      </div>
      <div id="confirm-modal" hidden><div class="btn large solid-blue margin-left-1">Post</div></div>
      <script>
        let uploadRole = "";
        globalThis.fanslyPostClicks = 0;
        globalThis.fanslyEvents = [];
        document.querySelector("#fansly-file").addEventListener("change", (event) => {
          if (uploadRole === "teaser") {
            const full = document.querySelector('[data-role="full"]');
            const preview = document.createElement("div");
            preview.className = "free-preview";
            preview.dataset.freePreview = "true";
            preview.dataset.file = event.target.files[0].name;
            preview.textContent = "Free Preview";
            full.append(preview);
            fanslyEvents.push("preview:" + event.target.files[0].name);
            return;
          }
          const card = document.createElement("app-account-media-template");
          card.className = "media-container hover-border selected";
          card.dataset.role = uploadRole;
          card.dataset.locked = "false";
          card.innerHTML = '<div class="locked-text-container pointer transparent-dropdown">Access</div><button type="button" class="btn outline-dark-blue">Add Free Preview</button>';
          card.querySelector(".locked-text-container").addEventListener("click", () => document.querySelector("#preset-menu").hidden = false);
          card.querySelector("button").addEventListener("click", () => document.querySelector("#preview-menu").hidden = false);
          document.querySelector("#media").append(card);
          fanslyEvents.push("uploaded:" + uploadRole + ":" + event.target.files[0].name);
        });
        globalThis.setFanslyUploadRole = (role) => uploadRole = role;
        document.querySelectorAll("#preset-menu .dropdown-item").forEach((option) => option.addEventListener("click", (event) => {
          const full = document.querySelector('[data-role="full"]');
          full.dataset.locked = "true";
          full.dataset.preset = event.target.textContent;
          full.querySelector(".locked-text-container").textContent = event.target.textContent;
          document.querySelector("#preset-menu").hidden = true;
        }));
        document.querySelector("#preview-menu .dropdown-item").addEventListener("click", () => {
          document.querySelector("#preview-menu").hidden = true;
        });
        document.querySelector(".icon-stack").addEventListener("click", () => document.querySelector("#schedule-modal").hidden = false);
        document.querySelector(".current-month-day").addEventListener("click", (event) => event.target.dataset.selected = "true");
        document.querySelector(".confirm-btn").addEventListener("click", () => {
          document.querySelector("#schedule-modal").hidden = true;
          document.querySelector(".new-post-btn").textContent = "Schedule";
        });
        document.querySelector(".new-post-btn").addEventListener("click", () => document.querySelector("#confirm-modal").hidden = false);
        document.querySelector("#confirm-modal .btn").addEventListener("click", () => fanslyPostClicks += 1);
      </script>
    `);
    await page.addScriptTag({
      path: path.join(
        repositoryRoot,
        "creator-tools",
        "upload-platform-adapters.js",
      ),
    });
    const result = await page.evaluate(async () => {
      const progress = [];
      const result = await CreatorUploadPlatformAdapters.runFansly({
        draft: {
          title: "Catalogue-only title",
          description: "Fansly episode description",
          scheduledIso: "2026-08-28T15:00:00.000Z",
          timeZone: "Europe/Zurich",
          fanslyPreset: "defaulT",
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
          progress.push(`attached:${role}`);
        },
        progress(value) {
          progress.push(value);
        },
      });
      return {
        result,
        progress,
        events: globalThis.fanslyEvents,
        full: { ...document.querySelector('[data-role="full"]').dataset },
        mediaCardCount: document.querySelectorAll("app-account-media-template")
          .length,
        preview: { ...document.querySelector(".free-preview").dataset },
        caption: document.querySelector("textarea").value,
        date: document.querySelector("[data-date]").dataset.selected,
        hour: document.querySelector('[data-time="hour"]').value,
        minute: document.querySelector('[data-time="minute"]').value,
        format: document.querySelector('[data-time="format"]').value,
        postClicks: globalThis.fanslyPostClicks,
      };
    });

    assert.deepEqual(result.result, {
      platform: "fansly",
      status: "submitted",
    });
    assert.deepEqual(result.events, [
      "uploaded:full:episode-full.mp4",
      "preview:episode-teaser.mp4",
    ]);
    assert.equal(result.mediaCardCount, 1);
    assert.equal(result.full.locked, "true");
    assert.equal(result.full.preset, "defaulT");
    assert.equal(result.preview.freePreview, "true");
    assert.equal(result.preview.file, "episode-teaser.mp4");
    assert.equal(result.caption, "Fansly episode description");
    assert.doesNotMatch(result.caption, /Catalogue-only title/);
    assert.equal(result.date, "true");
    assert.equal(result.hour, "17");
    assert.equal(result.minute, "00");
    assert.equal(result.format, "24H");
    assert.equal(result.postClicks, 1);
    assert.ok(
      result.progress.indexOf("attached:full") <
        result.progress.indexOf("attached:teaser"),
    );
  } finally {
    await browser.close();
  }
});

test("post response parser accepts one canonical platform URL or post ID and rejects ambiguity", () => {
  const context = loadScripts(
    "creator-tools/catalogue-contract.js",
    "creator-tools/upload-response-observer.js",
  );
  const extract = context.CreatorUploadResponseObserver.extractPostUrl;

  assert.equal(
    extract("onlyfans", { id: 123456789 }),
    "https://onlyfans.com/123456789/johnny_guides",
  );
  assert.equal(
    extract("onlyfans", {
      data: {
        postUrl: "https://onlyfans.com/123456789/johnny_guides?source=create",
      },
    }),
    "https://onlyfans.com/123456789/johnny_guides",
  );
  assert.equal(
    extract("fansly", { response: { id: "987654321" } }),
    "https://fansly.com/post/987654321",
  );
  assert.equal(
    extract("fansly", { postId: "987654321", media: { id: "111111111" } }),
    "https://fansly.com/post/987654321",
    "explicit postId outranks unrelated nested media IDs",
  );
  assert.equal(
    extract("fansly", {
      postId: "987654321",
      url: "https://fansly.com/post/111111111",
    }),
    null,
    "an explicit postId and URL must identify the same post",
  );
  assert.equal(
    extract("fansly", { posts: [{ id: "111111111" }, { id: "222222222" }] }),
    null,
  );
  assert.equal(
    extract("onlyfans", { url: "https://example.com/post/123456789" }),
    null,
  );
  assert.equal(extract("onlyfans", "not-json"), null);
});

test("response observer resolves only the successful expected final XHR", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("https://onlyfans.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<main>fixture</main>",
      });
      return;
    }
    if (url.pathname === "/api2/v2/upload/signed/finish") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"id":111111111}',
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: '{"data":{"post":{"id":123456789}}}',
    });
  });
  const page = await context.newPage();
  try {
    await page.goto("https://onlyfans.com/fixture");
    await page.addScriptTag({
      path: path.join(repositoryRoot, "creator-tools", "catalogue-contract.js"),
    });
    await page.addScriptTag({
      path: path.join(
        repositoryRoot,
        "creator-tools",
        "upload-response-observer.js",
      ),
    });
    const result = await page.evaluate(async () => {
      const observation = CreatorUploadResponseObserver.install({
        sessionId: "session-1234567890123456",
        platform: "onlyfans",
        timeoutMs: 2000,
      });
      const upload = new XMLHttpRequest();
      upload.open("POST", "/api2/v2/upload/signed/finish");
      upload.send("private-upload-body");
      await new Promise((resolve) =>
        upload.addEventListener("loadend", resolve),
      );
      let settledEarly = false;
      await Promise.race([
        observation.then(() => {
          settledEarly = true;
        }),
        new Promise((resolve) => setTimeout(resolve, 30)),
      ]);
      const settledBeforePost = settledEarly;
      const post = new XMLHttpRequest();
      post.open("POST", "/api2/v2/posts");
      post.send("private-post-body");
      const observed = await observation;
      return { observed, settledEarly: settledBeforePost };
    });

    assert.deepEqual(result, {
      observed: {
        platform: "onlyfans",
        postUrl: "https://onlyfans.com/123456789/johnny_guides",
        sessionId: "session-1234567890123456",
        status: "link-captured",
      },
      settledEarly: false,
    });
  } finally {
    await context.close();
    await browser.close();
  }
});

test("only the MAIN-world response observer can authorize a catalogue post link", () => {
  const observerSource = fs.readFileSync(
    path.join(repositoryRoot, "creator-tools", "upload-response-observer.js"),
    "utf8",
  );
  const backgroundSource = fs.readFileSync(
    path.join(repositoryRoot, "background.js"),
    "utf8",
  );

  assert.doesNotMatch(observerSource, /postMessage\s*\(/);
  assert.doesNotMatch(backgroundSource, /adapterResult\?\.postUrl/);
  assert.match(
    backgroundSource,
    /canonicalPostUrl\(\s*platform,\s*observed\?\.postUrl/s,
  );
});

test("catalogue bridge chooses a credible existing Friday row or a unique empty-row proposal", () => {
  const context = loadScripts("apps-script/catalogue-bridge.gs");
  const bridge = context.CreatorCatalogueBridgeTest;
  const rows = [
    {
      row: 134,
      id: "existing-id",
      releaseDate: "2026-08-21",
      title: "Earlier episode",
      description: "Earlier description",
      onlyfansLink: "https://onlyfans.com/111111111/johnny_guides",
      fanslyLink: "https://fansly.com/post/111111111",
      manyvidsLink: "https://www.manyvids.com/Video/111111111",
    },
    {
      row: 135,
      id: "episode-42",
      releaseDate: "2026-08-28",
      title: "Episode 42 The Test",
      description: "Matching description",
      onlyfansLink: "",
      fanslyLink: "",
      manyvidsLink: "",
    },
    {
      row: 136,
      id: "",
      releaseDate: "",
      title: "",
      description: "",
      onlyfansLink: "",
      fanslyLink: "",
      manyvidsLink: "",
    },
  ];
  const draft = {
    filename: "Episode 42 The Test (full).mp4",
    title: "Episode 42: The Test",
    description: "Matching description",
    releaseDate: "2026-08-28",
    targets: ["onlyfans", "fansly", "manyvids"],
  };

  const matched = plain(bridge.matchRows(draft, rows));
  assert.equal(matched.status, "matched");
  assert.equal(matched.candidate.row, 135);
  assert.ok(matched.candidate.score >= 65);

  const forced = plain(bridge.matchRows({ ...draft, forceNew: true }, rows));
  assert.equal(forced.status, "new");
  assert.equal(forced.candidate.row, 136);

  const proposed = plain(
    bridge.matchRows(
      {
        ...draft,
        title: "Entirely New Episode",
        filename: "Entirely New Episode.mp4",
      },
      rows,
    ),
  );
  assert.equal(proposed.status, "new");
  assert.deepEqual(proposed.candidate, {
    row: 136,
    id: "entirely-new-episode",
    releaseDate: "2026-08-28",
    title: "Entirely New Episode",
    description: "Matching description",
    onlyfansLink: "",
    fanslyLink: "",
    manyvidsLink: "",
    fingerprint: bridge.fingerprint(rows[2]),
    score: 0,
  });

  const collision = plain(
    bridge.matchRows(
      {
        ...draft,
        title: "Episode 42",
        filename: "unrelated-source.mp4",
        description: "different",
      },
      rows.map((row) =>
        row.row === 135 ? { ...row, releaseDate: "2027-01-01" } : row,
      ),
    ),
  );
  assert.equal(collision.candidate.id, "episode-42-2");
});

test("catalogue snapshot exposes proposal fields and the first fully empty A:L row", () => {
  const context = loadScripts("apps-script/catalogue-bridge.gs");
  const bridge = context.CreatorCatalogueBridgeTest;
  const rows = [
    {
      row: 2,
      id: "battlefield-ep02",
      releaseDate: "2026-02-20",
      title: "playin Battlefield 6 while Cumming",
      description: "Battlefield episode",
      seasonArc: "Battlefield",
      episode: "2",
      pornhubLink: "",
      onlyfansLink: "https://onlyfans.com/1/johnny_guides",
      fanslyLink: "https://fansly.com/post/2",
      manyvidsLink: "https://www.manyvids.com/Video/3",
      empty: false,
    },
    {
      row: 3,
      id: "",
      releaseDate: "",
      title: "",
      description: "",
      seasonArc: "",
      episode: "",
      pornhubLink: "",
      onlyfansLink: "",
      fanslyLink: "",
      manyvidsLink: "",
      empty: true,
    },
  ];

  const snapshot = plain(bridge.snapshot(rows));

  assert.equal(snapshot.status, "snapshot");
  assert.equal(snapshot.rows[0].seasonArc, "Battlefield");
  assert.equal(snapshot.rows[0].episode, "2");
  assert.equal(snapshot.rows[0].pornhubLink, "");
  assert.equal(snapshot.emptyRow.row, 3);
  assert.match(snapshot.rows[0].fingerprint, /^[a-f0-9]{8}$/);
});

test("catalogue snapshot does not reuse a category-only A:L row or expose its internal emptiness flag", () => {
  const context = loadScripts("apps-script/catalogue-bridge.gs");
  const bridge = context.CreatorCatalogueBridgeTest;
  const sheet = {
    getLastRow: () => 2,
    getMaxRows: () => 3,
    getRange: () => ({
      getValues: () => [
        ["", "", "", "", "", "category-only", "", "", "", "", "", ""],
        Array(12).fill(""),
      ],
    }),
  };

  const snapshot = plain(bridge.snapshot(bridge.readRows(sheet)));

  assert.equal(snapshot.emptyRow.row, 3);
  assert.equal(Object.hasOwn(snapshot.emptyRow, "empty"), false);
  assert.equal(Object.hasOwn(snapshot.rows[0], "empty"), false);
});

test("catalogue bridge reads the next writable row and does not truncate row 1002", () => {
  const context = loadScripts("apps-script/catalogue-bridge.gs");
  const bridge = context.CreatorCatalogueBridgeTest;
  const ranges = [];
  const sheet = {
    getLastRow() {
      return 134;
    },
    getMaxRows() {
      return 1002;
    },
    getRange(...range) {
      ranges.push(range);
      return {
        getValues() {
          return Array.from({ length: range[2] }, () => Array(12).fill(""));
        },
      };
    },
  };

  const rows = plain(bridge.readRows(sheet));
  assert.deepEqual(ranges, [[2, 1, 134, 12]]);
  assert.equal(rows.at(-1).row, 135);

  sheet.getLastRow = () => 1002;
  ranges.length = 0;
  const fullRows = plain(bridge.readRows(sheet));
  assert.deepEqual(ranges, [[2, 1, 1001, 12]]);
  assert.equal(fullRows.at(-1).row, 1002);
});

test("catalogue bridge commit is fingerprinted, idempotent, and never overwrites another link", () => {
  const context = loadScripts("apps-script/catalogue-bridge.gs");
  const bridge = context.CreatorCatalogueBridgeTest;
  const row = {
    row: 135,
    id: "episode-42",
    releaseDate: "2026-08-28",
    title: "Episode 42",
    description: "Description",
    onlyfansLink: "",
    fanslyLink: "",
    manyvidsLink: "",
  };
  const request = {
    row: 135,
    fingerprint: bridge.fingerprint(row),
    platform: "fansly",
    postUrl: "https://fansly.com/post/987654321",
    metadata: {
      id: "episode-42",
      releaseDate: "2026-08-28",
      title: "Episode 42",
      description: "Description",
    },
  };

  const updated = plain(bridge.planCommit(row, request));
  assert.equal(updated.status, "updated");
  assert.equal(updated.row.fanslyLink, "https://fansly.com/post/987654321");
  assert.equal(
    plain(
      bridge.planCommit(updated.row, {
        ...request,
        fingerprint: updated.fingerprint,
      }),
    ).status,
    "idempotent",
  );
  assert.equal(
    plain(
      bridge.planCommit(
        { ...row, fanslyLink: "https://fansly.com/post/111111111" },
        {
          ...request,
          fingerprint: bridge.fingerprint({
            ...row,
            fanslyLink: "https://fansly.com/post/111111111",
          }),
        },
      ),
    ).status,
    "conflict",
  );
  assert.equal(
    plain(bridge.planCommit({ ...row, title: "Changed" }, request)).status,
    "stale",
  );

  const manyvids = plain(
    bridge.planCommit(row, {
      ...request,
      fingerprint: bridge.fingerprint(row),
      platform: "manyvids",
      postUrl: "7783271",
    }),
  );
  assert.equal(manyvids.status, "updated");
  assert.equal(
    manyvids.row.manyvidsLink,
    "https://www.manyvids.com/Video/7783271",
  );
});

test("catalogue client sends bounded metadata only in a no-referrer POST body", async () => {
  const context = loadScripts("creator-tools/catalogue-client.js");
  const client = context.CreatorCatalogueClient;
  const config = plain(
    client.normalizeConfig({
      endpoint:
        "https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789/exec",
      secret: "this-is-a-long-random-secret-123456",
    }),
  );
  assert.equal(config.valid, true);
  let request;
  const result = await client.request(
    config.value,
    "matchCatalogue",
    {
      filename: "episode-full.mp4",
      title: "Private title",
      description: "Private description",
      releaseDate: "2026-08-28",
      targets: ["onlyfans", "fansly"],
    },
    {
      fetchImpl: async (url, options) => {
        request = {
          url,
          options: { ...options, body: JSON.parse(options.body) },
        };
        return new Response(
          JSON.stringify({
            ok: true,
            result: { status: "new", candidate: { row: 135 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  );

  assert.deepEqual(plain(result), { status: "new", candidate: { row: 135 } });
  assert.doesNotMatch(request.url, /Private|episode/i);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.referrerPolicy, "no-referrer");
  assert.equal(
    request.options.headers["content-type"],
    "text/plain;charset=UTF-8",
  );
  assert.equal(request.options.body.action, "matchCatalogue");
  assert.equal(
    request.options.body.secret,
    "this-is-a-long-random-secret-123456",
  );
  assert.equal(request.options.body.payload.title, "Private title");
});

test("catalogue client sends an empty bounded snapshot payload", async () => {
  const context = loadScripts("creator-tools/catalogue-client.js");
  const requests = [];
  const result = await context.CreatorCatalogueClient.request(
    {
      endpoint:
        "https://script.google.com/macros/s/fixture-bridge-12345678901234567890/exec",
      secret: "fixture-bridge-secret-1234567890",
    },
    "getCatalogueSnapshot",
    {},
    {
      fetchImpl: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              status: "snapshot",
              rows: [],
              emptyRow: { row: 2 },
            },
          }),
        );
      },
    },
  );

  assert.equal(result.status, "snapshot");
  assert.equal(requests[0].body.action, "getCatalogueSnapshot");
  assert.deepEqual(requests[0].body.payload, {});
});

test("upload console performs no platform mutation before the single Yes confirmation", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const html = fs
      .readFileSync(path.join(repositoryRoot, "upload-console.html"), "utf8")
      .replace(/<script[^>]+><\/script>/gi, "");
    await page.setContent(html);
    await page.evaluate(() => {
      globalThis.consoleMessages = [];
      globalThis.CreatorCatalogueClient = {
        async loadConfig() {
          return {
            endpoint: "https://script.google.com/fixture",
            secret: "configured",
          };
        },
        async getCatalogueSnapshot() {
          return {
            status: "snapshot",
            rows: [
              {
                row: 135,
                id: "episode-42",
                releaseDate: "2026-08-28",
                title: "Episode 42 from catalogue",
                description: "Catalogue description",
                seasonArc: "Episodes",
                episode: "42",
                pornhubLink: "https://pornhub.com/view_video.php?viewkey=42",
                onlyfansLink: "",
                fanslyLink: "https://fansly.com/post/777777777",
                manyvidsLink: "https://www.manyvids.com/Video/42",
                fingerprint: "1234abcd",
              },
            ],
            emptyRow: {
              row: 136,
              fingerprint: "8765dcba",
            },
          };
        },
      };
      globalThis.CreatorUploadQueueEvidence = {
        snapshot() {
          return {
            onlyfans: { verified: true, scheduled: [], occupiedFridays: [] },
          };
        },
      };
      const portListeners = [];
      const port = {
        onMessage: {
          addListener(listener) {
            portListeners.push(listener);
          },
        },
        onDisconnect: { addListener() {} },
        postMessage(message) {
          globalThis.consolePortMessages = [
            ...(globalThis.consolePortMessages || []),
            structuredClone(message),
          ];
        },
        disconnect() {},
      };
      globalThis.chrome = {
        permissions: { request: async () => true },
        runtime: {
          lastError: null,
          connect() {
            return port;
          },
          sendMessage(message, callback) {
            globalThis.consoleMessages.push(structuredClone(message));
            if (message.type === "SYNC_CREATOR_TOOLS") {
              callback({
                ok: true,
                creatorTools: { registered: [], skipped: [] },
              });
              return;
            }
            if (message.type === "PREPARE_CREATOR_UPLOAD") {
              callback({
                ok: true,
                uploadSession: {
                  sessionId: message.sessionId,
                  platforms: message.targets.map((platform) => ({
                    platform,
                    status: "prepared",
                  })),
                },
              });
              return;
            }
            callback({
              ok: true,
              results: message.targets.map((platform) => ({
                platform,
                status: "catalogue-updated",
              })),
            });
          },
        },
      };
    });
    for (const relativePath of [
      "creator-tools/catalogue-contract.js",
      "creator-tools/catalogue-proposal.js",
      "upload-console.js",
    ]) {
      await page.addScriptTag({
        path: path.join(repositoryRoot, relativePath),
      });
    }
    await page.locator("#uploadFullVideo").setInputFiles({
      name: "Episode 42 (full).mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("full-video"),
    });
    await page.locator("#uploadTitle").fill("Episode 42");
    await page.getByText(/Likely episode/i).waitFor();

    assert.deepEqual(
      await page.evaluate(() =>
        globalThis.consoleMessages.filter((message) =>
          ["PREPARE_CREATOR_UPLOAD", "START_CREATOR_UPLOAD"].includes(
            message.type,
          ),
        ),
      ),
      [],
      "catalogue matching is read-only and must not prepare platform tabs",
    );
    assert.equal(
      await page.locator("#uploadDescription").inputValue(),
      "Catalogue description",
    );
    assert.equal(await page.locator("#targetOnlyfans").isChecked(), true);
    assert.equal(await page.locator("#targetFansly").isChecked(), false);

    await page.locator("#confirmUpload").click();
    await page
      .getByText(/Catalogue updated/i)
      .first()
      .waitFor();
    const mutationMessages = await page.evaluate(() =>
      globalThis.consoleMessages.filter((message) =>
        ["PREPARE_CREATOR_UPLOAD", "START_CREATOR_UPLOAD"].includes(
          message.type,
        ),
      ),
    );
    assert.deepEqual(
      mutationMessages.map((message) => message.type),
      ["PREPARE_CREATOR_UPLOAD", "START_CREATOR_UPLOAD"],
    );
    assert.equal(mutationMessages[0].catalogue.row, 135);
    assert.equal(mutationMessages[0].catalogue.releaseDate, "2026-08-28");
    assert.notEqual(
      mutationMessages[0].catalogue.releaseDate,
      mutationMessages[0].draft.releaseDate,
    );
    assert.equal(mutationMessages[0].catalogue.seasonArc, "Episodes");
    assert.equal(mutationMessages[0].catalogue.episode, "42");
    assert.equal(
      mutationMessages[0].catalogue.pornhubLink,
      "https://pornhub.com/view_video.php?viewkey=42",
    );
    assert.deepEqual(mutationMessages[0].targets, ["onlyfans"]);
    assert.deepEqual(mutationMessages[1].targets, ["onlyfans"]);
    assert.equal(
      mutationMessages[0].catalogue.fanslyLink,
      "https://fansly.com/post/777777777",
    );
    assert.equal(
      mutationMessages[0].draft.scheduledIso.endsWith("T15:00:00.000Z"),
      true,
    );
    assert.equal(
      mutationMessages[0].draft.fullFilename,
      "Episode 42 (full).mp4",
    );
    assert.equal(mutationMessages[0].draft.manyvidsThumbnail, false);
  } finally {
    await browser.close();
  }
});

test("strong catalogue proposal shows one Yes card and No opens the searchable picker", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const html = fs
      .readFileSync(path.join(repositoryRoot, "upload-console.html"), "utf8")
      .replace(/<script[^>]+><\/script>/gi, "");
    await page.setContent(html);
    await page.evaluate(() => {
      globalThis.consoleMessages = [];
      globalThis.CreatorCatalogueClient = {
        async loadConfig() {
          return {
            endpoint: "https://script.google.com/fixture",
            secret: "configured",
          };
        },
        async getCatalogueSnapshot() {
          return {
            status: "snapshot",
            rows: [
              {
                row: 121,
                id: "battlefield-ep03",
                releaseDate: "2026-05-08",
                title: "BATTLEFIELD 6 Angry Sex",
                description: "Catalogue description",
                seasonArc: "Battlefield",
                episode: "3",
                pornhubLink: "",
                onlyfansLink: "",
                fanslyLink: "https://fansly.com/post/2",
                manyvidsLink: "https://www.manyvids.com/Video/3",
                fingerprint: "1234abcd",
              },
            ],
            emptyRow: {
              row: 136,
              id: "",
              releaseDate: "",
              title: "",
              description: "",
              seasonArc: "",
              episode: "",
              pornhubLink: "",
              onlyfansLink: "",
              fanslyLink: "",
              manyvidsLink: "",
              fingerprint: "8765dcba",
            },
          };
        },
      };
      globalThis.CreatorUploadQueueEvidence = {
        snapshot() {
          return {
            onlyfans: {
              verified: true,
              scheduled: [],
              occupiedFridays: [],
            },
          };
        },
      };
      globalThis.chrome = {
        runtime: {
          lastError: null,
          sendMessage(message, callback) {
            globalThis.consoleMessages.push(structuredClone(message));
            callback({ ok: true });
          },
        },
      };
    });
    for (const relativePath of [
      "creator-tools/catalogue-contract.js",
      "creator-tools/catalogue-proposal.js",
      "upload-console.js",
    ]) {
      await page.addScriptTag({
        path: path.join(repositoryRoot, relativePath),
      });
    }

    await page.locator("#uploadFullVideo").setInputFiles({
      name: "BATTLEFIELD 6 Angry Sex (full).mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("full-video"),
    });
    await page.getByText(/Likely episode/i).waitFor();

    assert.equal(await page.locator("#targetOnlyfans").isChecked(), true);
    assert.equal(await page.locator("#targetFansly").isChecked(), false);
    assert.equal(await page.locator("#targetManyvids").isChecked(), false);
    assert.match(
      await page.locator("#pornhubRecommendation").textContent(),
      /recommended.*not yet executable/i,
    );
    assert.equal(await page.locator("#confirmUpload").isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => globalThis.consoleMessages), []);

    await page.locator("#rejectMatch").click();
    await page.locator("#cataloguePicker").waitFor();
    await page.locator("#catalogueSearch").fill("battlefield");
    await page.locator("#catalogueRow").selectOption("row:121");
    assert.match(
      await page.locator("#selectedCatalogueReason").textContent(),
      /Episode 3/i,
    );
    assert.deepEqual(await page.evaluate(() => globalThis.consoleMessages), []);
  } finally {
    await browser.close();
  }
});

test("ambiguous catalogue wording opens the picker without offering Yes", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const html = fs
      .readFileSync(path.join(repositoryRoot, "upload-console.html"), "utf8")
      .replace(/<script[^>]+><\/script>/gi, "");
    await page.setContent(html);
    await page.evaluate(() => {
      globalThis.consoleMessages = [];
      globalThis.CreatorCatalogueClient = {
        async loadConfig() {
          return { endpoint: "https://script.google.com/fixture", secret: "x" };
        },
        async getCatalogueSnapshot() {
          const common = {
            releaseDate: "2026-05-08",
            title: "Claire VR",
            description: "",
            seasonArc: "Claire",
            pornhubLink: "",
            onlyfansLink: "",
            fanslyLink: "https://fansly.com/post/existing",
            manyvidsLink: "",
          };
          return {
            status: "snapshot",
            rows: [
              {
                ...common,
                row: 20,
                id: "claire-a",
                episode: "1",
                fingerprint: "a",
              },
              {
                ...common,
                row: 21,
                id: "claire-b",
                episode: "2",
                fingerprint: "b",
              },
            ],
            emptyRow: { row: 30, fingerprint: "empty" },
          };
        },
      };
      globalThis.chrome = {
        runtime: {
          lastError: null,
          sendMessage(message, callback) {
            globalThis.consoleMessages.push(structuredClone(message));
            callback({ ok: true });
          },
        },
      };
    });
    for (const relativePath of [
      "creator-tools/catalogue-contract.js",
      "creator-tools/catalogue-proposal.js",
      "upload-console.js",
    ]) {
      await page.addScriptTag({
        path: path.join(repositoryRoot, relativePath),
      });
    }

    await page.locator("#uploadFullVideo").setInputFiles({
      name: "Claire VR (full).mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("full-video"),
    });
    await page.locator("#cataloguePicker").waitFor();

    assert.equal(await page.locator("#confirmation").isHidden(), true);
    assert.equal(await page.locator("#catalogueRow option").count(), 4);
    assert.deepEqual(await page.evaluate(() => globalThis.consoleMessages), []);
  } finally {
    await browser.close();
  }
});

test("Yes rechecks the proposed catalogue row and stops before platform mutation when it changed", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const html = fs
      .readFileSync(path.join(repositoryRoot, "upload-console.html"), "utf8")
      .replace(/<script[^>]+><\/script>/gi, "");
    await page.setContent(html);
    await page.evaluate(() => {
      globalThis.consoleMessages = [];
      globalThis.permissionRequests = 0;
      globalThis.snapshotRequests = 0;
      globalThis.CreatorCatalogueClient = {
        async loadConfig() {
          return { endpoint: "https://script.google.com/fixture", secret: "x" };
        },
        async getCatalogueSnapshot() {
          globalThis.snapshotRequests += 1;
          return {
            status: "snapshot",
            rows: [
              {
                row: 121,
                id: "battlefield-ep03",
                releaseDate: "2026-05-08",
                title: "BATTLEFIELD 6 Angry Sex",
                description: "Catalogue description",
                seasonArc: "Battlefield",
                episode: "3",
                pornhubLink: "https://pornhub.com/view_video.php?viewkey=x",
                onlyfansLink: "",
                fanslyLink: "https://fansly.com/post/2",
                manyvidsLink: "https://www.manyvids.com/Video/3",
                fingerprint:
                  globalThis.snapshotRequests === 1
                    ? "1234abcd"
                    : "changed-row",
              },
            ],
            emptyRow: { row: 136, fingerprint: "empty" },
          };
        },
      };
      globalThis.CreatorUploadQueueEvidence = {
        snapshot() {
          return {
            onlyfans: { verified: true, scheduled: [], occupiedFridays: [] },
          };
        },
      };
      globalThis.chrome = {
        permissions: {
          async request() {
            globalThis.permissionRequests += 1;
            return true;
          },
        },
        runtime: {
          lastError: null,
          sendMessage(message, callback) {
            globalThis.consoleMessages.push(structuredClone(message));
            callback({ ok: true });
          },
        },
      };
    });
    for (const relativePath of [
      "creator-tools/catalogue-contract.js",
      "creator-tools/catalogue-proposal.js",
      "upload-console.js",
    ]) {
      await page.addScriptTag({
        path: path.join(repositoryRoot, relativePath),
      });
    }
    await page.locator("#uploadFullVideo").setInputFiles({
      name: "BATTLEFIELD 6 Angry Sex (full).mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("full-video"),
    });
    await page.getByText(/Likely episode/i).waitFor();

    await page.locator("#confirmUpload").click();
    await page.getByText(/changed.*review.*Yes again/i).waitFor();

    assert.equal(await page.evaluate(() => globalThis.snapshotRequests), 2);
    assert.equal(await page.evaluate(() => globalThis.permissionRequests), 0);
    assert.deepEqual(await page.evaluate(() => globalThis.consoleMessages), []);
  } finally {
    await browser.close();
  }
});

for (const scenario of [
  { name: "unconfigured", config: null, requests: 0 },
  {
    name: "incomplete",
    config: { endpoint: "invalid", secret: "" },
    requests: 0,
  },
  {
    name: "unreachable",
    config: {
      endpoint:
        "https://script.google.com/macros/s/fixture-bridge-12345678901234567890/exec",
      secret: "fixture-bridge-secret-1234567890",
    },
    requests: 1,
  },
]) {
  test(`upload console can upload with an ${scenario.name} sheet bridge after explicit confirmation`, async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      const html = fs
        .readFileSync(path.join(repositoryRoot, "upload-console.html"), "utf8")
        .replace(/<script[^>]+><\/script>/gi, "");
      await page.setContent(html);
      await page.evaluate((config) => {
        globalThis.consoleMessages = [];
        globalThis.catalogueRequests = 0;
        globalThis.fetch = async () => {
          globalThis.catalogueRequests += 1;
          return new Response("Unavailable", { status: 503 });
        };
        globalThis.chrome = {
          storage: {
            local: {
              get: async () => ({ creatorUploadSheetBridgeV1: config }),
            },
          },
          permissions: { request: async () => true },
          runtime: {
            connect: () => ({
              onMessage: { addListener() {} },
              onDisconnect: { addListener() {} },
              postMessage() {},
              disconnect() {},
            }),
            sendMessage(message, callback) {
              globalThis.consoleMessages.push(structuredClone(message));
              if (message.type === "PREPARE_CREATOR_UPLOAD") {
                callback({
                  ok: true,
                  uploadSession: {
                    platforms: message.targets.map((platform) => ({
                      platform,
                      status: "prepared",
                    })),
                  },
                });
              } else if (message.type === "START_CREATOR_UPLOAD") {
                callback({
                  ok: true,
                  results: message.targets.map((platform) => ({
                    platform,
                    status: "uploaded-no-sheet",
                    postUrl:
                      platform === "onlyfans"
                        ? "https://onlyfans.com/123456789/johnny_guides"
                        : "https://fansly.com/post/987654321",
                  })),
                });
              } else {
                callback({ ok: true });
              }
            },
          },
        };
      }, scenario.config);
      for (const relativePath of [
        "creator-tools/catalogue-contract.js",
        "creator-tools/catalogue-proposal.js",
        "creator-tools/catalogue-client.js",
        "upload-console.js",
      ]) {
        await page.addScriptTag({
          path: path.join(repositoryRoot, relativePath),
        });
      }
      await page.locator("#uploadFullVideo").setInputFiles({
        name: "Episode 42 (full).mp4",
        mimeType: "video/mp4",
        buffer: Buffer.from("full-video"),
      });
      await page.locator("#uploadDescription").fill("My description");
      if (scenario.config) {
        await page.locator("#continueWithoutSheet").waitFor({ timeout: 3000 });
        assert.equal(await page.locator("#confirmation").isVisible(), false);
        assert.match(
          await page.locator("#matchStatus").textContent(),
          /invalid|Apps Script|HTTP 503/i,
        );
        await page.locator("#continueWithoutSheet").click();
      }
      await page.locator("#confirmation").waitFor({ timeout: 3000 });
      assert.match(
        await page.locator("#matchBadge").textContent(),
        /without sheet/i,
      );
      assert.match(
        await page.locator("#confirmationNotice").textContent(),
        /no sheet data will be read or written/i,
      );
      assert.equal(
        await page.locator("#uploadDescription").inputValue(),
        "My description",
      );
      assert.equal(
        await page.evaluate(() => globalThis.consoleMessages.length),
        0,
      );
      assert.equal(
        await page.evaluate(() => globalThis.catalogueRequests),
        scenario.requests,
      );

      // Editing must keep the explicit upload-only choice and invalidate the old preview.
      await page.locator("#uploadDescription").fill("My final description");
      await page.locator("#confirmation").waitFor({ timeout: 3000 });
      assert.equal(
        await page.evaluate(() => globalThis.catalogueRequests),
        scenario.requests,
      );
      await page.locator("#confirmUpload").click();
      await page
        .getByText("Scheduled · sheet not connected", { exact: true })
        .first()
        .waitFor({ timeout: 3000 });
      const messages = await page.evaluate(() =>
        globalThis.consoleMessages.filter((message) =>
          ["PREPARE_CREATOR_UPLOAD", "START_CREATOR_UPLOAD"].includes(
            message.type,
          ),
        ),
      );
      assert.deepEqual(
        messages.map((message) => message.type),
        ["PREPARE_CREATOR_UPLOAD", "START_CREATOR_UPLOAD"],
      );
      assert.equal(messages[0].catalogue, null);
      assert.deepEqual(messages[0].targets, ["onlyfans", "fansly"]);
      assert.deepEqual(messages[1].targets, ["onlyfans", "fansly"]);
      assert.equal(messages[0].draft.description, "My final description");
      assert.match(messages[0].draft.scheduledIso, /T15:00:00.000Z$/);
      assert.equal(await page.locator("#results a").count(), 2);
      assert.equal(
        await page.locator("#results button").count(),
        0,
        "Successful upload-only posts must not offer a repost or sheet retry.",
      );
    } finally {
      await browser.close();
    }
  });
}
