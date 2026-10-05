"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");

const repositoryRoot = require("../support/paths.cjs").personalRoot;
const sha256Hex = (value) =>
  require("node:crypto").createHash("sha256").update(value).digest("hex");
const adapterPath = path.join(
  repositoryRoot,
  "workflows/x-publisher-adapter.js",
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
      preparedCaptionSha256: sha256Hex("Recorded caption"),
    });
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X preparation enables and verifies only the Nudity content warning when requested", async () => {
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
        <button type="button" aria-label="Edit media">Edit</button>
        <section id="media-editor" hidden>
          <div role="tab" aria-label="Captions">Captions</div>
          <div role="tab" aria-label="Content warning">Content warning</div>
          <div id="captions-panel">Captions</div>
          <div id="warning-panel" hidden>
            <label id="CHECKBOX_1_LABEL">Nudity</label>
            <input id="nudity" type="checkbox" aria-describedby="CHECKBOX_1_LABEL" />
            <label id="CHECKBOX_2_LABEL">Violence</label>
            <input id="violence" type="checkbox" aria-describedby="CHECKBOX_2_LABEL" />
          </div>
          <button id="warning-done" type="button" hidden>Done</button>
          <button id="captions-done" type="button">Done</button>
        </section>
        <script>
          const editor = document.querySelector('#media-editor');
          const captions = document.querySelector('#captions-panel');
          const warning = document.querySelector('#warning-panel');
          const warningDone = document.querySelector('#warning-done');
          const captionsDone = document.querySelector('#captions-done');
          document.querySelector('[aria-label="Edit media"]').addEventListener('click', () => {
            editor.hidden = false;
            document.querySelector('[data-testid="tweetTextarea_0"]').hidden = true;
            warning.hidden = true;
            captions.hidden = false;
            warningDone.hidden = true;
            captionsDone.hidden = false;
          });
          document.querySelector('[aria-label="Content warning"]').addEventListener('click', () => {
            captions.hidden = true;
            warning.hidden = false;
            warningDone.hidden = false;
            captionsDone.hidden = true;
          });
          warningDone.addEventListener('click', () => {
            warning.hidden = true;
            captions.hidden = false;
            warningDone.hidden = true;
            captionsDone.hidden = false;
          });
          captionsDone.addEventListener('click', () => {
            editor.hidden = true;
            document.querySelector('[data-testid="tweetTextarea_0"]').hidden = false;
          });
        </script>
      `,
    );
    const result = await page.evaluate(async () => {
      const prepared = await CreatorXPublisherAdapter.prepare({
        caption: "Recorded caption",
        xOptions: { sensitive: true },
        async attachFile() {},
      });
      return {
        prepared,
        nudity: document.querySelector("#nudity").checked,
        violence: document.querySelector("#violence").checked,
        postClicks: 0,
      };
    });
    assert.equal(result.prepared.status, "prepared");
    assert.equal(result.nudity, true);
    assert.equal(result.violence, false);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X preparation accepts the selected filename Ready state with an enabled Post button", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/compose/post",
      `
        <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <input type="file" data-testid="fileInput" />
        <div role="status">preview-test.mp4: Ready</div>
        <button type="button" data-testid="tweetButton">Post</button>
      `,
    );
    const prepared = await page.evaluate(() =>
      CreatorXPublisherAdapter.prepare({
        caption: "Recorded caption",
        async attachFile() {
          return { name: "preview-test.mp4" };
        },
      }),
    );
    assert.equal(prepared.status, "prepared");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X scheduling prepares the named controls and final gated click stays unresolved until receipt evidence exists", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const scheduledDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    scheduledDate.setUTCMinutes(3, 0, 0);
    const timeZone = "Europe/Zurich";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(scheduledDate);
    const value = (type) => parts.find((part) => part.type === type).value;
    const scheduledUtc = scheduledDate.toISOString();
    const zoneName = new Intl.DateTimeFormat("en", {
      timeZone,
      timeZoneName: "long",
    })
      .formatToParts(scheduledDate)
      .find((part) => part.type === "timeZoneName").value;
    const expectedSummary = `Will send on ${new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(scheduledDate)} at ${new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(scheduledDate)}`;
    const { context, page } = await xPage(
      browser,
      "https://x.com/compose/post",
      `
        <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
        <input type="file" data-testid="fileInput" />
        <div role="status">preview-test.mp4: Ready</div>
        <button type="button" data-testid="tweetButton">Post</button>
        <button type="button" aria-label="Schedule post">Schedule post</button>
        <section id="schedule" hidden>
          <div>Time zone ${zoneName}</div>
          <select aria-labelledby="SELECTOR_6_LABEL"><option value="${value("month")}">${value("month")}</option></select>
          <span id="SELECTOR_6_LABEL">Month</span>
          <select aria-labelledby="SELECTOR_7_LABEL"><option value="${value("day")}">${value("day")}</option></select>
          <span id="SELECTOR_7_LABEL">Day</span>
          <select aria-labelledby="SELECTOR_8_LABEL"><option value="${value("year")}">${value("year")}</option></select>
          <span id="SELECTOR_8_LABEL">Year</span>
          <select aria-labelledby="SELECTOR_9_LABEL"><option value="${String(Number(value("hour")))}">${String(Number(value("hour")))}</option></select>
          <span id="SELECTOR_9_LABEL">Hour</span>
            <select aria-labelledby="SELECTOR_10_LABEL"><option value="${String(Number(value("minute")))}">${value("minute")}</option></select>
          <span id="SELECTOR_10_LABEL">Minute</span>
          <button id="confirm" type="button">Confirm</button>
        </section>
        <button id="summary" type="button" hidden></button>
        <script>
          const dialog = document.querySelector('#schedule');
          const finalButton = document.querySelector('[data-testid="tweetButton"]');
          const summary = document.querySelector('#summary');
          globalThis.__scheduleClicks = 0;
          document.querySelector('[aria-label="Schedule post"]').addEventListener('click', () => { dialog.hidden = false; });
          document.querySelector('#confirm').addEventListener('click', () => {
            dialog.hidden = true;
            summary.hidden = false;
            summary.textContent = ${JSON.stringify(expectedSummary)};
            finalButton.textContent = 'Schedule';
          });
          finalButton.addEventListener('click', () => { globalThis.__scheduleClicks += 1; });
        </script>
      `,
    );
    const result = await page.evaluate(
      async ({ scheduledUtc, timeZone, captionSha256 }) => {
        const xOptions = { sensitive: false, scheduledUtc, timeZone };
        const prepared = await CreatorXPublisherAdapter.prepare({
          caption: "Recorded caption",
          xOptions,
          async attachFile() {
            return { name: "preview-test.mp4" };
          },
        });
        const afterPrepare = {
          summary: document.querySelector("#summary").textContent,
          button: document.querySelector('[data-testid="tweetButton"]')
            .textContent,
          clicks: globalThis.__scheduleClicks,
        };
        const submitted = await CreatorXPublisherAdapter.submit({
          xOptions,
          captionSha256,
          async beforeCommit() {
            return { armed: true };
          },
        });
        return {
          prepared,
          afterPrepare,
          submitted,
          clicks: globalThis.__scheduleClicks,
        };
      },
      { scheduledUtc, timeZone, captionSha256: sha256Hex("Recorded caption") },
    );
    assert.equal(result.prepared.status, "prepared");
    assert.equal(result.afterPrepare.summary, expectedSummary);
    assert.equal(result.afterPrepare.button, "Schedule");
    assert.equal(result.afterPrepare.clicks, 0);
    assert.deepEqual(result.submitted, {
      platform: "x",
      status: "scheduled-unresolved",
      scheduledUtc,
    });
    assert.equal(result.clicks, 1);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("X preparation fails closed when the requested Nudity warning is ambiguous", async () => {
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
        <button type="button" aria-label="Edit media">Edit</button>
        <section id="media-editor" hidden>
          <div role="tab" aria-label="Captions">Captions</div>
          <div role="tab" aria-label="Content warning">Content warning</div>
          <div id="captions-panel">Captions</div>
          <div id="warning-panel" hidden>
            <label id="CHECKBOX_1_LABEL">Nudity</label>
            <input type="checkbox" aria-describedby="CHECKBOX_1_LABEL" />
            <label id="CHECKBOX_2_LABEL">Nudity</label>
            <input type="checkbox" aria-describedby="CHECKBOX_2_LABEL" />
          </div>
          <button id="warning-done" type="button" hidden>Done</button>
          <button id="captions-done" type="button">Done</button>
        </section>
        <script>
          const editor = document.querySelector('#media-editor');
          const captions = document.querySelector('#captions-panel');
          const warning = document.querySelector('#warning-panel');
          document.querySelector('[aria-label="Edit media"]').addEventListener('click', () => {
            editor.hidden = false;
            document.querySelector('[data-testid="tweetTextarea_0"]').hidden = true;
          });
          document.querySelector('[aria-label="Content warning"]').addEventListener('click', () => {
            captions.hidden = true;
            warning.hidden = false;
            document.querySelector('#warning-done').hidden = false;
            document.querySelector('#captions-done').hidden = true;
          });
        </script>
      `,
    );
    await assert.rejects(
      page.evaluate(() =>
        CreatorXPublisherAdapter.prepare({
          caption: "Recorded caption",
          xOptions: { sensitive: true },
          async attachFile() {},
        }),
      ),
      /Nudity warning checkbox is ambiguous/i,
    );
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
        <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0">Recorded caption</div>
        <div role="progressbar" aria-valuenow="100"></div>
        <button type="button" data-testid="tweetButton">Post</button>
      `,
    );
    const result = await page.evaluate(async (captionSha256) => {
      const order = [];
      document
        .querySelector('[data-testid="tweetButton"]')
        .addEventListener("click", () => order.push("post"));
      const submitted = await CreatorXPublisherAdapter.submit({
        captionSha256,
        async beforeCommit() {
          order.push("armed");
          return { armed: true };
        },
      });
      return { order, submitted };
    }, sha256Hex("Recorded caption"));
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
        resultId: "9000000000000000001",
        paidUrl: "https://onlyfans.com/123/creator",
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

const paidUrl = "https://onlyfans.com/123/creator";
const armedCaption = "Recorded caption";
const armedCaptionSha256 = sha256Hex(armedCaption);

for (const [name, mutate] of [
  ["the page left the compose route", () => history.pushState({}, "", "/home")],
  [
    "the caption changed",
    () => {
      document.querySelector('[data-testid="tweetTextarea_0"]').textContent =
        "Edited caption";
    },
  ],
]) {
  test(`X submit rejects without clicking when ${name} after arming`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const { context, page } = await xPage(
        browser,
        "https://x.com/compose/post",
        `
          <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0">${armedCaption}</div>
          <button type="button" data-testid="tweetButton">Post</button>
          <script>
            globalThis.__clicks = 0;
            document.querySelector('[data-testid="tweetButton"]').addEventListener("click", () => globalThis.__clicks++);
          </script>
        `,
      );
      const result = await page.evaluate(
        async ({ mutateSource, captionSha256 }) => {
          const mutate = new Function(`return (${mutateSource})`)();
          try {
            await CreatorXPublisherAdapter.submit({
              captionSha256,
              async beforeCommit() {
                mutate();
                return { armed: true };
              },
            });
            return { rejected: false, clicks: globalThis.__clicks };
          } catch (error) {
            return { rejected: true, clicks: globalThis.__clicks };
          }
        },
        { mutateSource: mutate.toString(), captionSha256: armedCaptionSha256 },
      );
      assert.deepEqual(result, { rejected: true, clicks: 0 });
      await context.close();
    } finally {
      await browser.close();
    }
  });
}

for (const [name, mutate] of [
  [
    "the current status id differs from the armed id",
    () =>
      history.pushState({}, "", "/RecordedCreator/status/9000000000000000009"),
  ],
  [
    "the editor no longer holds the paid URL",
    () => {
      document.querySelector('[data-testid="tweetTextarea_0"]').textContent =
        "Something else";
    },
  ],
]) {
  test(`X submitReply rejects without clicking when ${name} after arming`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const { context, page } = await xPage(
        browser,
        "https://x.com/RecordedCreator/status/9000000000000000001",
        `
          <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0">${paidUrl}</div>
          <button type="button" data-testid="tweetButtonInline">Reply</button>
          <script>
            globalThis.__clicks = 0;
            document.querySelector('[data-testid="tweetButtonInline"]').addEventListener("click", () => globalThis.__clicks++);
          </script>
        `,
      );
      const result = await page.evaluate(
        async ({ mutateSource, paidUrl }) => {
          const mutate = new Function(`return (${mutateSource})`)();
          try {
            await CreatorXPublisherAdapter.submitReply({
              resultId: "9000000000000000001",
              paidUrl,
              async beforeCommit() {
                mutate();
                return { armed: true };
              },
            });
            return { rejected: false, clicks: globalThis.__clicks };
          } catch (error) {
            return { rejected: true, clicks: globalThis.__clicks };
          }
        },
        { mutateSource: mutate.toString(), paidUrl },
      );
      assert.deepEqual(result, { rejected: true, clicks: 0 });
      await context.close();
    } finally {
      await browser.close();
    }
  });
}

const X_COMPOSE_PAGE = `
  <main>
    <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>
    <input type="file" data-testid="fileInput" />
    <div role="progressbar" aria-valuenow="100"></div>
    <button type="button" data-testid="tweetButton">Post</button>
  </main>
  <script>
    globalThis.__clicks = 0;
    globalThis.__arms = 0;
    document.querySelector('[data-testid="tweetButton"]').addEventListener("click", () => globalThis.__clicks++);
  </script>
