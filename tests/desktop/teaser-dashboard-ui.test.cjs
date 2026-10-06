"use strict";

// Renders the shared X teaser dashboard with synthetic overview data in the
// desktop workspace's Teasers view and in the extension's dashboard page.
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
    episode("Reviews", "Series G", 1, 0, 1, { thumb: "asset-g1" }),
    episode("Reviews", "Series G", 2),
    episode("Specials", "Series E", 1, 1, 0),
    episode("Specials", "Series H", 1, 0, 1, { thumb: "asset-h1" }),
    episode("Toys", "Series F", 1, 0, 1, { thumb: "asset-f1" }),
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
            productVersion: "0.20.104",
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
        case "getTeaserClips":
          return {
            clips: data.overview.overview.episodes.flatMap((entry) =>
              Array.from(
                { length: Math.max(0, Number(entry.readyClips) || 0) },
                (_, index) => ({
                  clipId: `${entry.sourceKey}-${index + 1}`,
                  episodeKey: entry.sourceKey,
                  name: `${entry.sourceKey}__t${index + 1}.mp4`,
                  size: 128,
                  sha256: "a".repeat(64),
                  lastModified: Date.parse("2026-10-01T12:00:00Z"),
                  state: "ready",
                }),
              ),
            ),
          };
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
    await page.getByRole("button", { name: "Teasers", exact: true }).click();
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

