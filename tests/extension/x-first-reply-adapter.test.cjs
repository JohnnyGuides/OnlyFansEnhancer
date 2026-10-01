"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

const repositoryRoot = require("../support/paths.cjs").personalRoot;
const adapterPath = path.join(
  repositoryRoot,
  "workflows/x-publisher-adapter.js",
);
const STATUS_URL = "https://x.com/Owner_Handle/status/101";
const PAID = "https://onlyfans.com/123456789/johnny_guides";
const TEXT = `full vid (no ppv)\n-> ${PAID}`;
const TIMING = {
  elementWaitMs: 2000,
  conversationSettleMs: 50,
  cardWaitMs: 500,
  removalWaitMs: 1000,
  settleMs: 300,
  confirmWaitMs: 1000,
};

// Synthetic status page shaped like X's conversation view; benign text only.
function fixture({
  mode = "normal",
  extra = "",
  account = "Owner_Handle",
} = {}) {
  return `<!doctype html><style>[hidden]{display:none}</style>
    <nav><a id="profile" data-testid="AppTabBar_Profile_Link" href="/${account}">Profile</a></nav>
    <article><a href="/Owner_Handle/status/101"><time>now</time></a><div data-testid="videoPlayer"></div></article>
    ${extra}
    <div id="composer">
      <div id="reply" role="textbox" contenteditable="true" data-testid="tweetTextarea_0" style="white-space:pre-wrap"></div>
      <div id="cards"></div>
      <button type="button" data-testid="tweetButtonInline">Reply</button>
    </div>
    <script>
      globalThis.__events = [];
      const mode = ${JSON.stringify(mode)};
      const editor = document.querySelector('#reply');
      let dismissals = 0;
      function showCard() {
        if (document.querySelector('[data-testid="card.wrapper"]')) return;
        const card = document.createElement('div');
        card.dataset.testid = 'card.wrapper';
        card.innerHTML = '<a href="${PAID}">onlyfans.com OnlyFans</a><button type="button"></button>';
        card.querySelector('button').addEventListener('click', () => {
          dismissals += 1;
          globalThis.__events.push('card-removed');
          card.remove();
          if (mode === 'always-reappear' || (mode === 'reappear-once' && dismissals === 1))
            setTimeout(showCard, 100);
        });
        document.querySelector('#cards').append(card);
        globalThis.__events.push('card-shown');
      }
      editor.addEventListener('paste', (event) => {
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain');
        editor.textContent = mode === 'mangle' ? text.replace('\\n', ' ') : text;
        globalThis.__events.push('paste');
        if (mode !== 'no-card') setTimeout(showCard, 50);
      });
      document.querySelector('[data-testid="tweetButtonInline"]').addEventListener('click', () => {
        globalThis.__events.push('reply-clicked');
        if (mode === 'silent') return;
        const reply = document.createElement('article');
        reply.innerHTML = '<a href="/Owner_Handle/status/150"><time>now</time></a>';
        document.body.append(reply);
      });
    </script>`;
}

async function withPage(options, run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(STATUS_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: fixture(options),
      }),
    );
    await page.goto(STATUS_URL);
    await page.addScriptTag({ path: adapterPath });
    return await run(page);
  } finally {
    await browser.close();
  }
}

function prepare(page, over = {}) {
  return page.evaluate(
    async (args) => {
      try {
        return {
          result: await CreatorXPublisherAdapter.prepareFirstReply(args),
        };
      } catch (error) {
        return { error: error.message };
      }
    },
    {
      statusId: "101",
      ownerHandle: "Owner_Handle",
      text: TEXT,
      paidUrl: PAID,
      timing: TIMING,
      ...over,
    },
  );
}

function submit(page, over = {}) {
  return page.evaluate(
    async (args) => {
      try {
        return {
          result: await CreatorXPublisherAdapter.submitFirstReply(args),
        };
      } catch (error) {
        return { error: error.message };
      }
    },
    {
      statusId: "101",
      ownerHandle: "Owner_Handle",
      text: TEXT,
      paidUrl: PAID,
      timing: TIMING,
      ...over,
    },
  );
}

const events = (page) => page.evaluate(() => globalThis.__events);
const composer = (page) =>
  page.evaluate(() => document.querySelector("#reply").innerText);

test("first reply removes the link card, verifies the exact text and posts once", async () => {
  await withPage({}, async (page) => {
    const prepared = await prepare(page);
    assert.equal(prepared.result?.status, "ready", prepared.error);
    assert.equal(prepared.result.attempts, 1);
    assert.equal(await composer(page), TEXT);
    assert.deepEqual(await events(page), [
      "paste",
      "card-shown",
      "card-removed",
    ]);
    const submitted = await submit(page);
    assert.deepEqual(submitted.result, {
      resultId: "101",
      replyId: "150",
      replyUrl: "https://x.com/Owner_Handle/status/150",
    });
    assert.equal(
      (await events(page)).filter((name) => name === "reply-clicked").length,
      1,
    );
  });
});

test("a link card that reappears once is removed by a bounded re-paste", async () => {
  await withPage({ mode: "reappear-once" }, async (page) => {
    const prepared = await prepare(page);
    assert.equal(prepared.result?.status, "ready", prepared.error);
    assert.equal(prepared.result.attempts, 2);
    assert.equal(
      await page.evaluate(
        () => document.querySelectorAll('[data-testid="card.wrapper"]').length,
      ),
      0,
    );
    assert.deepEqual(
      (await events(page)).filter((name) => name === "paste").length,
      2,
    );
  });
});

