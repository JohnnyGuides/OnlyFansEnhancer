"use strict";

// Renders the shared X teaser dashboard with synthetic overview data in the
// desktop workspace's Twitter view and in the extension's dashboard page.
// Set OFENHANCER_TEASER_SCREENSHOTS to a folder to also save review images.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test, before, after } = require("node:test");
const { chromium } = require("../support/browser.cjs");
const {
  workspaceRoot,
  personalRoot,
  repositoryRoot,
} = require("../support/paths.cjs");

const NOW = "2026-10-01T12:00:00Z";
const DAY = 86400000;

function iso(daysAgo, hour = 18) {
  const date = new Date(Date.parse(NOW) - daysAgo * DAY);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

function episode(category, series, number, used = 0, ready = 0, extra = {}) {
  const key = `${series.toLowerCase().replace(/\s+/g, "-")}-e${number}`;
  return {
    itemId: `item-${key}`,
    sourceKey: key,
    title: `${series} E${number}`,
    usedCount: used,
    failedCount: extra.failed || 0,
    readyClips: ready,
    postedClips: 0,
    goodClips: extra.good || 0,
    failedClips: extra.failed || 0,
    category,
    series,
    episode: String(number),
  };
}

function metrics(views, likes, reposts, replies = 2, bookmarks = 3) {
  return {
    observedUtc: NOW,
    ageHours: 48,
    views,
    likes,
    reposts,
    replies,
    bookmarks,
  };
}

function usual(views, likes, reposts, engagementRate) {
  return { ageHours: 48, peers: 12, views, likes, reposts, engagementRate };
}

function post(statusId, daysAgo, itemKey, latest, typical, extra = {}) {
  return {
    statusId,
    postedUtc: iso(daysAgo),
    itemId: itemKey ? `item-${itemKey}` : null,
    sourceKey: itemKey,
    evidence: itemKey ? "sheet-link" : null,
    latest,
    usual: typical,
    verdict: extra.verdict
      ? {
          verdict: extra.verdict,
          engagementRate: 0.03,
          cohortMedian: 0.04,
          cohortSize: 12,
          sampleAgeHours: 168,
          decidedUtc: iso(daysAgo - 7),
        }
      : null,
    clipId: extra.clipId ?? null,
    posterUrl: `https://pbs.twimg.com/ext_tw_video_thumb/${statusId}/pu/img/poster.jpg`,
  };
}

function fixture() {
  const episodes = [
    episode("Games", "Series A", 1, 2, 1),
    episode("Games", "Series A", 2, 1, 0),
    episode("Games", "Series A", 3, 0, 2),
    episode("Games", "Series A", 4),
    episode("Games", "Series A", 5),
    episode("Games", "Series A", 6, 0, 0, { failed: 1 }),
    episode("Games", "Series C", 1, 1, 0),
    episode("Games", "Series C", 2, 0, 1),
    episode("Games", "Series C", 3),
    episode("Games", "Series C", 4),
    episode("Dolls", "Series B", 1, 1, 0, { good: 1 }),
    episode("Dolls", "Series B", 2, 1, 0),
    episode("Dolls", "Series B", 3, 1, 1),
    episode("Dolls", "Series B", 4),
    episode("Dolls", "Series B", 5, 0, 1),
    episode("Reviews", "Series D", 1, 1, 0),
    episode("Reviews", "Series D", 2),
    episode("Reviews", "Series G", 1, 0, 1),
    episode("Reviews", "Series G", 2),
    episode("Specials", "Series E", 1, 1, 0),
    episode("Specials", "Series H", 1, 0, 1),
    episode("Toys", "Series F", 1, 0, 1),
    episode("Toys", "Series F", 2),
    episode("Toys", "Series F", 3, 1, 0),
  ];
  const base = usual(1000, 100, 10, 0.11);
  const posts = [
    // Strip thresholds: views exactly +15% (good), likes 81 vs 100 (grey),
    // reposts exactly -20% (bad), rate 0.1 vs 0.08 (good).
    post(
      "6001",
      6,
      "series-a-e1",
      metrics(1150, 81, 8, 1, 25),
      usual(1000, 100, 10, 0.08),
    ),
    post("6002", 5, "series-b-e2", metrics(700, 114, 12, 2, 2), base),
    post("6003", 4, "series-d-e1", metrics(1420, 160, 15, 6, 9), base),
    post("6004", 3, "series-a-e2", metrics(980, 96, 9, 3, 2), base),
    post("6005", 2, "series-e-e1", metrics(640, 52, 4, 1, 1), base),
    post("6006", 1, "series-b-e3", metrics(1210, 140, 14, 4, 6), base),
    post("5001", 12, "series-c-e1", metrics(900, 60, 6), base, {
      verdict: "failed",
      clipId: 71,
    }),
    post("5002", 20, "series-b-e1", metrics(2100, 190, 22), base, {
      verdict: "good",
      clipId: 72,
    }),
    post("5003", 45, "series-f-e3", metrics(1300, 120, 12), base, {
      verdict: "good",
    }),
    post("5004", 75, "series-a-e1", metrics(400, 20, 1), base, {
      verdict: "failed",
      clipId: 73,
    }),
    post("5005", 120, "series-a-e6", metrics(800, 70, 7), null, {
      verdict: "failed",
    }),
  ].sort((left, right) => right.postedUtc.localeCompare(left.postedUtc));
  return {
    active: true,
    overview: {
      episodes,
      posts,
      unpairedClips: [],
      unboundPosts: [],
      recentMoves: [
        {
          moveId: 41,
          clipId: 71,
          fromRelPath: "Done\\series-c-e1__t1.mp4",
          toRelPath: "Done\\Failed\\series-c-e1__t1.mp4",
          reason: "verdict-failed",
          outcome: "moved",
          occurredUtc: iso(5),
          undoneUtc: null,
        },
        {
          moveId: 40,
          clipId: 72,
          fromRelPath: "Done\\series-b-e1__t1.mp4",
          toRelPath: "Done\\Good\\series-b-e1__t1.mp4",
          reason: "verdict-good",
          outcome: "moved",
          occurredUtc: iso(13),
          undoneUtc: iso(12),
        },
      ],
      truncated: false,
    },
  };
}

const initialSlots = [
  {
    date: "2026-10-04",
    episodeKey: "series-a-e1",
    itemId: "item-series-a-e1",
    clipId: 73,
    reEdit: true,
    createdUtc: NOW,
  },
];

function posterSvg(id) {
  const hue = (Number(id) * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},55%,42%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},45%,18%)"/></linearGradient></defs>
