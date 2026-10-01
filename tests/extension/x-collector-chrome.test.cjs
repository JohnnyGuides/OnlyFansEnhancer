"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

const extensionRoot = require("../support/paths.cjs").personalRoot;
const OWNER_ID = "1000000000000000001";

function tweet(id, authorId, handle) {
  return {
    __typename: "Tweet",
    rest_id: id,
    core: {
      user_results: {
        result: { rest_id: authorId, core: { screen_name: handle } },
      },
    },
    views: { count: "321" },
    legacy: {
      created_at: "Sat Sep 27 18:04:11 +0000 2026",
      full_text: `benign fixture ${id}`,
      conversation_id_str: id,
      favorite_count: 7,
      retweet_count: 1,
      reply_count: 2,
      quote_count: 0,
      bookmark_count: 3,
    },
  };
}

const timeline = {
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [
                  ["111", OWNER_ID, "Owner_Handle"],
                  ["999", "2000000000000000002", "Someone_Else"],
                ].map(([id, author, handle]) => ({
                  entryId: `tweet-${id}`,
                  content: {
                    itemContent: {
                      tweet_results: { result: tweet(id, author, handle) },
                    },
                  },
                })),
              },
            ],
          },
        },
      },
    },
  },
};

test("real Chrome injects the X collector before page scripts and forwards only owner posts", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "x-collector-chrome-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        "--window-position=-32000,-32000",
        "--window-size=1,1",
      ],
    });
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent("serviceworker", { timeout: 10000 });
    // Never reach a real desktop catalogue from a test profile.
    await worker.evaluate(async () => {
      globalThis.__xForwarded = [];
      sendDesktopRequest = async (operation, payload) => {
        globalThis.__xForwarded.push({ operation, payload });
        return { postsUpserted: payload.observations.length };
      };
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const registered = await chrome.scripting.getRegisteredContentScripts({
          ids: ["creator-x-collector-page", "creator-x-collector-relay"],
        });
        if (registered.length === 2) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("X collector scripts were not registered.");
    });
    await context.addCookies([
      {
        name: "twid",
        value: `u%3D${OWNER_ID}`,
        domain: ".x.com",
        path: "/",
        secure: true,
      },
    ]);
    let graphqlRequests = 0;
    await context.route("https://x.com/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/i/api/graphql/")) {
        graphqlRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(timeline),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><head><script>
          const wrapped = window.fetch.name;
          fetch("/i/api/graphql/q1/UserTweets?variables=%7B%7D")
            .then((response) => response.json())
            .then((payload) => {
              document.documentElement.dataset.result = JSON.stringify({
                wrapped,
                entries: payload.data.user.result.timeline.timeline.instructions[0].entries.length,
              });
            });
          const xhr = new XMLHttpRequest();
          xhr.open("GET", "/i/api/graphql/q2/HomeTimeline");
          xhr.send();
        </script></head><body></body></html>`,
      });
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto("https://x.com/Owner_Handle");
    await page.waitForFunction(() => document.documentElement.dataset.result);
    const result = JSON.parse(
      await page.evaluate(() => document.documentElement.dataset.result),
    );
    assert.deepEqual(result, { wrapped: "creatorObservedFetch", entries: 2 });
    const forwarded = await worker.evaluate(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (globalThis.__xForwarded.length) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return globalThis.__xForwarded;
    });
    assert.equal(graphqlRequests, 2);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].operation, "recordXObservations");
    assert.deepEqual(forwarded[0].payload.owner, {
      accountId: OWNER_ID,
      handle: "Owner_Handle",
    });
    assert.deepEqual(
      forwarded[0].payload.observations.map((row) => [
        row.statusId,
        row.metrics.views,
        row.source,
      ]),
      [["111", 321, "network"]],
    );
    assert.doesNotMatch(JSON.stringify(forwarded), /Someone_Else|999/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