test("a link card that keeps coming back fails closed without clicking", async () => {
  await withPage({ mode: "always-reappear" }, async (page) => {
    const prepared = await prepare(page);
    assert.match(prepared.error, /^card-not-removed:/);
    const seen = await events(page);
    assert.equal(seen.filter((name) => name === "paste").length, 3);
    assert.equal(seen.includes("reply-clicked"), false);
    const submitted = await submit(page);
    assert.match(submitted.error, /^card-not-removed:/);
    assert.equal((await events(page)).includes("reply-clicked"), false);
  });
});

test("when no card appears the reply proceeds only with the exact text", async () => {
  await withPage({ mode: "no-card" }, async (page) => {
    const prepared = await prepare(page);
    assert.equal(prepared.result?.status, "ready", prepared.error);
    assert.equal((await submit(page)).result?.replyId, "150");
  });
  await withPage({ mode: "mangle" }, async (page) => {
    const prepared = await prepare(page);
    assert.match(prepared.error, /^mismatch:/);
    assert.equal((await events(page)).includes("reply-clicked"), false);
  });
});

test("an existing owner reply in the conversation skips without typing", async () => {
  await withPage(
    {
      extra:
        '<article><a href="/Owner_Handle/status/120"><time>later</time></a>full vid</article>',
    },
    async (page) => {
      const prepared = await prepare(page);
      assert.deepEqual(prepared.result, {
        status: "existing-reply",
        replyId: "120",
      });
      assert.deepEqual(await events(page), []);
      assert.equal(await composer(page), "");
    },
  );
});

test("an older owner status or a foreign reply does not count as the first reply", async () => {
  await withPage(
    {
      extra:
        '<article><a href="/Owner_Handle/status/90"><time>older</time></a></article><article><a href="/Someone_Else/status/130"><time>later</time></a></article>',
    },
    async (page) => {
      const prepared = await prepare(page);
      assert.equal(prepared.result?.status, "ready", prepared.error);
    },
  );
});

test("the page must be the owner's exact teaser status", async () => {
  await withPage({}, async (page) => {
    assert.match(
      (await prepare(page, { ownerHandle: "Someone_Else" })).error,
      /^not-owner-teaser:/,
    );
    assert.match(
      (await prepare(page, { statusId: "102" })).error,
      /^not-owner-teaser:/,
    );
    assert.deepEqual(await events(page), []);
  });
  await withPage(
    {
      extra:
        '<article><a href="/Owner_Handle/status/101"><time>dup</time></a></article>',
    },
    async (page) => {
      assert.match((await prepare(page)).error, /^not-owner-teaser:/);
    },
  );
});

test("submit re-checks the gate in the click turn and never clicks unprepared", async () => {
  await withPage({}, async (page) => {
    assert.match((await submit(page)).error, /^mismatch:/);
    assert.equal(
      (await prepare(page)).result?.status,
      "ready",
      "prepared after refusal",
    );
    await page.evaluate(() => {
      document.querySelector("#reply").textContent = "edited";
    });
    assert.match((await submit(page)).error, /^mismatch:/);
    assert.equal((await events(page)).includes("reply-clicked"), false);
  });
  await withPage({}, async (page) => {
    assert.equal((await prepare(page)).result?.status, "ready");
    await page.evaluate(() => {
      const card = document.createElement("div");
      card.dataset.testid = "card.wrapper";
      card.textContent = "late card";
      document.querySelector("#cards").append(card);
    });
    assert.match((await submit(page)).error, /^card-not-removed:/);
    assert.equal((await events(page)).includes("reply-clicked"), false);
  });
});

test("an unobserved reply after the click is reported unconfirmed", async () => {
  await withPage({ mode: "silent" }, async (page) => {
    assert.equal((await prepare(page)).result?.status, "ready");
    const submitted = await submit(page);
    assert.match(submitted.error, /^unconfirmed:/);
    assert.equal(
      (await events(page)).filter((name) => name === "reply-clicked").length,
      1,
    );
  });
});

test("a different signed-in X account fails closed before typing and before the click", async () => {
  await withPage({ account: "Someone_Else" }, async (page) => {
    assert.match((await prepare(page)).error, /^wrong-account:/);
    assert.deepEqual(await events(page), []);
  });
  await withPage({}, async (page) => {
    assert.equal((await prepare(page)).result?.status, "ready");
    await page.evaluate(() =>
      document.querySelector("#profile").setAttribute("href", "/Someone_Else"),
    );
    assert.match((await submit(page)).error, /^wrong-account:/);
    assert.equal((await events(page)).includes("reply-clicked"), false);
  });
});

test("submit refuses when an owner reply appears after preparation", async () => {
  await withPage({}, async (page) => {
    assert.equal((await prepare(page)).result?.status, "ready");
    await page.evaluate(() => {
      const reply = document.createElement("article");
      reply.innerHTML =
        '<a href="/Owner_Handle/status/160"><time>now</time></a>';
      document.body.append(reply);
    });
    assert.match((await submit(page)).error, /^existing-reply:/);
    assert.equal((await events(page)).includes("reply-clicked"), false);
  });
});

test("the pre-click gate requires the reply to carry the scheduled episode link", async () => {
  await withPage({}, async (page) => {
    assert.equal((await prepare(page)).result?.status, "ready");
    const other = "https://onlyfans.com/987654321/johnny_guides";
    assert.match((await submit(page, { paidUrl: other })).error, /^mismatch:/);
    assert.match(
      (await submit(page, { paidUrl: "https://onlyfans.com/1/someone" })).error,
      /^mismatch:/,
    );
    assert.equal((await events(page)).includes("reply-clicked"), false);
  });
});
