"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { chromium } = require("../support/browser.cjs");

const repositoryRoot = require("../support/paths.cjs").personalRoot;
const consolePath = path.join(repositoryRoot, "upload-console.js");
const consoleHtmlPath = path.join(repositoryRoot, "upload-console.html");
const probePath = path.join(
  repositoryRoot,
  "workflows",
  "upload-capability-probe.js",
);

function loadConsoleHooks() {
  const context = vm.createContext({ Date });
  vm.runInContext(fs.readFileSync(consolePath, "utf8"), context, {
    filename: "upload-console.js",
  });
  return context.CreatorUploadConsole;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("upload console chooses the next Friday at 15:00 UTC in the browser's timezone", () => {
  const hooks = loadConsoleHooks();
  function localValue(iso) {
    const date = new Date(iso);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  for (const [now, expected] of [
    ["2026-08-20T09:00:00Z", "2026-08-21T15:00:00Z"],
    ["2026-08-21T14:59:00Z", "2026-08-21T15:00:00Z"],
    ["2026-08-21T15:00:00Z", "2026-08-28T15:00:00Z"],
  ]) {
    assert.equal(
      hooks.nextFridayLocalValue(new Date(now)),
      localValue(expected),
    );
  }
});

test("confirmed Pornhub preset learns one exact normalized Season or Arc mapping", () => {
  const hooks = loadConsoleHooks();
  const learned = plain(
    hooks.learnSeriesPresetMap(
      {
        "Resident  Evil": "Straight",
        Gooning: "Gay",
      },
      "resident evil",
      "Transgender",
    ),
  );
  assert.deepEqual(learned, {
    Gooning: "Gay",
    "resident evil": "Transgender",
  });
  assert.deepEqual(
    plain(hooks.learnSeriesPresetMap(learned, "", "Straight")),
    learned,
  );
});

test("upload console validates one local video and allow-listed targets", () => {
  const hooks = loadConsoleHooks();
  const valid = plain(
    hooks.validateDraft({
      file: { name: "episode.mp4", type: "video/mp4", size: 100 },
      title: " Episode 42 ",
      description: "",
      scheduledAt: "2026-08-28T15:00:00Z",
      targets: ["onlyfans", "fansly"],
    }),
  );
  assert.deepEqual(valid, { valid: true, errors: [] });

  const missingMime = plain(
    hooks.validateDraft({
      file: { name: "episode.webm", type: "", size: 100 },
      title: "Episode 42",
      scheduledAt: "2026-08-28T15:00:00Z",
      targets: ["onlyfans"],
    }),
  );
  assert.deepEqual(missingMime, { valid: true, errors: [] });

  const manyvids = plain(
    hooks.validateDraft({
      file: { name: "episode.mp4", type: "video/mp4", size: 100 },
      teaserFile: { name: "episode-teaser.mp4", type: "video/mp4", size: 50 },
      title: "Episode 42",
      scheduledAt: "2026-08-28T15:00:00Z",
      targets: ["manyvids"],
    }),
  );
  assert.deepEqual(manyvids, { valid: true, errors: [] });

  const fullFile = { name: "episode (full).mp4", type: "video/mp4", size: 100 };
  const limitedFile = {
    name: "episode (limited).mp4",
    type: "video/mp4",
    size: 80,
  };
  const pornhub = plain(
    hooks.normalizeDraft({
      fullFile,
      pornhubFile: limitedFile,
      thumbnailFile: { name: "cover.png", type: "image/png", size: 80 },
      title: "Episode 42",
      description: "Description",
      scheduledIso: "2026-08-28T15:00:00.000Z",
      targets: ["pornhub"],
      contentPreset: "Straight",
    }),
  );
  assert.equal(pornhub.valid, true);
  assert.deepEqual(pornhub.media.pornhub, {
    file: "episode (limited).mp4",
    source: "pornhub",
    thumbnail: "cover.png",
  });
  assert.equal(pornhub.contentPreset, "Straight");

  const pornhubOnly = plain(
    hooks.normalizeDraft({
      pornhubFile: limitedFile,
      title: "Episode limited",
      scheduledIso: "2026-08-28T15:00:00.000Z",
      targets: ["pornhub"],
      contentPreset: "Straight",
    }),
  );
  assert.equal(pornhubOnly.valid, true);
  assert.deepEqual(pornhubOnly.media.pornhub, {
    file: "episode (limited).mp4",
    source: "pornhub",
    thumbnail: null,
  });

  const pornhubFallback = plain(
    hooks.normalizeDraft({
      fullFile,
      title: "Episode 42",
      scheduledIso: "2026-08-28T15:00:00.000Z",
      targets: ["pornhub"],
      contentPreset: "Straight",
    }),
  );
  assert.deepEqual(pornhubFallback.media.pornhub, {
    file: "episode (full).mp4",
    source: "full",
    thumbnail: null,
  });
});

test("upload console rejects missing, empty, non-video, invalid-date, and unknown-target drafts", () => {
  const hooks = loadConsoleHooks();
  const result = plain(
    hooks.validateDraft({
      file: { name: "cover.jpg", type: "image/jpeg", size: 0 },
      title: " ",
      scheduledAt: "not-a-date",
      targets: ["unknown"],
    }),
  );

  assert.deepEqual(result, {
    valid: false,
    errors: [
      "Choose a non-empty video file.",
      "Enter a title.",
      "Choose a valid publication date and time.",
      "Choose OnlyFans, Fansly, ManyVids, Pornhub, or a combination.",
    ],
  });

  const disguisedImage = plain(
    hooks.validateDraft({
      file: { name: "not-a-video.mp4", type: "image/jpeg", size: 100 },
      title: "Episode 42",
      scheduledAt: "2026-08-28T15:00:00Z",
      targets: ["onlyfans"],
    }),
  );
  assert.equal(disguisedImage.valid, false);
  assert.equal(disguisedImage.errors[0], "Choose a non-empty video file.");
});

test("capability probe detects a composer without reading values or mutating the page", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <form data-testid="upload-composer">
        <input type="file" name="mediaUpload" accept="video/*" hidden>
        <textarea aria-label="Post caption">private creator text</textarea>
        <button type="button" aria-label="Schedule post">Calendar</button>
        <button type="submit">Post</button>
      </form>
    `);
    const before = await page
      .locator("form")
      .evaluate((node) => node.outerHTML);
    await page.addScriptTag({ path: probePath });
    const report = await page.evaluate(() =>
      CreatorUploadCapabilityProbe.inspect(document, {
        origin: "https://onlyfans.com",
        pathname: "/my/home",
      }),
    );

    assert.equal(report.status, "composer-detected");
    assert.equal(report.platform, "onlyfans");
    assert.equal(report.capabilities.file.state, "detected");
    assert.equal(report.capabilities.caption.state, "detected");
    assert.equal(report.capabilities.schedule.state, "detected");
    assert.equal(report.capabilities.commit.state, "detected");
    assert.doesNotMatch(JSON.stringify(report), /private creator text/);
    assert.equal(
      await page.locator("form").evaluate((node) => node.outerHTML),
      before,
    );
  } finally {
    await browser.close();
  }
});

test("capability probe reports login, incomplete, and ambiguous pages", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<form><input type="password"></form>`);
    await page.addScriptTag({ path: probePath });
    const login = await page.evaluate(() =>
      CreatorUploadCapabilityProbe.inspect(document, {
        origin: "https://fansly.com",
        pathname: "/login",
      }),
    );
    assert.equal(login.status, "login-required");
    assert.equal(login.platform, "fansly");

    await page.setContent(`<main><h1>Home</h1></main>`);
    const incomplete = await page.evaluate(() =>
      CreatorUploadCapabilityProbe.inspect(document, {
        origin: "https://onlyfans.com",
        pathname: "/my/home",
      }),
    );
    assert.equal(incomplete.status, "page-detected");

    const manyvids = await page.evaluate(() =>
      CreatorUploadCapabilityProbe.inspect(document, {
        origin: "https://www.manyvids.com",
        pathname: "/upload-video",
      }),
    );
    assert.equal(manyvids.platform, "manyvids");
    assert.equal(manyvids.status, "page-detected");

    await page.setContent(`
      <custom-dropdown data-key="orientation"><button class="customSelectTrigger">Orientation</button></custom-dropdown>
      <input name="tags">
      <input name="category">
      <input type="file" id="must-not-be-read">
      <button type="submit">Submit</button>
    `);
    const pornhub = await page.evaluate(() =>
      CreatorUploadCapabilityProbe.inspect(document, {
        origin: "https://pornhub.mainhub.com",
        pathname: "/upload/uploader",
      }),
    );
    assert.equal(pornhub.platform, "pornhub");
    assert.equal(pornhub.status, "metadata-ready");
    assert.deepEqual(Object.keys(pornhub.capabilities), [
      "orientation",
      "tags",
      "categories",
    ]);

    await page.setContent(`
      <input type="file" name="mediaUpload" accept="video/*" hidden>
      <textarea aria-label="Post caption"></textarea>
      <button type="submit">Post</button>
      <button type="submit">Post</button>
    `);
    const ambiguous = await page.evaluate(() =>
      CreatorUploadCapabilityProbe.inspect(document, {
        origin: "https://onlyfans.com",
        pathname: "/my/home",
      }),
    );
    assert.equal(ambiguous.status, "ambiguous");
    assert.equal(ambiguous.capabilities.commit.state, "ambiguous");
  } finally {
    await browser.close();
  }
});

