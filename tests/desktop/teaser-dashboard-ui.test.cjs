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
    thumbnailAssetId: extra.thumb ?? null,
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
    episode("Games", "Series A", 1, 2, 1, { thumb: "asset-a1" }),
    episode("Games", "Series A", 2, 1, 0),
    episode("Games", "Series A", 3, 0, 2),
    episode("Games", "Series A", 4, 0, 0, { thumb: "asset-a4" }),
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

async function openDashboard({
  area = "desktop",
  viewport,
  slots,
  overviewExtra = {},
  activity = null,
} = {}) {
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
  await page.route("https://thumbs.ofenhancer.local/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: posterSvg(route.request().url().length),
    }),
  );
  await page.exposeFunction("__teaserFixture", () => {
    const overview = fixture();
    Object.assign(overview.overview, overviewExtra);
    return { overview, slots: slots || initialSlots, activity };
  });
  await page.addInitScript(() => {
    const calls = [];
    let data;
    globalThis.__teaserCalls = calls;
    globalThis.__setScanActivity = async (activity) => {
      data ??= await globalThis.__teaserFixture();
      data.activity = activity;
    };
    globalThis.__OFENHANCER_TEST_HOST__ = async (operation, payload) => {
      data ??= await globalThis.__teaserFixture();
      calls.push({ operation, payload });
      switch (operation) {
        case "getStatus":
          return {
            productVersion: "0.20.93",
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
        case "getXScanActivity":
          return { activity: data.activity };
        case "requestXScan":
          return {
            requested: true,
            started: false,
            requestedUtc: "2026-10-01T12:00:00Z",
          };
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
    assert.equal(await page.locator(".xt-key").count(), 0, "no metric key");

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
      /^Series A E1 · posted .* · 1\.15K views/i,
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

test("catalogue gallery groups seasons under titles, badges teasers and filters by need", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    const tiles = page.locator(".xt-cards .xt-episode");
    assert.equal(await tiles.count(), fixture().overview.episodes.length);
    // Category, then season order; each season's title sits over its first tile.
    assert.deepEqual(
      await page
        .locator('.xt-card[data-season-start="true"] .xt-season-name')
        .allTextContents(),
      [
        "Series B",
        "Series A",
        "Series C",
        "Series D",
        "Series G",
        "Series E",
        "Series H",
        "Series F",
      ],
    );
    assert.equal(
      await page.locator('.xt-card[data-season-end="true"]').count(),
      8,
      "every season ends with a capped line",
    );
    // A long title wraps to at most two lines inside its season, resting on
    // the season line instead of running past it.
    const long = await page
      .locator('.xt-card[data-season-start="true"] .xt-season-name')
      .last()
      .evaluate((label) => {
        label.textContent =
          "Fallen Angel Marielle - Ascend The Futanari Tower Of Doom";
        const box = label.getBoundingClientRect();
        const card = label.parentElement.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(label).lineHeight);
        return {
          lines: Math.round(box.height / lineHeight),
          clipped: label.scrollHeight > label.clientHeight,
          inside: box.right <= card.right + 0.5,
          abovePicture:
            box.bottom <=
            label.parentElement
              .querySelector(".xt-episode")
              .getBoundingClientRect().top,
        };
      });
    assert.deepEqual(long, {
      lines: 2,
      clipped: true,
      inside: true,
      abovePicture: true,
    });
    const games = await page
      .locator('.xt-card[data-category="Games"]')
      .evaluateAll((cards) =>
        cards.map((card) => [
          card.dataset.season.split("\u0000")[1],
          card.dataset.seasonEnd === "true",
        ]),
      );
    assert.deepEqual(
      games.map(([season]) => season),
      [...Array(6).fill("Series A"), ...Array(4).fill("Series C")],
    );
    assert.deepEqual(
      games.filter(([, end]) => end).map(([season]) => season),
      ["Series A", "Series C"],
    );
    // The category line bridges gaps inside a season but never past its end.
    await page.locator(".xt-card[data-join]").first().waitFor();
    const joins = await page
      .locator(".xt-card")
      .evaluateAll((cards) =>
        cards.map((card) => [card.dataset.seasonEnd, card.dataset.join]),
      );
    assert.ok(joins.some(([, join]) => join === "true"));
    assert.ok(
      joins.every(([end, join]) => end !== "true" || join === "false"),
      "season ends do not join",
    );

    const tile = (key) =>
      page.locator(`.xt-episode[data-item-id="item-${key}"]`);
    const badges = (key) =>
      tile(key)
        .locator(".xt-badge")
        .evaluateAll((nodes) =>
          nodes.map((node) => [node.dataset.tone, node.textContent]),
        );
    assert.equal(await tile("series-a-e1").getAttribute("data-cover"), "used");
    assert.deepEqual(await badges("series-a-e1"), [
      ["posted", "✓2"],
      ["ready", "1"],
    ]);
    assert.equal(await tile("series-a-e3").getAttribute("data-cover"), "ready");
    assert.deepEqual(await badges("series-a-e3"), [["ready", "2"]]);
    assert.equal(await tile("series-a-e4").getAttribute("data-cover"), "empty");
    assert.deepEqual(await badges("series-a-e4"), []);
    assert.deepEqual(await badges("series-a-e6"), [["failed", "✕1"]]);
    assert.match(
      await tile("series-a-e1").getAttribute("title"),
      /^Series A E1 · Series A E1 · 2 posted · 1 ready · best \d+%$/,
    );
    assert.match(
      await tile("series-a-e4").getAttribute("title"),
      /no teasers$/,
    );

    // Thumbnails come from the desktop thumbnail host; untouched videos are grey.
    const thumb = (key) => tile(key).locator("img.xt-thumb-image");
    assert.equal(
      await thumb("series-a-e1").getAttribute("src"),
      "https://thumbs.ofenhancer.local/asset-a1",
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll("img.xt-thumb-image")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    );
    const look = (key) =>
      thumb(key).evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.filter, style.opacity];
      });
    assert.deepEqual(await look("series-a-e1"), ["none", "1"]);
    assert.deepEqual(await look("series-a-e4"), ["grayscale(1)", "0.35"]);
    assert.equal(await tile("series-a-e2").locator("img").count(), 0);
    assert.equal(
      await tile("series-a-e3").evaluate(
        (node) => getComputedStyle(node).borderTopColor,
      ),
      "rgb(242, 184, 75)",
      "ready-only tiles are amber outlined",
    );

    await tile("series-a-e1").click();
    assert.equal(
      await page.locator(".xt-detail").textContent(),
      "Games · Series A · E1 · 2 used · 1 ready",
    );
    await tile("series-a-e6").focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await page.locator(".xt-detail").textContent(),
      "Games · Series A · E6 · 0 used · 0 ready · 1 failed",
    );

    const filters = page.locator(".xt-flow-bar .xt-segment");
    assert.deepEqual(await filters.allTextContents(), [
      "Needs teasers 9",
      "Ready to post 8",
      "Posted 9",
      "All 24",
    ]);
    assert.equal(
      await page
        .locator('.xt-segment[data-coverage="all"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    const shown = () =>
      tiles.evaluateAll((nodes) => nodes.map((node) => node.dataset.cover));
    await page.locator('.xt-segment[data-coverage="needs"]').click();
    assert.deepEqual(await shown(), Array(9).fill("empty"));
    assert.equal(
      await page
        .locator('.xt-segment[data-coverage="needs"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    // A filtered season keeps its title over its first remaining tile.
    assert.equal(
      await page
        .locator('.xt-card[data-season-start="true"]')
        .filter({ has: tile("series-a-e4") })
        .locator(".xt-season-name")
        .textContent(),
      "Series A",
    );
    await page.locator('.xt-segment[data-coverage="ready"]').click();
    assert.equal(await tiles.count(), 8);
    await page.locator('.xt-segment[data-coverage="posted"]').click();
    assert.deepEqual(await shown(), Array(9).fill("used"));
    await screenshot(page, "M5-catalogue.png", true);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "no horizontal overflow",
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("history calendar lines up with the week row and trend cards compare periods", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    const cards = page.locator(".xt-trend-card");
    assert.deepEqual(
      await cards.evaluateAll((nodes) =>
        nodes.map((node) => [
          node.querySelector(".xt-trend-label").textContent,
          node.querySelector(".xt-trend-count").textContent,
        ]),
      ),
      [
        ["Overall", "11 teasers"],
        ["3 days", "3 teasers"],
        ["7 days", "6 teasers"],
        ["14 days", "7 teasers"],
        ["30 days", "8 teasers"],
      ],
    );
    const metricsOf = (card) =>
      card
        .locator(".xt-trend-metric")
        .evaluateAll((nodes) =>
          nodes.map((node) => [
            node.querySelector(".xt-trend-value").textContent,
            node.querySelector(".xt-trend-unit").textContent,
            node.querySelector(".xt-trend")?.dataset.tone ?? null,
            node.querySelector(".xt-trend")?.textContent ?? null,
            node.querySelector(".xt-trend")?.title ?? null,
          ]),
        );
    // The overall card is the plain average teaser, with nothing to beat.
    assert.deepEqual(await metricsOf(cards.nth(0)), [
      ["1.05K", "views", null, null, null],
      ["11%", "engagement", null, null, null],
    ]);
    // 3 days (6004-6006) against their usual at the same age: within the
    // grey band, so neither green nor red.
    assert.deepEqual(await metricsOf(cards.nth(1)), [
      [
        "943",
        "viewsusual 1K",
        "neutral",
        "\u22126%",
        "Usual views at the same age: 1K",
      ],
      [
        "11%",
        "engagementusual 11%",
        "neutral",
        "+0.3 pts",
        "Usual engagement at the same age: 11%",
      ],
    ]);
    // 7 days engages 19% more than usual: green, in points.
    assert.deepEqual((await metricsOf(cards.nth(2)))[1].slice(2, 4), [
      "good",
      "+2.1 pts",
    ]);

    // Days before the 7-day row, oldest first, in two-week rows ending the
    // day before the row; the first post (3 Jun) falls in the oldest row.
    const days = page.locator(".xt-past-list > li > .xt-past-tile");
    const dates = await page
      .locator(".xt-past-list > li")
      .evaluateAll((nodes) => nodes.length);
    assert.equal(dates, 9 * 14);
    assert.match(
      await days.first().getAttribute("aria-label"),
      /^Fri,? 22 May: no teaser$/,
    );
    assert.equal(
      await days.last().getAttribute("aria-label"),
      "Thu, 24 Sept: no teaser",
    );
    assert.equal(
      await page.locator(".xt-past-range").last().textContent(),
      "5 earlier teasers since Wed, 3 Jun",
    );
    const posted = page.locator(".xt-past-tile[data-key]");
    assert.deepEqual(
      await posted.evaluateAll((nodes) =>
        nodes.map((node) => node.dataset.key),
      ),
      ["past-5005", "past-5004", "past-5003", "past-5002", "past-5001"],
    );
    const tile = page.locator('.xt-past-tile[data-key="past-5002"]');
    assert.equal(await tile.getAttribute("data-verdict"), "good");
    // The date sits above the picture, never on it; the month starts each
    // two-week row and marks the 1st.
    assert.equal(await tile.locator(".xt-past-date").count(), 0);
    assert.equal(
      await tile.locator("xpath=preceding-sibling::span").textContent(),
      "11 Sept",
    );
    assert.equal(
      await page
        .locator(".xt-past-list > li > .xt-past-date[data-month]")
        .first()
        .textContent(),
      "1 Jun",
    );
    assert.equal(await tile.locator(".xt-past-views").textContent(), "2.1K");
    assert.equal(
      await tile.locator(".xt-past-views").getAttribute("data-tone"),
      "good",
    );
    assert.equal(await tile.locator(".xt-past-rate").textContent(), "10%");
    assert.equal(
      await tile.locator("img.xt-past-poster").getAttribute("src"),
      "https://pbs.twimg.com/ext_tw_video_thumb/5002/pu/img/poster.jpg",
    );
    // Empty days stay as faint squares the same size as posted days.
    const [emptyBox, postedBox] = await Promise.all([
      days.first().boundingBox(),
      tile.boundingBox(),
    ]);
    assert.equal(Math.round(emptyBox.width), Math.round(postedBox.width));
    assert.equal(Math.round(emptyBox.height), Math.round(postedBox.height));
    assert.equal(
      await days
        .first()
        .evaluate((node) => getComputedStyle(node).borderTopStyle),
      "dashed",
    );
    // Each history row is two weeks wide with the same weekday columns as the 7-day row.
    const [firstPast, firstHistory] = await Promise.all([
      page.locator('[data-row="past"] > li').first().boundingBox(),
      page.locator(".xt-past-list > li").nth(14).boundingBox(),
    ]);
    assert.ok(Math.abs(firstPast.x - firstHistory.x) <= 1, "columns line up");

    await tile.click();
    assert.match(
      await page.locator(".xt-detail").textContent(),
      /^Series B E1 · posted .* · 2\.1K views/i,
    );
    await page.locator(".xt-past").scrollIntoViewIfNeeded();
    await screenshot(page, "M5-history.png");
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

test("X scheduled posts outline their day in row 2 and Scan now asks for a scan", async () => {
  const scheduled = [
    {
      scheduledId: "7001",
      scheduledUtc: "2026-10-03T18:30:00.000Z",
      text: "benign scheduled teaser",
      mediaSummary: "1 video",
      observedUtc: NOW,
    },
    // Same day as the planned re-edit slot: the plan's title labels it.
    {
      scheduledId: "7002",
      scheduledUtc: "2026-10-04T09:15:00.000Z",
      text: "another benign post",
      mediaSummary: "",
      observedUtc: NOW,
    },
  ];
  for (const area of ["desktop", "extension"]) {
    const { page, context, errors } = await openDashboard({
      area,
      overviewExtra: {
        scheduled,
        scan: {
          requestedUtc: null,
          last: {
            trigger: "routine",
            mode: "routine",
            startedUtc: "2026-10-01T11:00:00.000Z",
            finishedUtc: "2026-10-01T11:01:00.000Z",
            outcome: "complete",
            detail: "",
            pages: 3,
            rows: 41,
            scheduled: 2,
          },
        },
      },
    });
    try {
      const day3 = page.locator(
        '[data-row="next"] [data-key="day-2026-10-03"]',
      );
      assert.equal(await day3.getAttribute("data-kind"), "scheduled");
      assert.match(
        await day3.getAttribute("aria-label"),
        /scheduled on X at 18:30, benign scheduled teaser/,
      );
      assert.equal(await day3.locator(".xt-tile-time").textContent(), "18:30");
      assert.equal(
        await day3.locator(".xt-tile-label").textContent(),
        "benign scheduled teaser",
      );
      const day4 = page.locator(
        '[data-row="next"] [data-key="day-2026-10-04"]',
      );
      assert.equal(await day4.getAttribute("data-kind"), "scheduled");
      assert.equal(
        await day4.locator(".xt-tile-label").textContent(),
        "Series A E1",
      );
      assert.equal(await day4.getAttribute("data-re-edit"), "true");
      const outlined = await day3.evaluate((node) => {
        const style = getComputedStyle(node);
        return `${style.borderTopWidth} ${style.borderTopStyle}`;
      });
      assert.equal(outlined, "2px solid");
      const empty = page.locator(
        '[data-row="next"] [data-key="day-2026-10-05"]',
      );
      assert.equal(await empty.getAttribute("data-kind"), "empty");

      const scan = page.locator(".xt-scan-text");
      assert.equal(
        await scan.textContent(),
        "Last scan 1 Oct, 11:01 · 41 posts · 2 scheduled",
      );
      const pending = page.locator(".xt-scan-state");
      assert.equal(await pending.isVisible(), false);
      // Text, muted pending state and a right-aligned button share one row.
      const button = page.getByRole("button", { name: "Scan now" });
      await button.click();
      await page.waitForFunction(
        () =>
          document.querySelector(".xt-scan-state")?.textContent ===
          "Scan requested…",
      );
      assert.equal(await pending.isVisible(), true);
      const [textBox, pendingBox, buttonBox, barBox] = await Promise.all([
        scan.boundingBox(),
        pending.boundingBox(),
        button.boundingBox(),
        page.locator(".xt-scan").boundingBox(),
      ]);
      assert.ok(
        Math.abs(
          textBox.y + textBox.height / 2 - (buttonBox.y + buttonBox.height / 2),
        ) < 4,
      );
      assert.ok(
        Math.abs(
          pendingBox.y +
            pendingBox.height / 2 -
            (buttonBox.y + buttonBox.height / 2),
        ) < 4,
      );
      assert.ok(
        Math.abs(buttonBox.x + buttonBox.width - (barBox.x + barBox.width)) < 2,
      );
      assert.equal(
        await pending.evaluate((node) => getComputedStyle(node).color),
        "rgb(143, 153, 168)",
      );
      assert.deepEqual(
        (await calls(page, "requestXScan")).map((call) => call.payload),
        [{}],
      );
      if (area === "desktop") await screenshot(page, "M4-scheduled-scan.png");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  const background = fs.readFileSync(
    path.join(repositoryRoot, "extensions/personal/background.js"),
    "utf8",
  );
  assert.match(
    background.slice(
      background.indexOf("async function routeOFEnhancerAppRequest"),
    ),
    /if \(operation === "requestXScan"\) return xScanner\(\)\.requestNow\(\);/,
  );
});

test("a failed scan is shown plainly", async () => {
  const { page, context, errors } = await openDashboard({
    overviewExtra: {
      scheduled: [],
      scan: {
        requestedUtc: null,
        last: {
          trigger: "checkpoint",
          mode: "routine",
          startedUtc: "2026-10-01T11:00:00.000Z",
          finishedUtc: "2026-10-01T11:00:20.000Z",
          outcome: "error",
          detail: "http-429",
          pages: 2,
          rows: 20,
          scheduled: null,
          backoffUntilUtc: "2026-10-01T17:00:20.000Z",
        },
      },
    },
  });
  try {
    const scan = page.locator(".xt-scan-text");
    assert.equal(
      await scan.textContent(),
      "Last scan 1 Oct, 11:00 · X error (http-429) · automatic scans paused until 1 Oct, 17:00",
    );
    assert.equal(await page.locator(".xt-scan-state").isVisible(), false);
    assert.equal(await scan.getAttribute("data-tone"), "warn");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
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
            productVersion: "0.20.93",
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

function livePost(statusId, views, mediaType = "video") {
  return {
    statusId,
    postedUtc: "2026-09-30T18:00:00.000Z",
    kind: "post",
    text: `Benign scan preview ${statusId}`,
    mediaType,
    posterUrl: mediaType
      ? `https://pbs.twimg.com/ext_tw_video_thumb/${statusId}/pu/img/poster.jpg`
      : "",
    metrics: {
      views,
      likes: 1204,
      reposts: 37,
      replies: 12,
      quotes: 0,
      bookmarks: 88,
    },
  };
}

function liveActivity(extra = {}) {
  const posts = [
    livePost("9101", 12345),
    livePost("9102", 980),
    livePost("9103", 45210),
    livePost("9104", 3, ""),
  ];
  return {
    version: 1,
    runId: "0123456789abcdef0123456789abcdef",
    running: true,
    trigger: "startup",
    mode: "routine",
    phase: "waiting",
    startedUtc: "2026-10-01T11:59:10.000Z",
    updatedUtc: "2026-10-01T11:59:58.000Z",
    pages: 2,
    rows: 24,
    outcome: "",
    posts,
    events: [
      {
        at: "2026-10-01T11:59:10.000Z",
        kind: "step",
        text: "Scan started because OFEnhancer was started — reading the last 35 days (up to 10 pages)",
      },
      {
        at: "2026-10-01T11:59:11.000Z",
        kind: "step",
        text: "Opening an inactive background tab on x.com/Owner_Handle/with_replies using your existing Chrome sign-in",
      },
      {
        at: "2026-10-01T11:59:55.000Z",
        kind: "step",
        text: "Page 2: read 4 posts, 4 new in this scan, newest from Sep 30, 6:00 PM",
      },
      ...posts.map((post, index) => ({
        at: `2026-10-01T11:59:5${5 + Math.min(index, 2)}.000Z`,
        kind: "post",
        text: `Page 2: Video post ${post.statusId} — ${post.metrics.views.toLocaleString("en-US")} views`,
        post,
      })),
      {
        at: "2026-10-01T11:59:58.000Z",
        kind: "step",
        text: "Pausing 3.1 s before page 3 so requests stay gentle",
      },
    ],
    ...extra,
  };
}

test("the live scan panel shows each step and the post being read with exact counts", async () => {
  const { page, context, errors } = await openDashboard({
    activity: liveActivity(),
  });
  try {
    const panel = page.locator(".xt-live");
    await panel.waitFor();
    assert.equal(await panel.getAttribute("data-running"), "true");
    assert.equal(await panel.getAttribute("data-tone"), "live");
    await page
      .locator(".xt-scan-text", { hasText: "Scan running now" })
      .waitFor();
    assert.equal(
      await panel.locator(".xt-live-title strong").textContent(),
      "Scanning your X profile",
    );
    assert.equal(
      await panel.locator(".xt-live-phase").textContent(),
      "Pausing before page 3 · 50 s so far",
    );
    assert.deepEqual(await panel.locator(".xt-live-chip").allTextContents(), [
      "2 pages",
      "24 posts",
      "Startup",
    ]);
    // The newest post read is shown large, with X's exact numbers.
    const now = panel.locator(".xt-live-now");
    assert.match(
      await now.locator(".xt-live-kind").textContent(),
      /^Text post/,
    );
    assert.equal(
      await panel
        .locator('[data-key="live-9104"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    await panel.locator('[data-key="live-9101"]').click();
    assert.match(
      await now.locator(".xt-live-kind").textContent(),
      /^Video post/,
    );
    assert.deepEqual(await now.locator(".xt-live-count").allTextContents(), [
      "Views12,345",
      "Likes1,204",
      "Reposts37",
      "Replies12",
      "Bookmarks88",
      "Quotes0",
    ]);
    assert.equal(
      await now.locator(".xt-live-poster").getAttribute("src"),
      "https://pbs.twimg.com/ext_tw_video_thumb/9101/pu/img/poster.jpg",
    );
    assert.equal(
      await now.locator(".xt-live-link").getAttribute("href"),
      "https://x.com/i/status/9101",
    );
    assert.equal(await panel.locator(".xt-live-thumb").count(), 4);
    // Steps newest first, the post lines with their own thumbnail.
    const lines = panel.locator(".xt-live-line");
    assert.equal(await lines.count(), 8);
    assert.match(
      await lines.first().textContent(),
      /Pausing 3\.1 s before page 3 so requests stay gentle$/,
    );
    assert.equal(await panel.locator(".xt-live-line .xt-live-mini").count(), 4);
    await screenshot(page, "teaser-live-scan.png");
    await page.locator('[data-key="live-toggle"]').click();
    assert.equal(await panel.locator(".xt-live-log").count(), 0);
    assert.equal(
      await page
        .locator('[data-key="live-toggle"]')
        .getAttribute("aria-expanded"),
      "false",
    );

    // The scan finishes: the panel says so and the dashboard reloads its numbers.
    const before = (await calls(page, "getTeaserOverview")).length;
    await page.evaluate(
      (activity) => globalThis.__setScanActivity(activity),
      liveActivity({
        running: false,
        phase: "done",
        outcome: "complete",
        pages: 3,
        rows: 31,
        updatedUtc: "2026-10-01T12:00:00.000Z",
      }),
    );
    await page.locator('.xt-live[data-tone="good"]').waitFor({ timeout: 5000 });
    assert.equal(
      await panel.locator(".xt-live-title strong").textContent(),
      "Last background scan",
    );
    assert.match(
      await panel.locator(".xt-live-phase").textContent(),
      /^Finished · 1 Oct, 11:59, took 50 s$/,
    );
    await page.waitForFunction(
      (count) =>
        globalThis.__teaserCalls.filter(
          (call) => call.operation === "getTeaserOverview",
        ).length > count,
      before,
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a live log that stopped updating is never shown as a running scan", async () => {
  const { page, context, errors } = await openDashboard({
    area: "extension",
    activity: liveActivity({ updatedUtc: "2026-10-01T11:55:00.000Z" }),
  });
  try {
    const panel = page.locator(".xt-live");
    await panel.waitFor();
    assert.equal(await panel.getAttribute("data-running"), "false");
    assert.equal(await panel.getAttribute("data-tone"), "warn");
    assert.match(
      await panel.locator(".xt-live-phase").textContent(),
      /^Interrupted: Chrome stopped reporting/,
    );
    // Steps stay collapsed for a scan that is not running.
    assert.equal(await panel.locator(".xt-live-log").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("no live panel before the first scan", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    await page.waitForFunction(() =>
      globalThis.__teaserCalls.some(
        (call) => call.operation === "getXScanActivity",
      ),
    );
    assert.equal(await page.locator(".xt-live").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
