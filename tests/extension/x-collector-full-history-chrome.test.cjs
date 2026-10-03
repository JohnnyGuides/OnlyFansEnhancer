"use strict";

// Real Chrome with the built personal extension: one full-history scan of
// the owner's own profile against a routed, synthetic x.com timeline that is
// longer than any old page cap and years deep. Page pauses are shortened;
// everything else (tab, page script, relay, forwarder, live log) is real.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

const extensionRoot = require("../support/paths.cjs").personalRoot;
const OWNER_ID = "1000000000000000001";
const PAGE_COUNT = 45;
const PER_PAGE = 20;
const DAY = 86400000;

function tweet(id, daysAgo) {
  return {
    __typename: "TweetWithVisibilityResults",
    tweet: {
      rest_id: id,
      core: {
        user_results: {
          result: { rest_id: OWNER_ID, core: { screen_name: "Owner_Handle" } },
        },
      },
      views: { count: String(Number(id) % 100_000) },
      legacy: {
        created_at: new Date(Date.now() - daysAgo * DAY).toUTCString(),
        full_text: `benign history fixture ${id}`,
        conversation_id_str: id,
        favorite_count: Number(id) % 97,
        retweet_count: 0,
        reply_count: 0,
        quote_count: 0,
        bookmark_count: 0,
      },
    },
  };
}

// Page n (0-based) holds 20 posts, each 1.5 days older than the last, so the
// whole timeline spans about 3.7 years; the last page has no Bottom cursor.
function timelinePage(n) {
  const entries = [];
  for (let index = 0; index < PER_PAGE; index += 1) {
    const position = n * PER_PAGE + index;
    const id = String(500_000 + position);
    entries.push({
      entryId: `tweet-${id}`,
      content: {
        entryType: "TimelineTimelineItem",
        itemContent: {
          tweet_results: { result: tweet(id, 0.5 + position * 1.5) },
        },
      },
    });
  }
  if (n < PAGE_COUNT - 1)
    entries.push({
      entryId: `cursor-bottom-${n}`,
      content: {
        entryType: "TimelineTimelineCursor",
        cursorType: "Bottom",
        value: `cursor-${n + 1}`,
      },
    });
  return {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [{ type: "TimelineAddEntries", entries }],
            },
          },
        },
      },
    },
  };
}

const profileHtml = `<!doctype html><html><head><script>
  const variables = encodeURIComponent(JSON.stringify({ userId: "${OWNER_ID}", count: 20 }));
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "/i/api/graphql/r1/UserRepliesTimeline?variables=" + variables + "&features=%7B%7D");
  xhr.setRequestHeader("authorization", "Bearer fixture-app-token");
  xhr.setRequestHeader("x-csrf-token", "fixture-csrf");
  xhr.withCredentials = true;
  xhr.send();
</script></head><body>profile</body></html>`;

