"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

const extensionRoot = require("../support/paths.cjs").personalRoot;
const read = (relative) =>
  fs.readFileSync(path.join(extensionRoot, relative), "utf8");

// Synthetic markup shaped like X's rendered timeline; benign text, fake ids.
function quoteCard({ handle = "Someone_Else", id = "990", text, video }) {
  return `<div role="link" tabindex="0">
    <div data-testid="User-Name"><span>@${handle}</span></div>
    <time datetime="2026-01-01T00:00:00.000Z">Jan 1</time>
    ${text ? `<div data-testid="tweetText">${text}</div>` : ""}
    ${video ? '<div data-testid="videoPlayer"><video></video></div>' : ""}
  </div>`;
}

function article({
  id,
  handle = "Owner_Handle",
  text = "",
  video = false,
  quote = "",
  extra = "",
  social = false,
}) {
  return `<article data-id="${id}">
    ${social ? '<div data-testid="socialContext">You reposted</div>' : ""}
    <a href="/${handle}/status/${id}" role="link"><time datetime="2026-09-27T18:04:11.000Z">Sep 27</time></a>
    ${text ? `<div data-testid="tweetText">${text}</div>` : ""}
    ${video ? '<div data-testid="videoPlayer"><video></video></div>' : ""}
    ${quote}
    ${extra}
    <div role="group" aria-label="1 reply, 2 reposts, 3 likes, 4 bookmarks, 50 views"></div>
  </article>`;
}

const MARKUP = `<nav><a data-testid="AppTabBar_Profile_Link" href="/Owner_Handle">Profile</a></nav>
  ${article({ id: "101", text: "own teaser", video: true })}
  ${article({ id: "102", quote: quoteCard({ text: "foreign words", video: true }) })}
  ${article({ id: "103", text: "own words", quote: quoteCard({ text: "foreign words", video: true }) })}
  ${article({
    id: "104",
    text: "own words",
    extra:
      '<div><time datetime="2026-01-01T00:00:00.000Z">Jan 1</time><div data-testid="tweetText">foreign words</div><div data-testid="videoPlayer"></div></div>',
  })}
  ${article({ id: "105", handle: "Someone_Else", text: "foreign words" })}
  ${article({ id: "106", text: "foreign words", social: true })}`;

test("DOM fallback keeps only the outer owner post and never quoted content", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><body>${MARKUP}</body>`);
    await page.addScriptTag({
      content: read("workflows/x-collector-contract.js"),
    });
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("article")].map((element) =>
        globalThis.CreatorXCollectorContract.extractDomArticle(
          element,
          "Owner_Handle",
        ),
      ),
    );
    const [plain, quoteOnly, ownPlusQuote, unknownQuote, foreign, repost] =
      rows;
    assert.equal(plain.statusId, "101");
    assert.equal(plain.text, "own teaser");
    assert.equal(plain.media.length, 1);
    assert.deepEqual(plain.metrics, {
      views: 50,
      likes: 3,
      reposts: 2,
      replies: 1,
      quotes: null,
      bookmarks: 4,
    });
    assert.equal(quoteOnly.statusId, "102");
    assert.equal(quoteOnly.text, "");
    assert.deepEqual(quoteOnly.media, []);
    assert.equal(quoteOnly.metrics.views, 50);
    assert.equal(ownPlusQuote.text, "own words");
    assert.deepEqual(ownPlusQuote.media, []);
    // An unrecognized embedded post: text and media cannot be isolated.
    assert.equal(unknownQuote.statusId, "104");
    assert.equal(unknownQuote.text, "");
    assert.deepEqual(unknownQuote.media, []);
    assert.equal(foreign, null);
    assert.equal(repost, null);
    assert.doesNotMatch(JSON.stringify(rows), /foreign words|Someone_Else/);
    const handle = await page.evaluate(() =>
      globalThis.CreatorXCollectorContract.ownerHandleFromDocument(document),
    );
    assert.equal(handle, "Owner_Handle");
  } finally {
    await browser.close();
  }
});

test("relay DOM fallback reports owner articles once and stops after network data", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><body>${MARKUP}</body>`);
    await page.evaluate(() => {
      globalThis.__sent = [];
      globalThis.__timers = [];
      globalThis.setTimeout = (callback) => globalThis.__timers.push(callback);
      globalThis.chrome = {
        runtime: {
          sendMessage(message, callback) {
            globalThis.__sent.push(JSON.parse(JSON.stringify(message)));
            callback?.();
          },
        },
      };
    });
    await page.addScriptTag({
      content: read("workflows/x-collector-relay-contract.js"),
    });
    await page.addScriptTag({
      content: read("workflows/x-collector-relay.js"),
    });
    const first = await page.evaluate(() => {
      const timers = globalThis.__timers;
      if (timers.length !== 1) throw new Error("expected only the delay timer");
      timers.shift()();
      timers.shift()();
      return globalThis.__sent.splice(0);
    });
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].batch.owner, {
      accountId: null,
      handle: "Owner_Handle",
    });
    assert.deepEqual(
      first[0].batch.observations.map((row) => [row.statusId, row.text]),
      [
        ["101", "own teaser"],
        ["102", ""],
        ["103", "own words"],
        ["104", ""],
      ],
    );
    const repeat = await page.evaluate(async () => {
      document.body.append(document.createElement("span"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      globalThis.__timers.shift()?.();
      return globalThis.__sent.length;
    });
    assert.equal(repeat, 0, "Unchanged articles are not re-sent.");
    const afterNetwork = await page.evaluate(async () => {
      const channel = new MessageChannel();
      document.dispatchEvent(
        new MessageEvent("creator-x-collector", {
          data: JSON.stringify({ kind: "hello" }),
          ports: [channel.port2],
        }),
      );
      channel.port1.postMessage({
        kind: "batch",
        batch: {
          owner: { accountId: "1", handle: "Owner_Handle" },
          observations: [],
        },
      });
      for (let wait = 0; wait < 50 && !globalThis.__sent.length; wait += 1)
        await new Promise((resolve) => requestAnimationFrame(resolve));
      document.body.append(document.createElement("span"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return {
        timers: globalThis.__timers.length,
        sent: globalThis.__sent.length,
      };
    });
    assert.deepEqual(afterNetwork, { timers: 0, sent: 1 });
  } finally {
    await browser.close();
  }
});