test("capability probe rejects profile settings that merely resemble a composer", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <form id="profile-settings">
        <input type="file" name="avatar" accept="image/*" hidden>
        <textarea aria-label="Biography"></textarea>
        <button type="submit">Save</button>
      </form>
    `);
    await page.addScriptTag({ path: probePath });
    const report = await page.evaluate(() =>
      CreatorUploadCapabilityProbe.inspect(document, {
        origin: "https://onlyfans.com",
        pathname: "/my/settings/profile",
      }),
    );

    assert.equal(report.status, "page-detected");
    assert.equal(report.capabilities.file.state, "missing");
    assert.equal(report.capabilities.caption.state, "missing");
    assert.equal(report.capabilities.commit.state, "missing");

    await page.setContent(`
      <form aria-label="Post composer">
        <fieldset disabled>
          <input type="file" name="videoUpload" accept="video/*">
          <textarea aria-label="Post caption"></textarea>
          <button type="submit">Publish</button>
        </fieldset>
      </form>
    `);
    const disabled = await page.evaluate(() =>
      CreatorUploadCapabilityProbe.inspect(document, {
        origin: "https://onlyfans.com",
        pathname: "/my/home",
      }),
    );
    assert.equal(disabled.status, "page-detected");
    assert.equal(disabled.capabilities.file.state, "missing");
    assert.equal(disabled.capabilities.caption.state, "missing");
    assert.equal(disabled.capabilities.commit.state, "missing");

    await page.setContent(`
      <main>
        <form aria-label="Video upload">
          <input type="file" name="videoUpload" accept="video/*">
        </form>
        <form aria-label="Text post">
          <textarea aria-label="Post caption"></textarea>
          <button type="submit">Publish</button>
        </form>
      </main>
    `);
    const separated = await page.evaluate(() =>
      CreatorUploadCapabilityProbe.inspect(document, {
        origin: "https://onlyfans.com",
        pathname: "/my/home",
      }),
    );
    assert.equal(
      separated.status,
      "page-detected",
      "Controls belonging to separate forms are not one upload composer.",
    );

    await page.setContent(`
      <main>
        <section>
          <input type="file" name="videoUpload" accept="video/*">
        </section>
        <section>
          <textarea aria-label="Post caption"></textarea>
          <button type="submit">Publish</button>
        </section>
      </main>
    `);
    const formlessGroups = await page.evaluate(() =>
      CreatorUploadCapabilityProbe.inspect(document, {
        origin: "https://onlyfans.com",
        pathname: "/my/home",
      }),
    );
    assert.equal(
      formlessGroups.status,
      "page-detected",
      "Unrelated formless sibling groups are not one upload composer.",
    );

    for (const wrapper of ['aria-disabled="true"', 'style="opacity: 0"']) {
      await page.setContent(`
        <form ${wrapper} aria-label="Post composer">
          <input type="file" name="videoUpload" accept="video/*">
          <textarea aria-label="Post caption"></textarea>
          <button type="submit">Publish</button>
        </form>
      `);
      const unavailable = await page.evaluate(() =>
        CreatorUploadCapabilityProbe.inspect(document, {
          origin: "https://onlyfans.com",
          pathname: "/my/home",
        }),
      );
      assert.equal(
        unavailable.status,
        "page-detected",
        `Unavailable ancestor must suppress composer detection: ${wrapper}`,
      );
    }
  } finally {
    await browser.close();
  }
});