test("Reddit draft count leaves the daily Twitter card and plan intact", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    const day = page.locator('.xt-day[data-date="2026-10-04"]');
    const before = await day.locator(".xt-tile").getAttribute("data-kind");
    await page.evaluate(async () => {
      for (const subreddit of [
        "example_one",
        "example_two",
        "example_unchecked",
      ])
        await OFEnhancerTeaserDrafts.savePost({
          id: crypto.randomUUID(),
          date: "2026-10-04",
          subreddit,
          file: new File(["clip"], "preview.mp4", { type: "video/mp4" }),
          caption: "Community title",
          time: "18:00",
        });
      const disabled = (
        await OFEnhancerTeaserDrafts.listPosts("2026-10-04")
      ).find((post) => post.subreddit === "example_unchecked");
      await OFEnhancerTeaserDrafts.setPostEnabled(disabled.id, false);
    });
    await page.reload();
    await page.getByRole("button", { name: "Teasers", exact: true }).click();
    await page.locator('#teaserDashboard[data-state="ready"]').waitFor();
    assert.equal(
      await day.locator(".xt-tile").getAttribute("data-kind"),
      before,
    );
    assert.equal(await day.locator(".xt-tile").count(), 1);
    assert.equal(
      await day.locator(".xt-other-posts").textContent(),
      "Reddit · 2 drafts",
    );
    const tops = await page
      .locator('.xt-week-section[data-period="next"] .xt-tile')
      .evaluateAll((tiles) =>
        tiles.map((tile) => Math.round(tile.getBoundingClientRect().top)),
      );
    assert.equal(new Set(tops).size, 1, "extra drafts do not shift day cards");
    assert.equal((await calls(page, "setTeaserPlanSlot")).length, 0);
    await screenshot(page, "reddit-draft-calendar.png", true);
    if (process.env.OFENHANCER_TEASER_SCREENSHOTS)
      await page.locator(".xt-calendar").screenshot({
        path: path.join(
          process.env.OFENHANCER_TEASER_SCREENSHOTS,
          "daily-calendar.png",
        ),
      });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

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
    assert.equal(
      colours[1],
      "rgb(198, 210, 222)",
      "neutral metrics use a brighter foreground",
    );
    const metricStyles = await past
      .nth(0)
      .locator(".xt-number")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return {
            size: parseFloat(style.fontSize),
            weight: parseInt(style.fontWeight),
            fits: node.scrollWidth <= node.clientWidth,
          };
        }),
      );
    assert.ok(
      metricStyles.every(
        (style) => style.size >= 12 && style.weight >= 600 && style.fits,
      ),
      "week metrics are legible and fit their tile width",
    );
    const metricLayout = await past
      .nth(0)
      .locator(".xt-number")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return {
            x: box.x,
            y: box.y,
            icon: node.querySelector('svg[aria-hidden="true"]') !== null,
          };
        }),
      );
    assert.ok(metricLayout.every((metric) => metric.icon));
    assert.equal(metricLayout[0].y, metricLayout[1].y);
    assert.equal(metricLayout[2].y, metricLayout[3].y);
    assert.ok(metricLayout[2].y > metricLayout[0].y);
    assert.equal(metricLayout[0].x, metricLayout[2].x);
    assert.equal(metricLayout[1].x, metricLayout[3].x);
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
    const seasonAccents = await page
      .locator(".xt-card")
      .evaluateAll((cards) =>
        Object.fromEntries(
          cards.map((card) => [
            card.dataset.season,
            card.style.getPropertyValue("--xt-season"),
          ]),
        ),
      );
    assert.notEqual(
      seasonAccents["Games\u0000Series A"],
      seasonAccents["Games\u0000Series C"],
      "seasons within one category have distinct accents",
    );
    assert.ok(
      await page.locator(".xt-card").evaluateAll((cards) =>
        cards.every(
          (card) =>
            getComputedStyle(card, "::before").borderTopColor ===
            getComputedStyle(
              cards.find(
                (other) => other.dataset.season === card.dataset.season,
              ),
              "::before",
            ).borderTopColor,
        ),
      ),
      "season accents remain consistent across episode tiles and wrapped rows",
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
      "Games · Series A · E1 · 2 used · 1 ready Open episode folder",
    );
    await page
      .getByRole("button", { name: "Open episode folder", exact: true })
      .click();
    assert.deepEqual(
      (await calls(page, "openTeaserEpisodeFolder")).map(
        (call) => call.payload,
      ),
      [{ episodeKey: "series-a-e1" }],
    );
    await tile("series-a-e6").focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await page.locator(".xt-detail").textContent(),
      "Games · Series A · E6 · 0 used · 0 ready · 1 failed Open episode folder",
    );

    const filters = page.locator(".xt-flow-bar .xt-segment");
    await page.waitForFunction(
      () => document.querySelector(".xt-flow-bar").style.width,
    );
    const catalogueEdges = await page.evaluate(() => ({
      gallery: Math.max(
        ...[...document.querySelectorAll(".xt-card")].map(
          (node) => node.getBoundingClientRect().right,
        ),
      ),
      filters: Math.max(
        ...[...document.querySelectorAll(".xt-flow-bar .xt-segment")].map(
          (node) => node.getBoundingClientRect().right,
        ),
      ),
      header: document.querySelector(".xt-flow-bar").getBoundingClientRect()
        .right,
      sections: [
        ".twitter-heading",
        ".xt-trends-wrap",
        ".xt-past-scroll",
        ".xt-strip",
        "#teaserDashboard",
      ].map(
        (selector) =>
          document.querySelector(selector).getBoundingClientRect().right,
      ),
    }));
    assert.ok(
      catalogueEdges.filters <= catalogueEdges.gallery + 1,
      "filter pills stay within the gallery edge",
    );
    assert.ok(
      Math.abs(catalogueEdges.header - catalogueEdges.gallery) <= 1,
      "catalogue header aligns with full tile columns",
    );
    assert.ok(
      catalogueEdges.sections.every(
        (right) => Math.abs(right - catalogueEdges.gallery) <= 1,
      ),
      "title, summary, history and calendar share the catalogue's right edge",
    );
    for (const width of [1440, 1120, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(() => {
        const root = document.querySelector("#teaserDashboard");
        const parent = root.parentElement;
        const style = getComputedStyle(parent);
        const available =
          parent.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        return (
          Math.abs(
            root.getBoundingClientRect().width -
              (available >= 600
                ? Math.floor((available + 6) / 102) * 102 - 6
                : available),
          ) < 1
        );
      });
      const geometry = await page
        .locator(".xt-day .xt-tile")
        .first()
        .boundingBox();
      assert.ok(
        Math.abs(geometry.width - geometry.height) < 1,
        "calendar tiles remain square after container alignment and resizing",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
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
    assert.deepEqual(
      await page
        .locator(".xt-card")
        .evaluateAll((cards) =>
          cards.map((card) => [
            card.dataset.season,
            card.style.getPropertyValue("--xt-season"),
          ]),
        ),
      await page
        .locator(".xt-card")
        .evaluateAll(
          (cards, accents) =>
            cards.map((card) => [
              card.dataset.season,
              accents[card.dataset.season],
            ]),
          seasonAccents,
        ),
      "filtering preserves each season's accent",
    );
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

test("summary compares the same cohort and resists viral skew", async () => {
  const { page, context, errors } = await openDashboard({
    overviewExtra: {
      posts: [
        post(
          "8001",
          1,
          "series-a-e1",
          metrics(1000, 100, 10),
          usual(1001, 100, 10, 0.115),
        ),
        post("8002", 2, "series-a-e2", metrics(3000, 300, 30), null),
        post("8003", 10, "series-b-e1", metrics(100000, 10000, 1000), null),
      ],
    },
  });
  try {
    const compact = await page.evaluate(() => {
      const format = new Intl.NumberFormat(undefined, {
        notation: "compact",
        maximumSignificantDigits: 3,
      });
      return [1000, 3000, 104000 / 3].map((value) => format.format(value));
    });
    const overall = page
      .locator(".xt-trends tbody tr")
      .first()
      .locator("td")
      .nth(0);
    assert.equal(
      await overall.locator(".xt-trend-value").textContent(),
      compact[1],
    );
    assert.equal(
      await overall.locator(".xt-trend-average").textContent(),
      compact[2],
    );
    assert.equal(await overall.locator(".xt-trend").textContent(), "\u221291%");
    assert.equal(
      await overall.locator(".xt-trend").getAttribute("data-tone"),
      "bad",
    );
    assert.equal(
      await overall.locator(".xt-trend").getAttribute("title"),
      `Median views vs average ${compact[2]}`,
    );
    const recent = page
      .locator(".xt-trends tbody tr")
      .first()
      .locator("td")
      .nth(1);
    assert.equal(
      await recent.locator(".xt-trend-value").textContent(),
      compact[0],
      "headline uses the compared teaser, excluding the unpaired viral post",
    );
    assert.equal(
      await recent.locator(".xt-trend").textContent(),
      "0%",
      "rounded zero has no misleading sign",
    );
    assert.match(
      await recent.locator(".xt-trend").getAttribute("title"),
      /1 of 2 teasers compared/,
    );
    assert.equal(
      await page
        .locator(".xt-trend-column")
        .nth(1)
        .locator(".xt-trend-note")
        .count(),
      0,
    );
    assert.doesNotMatch(
      await page.locator(".xt-trends").textContent(),
      /\d+ of \d+ compared/,
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("young teasers omit comparison copy and preserve even medians", async () => {
  const { page, context, errors } = await openDashboard({
    overviewExtra: {
      posts: [
        post("8001", 1, "series-a-e1", metrics(100, 10, 1), null),
        post("8002", 2, "series-a-e2", metrics(300, 30, 3), null),
      ],
    },
  });
  try {
    const cells = page.locator(".xt-trends tbody tr").first().locator("td");
    assert.equal(
      await cells.nth(0).locator(".xt-trend-value").textContent(),
      "200",
    );
    assert.equal(
      await cells.nth(1).locator(".xt-trend-value").textContent(),
      "200",
    );
    assert.equal(
      await page
        .locator(".xt-trend-column")
        .nth(1)
        .locator(".xt-trend-note")
        .count(),
      0,
    );
    assert.doesNotMatch(
      await page.locator(".xt-trends").textContent(),
      /too new to compare/,
    );
    assert.equal(await cells.nth(1).locator(".xt-trend").count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "summary scrolls locally on narrow screens",
    );
    assert.equal(
      await page
        .locator(".xt-trends-wrap")
        .evaluate((node) => node.scrollWidth > node.clientWidth),
      true,
    );
    await screenshot(page, "M6-summary-narrow.png");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("page sections distinguish history, recent days, upcoming days and catalogue", async () => {
  const { page, context, errors } = await openDashboard({
    viewport: { width: 1280, height: 1100 },
  });
  try {
    assert.deepEqual(
      await page.locator(".xt-section-title, .xt-flow-title").allTextContents(),
      ["Catalogue"],
    );
    assert.deepEqual(
      await page
        .locator(".xt-history-region, .xt-week-section")
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label"))),
      ["History", "Last 7 days", "Next 7 days"],
      "regions remain named for accessibility",
    );
    const surfaces = await page
      .locator(
        ".xt-calendar, .xt-week-section[data-period='next'], .xt-history-region",
      )
      .evaluateAll((nodes) =>
        nodes.map((n) => getComputedStyle(n).backgroundColor),
      );
    assert.equal(
      new Set(surfaces).size,
      3,
      "history, posted days and upcoming days use distinct surfaces",
    );
    assert.ok(
      await page.locator(".xt-week-section").evaluateAll((nodes) =>
        nodes.every((node) => {
          const style = getComputedStyle(node);
          return (
            style.paddingTop === "8px" &&
            style.paddingBottom === "8px" &&
            style.paddingLeft === "8px"
          );
        }),
      ),
      "calendar padding stays compact",
    );
    assert.equal(
      await page
        .locator(
          '.xt-week-section[data-period="past"] .xt-tile[data-kind="posted"]',
        )
        .first()
        .evaluate((n) => getComputedStyle(n).borderTopStyle),
      "solid",
    );
    assert.equal(
      await page
        .locator(
          '.xt-week-section[data-period="next"] .xt-tile[data-kind="empty"]',
        )
        .first()
        .evaluate((n) => getComputedStyle(n).borderTopStyle),
      "dashed",
    );
    const regions = await page
      .locator(".xt-history-region, .xt-calendar, .xt-flow")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return {
            top: box.top,
            bottom: box.bottom,
            left: box.left,
            right: box.right,
          };
        }),
      );
    assert.ok(
      regions.every(
        (region) =>
          Math.abs(region.left - regions[0].left) < 1 &&
          Math.abs(region.right - regions[0].right) < 1,
      ),
      "page sections retain a shared content edge",
    );
    for (let index = 1; index < regions.length; index++)
      assert.ok(
        regions[index].top - regions[index - 1].bottom >= 19,
        "distinct sections have more breathing room than their internal elements",
      );
    assert.equal(
      await page
        .locator(".xt-trends-wrap")
        .getAttribute("data-comparison-style"),
      null,
      "comparison table retains the accepted design",
    );
    await screenshot(page, "page-section-hierarchy.png");
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await screenshot(page, "page-section-hierarchy-mobile.png");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("history calendar lines up with the week row and trend cards compare periods", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    // Compact suffixes vary with the browser's locale data (en-GB uses k).
    const [overallViews, usualViews, tileViews] = await page.evaluate(() => {
      const formatter = new Intl.NumberFormat(undefined, {
        notation: "compact",
        maximumSignificantDigits: 3,
      });
      return [1050, 1000, 2100].map((value) => formatter.format(value));
    });
    const cards = page.locator(".xt-trend-column");
    for (const header of await cards.all()) {
      const [label, count] = await Promise.all([
        header.locator(".xt-trend-label").boundingBox(),
        header.locator(".xt-trend-count").boundingBox(),
      ]);
      assert.ok(
        Math.abs(count.x - label.x - label.width - 8) < 1,
        "teaser count sits beside the period with a consistent compact gap",
      );
      assert.ok(
        Math.abs(count.y - label.y) < 4,
        "teaser count shares the heading line",
      );
    }
    assert.equal(
      await page.locator(".xt-trends thead th").first().textContent(),
      "",
    );
    assert.equal(
      await page
        .locator(".xt-trends thead th")
        .first()
        .getAttribute("aria-label"),
      "Metric",
    );
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
    const metricsOf = (column) =>
      page
        .locator(`.xt-trends tbody tr > td:nth-child(${column + 2})`)
        .evaluateAll((nodes) =>
          nodes.map((node) => [
            node.querySelector(".xt-trend-value").textContent,
            node.dataset.metric === "rate" ? "engagement" : node.dataset.metric,
            node.querySelector(".xt-trend")?.dataset.tone ?? null,
            node.querySelector(".xt-trend")?.textContent ?? null,
            node.querySelector(".xt-trend")?.title ?? null,
          ]),
        );
    // Overall leads with the median while retaining the mean as a caption.
    assert.deepEqual(await metricsOf(0), [
      [
        "980",
        "views",
        "neutral",
        "\u22127%",
        `Median views vs average ${overallViews}`,
      ],
      ["96", "likes", "neutral", "\u22124%", "Median likes vs average 100"],
      ["9", "reposts", "neutral", "\u221210%", "Median reposts vs average 10"],
      [
        "10%",
        "engagement",
        "neutral",
        "\u22120.7 pts",
        "Median engagement vs average 11%",
      ],
    ]);
    assert.equal(
      await page
        .locator('.xt-trend-metric[data-baseline="true"]')
        .first()
        .locator(".xt-trend-average")
        .textContent(),
      overallViews,
    );
    for (const cell of await page
      .locator('.xt-trend-metric[data-baseline="true"]')
      .all()) {
      assert.deepEqual(
        await cell
          .locator(".xt-trend-line > span")
          .evaluateAll((nodes) => nodes.map((node) => node.className)),
        ["xt-trend-value", "xt-trend-average", "xt-trend"],
      );
      const [value, average, delta] = await Promise.all([
        cell.locator(".xt-trend-value").boundingBox(),
        cell.locator(".xt-trend-average").boundingBox(),
        cell.locator(".xt-trend").boundingBox(),
      ]);
      assert.ok(
        average.x >= value.x + value.width &&
          delta.x >= average.x + average.width,
        "average pill follows the value, then the change",
      );
      assert.ok(
        Math.abs(value.y + value.height / 2 - average.y - average.height / 2) <=
          1,
        "average pill stays on the value's line",
      );
      assert.equal(
        await cell
          .locator(".xt-trend-average")
          .evaluate((node) => getComputedStyle(node).borderRadius),
        "999px",
      );
      assert.equal(average.height, 18, "average pills use a slim height");
      assert.match(
        await cell.locator(".xt-trend-average").getAttribute("aria-label"),
        /^Average /,
      );
      assert.equal(
        await cell.locator(".xt-trend-average").getAttribute("title"),
        await cell.locator(".xt-trend-average").getAttribute("aria-label"),
      );
    }
    const pillGeometry = await page
      .locator(".xt-trend-average")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return [rect.x, rect.width, rect.height];
        }),
      );
    assert.ok(
      pillGeometry.every((geometry) =>
        geometry.every(
          (value, index) => Math.abs(value - pillGeometry[0][index]) < 1,
        ),
      ),
      "average pills have uniform size and alignment",
    );
    for (const row of await page.locator(".xt-trends tbody tr").all()) {
      for (const cell of await row.locator("td").all()) {
        const delta = cell.locator(".xt-trend");
        if (!(await delta.count())) continue;
        const [cellBox, valueBox, deltaBox] = await Promise.all([
          cell.boundingBox(),
          cell.locator(".xt-trend-value").boundingBox(),
          delta.boundingBox(),
        ]);
        const overall = (await cell.getAttribute("data-baseline")) === "true";
        assert.ok(
          Math.abs(valueBox.x - cellBox.x - 14) < 1 &&
            Math.abs(deltaBox.x - valueBox.x - (overall ? 146 : 56)) < 1,
          "values and changes use compact, uniform tracks anchored left",
        );
        assert.equal(
          await delta.evaluate((node) => getComputedStyle(node).textAlign),
          "start",
          "change text starts at the same position regardless of its length",
        );
      }
    }
    // 3 days (6004-6006) against their usual at the same age: within the
    // grey band, so neither green nor red.
    assert.deepEqual(await metricsOf(1), [
      [
        "943",
        "views",
        "neutral",
        "\u22126%",
        `Usual views at the same age: ${usualViews} · 3 of 3 teasers compared`,
      ],
      [
        "96",
        "likes",
        "neutral",
        "\u22124%",
        "Usual likes at the same age: 100 · 3 of 3 teasers compared",
      ],
      [
        "9",
        "reposts",
        "neutral",
        "\u221210%",
        "Usual reposts at the same age: 10 · 3 of 3 teasers compared",
      ],
      [
        "11%",
        "engagement",
        "neutral",
        "+0.3 pts",
        "Usual engagement at the same age: 11% · 3 of 3 teasers compared",
      ],
    ]);
    // 7 days engages 19% more than usual: green, in points.
    assert.deepEqual((await metricsOf(2))[3].slice(2, 4), ["good", "+2.1 pts"]);
    assert.deepEqual(
      await page.locator('.xt-trends tbody th[scope="row"]').allTextContents(),
      ["Views", "Likes", "Reposts", "Engagement"],
    );
    assert.ok(
      await page.locator(".xt-trends th, .xt-trends td").evaluateAll((nodes) =>
        nodes.every((node) => {
          const style = getComputedStyle(node);
          return (
            parseFloat(style.borderTopWidth) === 0 &&
            parseFloat(style.borderBottomWidth) === 0
          );
        }),
      ),
      "summary has no horizontal dividers",
    );
    assert.ok(
      await page
        .locator(".xt-trends tr > * + *")
        .evaluateAll((nodes) =>
          nodes.every(
            (node) => getComputedStyle(node).borderInlineStartWidth === "1px",
          ),
        ),
      "vertical separators distinguish each comparison column",
    );
    assert.equal(
      await page
        .locator(".xt-trend-column")
        .nth(1)
        .evaluate((node) => getComputedStyle(node).backgroundColor),
      await page
        .locator(".xt-trends tbody td")
        .nth(1)
        .evaluate((node) => getComputedStyle(node).backgroundColor),
      "period headers share the metrics' background",
    );
    for (const row of await page.locator(".xt-trends tbody tr").all()) {
      const rowTops = await row
        .locator("td")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getBoundingClientRect().top),
        );
      assert.ok(
        Math.max(...rowTops) - Math.min(...rowTops) <= 1,
        "metric rows align across all periods",
      );
    }

    // Days before the 7-day row, oldest first, in two-week rows ending the
    // day before the row; the first post (3 Jun) falls in the oldest row.
    const days = page.locator(".xt-past-list > li > .xt-past-tile");
    assert.equal(
      await days.count(),
      14,
      "history starts with only the newest row",
    );
    const expand = page.getByRole("button", {
      name: "Expand history",
      exact: true,
    });
    assert.equal(await expand.getAttribute("aria-expanded"), "false");
    await expand.click();
    const menu = page.getByRole("group", { name: "Earlier history period" });
    assert.deepEqual(await menu.getByRole("button").allTextContents(), [
      "Last 30 days",
      "Last 90 days",
      "All",
    ]);
    assert.equal(
      await days.count(),
      23,
      "last 30 days excludes the main seven-day row",
    );
    assert.ok(
      await page
        .locator(".xt-past-scroll")
        .evaluate((node) =>
          node
            .getAnimations()
            .some((animation) =>
              animation.effect
                .getKeyframes()
                .every((frame) => typeof frame.height === "string"),
            ),
        ),
      "expansion animates the panel height",
    );
    await menu
      .getByRole("button", { name: "Last 90 days", exact: true })
      .click();
    assert.equal(await days.count(), 83);
    await menu.getByRole("button", { name: "All", exact: true }).click();
    await page.locator(".xt-past-scroll").evaluate(async (node) => {
      await Promise.all(
        node.getAnimations().map((animation) => animation.finished),
      );
    });
    await screenshot(page, "M5-expanded-history.png");
    assert.equal(
      await page
        .getByRole("button", { name: "Collapse history", exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    const dates = await page
      .locator(".xt-past-list > li")
      .evaluateAll((nodes) => nodes.length);
    assert.equal(dates, 9 * 14);
    assert.match(
      await days.first().getAttribute("aria-label"),
      /^Fri,? 22 May: no teaser$/,
    );
    assert.match(
      await days.last().getAttribute("aria-label"),
      /^Thu,? 24 Sept: no teaser$/,
    );
    assert.equal(
      await page.locator(".xt-past-head, .xt-past-range").count(),
      0,
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
    // Posted tiles have no visible dates; empty tiles retain the day and month.
    assert.equal(await posted.locator(".xt-past-date").count(), 0);
    assert.equal(await page.locator(".xt-past-day > .xt-past-date").count(), 0);
    assert.equal(
      await days.first().locator(".xt-past-date").textContent(),
      "22 May",
    );
    assert.equal(await tile.locator(".xt-past-views").textContent(), tileViews);
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
    // Each history row has seven larger tiles aligned with the 7-day row.
    const [firstPast, firstHistory] = await Promise.all([
      page.locator('[data-row="past"] > li').first().boundingBox(),
      page.locator(".xt-past-list > li").nth(14).boundingBox(),
    ]);
    assert.ok(
      Math.abs(
        (await page.locator(".xt-past-expand").boundingBox()).x +
          28 -
          firstHistory.x,
      ) <= 1,
      "history leaves a slim control on the left",
    );
    assert.ok(
      postedBox.width < firstPast.width,
      "history keeps the compact two-week layout",
    );
    assert.ok(
      Math.abs(postedBox.height - postedBox.width) < 1,
      "history tiles remain square",
    );
    await tile.click();
    assert.match(
      await page.locator(".xt-detail").textContent(),
      /^Series B E1 · posted .* · 2\.1K views/i,
    );
    await page
      .getByRole("button", { name: "Collapse history", exact: true })
      .click();
    await page.locator(".xt-past-scroll").evaluate(async (node) => {
      await Promise.all(
        node.getAnimations().map((animation) => animation.finished),
      );
    });
    assert.equal(await days.count(), 14);
    assert.equal(
      await page
        .locator(".xt-past-scroll")
        .evaluate(
          (node) =>
            node.scrollHeight === node.clientHeight &&
            getComputedStyle(node).overflowY === "visible",
        ),
      true,
      "collapsed history has no internal scrolling",
    );
    const visibleHistory = await page
      .locator(".xt-past-scroll")
      .evaluate((node) => {
        const viewport = node.getBoundingClientRect();
        const visible = [...node.querySelectorAll(".xt-past-tile")]
          .map((tile) => tile.getBoundingClientRect())
          .filter(
            (tile) => tile.bottom > viewport.top && tile.top < viewport.bottom,
          );
        return {
          height: viewport.height,
          count: visible.length,
          rows: new Set(visible.map((tile) => tile.top)).size,
          complete: visible.every(
            (tile) =>
              tile.top >= viewport.top && tile.bottom <= viewport.bottom,
          ),
        };
      });
    assert.ok(
      visibleHistory.height <= firstPast.width + 0.1,
      "the history row fits within the main tile height",
    );
    assert.equal(visibleHistory.count, 14, "exactly two weeks are visible");
    assert.equal(visibleHistory.rows, 1, "one weekly row is visible");
    assert.ok(visibleHistory.complete, "no partial older row appears");
    const comparison = await page.locator(".xt-trends-wrap").boundingBox();
    const history = await page.locator(".xt-past-scroll").boundingBox();
    assert.ok(
      history.y - comparison.y - comparison.height >= 20,
      "comparison and history have breathing room",
    );

    await page.locator(".xt-past").scrollIntoViewIfNeeded();
    await screenshot(page, "M5-history.png");
    for (const width of [900, 1400]) {
      await page.setViewportSize({ width, height: 900 });
      const sizes = await page.evaluate(() => ({
        history: document
          .querySelector(".xt-past-scroll")
          .getBoundingClientRect().height,
        main: document
          .querySelector('[data-row="past"] .xt-tile')
          .getBoundingClientRect().height,
        tile: (() => {
          const r = document
            .querySelector(".xt-past-tile")
            .getBoundingClientRect();
          return [r.width, r.height];
        })(),
      }));
      assert.ok(
        sizes.history <= sizes.main + 0.1,
        `history fits the main tile at ${width}px`,
      );
      assert.ok(
        Math.abs(sizes.tile[0] - sizes.tile[1]) < 1,
        `history stays square at ${width}px`,
      );
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("day-scoped teaser modal ranks ready clips without mutating the calendar plan", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    const day = page.locator('.xt-tile[data-date="2026-10-02"]');
    await day.click();
    const modal = page.locator(".xt-composer-dialog");
    await modal.waitFor();
    assert.match(await modal.getAttribute("aria-label"), /^Teaser for /);
    await page.waitForFunction(
      () =>
        document.querySelector(".xt-composer-status")?.textContent !==
        "Loading ready clips…",
    );
    await modal
      .getByRole("button", { name: "Choose a new teaser video" })
      .waitFor();
    const recommendations = modal.locator(
      ".xt-episode[data-recommendation-rank]",
    );
    await recommendations.first().waitFor();
    assert.deepEqual(
      await recommendations.evaluateAll((nodes) =>
        nodes.map((node) => [
          node.dataset.recommendationRank,
          node.dataset.episodeKey,
        ]),
      ),
      [
        ["1", "series-g-e1"],
        ["2", "series-h-e1"],
        ["3", "series-f-e1"],
      ],
    );
    assert.match(
      await recommendations.nth(0).getAttribute("title"),
      /No comparable history/,
    );
    assert.match(
      await recommendations.nth(1).getAttribute("title"),
      /No comparable history/,
    );
    assert.equal(
      await modal
        .locator('.xt-episode[data-episode-key="series-c-e2"]')
        .getAttribute("data-recommendation-rank"),
      null,
    );
    assert.ok(
      (await modal.locator(".xt-episode").count()) >
        (await recommendations.count()),
    );
    assert.equal(await page.locator(".xt-picker").count(), 0);
    const allCount = await modal.locator(".xt-card").count();
    assert.equal(
      await modal.locator(".xt-season-name").first().isVisible(),
      true,
    );
    assert.equal(
      await modal
        .locator(".xt-card")
        .first()
        .evaluate((card) => card.getBoundingClientRect().width),
      96,
    );
    await modal.evaluate((node) =>
      Promise.all(node.getAnimations().map((animation) => animation.finished)),
    );
    assert.ok(
      await modal.evaluate((node) => node.getBoundingClientRect().width <= 620),
    );
    await modal.locator('[data-coverage="needs"]').click();
    assert.ok((await modal.locator(".xt-card").count()) < allCount);
    assert.equal(await modal.locator(".xt-upload-choice").count(), 1);
    await modal.locator('[data-coverage="all"]').click();
    assert.equal(await modal.locator(".xt-card").count(), allCount);
    assert.equal((await calls(page, "setTeaserPlanSlot")).length, 0);
    assert.equal(await day.getAttribute("data-kind"), "empty");
    await screenshot(page, "M3-teaser-modal-desktop.png");
    assert.equal(
      await modal.evaluate(
        (node) => innerWidth - node.getBoundingClientRect().right,
      ),
      0,
    );
    assert.equal(
      await modal.evaluate((node) => node.getBoundingClientRect().height),
      await page.evaluate(() => innerHeight),
    );
    assert.ok(
      await modal
        .locator('.xt-episode[data-cover="empty"] .xt-thumb-image')
        .evaluateAll(
          (images) =>
            images.length > 0 &&
            images.every((image) => {
              const style = getComputedStyle(image);
              return style.filter === "none" && style.opacity === "1";
            }),
        ),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "M3-teaser-modal-phone.png");
    assert.ok(
      await modal.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth;
      }),
    );
    await page.setViewportSize({ width: 1365, height: 960 });
    await modal.getByRole("button", { name: "Close" }).click();
    await page.waitForFunction(
      () => !document.querySelector(".xt-composer-dialog"),
    );
    assert.equal(
      await day.evaluate((node) => node === document.activeElement),
      true,
    );
    const plannedDay = page.locator('.xt-tile[data-date="2026-10-04"]');
    await plannedDay.click();
    const planned = page.locator(".xt-composer-dialog");
    await planned
      .locator('.xt-clip-choice[data-episode-key="series-a-e1"]')
      .waitFor();
    assert.equal(
      await planned
        .locator(
          '.xt-clip-choice[data-episode-key]:not([data-episode-key="series-a-e1"])',
        )
        .count(),
      0,
    );
    await planned
      .getByRole("button", { name: "Open episode folder", exact: true })
      .click();
    assert.deepEqual(
      (await calls(page, "openTeaserEpisodeFolder")).map(
        (call) => call.payload,
      ),
      [{ episodeKey: "series-a-e1" }],
    );
    assert.equal((await calls(page, "setTeaserPlanSlot")).length, 0);
    await planned.getByRole("button", { name: "Close" }).click();
    await page.waitForFunction(
      () => !document.querySelector(".xt-composer-dialog"),
    );
    assert.equal(await day.getAttribute("data-kind"), "empty");
    assert.equal(
      await plannedDay.evaluate((node) => node === document.activeElement),
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("teaser modal traps and restores focus, cancels cleanly and fits desktop and phone viewports", async () => {
  for (const options of [{}, { viewport: { width: 390, height: 844 } }]) {
    const { page, context, errors } = await openDashboard(options);
    try {
      const day = page.locator('.xt-tile[data-date="2026-10-02"]');
      await day.click();
      const modal = page.locator(".xt-composer-dialog");
      await modal.waitFor();
      await modal.evaluate((node) =>
        Promise.all(
          node.getAnimations().map((animation) => animation.finished),
        ),
      );
      const dimensions = await modal.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const add = node.querySelector(".xt-clip-add").getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          width: box.width,
          viewport: innerWidth,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          addRight: add.right,
        };
      });
      assert.ok(
        dimensions.left >= 0 && dimensions.right <= dimensions.viewport,
      );
      assert.ok(dimensions.scrollWidth <= dimensions.clientWidth);
      assert.ok(dimensions.addRight <= dimensions.right);
      if (options.viewport) assert.ok(dimensions.width <= 390);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await modal.evaluate((node) => node.contains(document.activeElement)),
        true,
      );
      await screenshot(
        page,
        options.viewport
          ? "M3-teaser-modal-phone.png"
          : "M3-teaser-modal-focus.png",
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector(".xt-composer-dialog"),
      );
      assert.equal(
        await day.evaluate((node) => node === document.activeElement),
        true,
      );
      assert.equal((await calls(page, "setTeaserPlanSlot")).length, 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});

test("recommendations use age-matched history, resist viral outliers and fall back carefully", async () => {
  const candidates = [
    episode("Steady", "Zulu", 4, 0, 1),
    episode("Unknown", "Beta", 1, 0, 1),
    episode("Viral", "Alpha", 4, 0, 1),
    episode("Insufficient", "Sparse", 2, 0, 1),
    episode("Young", "Young", 4, 0, 1),
    episode("Fallback", "New", 1, 0, 1),
    episode("Fallback", "Weak", 4, 0, 1),
  ];
  const historyEpisodes = [];
  const history = [];
  const addHistory = (category, series, views, comparable = true) => {
    views.forEach((value, index) => {
      const entry = episode(category, series, index + 1, 1, 0);
      historyEpisodes.push(entry);
      history.push(
        post(
          `${series}-${index}`,
          12 + index,
          entry.sourceKey,
          metrics(value, value / 100, 0, 0, 0),
          comparable ? usual(1000, 10, 0, 0.01) : null,
        ),
      );
    });
  };
  addHistory("Steady", "Zulu", [2000, 2000, 2000]);
  addHistory("Viral", "Alpha", [500, 500, 1000000000]);
  addHistory("Insufficient", "Sparse", [1000000000]);
  addHistory("Young", "Young", [1000000000, 1000000000, 1000000000], false);
  addHistory("Fallback", "Old", [4000, 4000, 4000, 4000, 4000]);
  addHistory("Fallback", "Weak", [100, 100, 100]);
  const { page, context, errors } = await openDashboard({
    slots: [],
    overviewExtra: {
      episodes: [...candidates, ...historyEpisodes],
      posts: history,
    },
  });
  try {
    await page.locator('.xt-tile[data-date="2026-10-02"]').click();
    const suggestions = page.locator(
      ".xt-composer-dialog .xt-episode[data-recommendation-rank]",
    );
    await suggestions.first().waitFor();
    assert.deepEqual(
      await suggestions.evaluateAll((nodes) =>
        nodes.slice(0, 3).map((node) => node.dataset.episodeKey),
      ),
      ["new-e1", "zulu-e4", "sparse-e2"],
    );
    assert.match(
      await suggestions.nth(0).getAttribute("title"),
      /Category above usual/,
    );
    assert.match(
      await suggestions.nth(1).getAttribute("title"),
      /3 comparable posts/,
    );
    assert.match(
      await suggestions.nth(1).getAttribute("title"),
      /Series above usual/,
    );
    assert.match(
      await suggestions.nth(2).getAttribute("title"),
      /No comparable history/,
    );
    // Remove the insufficient/unknown candidates to reveal the weaker series.
    // Its own series evidence must take precedence over its stronger category.
    await page.keyboard.press("Escape");
    assert.equal((await calls(page, "setTeaserPlanSlot")).length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  const second = await openDashboard({
    slots: [],
    overviewExtra: {
      episodes: [
        ...candidates.filter((candidate) =>
          ["alpha-e4", "weak-e4", "young-e4"].includes(candidate.sourceKey),
        ),
        ...historyEpisodes,
      ],
      posts: history,
    },
  });
  try {
    await second.page.locator('.xt-tile[data-date="2026-10-02"]').click();
    await second.page
      .locator(".xt-composer-dialog .xt-episode[data-recommendation-rank]")
      .first()
      .waitFor();
    assert.deepEqual(
      await second.page
        .locator(".xt-composer-dialog .xt-episode[data-recommendation-rank]")
        .evaluateAll((nodes) =>
          nodes.slice(0, 3).map((node) => node.dataset.episodeKey),
        ),
      ["young-e4", "alpha-e4", "weak-e4"],
    );
    assert.match(
      await second.page
        .locator('.xt-composer-dialog [data-episode-key="weak-e4"]')
        .getAttribute("title"),
      /Series below usual/,
    );
    assert.deepEqual(second.errors, []);
  } finally {
    await second.context.close();
  }
  const third = await openDashboard({
    slots: [],
    overviewExtra: {
      episodes: [
        ...candidates.filter((candidate) =>
          ["zulu-e4", "new-e1", "sparse-e2"].includes(candidate.sourceKey),
        ),
        ...historyEpisodes,
      ],
      posts: history.map((entry) =>
        entry.sourceKey.startsWith("zulu-")
          ? {
              ...entry,
              latest: { ...entry.latest, likes: entry.latest.likes * 4 },
            }
          : entry,
      ),
    },
  });
  try {
    await third.page.locator('.xt-tile[data-date="2026-10-02"]').click();
    await third.page
      .locator(".xt-composer-dialog .xt-episode[data-recommendation-rank]")
      .first()
      .waitFor();
    assert.deepEqual(
      await third.page
        .locator(".xt-composer-dialog .xt-episode[data-recommendation-rank]")
        .evaluateAll((nodes) =>
          nodes.slice(0, 3).map((node) => node.dataset.episodeKey),
        ),
      ["zulu-e4", "new-e1", "sparse-e2"],
      "stronger engagement changes the ranking even with unchanged view counts",
    );
    assert.deepEqual(third.errors, []);
  } finally {
    await third.context.close();
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
    assert.equal(await page.locator("h1").textContent(), "Teasers");
    assert.equal(await page.title(), "Teasers · OFEnhancer");
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
  assert.match(consoleHtml, /href="teaser-dashboard\.html"[^>]*>Teasers<\/a/s);
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

test("refresh cleans up layout observers through empty and failed results", async () => {
  const { page, context, errors } = await openDashboard();
  try {
    await page.evaluate(async () => {
      const container = document.createElement("div");
      container.style.width = "1000px";
      const root = document.createElement("div");
      container.append(root);
      document.body.append(container);
      let response = {
        overview: {
          episodes: [
            {
              itemId: "test-item",
              sourceKey: "test",
              title: "Test",
              series: "Test",
              category: "Games",
              readyClips: 0,
              usedCount: 0,
            },
          ],
          posts: [],
          recentMoves: [],
        },
      };
      let fail = false;
      const dashboard = globalThis.OFEnhancerTeaserDashboard.mount(root, {
        request: async (operation) => {
          if (fail) throw new Error("offline");
          return operation === "getTeaserOverview" ? response : { slots: [] };
        },
      });
      await dashboard.load();
      response = { overview: { episodes: [], posts: [], recentMoves: [] } };
      await dashboard.load();
      container.style.width = "800px";
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      if (root.style.width !== "708px")
        throw new Error("Empty catalogue did not resize");
      fail = true;
      await dashboard.load();
      container.style.width = "700px";
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      if (root.dataset.state !== "error")
        throw new Error("Expected load error");
      container.remove();
    });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
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
        "1 Oct, 11:01 · 41 posts · 2 scheduled",
      );
      const pending = page.locator(".xt-scan-state");
      assert.equal(await pending.isVisible(), false);
      // Scan, status and request feedback share one line.
      const button = page.getByRole("button", { name: "Scan", exact: true });
      assert.equal(
        await page
          .locator(".twitter-heading")
          .getByRole("button", { name: "Scan", exact: true })
          .count(),
        1,
        "scan action belongs to the title header",
      );
      await button.click();
      await page.waitForFunction(
        () =>
          document.querySelector(".xt-scan-state")?.textContent ===
          "Scan requested…",
      );
      assert.equal(await pending.isVisible(), true);
      const [textBox, pendingBox, buttonBox, headingBox, titleBox] =
        await Promise.all([
          scan.boundingBox(),
          pending.boundingBox(),
          button.boundingBox(),
          page.locator(".twitter-heading").boundingBox(),
          page.locator(".twitter-heading h1").boundingBox(),
        ]);
      assert.ok(
        Math.abs(
          titleBox.y +
            titleBox.height / 2 -
            (buttonBox.y + buttonBox.height / 2),
        ) < 1,
        "Scan is vertically aligned with the title",
      );
      assert.ok(
        Math.abs(
          textBox.y + textBox.height / 2 - buttonBox.y - buttonBox.height / 2,
        ) < 1 &&
          Math.abs(
            pendingBox.y +
              pendingBox.height / 2 -
              (buttonBox.y + buttonBox.height / 2),
          ) < 1 &&
          Math.abs(pendingBox.x - textBox.x - textBox.width - 16) < 1 &&
          Math.abs(buttonBox.x - pendingBox.x - pendingBox.width - 16) < 1,
        "status, pending feedback and Scan stay inline",
      );
      assert.ok(
        Math.abs(
          buttonBox.x + buttonBox.width - (headingBox.x + headingBox.width),
        ) < 2,
        "Scan aligns with the dashboard's right edge",
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
      "1 Oct, 11:00 · X error (http-429) · automatic scans paused until 1 Oct, 17:00",
    );
    assert.equal(await page.locator(".xt-scan-state").isVisible(), false);
    assert.equal(await scan.getAttribute("data-tone"), "warn");
    await page.getByRole("button", { name: "Scan", exact: true }).click();
    await page.locator(".xt-scan-state").getByText("Scan requested…").waitFor();
    for (const width of [1200, 800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = await Promise.all(
        [
          ".xt-scan-text",
          ".xt-scan-state",
          '.xt-scan [data-key="scan-now"]',
        ].map((selector) => page.locator(selector).boundingBox()),
      );
      const centres = boxes.map((box) => box.y + box.height / 2);
      assert.ok(
        Math.max(...centres) - Math.min(...centres) < 1,
        `scan error, request feedback and button stay inline at ${width}px`,
      );
      assert.ok(
        boxes.every((box) => box.x >= 0 && box.x + box.width <= width),
        `scan row stays within ${width}px`,
      );
      if (width > 600) {
        const title = await page.locator(".twitter-heading h1").boundingBox();
        assert.ok(boxes[0].x >= title.x + title.width + 15);
      }
      await screenshot(page, `scan-request-error-${width}.png`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("an interrupted scan uses concise status copy", async () => {
  const { page, context, errors } = await openDashboard({
    overviewExtra: {
      scan: {
        last: {
          startedUtc: "2026-10-01T11:00:00.000Z",
          outcome: "user-took-over",
        },
      },
    },
  });
  try {
    assert.equal(
      await page.locator(".xt-scan-text").textContent(),
      "1 Oct, 11:00 · stopped",
    );
    assert.equal(
      await page.locator(".xt-scan-text").getAttribute("title"),
      "Scan stopped because you opened the scan tab.",
    );
    assert.equal(
      await page.locator(".xt-scan-text").getAttribute("data-tone"),
      null,
    );
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
            productVersion: "0.20.104",
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

function liveActivity(extra = {}) {
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
    expected: 45,
    outcome: "",
    posts: [],
    events: [
      {
        at: "2026-10-01T11:59:58.000Z",
        kind: "step",
        text: "Pausing 3.1 s before page 3 so requests stay gentle",
      },
    ],
    ...extra,
  };
}

test("a running scan shows one line beside Scan: a spinner and posts read of those recorded", async () => {
  const { page, context, errors } = await openDashboard({
    activity: liveActivity(),
  });
  try {
    const line = page.locator(".xt-scan .xt-scan-live");
    await line.waitFor();
    assert.equal(await line.textContent(), "Scanning 24/45");
    assert.equal(await line.locator(".xt-spinner").count(), 1);
    assert.equal(
      await line.getAttribute("title"),
      "Pausing 3.1 s before page 3 so requests stay gentle\nPage 2 · 45 posts already recorded for this range",
    );
    // Only the line and the button: no panel, no last-scan text.
    assert.equal(await page.locator(".xt-scan .xt-scan-text").count(), 0);
    assert.equal(await page.locator(".xt-live").count(), 0);
    await screenshot(page, "teaser-live-scan.png");

    // More posts than recorded: the total follows the count read.
    await page.evaluate(
      (activity) => globalThis.__setScanActivity(activity),
      liveActivity({ rows: 52, updatedUtc: "2026-10-01T11:59:59.000Z" }),
    );
    await page
      .locator(".xt-scan-live", { hasText: "Scanning 52/52" })
      .waitFor({ timeout: 5000 });

    // The scan finishes: the line goes and the dashboard reloads its numbers.
    const before = (await calls(page, "getTeaserOverview")).length;
    await page.evaluate(
      (activity) => globalThis.__setScanActivity(activity),
      liveActivity({
        running: false,
        phase: "done",
        outcome: "complete",
        updatedUtc: "2026-10-01T12:00:00.000Z",
      }),
    );
    await page.locator(".xt-scan .xt-scan-text").waitFor({ timeout: 5000 });
    assert.equal(await page.locator(".xt-spinner").count(), 0);
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

test("before any post is recorded the line counts posts read without a total", async () => {
  const { page, context, errors } = await openDashboard({
    area: "extension",
    activity: liveActivity({ expected: 0, rows: 7 }),
  });
  try {
    const line = page.locator(".xt-scan-live");
    await line.waitFor();
    assert.equal(await line.textContent(), "Scanning 7 posts");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a scan log that stopped updating never shows a spinner", async () => {
  const { page, context, errors } = await openDashboard({
    activity: liveActivity({ updatedUtc: "2026-10-01T11:55:00.000Z" }),
  });
  try {
    await page.waitForFunction(() =>
      globalThis.__teaserCalls.some(
        (call) => call.operation === "getXScanActivity",
      ),
    );
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".xt-spinner").count(), 0);
    assert.equal(await page.locator(".xt-scan .xt-scan-text").count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
