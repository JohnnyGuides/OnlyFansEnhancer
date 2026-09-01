"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const repositoryRoot = path.resolve(__dirname, "..");
const adapterPath = path.join(
  repositoryRoot,
  "creator-tools/x-publisher-adapter.js",
);

async function loadAdapter(page) {
  if (fs.existsSync(adapterPath))
    await page.addScriptTag({ path: adapterPath });
  assert.equal(
    await page.evaluate(() => Boolean(globalThis.CreatorXPublisherAdapter)),
    true,
    "CreatorXPublisherAdapter must be exposed",
  );
}

async function xPage(browser, url, body) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><style>[hidden]{display:none}button:disabled{display:block}</style>${body}`,
    }),
  );
  await page.goto(url);
  await loadAdapter(page);
  return { context, page };
}

test("X preparation fills one composer and waits for the recorded upload-ready state", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/compose/post",
      `
        <main>
          <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
          <input type="file" data-testid="fileInput" />
          <div role="progressbar" aria-valuenow="100"></div>
          <div role="status">Ready</div>
          <button type="button" data-testid="tweetButton">Post</button>
        </main>
      `,
    );
    const result = await page.evaluate(async () => {
      const attached = [];
      let postClicks = 0;
      document
        .querySelector('[data-testid="tweetButton"]')
        .addEventListener("click", () => (postClicks += 1));
      const prepared = await CreatorXPublisherAdapter.prepare({
        caption: "Recorded caption",
        async attachFile(role, selector) {
          attached.push([role, selector]);
        },
      });
      return {
        prepared,
        attached,
        composer: document.querySelector('[data-testid="tweetTextarea_0"]')
          .textContent,
        postClicks,
      };
    });
    assert.deepEqual(result.attached, [
      ["social", "input[data-testid='fileInput'][type='file']"],
    ]);
    assert.equal(result.composer, "Recorded caption");
    assert.equal(result.postClicks, 0);
    assert.deepEqual(result.prepared, {
      platform: "x",
      status: "prepared",
      upload: "ready",
    });
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X submit clicks the recorded main Post only after durable arming", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/compose/post",
      `
        <div role="progressbar" aria-valuenow="100"></div>
        <button type="button" data-testid="tweetButton">Post</button>
      `,
    );
    const result = await page.evaluate(async () => {
      const order = [];
      document
        .querySelector('[data-testid="tweetButton"]')
        .addEventListener("click", () => order.push("post"));
      const submitted = await CreatorXPublisherAdapter.submit({
        async beforeCommit() {
          order.push("armed");
          return { armed: true };
        },
      });
      return { order, submitted };
    });
    assert.deepEqual(result.order, ["armed", "post"]);
    assert.deepEqual(result.submitted, {
      platform: "x",
      status: "submitted",
    });
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X main identity requires the prepared Post click", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/compose/post",
      `
        <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <input type="file" data-testid="fileInput" />
        <div role="progressbar" aria-valuenow="100"></div>
        <button type="button" data-testid="tweetButton">Post</button>
      `,
    );
    await page.evaluate(() =>
      CreatorXPublisherAdapter.prepare({
        caption: "Recorded caption",
        async attachFile() {},
      }),
    );
    await page.evaluate(() =>
      history.pushState({}, "", "/SomeoneElse/status/9999999999999999999"),
    );
    await assert.rejects(
      page.evaluate(() => CreatorXPublisherAdapter.mainIdentity()),
      /prepared X Post.*not clicked/i,
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X main identity freezes the first status reached after the prepared Post click", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/compose/post",
      `
        <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <input type="file" data-testid="fileInput" />
        <div role="progressbar" aria-valuenow="100"></div>
        <button type="button" data-testid="tweetButton">Post</button>
        <script>
          document.querySelector('[data-testid="tweetButton"]').addEventListener('click', () => {
            history.pushState({}, '', '/RecordedCreator/status/9000000000000000001');
          });
        </script>
      `,
    );
    const identity = await page.evaluate(async () => {
      await CreatorXPublisherAdapter.prepare({
        caption: "Recorded caption",
        async attachFile() {},
      });
      document.querySelector('[data-testid="tweetButton"]').click();
      return CreatorXPublisherAdapter.mainIdentity();
    });
    assert.deepEqual(identity, {
      handle: "recordedcreator",
      resultId: "9000000000000000001",
      resultUrl: "https://x.com/RecordedCreator/status/9000000000000000001",
    });

    await page.evaluate(() =>
      history.pushState({}, "", "/SomeoneElse/status/9999999999999999999"),
    );
    await assert.rejects(
      page.evaluate(() => CreatorXPublisherAdapter.mainIdentity()),
      /no longer matches/i,
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("manual X capture prepares the paid reply and removes its OnlyFans card without posting", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/RecordedCreator/status/9000000000000000001",
      `
        <article data-status-id="9000000000000000001">
          <a href="/RecordedCreator/status/9000000000000000001">Main status</a>
        </article>
        <div id="reply" role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <div id="preview" hidden><a href="https://onlyfans.com/123/creator">OnlyFans</a><button type="button"></button></div>
        <button type="button" data-testid="tweetButtonInline">Reply</button>
        <script>
          globalThis.__events = [];
          const editor = document.querySelector('#reply');
          const preview = document.querySelector('#preview');
          editor.addEventListener('input', () => { preview.hidden = false; });
          preview.querySelector('button').addEventListener('click', () => {
            globalThis.__events.push('preview-removed');
            preview.remove();
          });
          document.querySelector('[data-testid="tweetButtonInline"]').addEventListener('click', () => globalThis.__events.push('reply-posted'));
        </script>
      `,
    );
    const result = await page.evaluate(async () => {
      const captured = await CreatorXPublisherAdapter.captureResult({
        mode: "manual",
        paidUrl: "https://onlyfans.com/123/creator",
      });
      return {
        captured,
        reply: document.querySelector("#reply").textContent,
        previewCount: document.querySelectorAll("#preview").length,
        events: globalThis.__events,
      };
    });
    assert.equal(result.reply, "https://onlyfans.com/123/creator");
    assert.equal(result.previewCount, 0);
    assert.deepEqual(result.events, ["preview-removed"]);
    assert.deepEqual(result.captured, {
      status: "reply-prepared",
      resultId: "9000000000000000001",
      resultUrl: "https://x.com/RecordedCreator/status/9000000000000000001",
    });
    await context.close();
  } finally {
    await browser.close();
  }
});

test("manual X polling leaves an already prepared paid reply untouched", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/RecordedCreator/status/9000000000000000001",
      `
        <a href="/RecordedCreator/status/9000000000000000001">Main status</a>
        <div id="reply" role="textbox" contenteditable="true" data-testid="tweetTextarea_0">https://onlyfans.com/123/creator</div>
        <button type="button" data-testid="tweetButtonInline">Reply</button>
        <script>
          globalThis.__inputs = 0;
          globalThis.__replyClicks = 0;
          document.querySelector('#reply').addEventListener('input', () => globalThis.__inputs += 1);
          document.querySelector('[data-testid="tweetButtonInline"]').addEventListener('click', () => globalThis.__replyClicks += 1);
        </script>
      `,
    );
    const result = await page.evaluate(async () => ({
      captured: await CreatorXPublisherAdapter.captureResult({
        mode: "manual",
        paidUrl: "https://onlyfans.com/123/creator",
      }),
      inputs: globalThis.__inputs,
      replyClicks: globalThis.__replyClicks,
    }));
    assert.deepEqual(result.captured, {
      status: "reply-prepared",
      resultId: "9000000000000000001",
      resultUrl: "https://x.com/RecordedCreator/status/9000000000000000001",
    });
    assert.equal(result.inputs, 0);
    assert.equal(result.replyClicks, 0);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X does not mistake a pre-existing same-author status link for this reply", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/RecordedCreator/status/9000000000000000001",
      `
        <a href="/RecordedCreator/status/8000000000000000000">Unrelated older status</a>
        <div id="reply" role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <div id="preview" hidden><a href="https://onlyfans.com/123/creator">OnlyFans</a><button type="button"></button></div>
        <button type="button" data-testid="tweetButtonInline">Reply</button>
        <script>
          const preview = document.querySelector('#preview');
          document.querySelector('#reply').addEventListener('input', () => { preview.hidden = false; });
          preview.querySelector('button').addEventListener('click', () => preview.remove());
        </script>
      `,
    );
    const captured = await page.evaluate(() =>
      CreatorXPublisherAdapter.captureResult({
        mode: "manual",
        paidUrl: "https://onlyfans.com/123/creator",
      }),
    );
    assert.deepEqual(captured, {
      status: "reply-prepared",
      resultId: "9000000000000000001",
      resultUrl: "https://x.com/RecordedCreator/status/9000000000000000001",
    });
    await context.close();
  } finally {
    await browser.close();
  }
});

test("autonomous X capture arms, posts, and captures the first reply after card removal", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/RecordedCreator/status/9000000000000000001",
      `
        <article><a href="/RecordedCreator/status/9000000000000000001">Main status</a></article>
        <div id="reply" role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <div id="preview" hidden><a href="https://onlyfans.com/123/creator">OnlyFans</a><button type="button"></button></div>
        <button type="button" data-testid="tweetButtonInline">Reply</button>
        <script>
          globalThis.__events = [];
          const preview = document.querySelector('#preview');
          document.querySelector('#reply').addEventListener('input', () => { preview.hidden = false; });
          preview.querySelector('button').addEventListener('click', () => {
            globalThis.__events.push('preview-removed');
            preview.remove();
          });
          document.querySelector('[data-testid="tweetButtonInline"]').addEventListener('click', () => {
            globalThis.__events.push('reply-posted');
            const link = document.createElement('a');
            link.href = '/RecordedCreator/status/9000000000000000002';
            link.textContent = 'First reply';
            document.body.append(link);
          });
        </script>
      `,
    );
    const result = await page.evaluate(async () => {
      const captured = await CreatorXPublisherAdapter.captureResult({
        mode: "autonomous",
        paidUrl: "https://onlyfans.com/123/creator",
        async beforeReplyCommit(main) {
          globalThis.__events.push(`armed:${main.resultId}`);
          return { armed: true };
        },
      });
      return { captured, events: globalThis.__events };
    });
    assert.deepEqual(result.events, [
      "preview-removed",
      "armed:9000000000000000001",
      "reply-posted",
    ]);
    assert.deepEqual(result.captured, {
      resultId: "9000000000000000001",
      resultUrl: "https://x.com/RecordedCreator/status/9000000000000000001",
      replyResultId: "9000000000000000002",
      replyResultUrl:
        "https://x.com/RecordedCreator/status/9000000000000000002",
    });
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X exposes separate reply preparation and armed submission phases", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/RecordedCreator/status/9000000000000000001",
      `
        <a href="/RecordedCreator/status/9000000000000000001">Main status</a>
        <div id="reply" role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <div id="preview" hidden><a href="https://onlyfans.com/123/creator">OnlyFans</a><button type="button"></button></div>
        <button type="button" data-testid="tweetButtonInline">Reply</button>
        <script>
          globalThis.__events = [];
          const preview = document.querySelector('#preview');
          document.querySelector('#reply').addEventListener('input', () => { preview.hidden = false; });
          preview.querySelector('button').addEventListener('click', () => {
            globalThis.__events.push('preview-removed');
            preview.remove();
          });
          document.querySelector('[data-testid="tweetButtonInline"]').addEventListener('click', () => {
            globalThis.__events.push('reply-posted');
            const link = document.createElement('a');
            link.href = '/RecordedCreator/status/9000000000000000002';
            document.body.append(link);
          });
        </script>
      `,
    );
    const prepared = await page.evaluate(() =>
      CreatorXPublisherAdapter.prepareReply({
        paidUrl: "https://onlyfans.com/123/creator",
      }),
    );
    assert.equal(prepared.status, "reply-prepared");
    assert.deepEqual(await page.evaluate(() => globalThis.__events), [
      "preview-removed",
    ]);

    const submitted = await page.evaluate(() =>
      CreatorXPublisherAdapter.submitReply({
        async beforeCommit() {
          globalThis.__events.push("armed");
          return { armed: true };
        },
      }),
    );
    assert.equal(submitted.replyResultId, "9000000000000000002");
    assert.deepEqual(await page.evaluate(() => globalThis.__events), [
      "preview-removed",
      "armed",
      "reply-posted",
    ]);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X adapter fails closed when the OnlyFans preview dismissal is ambiguous", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/RecordedCreator/status/9000000000000000001",
      `
        <a href="/RecordedCreator/status/9000000000000000001">Main status</a>
        <div id="reply" role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <div class="preview" hidden><a href="https://onlyfans.com/1/creator">OnlyFans</a><button type="button"></button></div>
        <div class="preview" hidden><a href="https://onlyfans.com/1/creator">OnlyFans</a><button type="button"></button></div>
        <button type="button" data-testid="tweetButtonInline">Reply</button>
        <script>
          document.querySelector('#reply').addEventListener('input', () => {
            for (const card of document.querySelectorAll('.preview')) card.hidden = false;
          });
        </script>
      `,
    );
    await assert.rejects(
      page.evaluate(() =>
        CreatorXPublisherAdapter.captureResult({
          mode: "manual",
          paidUrl: "https://onlyfans.com/1/creator",
        }),
      ),
      /preview.*ambiguous/i,
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X recovery after a durably attempted reply captures only and cannot click Reply again", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/RecordedCreator/status/9000000000000000001",
      `
        <a href="/RecordedCreator/status/9000000000000000001">Main status</a>
        <div id="reply" role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <div id="preview" hidden><a href="https://onlyfans.com/1/creator">OnlyFans</a><button type="button"></button></div>
        <button type="button" data-testid="tweetButtonInline">Reply</button>
        <script>
          globalThis.__replyClicks = 0;
          const preview = document.querySelector('#preview');
          document.querySelector('#reply').addEventListener('input', () => { preview.hidden = false; });
          preview.querySelector('button').addEventListener('click', () => preview.remove());
          document.querySelector('[data-testid="tweetButtonInline"]').addEventListener('click', () => globalThis.__replyClicks += 1);
        </script>
      `,
    );
    await page.evaluate(() =>
      CreatorXPublisherAdapter.prepareReply({
        paidUrl: "https://onlyfans.com/1/creator",
      }),
    );
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "/RecordedCreator/status/9000000000000000002";
      link.textContent = "First reply";
      document.body.append(link);
    });
    const result = await page.evaluate(async () => ({
      captured: await CreatorXPublisherAdapter.captureResult({
        mode: "autonomous",
        paidUrl: "https://onlyfans.com/1/creator",
        allowReplySubmit: false,
      }),
      clicks: globalThis.__replyClicks,
    }));
    assert.equal(result.clicks, 0);
    assert.equal(result.captured.replyResultId, "9000000000000000002");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X capture-only recovery stays unresolved when the attempted reply is not visible", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/RecordedCreator/status/9000000000000000001",
      `
        <a href="/RecordedCreator/status/9000000000000000001">Main status</a>
        <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <button type="button" data-testid="tweetButtonInline">Reply</button>
        <script>
          globalThis.__replyClicks = 0;
          document.querySelector('[data-testid="tweetButtonInline"]').addEventListener('click', () => globalThis.__replyClicks += 1);
        </script>
      `,
    );
    await assert.rejects(
      page.evaluate(() =>
        CreatorXPublisherAdapter.captureResult({
          mode: "autonomous",
          paidUrl: "https://onlyfans.com/1/creator",
          allowReplySubmit: false,
        }),
      ),
      /reply.*already attempted.*capture/i,
    );
    assert.equal(await page.evaluate(() => globalThis.__replyClicks), 0);
    await context.close();
  } finally {
    await browser.close();
  }
});