test("real Chrome refreshes known status pages and confirms desktop delivery before profile discovery", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "x-known-chrome-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        "--host-resolver-rules=MAP x.com ~NOTFOUND, MAP *.x.com ~NOTFOUND",
        "--window-position=-32000,-32000",
      ],
    });
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent("serviceworker", { timeout: 10000 });
    // A worker can be announced before its extension scripts finish loading.
    for (let n = 0; n < 100; n++) {
      if (
        await worker.evaluate(
          () => typeof X_SCANNER !== "undefined" && Boolean(X_SCANNER),
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await context.addCookies([
      {
        name: "twid",
        value: `u%3D${OWNER_ID}`,
        domain: ".x.com",
        path: "/",
        secure: true,
      },
    ]);
    const requests = [];
    await context.route("https://x.com/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/TweetDetail")) {
        const id = JSON.parse(url.searchParams.get("variables")).focalTweetId;
        requests.push(id);
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            data: { tweet_results: { result: tweet(id, 700) } },
          }),
        });
      }
      if (url.pathname.endsWith("/UserRepliesTimeline")) {
        const body = timelinePage(PAGE_COUNT - 1);
        body.data.user.result.timeline.timeline.instructions[0].entries = [];
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      }
      const match = /^\/Owner_Handle\/status\/(\d+)$/.exec(url.pathname);
      const body = match
        ? `<!doctype html><script>
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "/i/api/graphql/q/TweetDetail?variables="+encodeURIComponent(JSON.stringify({focalTweetId: "${match[1]}"})));
        xhr.send();</script>benign status`
        : url.pathname.endsWith("/with_replies")
          ? profileHtml
          : "";
      return route.fulfill({
        status: body ? 200 : 404,
        contentType: "text/html",
        body,
      });
    });
    const result = await worker.evaluate(async (ownerId) => {
      const targets = ["501", "502"].map((statusId) => ({
        statusId,
        lastSeenUtc: "2024-01-01T00:00:00Z",
        lastMetricUtc: null,
      }));
      const recorded = [];
      sendDesktopRequest = async (operation, payload) => {
        if (operation === "getXScanPlan")
          return {
            owner: { accountId: ownerId, handle: "Owner_Handle" },
            knownStatuses: targets,
            knownPosts: 2,
            recentPostsUtc: [],
          };
        if (operation === "recordXObservations")
          for (const row of payload.observations) {
            const target = targets.find(
              (target) => target.statusId === row.statusId,
            );
            if (target) {
              target.lastSeenUtc = new Date().toISOString();
              target.lastMetricUtc = target.lastSeenUtc;
              recorded.push(row.statusId);
            }
          }
        return {};
      };
      for (let n = 0; n < 100; n++) {
        if (
          (
            await chrome.scripting.getRegisteredContentScripts({
              ids: ["creator-x-collector-page", "creator-x-collector-relay"],
            })
          ).length === 2
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      xScannerInstance = X_SCANNER.create({
        storage: chrome.storage.local,
        desktop: {
          plan: () => sendDesktopRequest("getXScanPlan"),
          record: (report) => sendDesktopRequest("recordXScanResult", report),
        },
        runner: X_SCANNER.createChromeRunner({
          chrome,
          scheduledTimeoutMs: 100,
        }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / 40)),
      });
      const outcome = await xScanner().run("startup");
      return {
        outcome,
        recorded,
        pending: (await chrome.storage.local.get("creatorXScanV1"))
          .creatorXScanV1.refreshPending,
        tabs: (await chrome.tabs.query({ url: "https://x.com/*" })).length,
      };
    }, OWNER_ID);
    assert.equal(result.outcome.mode, "refresh");
    assert.equal(result.outcome.outcome, "complete", JSON.stringify(result));
    assert.equal(result.outcome.rows, 2);
    assert.deepEqual(requests, ["501", "502"]);
    assert.deepEqual(result.recorded, ["501", "502"]);
    assert.deepEqual(result.pending, []);
    assert.equal(result.tabs, 0);
  } finally {
    await context?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("real Chrome reads the owner's whole history, every page to the end", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "x-full-chrome-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        // Nothing may reach the real x.com: every x.com request is routed.
        "--host-resolver-rules=MAP x.com ~NOTFOUND, MAP *.x.com ~NOTFOUND",
        "--window-position=-32000,-32000",
        "--window-size=1,1",
      ],
    });
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent("serviceworker", { timeout: 10000 });
    await context.addCookies([
      {
        name: "twid",
        value: `u%3D${OWNER_ID}`,
        domain: ".x.com",
        path: "/",
        secure: true,
      },
    ]);
    const cursors = [];
    await context.route("https://x.com/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/UserRepliesTimeline")) {
        const cursor = JSON.parse(url.searchParams.get("variables")).cursor;
        cursors.push(cursor || "");
        const n = cursor ? Number(cursor.slice("cursor-".length)) : 0;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(timelinePage(n)),
        });
        return;
      }
      const body =
        url.pathname === "/Owner_Handle/with_replies" ? profileHtml : "";
      await route.fulfill({
        status: body ? 200 : 404,
        contentType: "text/html",
        body,
      });
    });

    const result = await worker.evaluate(async (ownerId) => {
      globalThis.__desktop = [];
      // Never reach a real desktop catalogue from a test profile.
      sendDesktopRequest = async (operation, payload) => {
        globalThis.__desktop.push({ operation, payload });
        if (operation === "getXScanPlan")
          return {
            owner: { accountId: ownerId, handle: "Owner_Handle" },
            requestedUtc: null,
            recentPostsUtc: [],
            knownPosts: 0,
            knownPostsInWindow: 0,
          };
        return {};
      };
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const registered = await chrome.scripting.getRegisteredContentScripts({
          ids: ["creator-x-collector-page", "creator-x-collector-relay"],
        });
        if (registered.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // The production scanner and Chrome runner, with short page pauses.
      xScannerInstance = X_SCANNER.create({
        storage: chrome.storage.local,
        desktop: {
          plan: () => sendDesktopRequest("getXScanPlan"),
          record: (report) => sendDesktopRequest("recordXScanResult", report),
        },
        runner: X_SCANNER.createChromeRunner({
          chrome,
          scheduledTimeoutMs: 500,
        }),
        onActivity: recordXScanActivity,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / 40)),
      });
      const outcome = await xScanner().run("startup");
      // Let the forwarder deliver what it queued.
      await new Promise((resolve) => setTimeout(resolve, 6000));
      const tabs = await chrome.tabs.query({ url: "https://x.com/*" });
      return {
        outcome,
        openTabs: tabs.length,
        desktop: globalThis.__desktop,
        state: (await chrome.storage.local.get("creatorXScanV1"))
          .creatorXScanV1,
      };
    }, OWNER_ID);

    assert.equal(
      result.outcome.outcome,
      "complete",
      JSON.stringify(result.outcome),
    );
    assert.equal(result.outcome.mode, "backfill");
    assert.equal(result.outcome.pages, PAGE_COUNT);
    assert.equal(result.outcome.rows, PAGE_COUNT * PER_PAGE);
    assert.equal(result.openTabs, 0, "The scan tab is closed.");
    assert.equal(result.state.backfillDone, true);
    // Every cursor exactly once, in order, to the end of the timeline.
    assert.deepEqual(cursors, [
      "",
      ...Array.from({ length: PAGE_COUNT - 1 }, (_, n) => `cursor-${n + 1}`),
    ]);
    // Every post reached the desktop once, with X's counters unchanged.
    const rows = result.desktop
      .filter((entry) => entry.operation === "recordXObservations")
      .flatMap((entry) => entry.payload.observations);
    const byId = new Map(rows.map((row) => [row.statusId, row]));
    assert.equal(byId.size, PAGE_COUNT * PER_PAGE);
    for (const [id, row] of byId) {
      assert.equal(row.metrics.views, Number(id) % 100_000);
      assert.equal(row.metrics.likes, Number(id) % 97);
    }
    const oldest = rows.reduce((left, right) =>
      Date.parse(left.createdAt) < Date.parse(right.createdAt) ? left : right,
    );
    assert.ok(
      Date.now() - Date.parse(oldest.createdAt) > 3 * 365 * DAY,
      "Posts years old are read.",
    );
    const final = result.desktop
      .filter((entry) => entry.operation === "recordXScanActivity")
      .at(-1).payload;
    assert.equal(final.running, false);
    assert.equal(final.rows, PAGE_COUNT * PER_PAGE);
  } finally {
    await context?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
