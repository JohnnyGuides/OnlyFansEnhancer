"use strict";

// Real Chrome with the built extension and routed (fake) x.com pages: a
// background scan opens one inactive with_replies tab, pages back by
// replaying the page's own timeline request with the Bottom cursor and the
// allowlisted headers, reads the scheduled list in the same tab, reports to
// the (stubbed) desktop and closes the tab. Benign synthetic data only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

const extensionRoot = require("../support/paths.cjs").personalRoot;
const OWNER_ID = "1000000000000000001";

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
      views: { count: "100" },
      legacy: {
        created_at: new Date(Date.now() - daysAgo * 86400000).toUTCString(),
        full_text: `benign scan fixture ${id}`,
        conversation_id_str: id,
        favorite_count: 1,
        retweet_count: 0,
        reply_count: 0,
        quote_count: 0,
        bookmark_count: 0,
      },
    },
  };
}

function page(posts, bottom) {
  return {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries: [
                    ...posts.map(([id, age]) => ({
                      entryId: `tweet-${id}`,
                      content: {
                        entryType: "TimelineTimelineItem",
                        itemContent: {
                          tweet_results: { result: tweet(id, age) },
                        },
                      },
                    })),
                    ...(bottom
                      ? [
                          {
                            entryId: "cursor-bottom-1",
                            content: {
                              entryType: "TimelineTimelineCursor",
                              cursorType: "Bottom",
                              value: bottom,
                            },
                          },
                        ]
                      : []),
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };
}

const PAGES = {
  "": page(
    [
      ["301", 1],
      ["302", 2],
    ],
    "cursor-1",
  ),
  "cursor-1": page([["303", 3]], "cursor-2"),
  "cursor-2": page([["304", 4]], null),
};

const profileHtml = `<!doctype html><html><head><script>
  const variables = encodeURIComponent(JSON.stringify({ userId: "${OWNER_ID}", count: 20 }));
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "/i/api/graphql/r1/UserRepliesTimeline?variables=" + variables + "&features=%7B%7D");
  xhr.setRequestHeader("authorization", "Bearer fixture-app-token");
  xhr.setRequestHeader("x-csrf-token", "fixture-csrf");
  xhr.setRequestHeader("x-client-transaction-id", "fixture-tx");
  xhr.setRequestHeader("x-unlisted", "not-copied");
  xhr.withCredentials = true;
  xhr.send();
</script></head><body>profile</body></html>`;

const scheduledHtml = `<!doctype html><html><head><script>
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "/i/api/graphql/s1/FetchScheduledTweets?variables=%7B%7D");
  xhr.send();
</script></head><body>scheduled</body></html>`;

test("real Chrome runs one background scan of the owner's own profile and closes its tab", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "x-scan-chrome-"));
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
    const replays = [];
    const visited = [];
    await context.route("https://x.com/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith("/UserRepliesTimeline")) {
        const variables = JSON.parse(url.searchParams.get("variables"));
        const headers = request.headers();
        replays.push({
          cursor: variables.cursor || "",
          userId: variables.userId,
          authorization: headers.authorization,
          csrf: headers["x-csrf-token"],
          transaction: headers["x-client-transaction-id"],
          unlisted: headers["x-unlisted"] || "",
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(PAGES[variables.cursor || ""]),
        });
        return;
      }
      if (url.pathname.endsWith("/FetchScheduledTweets")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              viewer: {
                scheduled_tweet_list: [
                  {
                    rest_id: "7001",
                    scheduling_info: {
                      execute_at: Date.now() + 2 * 86400000,
                      state: "Scheduled",
                    },
                    tweet_create_request: { status: "benign scheduled" },
                  },
                ],
              },
            },
          }),
        });
        return;
      }
      visited.push(url.pathname);
      const body =
        url.pathname === "/Owner_Handle/with_replies"
          ? profileHtml
          : url.pathname === "/compose/post/unsent/scheduled"
            ? scheduledHtml
            : "";
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
      const alarm = await chrome.alarms.get("creator-x-scan");
      const outcome = await xScanner().run("manual");
      // Let the forwarder deliver what it queued.
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const tabs = await chrome.tabs.query({ url: "https://x.com/*" });
      return {
        alarm,
        outcome,
        openTabs: tabs.length,
        desktop: globalThis.__desktop,
      };
    }, OWNER_ID);

    assert.equal(result.alarm?.periodInMinutes, 5);
    assert.equal(result.outcome.outcome, "complete", JSON.stringify(result));
    assert.equal(result.outcome.pages, 3);
    assert.equal(result.outcome.rows, 4);
    assert.equal(result.outcome.scheduled, 1);
    assert.equal(result.openTabs, 0, "The scan tab is closed.");
    assert.deepEqual(
      replays.map((replay) => replay.cursor),
      ["", "cursor-1", "cursor-2"],
    );
    for (const replay of replays.slice(1)) {
      assert.equal(replay.userId, OWNER_ID);
      assert.equal(replay.authorization, "Bearer fixture-app-token");
      assert.equal(replay.csrf, "fixture-csrf");
      assert.equal(replay.transaction, "fixture-tx");
      assert.equal(replay.unlisted, "", "Unlisted headers are not replayed.");
    }
    assert.deepEqual(visited, [
      "/Owner_Handle/with_replies",
      "/compose/post/unsent/scheduled",
    ]);
    const operations = result.desktop.map((entry) => entry.operation);
    assert.equal(operations[0], "getXScanPlan");
    const stored = result.desktop
      .filter((entry) => entry.operation === "recordXObservations")
      .flatMap((entry) => entry.payload.observations.map((row) => row.statusId))
      .sort();
    assert.deepEqual(stored, ["301", "302", "303", "304"]);
    const scheduled = result.desktop.find(
      (entry) => entry.operation === "recordXScheduledPosts",
    );
    assert.equal(scheduled.payload.owner.accountId, OWNER_ID);
    assert.equal(scheduled.payload.scheduled[0].scheduledId, "7001");
    const report = result.desktop.find(
      (entry) => entry.operation === "recordXScanResult",
    );
    assert.equal(report.payload.outcome, "complete");
    assert.equal(report.payload.trigger, "manual");
    assert.equal(report.payload.mode, "backfill");
  } finally {
    await context?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