<rect width="320" height="320" fill="url(#g)"/><circle cx="230" cy="96" r="54" fill="rgba(255,255,255,0.18)"/>
<text x="24" y="292" font-family="sans-serif" font-size="34" fill="rgba(255,255,255,0.85)">Teaser ${id}</text></svg>`;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

let server;
let port;
let browser;

before(async () => {
  server = http.createServer((request, response) => {
    const requested = new URL(request.url, "http://127.0.0.1").pathname;
    // /desktop/* serves the shared workspace; /extension/* the built personal extension.
    const [, area, ...rest] = requested.split("/");
    const root =
      area === "desktop"
        ? workspaceRoot
        : area === "extension"
          ? personalRoot
          : null;
    const file = root ? path.resolve(root, rest.join("/")) : "";
    if (
      !root ||
      !file.startsWith(`${root}${path.sep}`) ||
      !fs.existsSync(file)
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": contentType(file) });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function openDashboard({ area = "desktop", viewport, slots } = {}) {
  const context = await browser.newContext({
    viewport: viewport || { width: 1200, height: 900 },
    timezoneId: "UTC",
    locale: "en-GB",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("https://pbs.twimg.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: posterSvg(new URL(route.request().url()).pathname.split("/")[2]),
    }),
  );
  await page.exposeFunction("__teaserFixture", () => ({
    overview: fixture(),
    slots: slots || initialSlots,
  }));
  await page.addInitScript(() => {
    const calls = [];
    let data;
    globalThis.__teaserCalls = calls;
    globalThis.__OFENHANCER_TEST_HOST__ = async (operation, payload) => {
      data ??= await globalThis.__teaserFixture();
      calls.push({ operation, payload });
      switch (operation) {
        case "getStatus":
          return {
            productVersion: "0.20.91",
            protocolVersion: 1,
            capabilities: [
              "desktop-shell",
              "local-file-attach",
              "native-bridge",
              "chrome-readiness",
            ],
          };
        case "getChromeReadiness":
          return {
            state: "connected",
            chromeFound: true,
            prepared: true,
            message: "Chrome is connected.",
          };
        case "getTeaserOverview":
          return data.overview;
        case "getTeaserPlan":
          return { slots: data.slots };
        case "setTeaserPlanSlot": {
          data.slots = data.slots
            .filter((slot) => slot.date !== payload.date)
            .concat({
              date: payload.date,
              episodeKey: payload.episodeKey,
              itemId: `item-${payload.episodeKey}`,
              clipId: payload.clipId ?? null,
              reEdit: Boolean(payload.clipId),
              createdUtc: "2026-10-01T12:00:00Z",
            })
            .sort((left, right) => left.date.localeCompare(right.date));
          return data.slots.find((slot) => slot.date === payload.date);
        }
        case "clearTeaserPlanSlot":
          data.slots = data.slots.filter((slot) => slot.date !== payload.date);
          return { date: payload.date, cleared: true };
        case "undoTeaserClipMove":
          return {
            moveId: 42,
            clipId: 71,
            fromRelPath: "Done\\Failed\\series-c-e1__t1.mp4",
            toRelPath: "Done\\series-c-e1__t1.mp4",
            reason: "undo",
            outcome: "moved",
          };
        default:
          return {};
      }
    };
  });
  if (area === "desktop") {
    await page.goto(`http://127.0.0.1:${port}/desktop/index.html`);
    await page.getByRole("button", { name: "Twitter", exact: true }).click();
  } else {
    await page.goto(`http://127.0.0.1:${port}/extension/teaser-dashboard.html`);
  }
  await page.locator('#teaserDashboard[data-state="ready"]').waitFor();
  return { page, context, errors };
}

