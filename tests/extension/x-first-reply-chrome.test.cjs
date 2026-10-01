"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

const extensionRoot = require("../support/paths.cjs").personalRoot;
const STATUS_URL = "https://x.com/Owner_Handle/status/101";
const PAID = "https://onlyfans.com/123456789/johnny_guides";

// Synthetic status page shaped like X's conversation view; benign text only.
const statusPage = `<!doctype html>
  <article><a href="/Owner_Handle/status/101"><time>now</time></a><div data-testid="videoPlayer"></div></article>
  <div id="composer">
    <div id="reply" role="textbox" contenteditable="true" data-testid="tweetTextarea_0" style="white-space:pre-wrap"></div>
    <div id="cards"></div>
    <button type="button" data-testid="tweetButtonInline">Reply</button>
  </div>
  <script>
    const editor = document.querySelector('#reply');
    editor.addEventListener('paste', (event) => {
      event.preventDefault();
      editor.textContent = event.clipboardData.getData('text/plain');
      setTimeout(() => {
        if (document.querySelector('[data-testid="card.wrapper"]')) return;
        const card = document.createElement('div');
        card.dataset.testid = 'card.wrapper';
        card.innerHTML = '<a href="${PAID}">onlyfans.com OnlyFans</a><button type="button"></button>';
        card.querySelector('button').addEventListener('click', () => card.remove());
        document.querySelector('#cards').append(card);
      }, 50);
    });
    document.querySelector('[data-testid="tweetButtonInline"]').addEventListener('click', () => {
      fetch('/__fixture/reply-clicked?text=' + encodeURIComponent(editor.innerText));
      const reply = document.createElement('article');
      reply.innerHTML = '<a href="/Owner_Handle/status/150"><time>now</time></a>';
      document.body.append(reply);
    });
  </script>`;

test("real Chrome schedules the first reply on an alarm, posts once in a background tab and closes it", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "x-first-reply-"));
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
    const clicks = [];
    await context.route("https://x.com/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/__fixture/reply-clicked") {
        clicks.push(url.searchParams.get("text"));
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      if (url.pathname === "/Owner_Handle/status/101") {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: statusPage,
        });
        return;
      }
      await route.fulfill({ status: 404, body: "" });
    });

    const setup = await worker.evaluate(async (paidUrl) => {
      globalThis.__desktop = [];
      // Never reach a real desktop catalogue from a test profile.
      sendDesktopRequest = async (operation) => {
        globalThis.__desktop.push(operation);
        if (operation !== "getTeaserReplyQueue") return {};
        return {
          ownerHandle: "Owner_Handle",
          items: [
            {
              statusId: "101",
              postedUtc: new Date(Date.now() - 90 * 60_000).toISOString(),
              itemId: "item-1",
              sourceKey: "ep-1",
              paidUrl,
              hasVideo: true,
              isReply: false,
              isRepost: false,
              ownerReplyExists: false,
            },
          ],
        };
      };
      let alarm = null;
      for (let attempt = 0; attempt < 50 && !alarm; attempt += 1) {
        alarm = await chrome.alarms.get("creator-x-first-reply");
        if (!alarm) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const before = await xFirstReply().status();
      const idle = await xFirstReply().tick();
      return { alarm, before, idle, desktop: [...globalThis.__desktop] };
    }, PAID);
    assert.equal(setup.alarm?.periodInMinutes, 5);
    assert.equal(setup.before.enabled, false);
    assert.equal(setup.before.label, "needs one live check");
    assert.deepEqual(setup.idle, { ran: false, reason: "disabled" });
    assert.deepEqual(setup.desktop, [], "disabled means no desktop polling");

    const extensionId = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.waitForFunction(() =>
      document
        .querySelector("#xFirstReplyStatus")
        ?.textContent.includes("needs one live check"),
    );
    assert.equal(await options.isChecked("#xFirstReplyEnabled"), false);
    await options.check("#xFirstReplyEnabled");
    await options.waitForFunction(() =>
      document
        .querySelector("#xFirstReplyStatus")
        ?.textContent.includes("enabled by owner"),
    );

    const run = await worker.evaluate(async () => {
      const first = await xFirstReply().tick();
      const second = await xFirstReply().tick();
      const tabs = await chrome.tabs.query({ url: "https://x.com/*" });
      const stored = (await chrome.storage.local.get("creatorXFirstReplyV1"))
        .creatorXFirstReplyV1;
      return { first, second, openTabs: tabs.length, stored };
    });
    assert.equal(run.first.executed, "101", JSON.stringify(run.stored?.log));
    assert.equal(
      run.first.outcome,
      "posted",
      JSON.stringify(run.stored?.items),
    );
    assert.equal(run.second.executed, "");
    assert.equal(run.openTabs, 0);
    const item = run.stored.items["101"];
    assert.equal(item.state, "finished");
    assert.equal(item.replyId, "150");
    assert.equal(item.late, false);
    assert.equal(item.text, `full vid (no ppv)\n-> ${PAID}`);
    assert.deepEqual(clicks, [`full vid (no ppv)\n-> ${PAID}`]);

    await options.reload();
    await options.waitForFunction(() =>
      document.querySelector("#xFirstReplyLog")?.textContent.includes("101"),
    );
    assert.match(
      await options.textContent("#xFirstReplyLog"),
      /101: posted reply 150/,
    );
  } finally {
    await context?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