`;

async function withXCompose(callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/compose/post",
      X_COMPOSE_PAGE,
    );
    await callback(page);
    await context.close();
  } finally {
    await browser.close();
  }
}

const prepareX = (page, caption) =>
  page.evaluate(
    (caption) =>
      CreatorXPublisherAdapter.prepare({
        caption,
        async attachFile() {},
      }),
    caption,
  );

const submitX = (page, captionSha256, hook) =>
  page.evaluate(
    async ({ captionSha256, hook }) => {
      if (hook) new Function(hook)();
      try {
        await CreatorXPublisherAdapter.submit({
          captionSha256,
          async beforeCommit() {
            globalThis.__arms++;
            return { armed: true };
          },
        });
        return { rejected: false, clicks: globalThis.__clicks };
      } catch (error) {
        return {
          rejected: true,
          message: error.message,
          clicks: globalThis.__clicks,
          arms: globalThis.__arms,
        };
      }
    },
    { captionSha256, hook },
  );

const EDITOR = `document.querySelector('[data-testid="tweetTextarea_0"]')`;

test("X prepare returns the hash of the composer text and submit posts once when it matches", async () => {
  await withXCompose(async (page) => {
    const prepared = await prepareX(page, "Recorded caption");
    assert.match(prepared.preparedCaptionSha256, /^[0-9a-f]{64}$/);
    assert.equal(prepared.preparedCaptionSha256, sha256Hex("Recorded caption"));
    const outcome = await submitX(page, prepared.preparedCaptionSha256);
    assert.equal(outcome.rejected, false);
    assert.equal(outcome.clicks, 1);
  });
});

for (const [name, edit] of [
  ["one space added", `${EDITOR}.textContent += " ";`],
  [
    "one character changed",
    `${EDITOR}.textContent = ${EDITOR}.textContent.replace("Line one", "Line onf");`,
  ],
  [
    "a line break removed",
    `${EDITOR}.textContent = ${EDITOR}.textContent.replace("\\n", "");`,
  ],
]) {
  test(`X submit rejects with zero clicks when ${name} after preparation`, async () => {
    await withXCompose(async (page) => {
      const prepared = await prepareX(page, "Line one\nLine two");
      const outcome = await submitX(page, prepared.preparedCaptionSha256, edit);
      assert.equal(outcome.rejected, true, JSON.stringify(outcome));
      assert.match(outcome.message, /caption/i);
      assert.equal(outcome.clicks, 0);
    });
  });
}

for (const [name, hash] of [
  ["missing", undefined],
  ["empty", ""],
  ["63 characters", "a".repeat(63)],
  ["uppercase", "A".repeat(64)],
]) {
  test(`X submit rejects a ${name} caption hash with zero clicks and no arm`, async () => {
    await withXCompose(async (page) => {
      await prepareX(page, "Recorded caption");
      const outcome = await submitX(page, hash);
      assert.equal(outcome.rejected, true, JSON.stringify(outcome));
      assert.equal(outcome.clicks, 0);
      assert.equal(outcome.arms, 0);
    });
  });
}

test("X prepare rejects an editor holding text unrelated to the approved caption", async () => {
  await withXCompose(async (page) => {
    await assert.rejects(
      page.evaluate(() =>
        CreatorXPublisherAdapter.prepare({
          caption: "Recorded caption",
          async attachFile() {
            document.querySelector(
              '[data-testid="tweetTextarea_0"]',
            ).textContent = "Something else entirely";
          },
        }),
      ),
      /caption/i,
    );
  });
});

test("X prepare tolerates whitespace-only rendering differences and hashes the exact editor text", async () => {
  await withXCompose(async (page) => {
    const prepared = await page.evaluate(() =>
      CreatorXPublisherAdapter.prepare({
        caption: "Line one\nLine two",
        async attachFile() {
          document.querySelector(
            '[data-testid="tweetTextarea_0"]',
          ).textContent = "Line one Line two ";
        },
      }),
    );
    assert.equal(
      prepared.preparedCaptionSha256,
      sha256Hex("Line one Line two "),
    );
  });
});

for (const [name, hook] of [
  [
    "the composer text changes while the hash is computed",
    `const digest = crypto.subtle.digest.bind(crypto.subtle);
     crypto.subtle.digest = async (...args) => {
       ${EDITOR}.textContent += "!";
       return digest(...args);
     };`,
  ],
  [
    "the route changes while the hash is computed",
    `const digest = crypto.subtle.digest.bind(crypto.subtle);
     crypto.subtle.digest = async (...args) => {
       history.pushState({}, "", "/home");
       return digest(...args);
     };`,
  ],
]) {
  test(`X submit rejects with zero clicks when ${name}`, async () => {
    await withXCompose(async (page) => {
      const prepared = await prepareX(page, "Caption");
      const outcome = await submitX(page, prepared.preparedCaptionSha256, hook);
      assert.equal(outcome.rejected, true, JSON.stringify(outcome));
      assert.equal(outcome.clicks, 0);
    });
  });
}

test("X submitReply requires the armed result id and paid URL", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, page } = await xPage(
      browser,
      "https://x.com/RecordedCreator/status/9000000000000000001",
      `
        <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0">https://onlyfans.com/1/creator</div>
        <button type="button" data-testid="tweetButtonInline">Reply</button>
        <script>
          globalThis.__clicks = 0;
          document.querySelector('[data-testid="tweetButtonInline"]').addEventListener("click", () => globalThis.__clicks++);
        </script>
      `,
    );
    for (const args of [
      { paidUrl: "https://onlyfans.com/1/creator" },
      { resultId: "9000000000000000001" },
      {},
    ]) {
      const outcome = await page.evaluate(async (args) => {
        let arms = 0;
        try {
          await CreatorXPublisherAdapter.submitReply({
            ...args,
            async beforeCommit() {
              arms++;
              return { armed: true };
            },
          });
          return { rejected: false };
        } catch {
          return { rejected: true, arms, clicks: globalThis.__clicks };
        }
      }, args);
      assert.deepEqual(outcome, { rejected: true, arms: 0, clicks: 0 });
    }
    await context.close();
  } finally {
    await browser.close();
  }
});