const calls = (page, operation) =>
  page.evaluate(
    (name) =>
      globalThis.__teaserCalls.filter((call) => call.operation === name),
    operation,
  );

async function screenshot(page, name, fullPage = false) {
  const folder = process.env.OFENHANCER_TEASER_SCREENSHOTS;
  if (!folder) return;
  fs.mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(folder, name), fullPage });
}

test("timeline strip orders 7 square days and colours numbers by the usual", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    const past = page.locator('[data-row="past"] > li');
    const next = page.locator('[data-row="next"] > li');
    assert.deepEqual(
      await past.evaluateAll((items) => items.map((item) => item.dataset.date)),
      [
        "2026-09-25",
        "2026-09-26",
        "2026-09-27",
        "2026-09-28",
        "2026-09-29",
        "2026-09-30",
        "2026-10-01",
      ],
    );
    assert.deepEqual(
      await next.evaluateAll((items) => items.map((item) => item.dataset.date)),
      [
        "2026-10-02",
        "2026-10-03",
        "2026-10-04",
        "2026-10-05",
        "2026-10-06",
        "2026-10-07",
        "2026-10-08",
      ],
    );
    const sizes = await page.locator(".xt-row .xt-tile").evaluateAll((tiles) =>
      tiles.map((tile) => {
        const box = tile.getBoundingClientRect();
        return [Math.round(box.width), Math.round(box.height)];
      }),
    );
    assert.equal(sizes.length, 14);
    for (const [width, height] of sizes) {
      assert.equal(width, height, "tiles are square");
      assert.equal(width, sizes[0][0], "tiles share one size");
    }
    const lefts = await past.evaluateAll((items) =>
      items.map((item) => Math.round(item.getBoundingClientRect().left)),
    );
    const gaps = lefts.slice(1).map((left, index) => left - lefts[index]);
    assert.ok(
      gaps.every((gap) => Math.abs(gap - gaps[0]) <= 1),
      "uniform spacing",
    );

    // Posted days carry the X poster; today with no post is a plannable slot.
    assert.equal(
      await past.nth(0).locator("img.xt-poster").getAttribute("src"),
      "https://pbs.twimg.com/ext_tw_video_thumb/6001/pu/img/poster.jpg",
    );
    assert.equal(
      await past.nth(6).locator(".xt-tile").getAttribute("data-kind"),
      "empty",
    );
    const tones = await past
      .nth(0)
      .locator(".xt-number")
      .evaluateAll((cells) =>
        cells.map((cell) => [cell.dataset.metric, cell.dataset.tone]),
      );
    assert.deepEqual(tones, [
      ["views", "good"],
      ["likes", "neutral"],
      ["reposts", "bad"],
      ["rate", "good"],
    ]);
    const colours = await past
      .nth(0)
      .locator(".xt-number")
      .evaluateAll((cells) =>
        cells.map((cell) => getComputedStyle(cell).color),
      );
    assert.notEqual(colours[0], colours[1]);
    assert.notEqual(colours[1], colours[2]);
    assert.match(
      await past
        .nth(0)
        .locator('[data-metric="views"]')
        .getAttribute("aria-label"),
      /views, above usual$/,
    );
    assert.equal(await page.locator(".xt-key .xt-key-item").count(), 4);
    assert.equal(await page.locator(".xt-key").count(), 1, "key shown once");

    // Row 2: planned re-edit is faded with scissors, empty days show +.
    const planned = next.nth(2).locator(".xt-tile");
    assert.equal(await planned.getAttribute("data-kind"), "planned");
    assert.equal(await planned.getAttribute("data-re-edit"), "true");
    assert.equal(await planned.locator(".xt-scissors svg").count(), 1);
    assert.ok(
      Number(await planned.evaluate((node) => getComputedStyle(node).opacity)) <
        1,
    );
    assert.equal(await next.nth(0).locator(".xt-plus").textContent(), "+");
    assert.equal(
      await next
        .nth(0)
        .locator(".xt-tile")
        .evaluate((node) => getComputedStyle(node).userSelect),
      "none",
    );

    await past.nth(0).locator(".xt-tile").click();
    assert.match(
      await page.locator(".xt-detail").textContent(),
      /^Series A E1 · posted .* · 1\.2K views/i,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "no horizontal overflow",
    );
    await screenshot(page, "M3-dashboard.png", true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("coverage flow groups every episode by category and season with visible states", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    const squares = page.locator(".xt-flow .xt-episode");
    assert.equal(await squares.count(), fixture().overview.episodes.length);
    assert.deepEqual(
      await page
        .locator('.xt-cell[data-category-start="true"] .xt-category-name')
        .allTextContents(),
      ["Dolls", "Games", "Reviews", "Specials", "Toys"],
    );
    const order = await page
      .locator(".xt-cell")
      .evaluateAll((cells) =>
        cells.map((cell) => [
          cell.dataset.category,
          cell.querySelector("button").getAttribute("aria-label"),
          cell.dataset.seasonEnd === "true",
        ]),
      );
    // Seasons stay together and each season's last square breaks the line.
    const gamesSeasons = order
      .filter(([category]) => category === "Games")
      .map(([, label, end]) => [label.split(" · ")[1], end]);
    assert.deepEqual(
      gamesSeasons.map(([season]) => season),
      [...Array(6).fill("Series A"), ...Array(4).fill("Series C")],
    );
    assert.deepEqual(
      gamesSeasons.filter(([, end]) => end).length,
      2,
      "two Games seasons end",
    );
    const lineTops = await page
      .locator(".xt-cell")
      .evaluateAll(
        (cells) => new Set(cells.map((cell) => cell.offsetTop)).size,
      );
    assert.ok(lineTops >= 1);

    const state = (key) =>
      page.locator(`.xt-episode[data-item-id="item-${key}"]`);
    assert.equal(await state("series-a-e1").getAttribute("data-cover"), "used");
    assert.equal(
      await state("series-a-e1").locator(".xt-used").textContent(),
      "2",
    );
    assert.equal(
      await state("series-a-e1").locator(".xt-ready").textContent(),
      "1",
    );
    assert.equal(
      await state("series-a-e3").getAttribute("data-cover"),
      "ready",
    );
    assert.equal(
      await state("series-a-e4").getAttribute("data-cover"),
      "empty",
    );
    const used = await state("series-a-e1").evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    const ready = await state("series-a-e3").evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.backgroundColor, style.borderTopColor];
    });
    const empty = await state("series-a-e4").evaluate((node) => {
      const style = getComputedStyle(node);
      return [
        style.borderTopWidth,
        style.borderTopColor,
        style.opacity,
        style.visibility,
      ];
    });
    assert.notEqual(used, "rgba(0, 0, 0, 0)", "used squares are filled");
    assert.equal(
      ready[0],
      "rgba(0, 0, 0, 0)",
      "ready-only squares have no fill",
    );
    assert.equal(
      ready[1],
      "rgb(242, 184, 75)",
      "ready-only squares are amber outlined",
    );
    assert.ok(parseFloat(empty[0]) >= 1, "empty squares keep a border");
    assert.notEqual(empty[1], "rgba(0, 0, 0, 0)");
    assert.equal(empty[2], "1");
    assert.equal(empty[3], "visible");

    await state("series-a-e1").click();
    assert.equal(
      await page.locator(".xt-detail").textContent(),
      "Games · Series A · E1 · 2 used · 1 ready",
    );
    await state("series-a-e6").focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await page.locator(".xt-detail").textContent(),
      "Games · Series A · E6 · 0 used · 0 ready · 1 failed",
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("picking mode hides recent seasons, dims busy categories and persists picks", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    await page
      .locator('[data-row="past"] > li')
      .nth(6)
      .locator(".xt-tile")
      .click();
    assert.match(
      await page.locator(".xt-picking-text").textContent(),
      /Picking for/,
    );
    const pick = (key) =>
      page
        .locator(`.xt-episode[data-item-id="item-${key}"]`)
        .getAttribute("data-pick");
    // Posted in the last 7 days: Series A, B, D, E; planned on 4 Oct: Series A.
    assert.equal(await pick("series-a-e3"), "hidden");
    assert.equal(await pick("series-b-e5"), "hidden");
    assert.equal(await pick("series-d-e2"), "hidden");
    // Games (3) and Dolls (2) have two or more recent/planned posts.
    assert.equal(await pick("series-c-e2"), "dimmed");
    // Fresh episodes with a ready clip in quiet categories are recommended.
    assert.equal(await pick("series-f-e1"), "recommended");
    assert.equal(await pick("series-g-e1"), "recommended");
    assert.equal(await pick("series-h-e1"), "recommended");
    assert.equal(await pick("series-f-e2"), "neutral");
    const hidden = page.locator('.xt-episode[data-item-id="item-series-a-e3"]');
    assert.ok(
      Number(await hidden.evaluate((node) => getComputedStyle(node).opacity)) <
        0.2,
    );
    assert.equal(await hidden.getAttribute("aria-disabled"), "true");
    await hidden.click({ force: true });
    assert.equal(
      (await calls(page, "setTeaserPlanSlot")).length,
      0,
      "hidden squares cannot be picked",
    );

    await page.locator('.xt-episode[data-item-id="item-series-f-e1"]').click();
    await page
      .locator('.xt-tile[data-date="2026-10-01"][data-kind="planned"]')
      .waitFor();
    assert.deepEqual(
      (await calls(page, "setTeaserPlanSlot")).map((call) => call.payload),
      [{ date: "2026-10-01", episodeKey: "series-f-e1" }],
    );
    // The pick advances to the next empty day and updates the similarity rules.
    assert.equal(
      await page
        .locator(".xt-tile[data-target='true']")
        .getAttribute("data-date"),
      "2026-10-02",
    );
    assert.equal(await pick("series-f-e2"), "hidden");
    await screenshot(page, "M3-picking.png");

    await page.locator('.xt-episode[data-item-id="item-series-h-e1"]').click();
    await page
      .locator(".xt-tile[data-target='true'][data-date='2026-10-03']")
      .waitFor();
    assert.equal(await pick("series-g-e1"), "recommended");
    assert.equal(await pick("series-h-e1"), "hidden");
    assert.equal(
      (await calls(page, "getTeaserPlan")).length >= 3,
      true,
      "plan reloaded after each pick",
    );

    await page.getByRole("button", { name: "Done" }).click();
    assert.equal(await page.locator(".xt-picking").isHidden(), true);
    assert.equal(await page.locator(".xt-episode[data-pick]").count(), 0);
    assert.equal(
      await page
        .locator('[data-row="next"] .xt-tile[data-date="2026-10-02"]')
        .getAttribute("data-kind"),
      "planned",
    );

    // Re-entering a planned day can clear it.
    await page.locator('.xt-tile[data-date="2026-10-02"]').click();
    await page.getByRole("button", { name: "Clear day" }).click();
    await page
      .locator('.xt-tile[data-date="2026-10-02"][data-kind="empty"]')
      .waitFor();
    assert.deepEqual(
      (await calls(page, "clearTeaserPlanSlot")).map((call) => call.payload),
      [{ date: "2026-10-02" }],
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".xt-picking").isHidden(), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("history toggles its period, sorts worst first, plans remakes and undoes verdict moves", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    const items = page.locator(".xt-history-item");
    const ids = () =>
      items.evaluateAll((nodes) => nodes.map((node) => node.dataset.statusId));
    assert.equal(
      await page
        .locator('.xt-segment[data-period="30"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.deepEqual(await ids(), [
      "6006",
      "6005",
      "6004",
      "6003",
      "6002",
      "6001",
      "5001",
      "5002",
    ]);
    await page.locator('.xt-segment[data-period="90"]').click();
    assert.deepEqual((await ids()).slice(-2), ["5003", "5004"]);
    await page.locator('.xt-segment[data-period="all"]').click();
    assert.equal(await items.count(), 11);
    assert.equal(
      await page
        .locator('.xt-segment[data-period="all"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    await page.getByRole("button", { name: "Worst first" }).click();
    // 5004 has the lowest rate against its usual; 5005 has no usual and sorts last.
    assert.equal((await ids())[0], "5004");
    assert.equal((await ids()).at(-1), "5005");
    assert.equal(
      await page
        .locator('.xt-history-item[data-status-id="5001"] .xt-verdict')
        .textContent(),
      "Failed",
    );
    assert.equal(
      await page
        .locator('.xt-history-item[data-status-id="5002"] .xt-verdict')
        .textContent(),
      "Good",
    );
    assert.equal(
      await page
        .locator('.xt-history-item[data-status-id="5001"] .xt-number')
        .count(),
      4,
    );

    // Only the not-undone verdict move is offered.
    const undo = page.getByRole("button", { name: /^Undo move of/ });
    assert.equal(await undo.count(), 1);
    await page.locator(".xt-history").scrollIntoViewIfNeeded();
    await screenshot(page, "M3-history.png");
    await undo.click();
    await page.locator(".xt-status", { hasText: "Clip moved back." }).waitFor();
    assert.deepEqual(
      (await calls(page, "undoTeaserClipMove")).map((call) => call.payload),
      [{ moveId: 41 }],
    );

    await page
      .locator('.xt-history-item[data-status-id="5001"]')
      .getByRole("button", { name: /re-edit/ })
      .click();
    await page
      .locator('.xt-tile[data-date="2026-10-01"][data-re-edit="true"]')
      .waitFor();
    assert.deepEqual(
      (await calls(page, "setTeaserPlanSlot")).map((call) => call.payload),
      [{ date: "2026-10-01", episodeKey: "series-c-e1", clipId: 71 }],
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("the extension page mounts the same dashboard and the console links to it", async () => {
  const { page, context, errors } = await openDashboard({ area: "extension" });
  try {
    assert.equal(
      await page.locator(".xt-flow .xt-episode").count(),
      fixture().overview.episodes.length,
    );
    assert.equal(await page.locator('[data-row="past"] > li').count(), 7);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  const consoleHtml = fs.readFileSync(
    path.join(personalRoot, "upload-console.html"),
    "utf8",
  );
  assert.match(
    consoleHtml,
    /<a[^>]+href="teaser-dashboard\.html"[^>]*data-chrome-only/,
  );
  const background = fs.readFileSync(
    path.join(repositoryRoot, "extensions/personal/background.js"),
    "utf8",
  );
  const routed = background.slice(
    background.indexOf("async function routeOFEnhancerAppRequest"),
  );
  for (const operation of [
    "getTeaserOverview",
    "undoTeaserClipMove",
    "getTeaserPlan",
    "setTeaserPlanSlot",
    "clearTeaserPlanSlot",
  ])
    assert.ok(
      routed
        .slice(0, routed.indexOf("sendDesktopRequest(operation"))
        .includes(`"${operation}"`),
      operation,
    );
});

test("a failed load offers a retry", async () => {
  const context = await browser.newContext({
    viewport: { width: 900, height: 700 },
  });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      let fail = true;
      globalThis.__OFENHANCER_TEST_HOST__ = async (operation) => {
        if (operation === "getTeaserOverview" && fail) {
          fail = false;
          throw new Error("desktop-unavailable");
        }
        if (operation === "getTeaserOverview")
          return {
            active: false,
            overview: { episodes: [], posts: [], recentMoves: [] },
          };
        if (operation === "getTeaserPlan") return { slots: [] };
        if (operation === "getStatus")
          return {
            productVersion: "0.20.91",
            protocolVersion: 1,
            capabilities: [],
          };
        return {};
      };
    });
    await page.goto(`http://127.0.0.1:${port}/extension/teaser-dashboard.html`);
    await page.locator('#teaserDashboard[data-state="error"]').waitFor();
    assert.match(
      await page.locator(".xt-status").textContent(),
      /desktop-unavailable/,
    );
    await page.getByRole("button", { name: "Try again" }).click();
    await page.locator('#teaserDashboard[data-state="ready"]').waitFor();
    assert.match(
      await page.locator(".xt-status").textContent(),
      /teaser folder/,
    );
    assert.match(
      await page.locator(".xt-empty").first().textContent(),
      /No catalogue episodes/,
    );
  } finally {
    await context.close();
  }
});
