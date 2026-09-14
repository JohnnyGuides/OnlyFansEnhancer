"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { chromium } = require("../support/browser.cjs");

const repositoryRoot = require("../support/paths.cjs").personalRoot;
const recorderPath = path.join(
  repositoryRoot,
  "workflows",
  "upload-trace-recorder.js",
);
const registryPath = path.join(repositoryRoot, "workflows", "registry.js");
const commonPath = path.join(repositoryRoot, "workflows", "common.js");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function loadRecorderHooks() {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(recorderPath, "utf8"), context, {
    filename: "upload-trace-recorder.js",
  });
  return context.CreatorUploadTraceRecorder;
}

test("recorder is integrated into the personal toolkit and excluded from store", () => {
  const registryContext = vm.createContext({});
  vm.runInContext(read("workflows/registry.js"), registryContext, {
    filename: "registry.js",
  });
  const registry = registryContext.CreatorToolkitRegistry;
  const defaults = registry.normalizeSettings({}).value;

  assert.equal(fs.existsSync(recorderPath), true);
  assert.equal(registry.TOOL_DEFINITIONS.uploadTraceRecorder.mutates, false);
  assert.equal(defaults.tools.uploadTraceRecorder.enabled, true);
  assert.equal(defaults.tools.uploadTraceRecorder.autorun, false);
  assert.match(read("upload-console.html"), /id="toolUploadTraceRecorder"/);
  assert.doesNotMatch(read("options.html"), /id="toolUploadTraceRecorder"/);
  assert.match(
    JSON.stringify(require("../../packaging/extensions.json").personal),
    /workflows\/upload-trace-recorder\.js/,
  );
  assert.doesNotMatch(
    fs.readFileSync(
      path.join(require("../support/paths.cjs").storeRoot, "manifest.json"),
      "utf8",
    ),
    /upload-trace-recorder/i,
  );
  assert.doesNotMatch(
    JSON.stringify(require("../../packaging/extensions.json").store),
    /upload-trace-recorder/i,
  );
});

test("recorder sanitizers remove private data and bound duplicate events", () => {
  const hooks = loadRecorderHooks();

  assert.equal(hooks.platformFor("x.com"), "X");
  assert.equal(hooks.platformFor("www.redgifs.com"), "Redgifs");
  assert.equal(hooks.platformFor("studio.redgifs.com"), "Redgifs");
  assert.equal(hooks.platformFor("www.reddit.com"), "Reddit");
  assert.equal(
    hooks.candidatePostUrl(
      "https://x.com/johnny_guides/status/123456789?utm_source=private",
      "x.com",
    ),
    "https://x.com/johnny_guides/status/123456789",
  );
  assert.equal(
    hooks.candidatePostUrl(
      "https://www.redgifs.com/watch/safeslug?secret=private",
      "www.redgifs.com",
    ),
    "https://www.redgifs.com/watch/safeslug",
  );
  assert.equal(
    hooks.candidatePostUrl(
      "https://www.reddit.com/r/example/comments/abc123/a_title/?utm_source=private",
      "www.reddit.com",
    ),
    "https://www.reddit.com/r/example/comments/abc123/a_title",
  );
  assert.equal(
    hooks.candidatePostUrl(
      "https://www.reddit.com/r/example/submit?url=private",
      "www.reddit.com",
    ),
    "",
  );

  assert.equal(
    hooks.sanitizeUrl(
      "https://fansly.com/post/123?token=secret&caption=private#comments",
    ),
    "https://fansly.com/post/[id]",
  );
  assert.equal(
    hooks.sanitizeUrl(
      "https://www.pornhub.com/view_video.php?token=secret&viewkey=phabc123#x",
    ),
    "https://www.pornhub.com/[file].php",
  );
  assert.equal(
    hooks.sanitizeFilename("C:\\private\\creator\\episode (full).mp4"),
    "[redacted].mp4",
  );
  assert.equal(
    hooks.sanitizeResourceUrl(
      "https://fansly-upload.s3.eu-central-1.amazonaws.com/8ddff1e0-5678-4ed6-9a57-f51da14b0504/947128129548206081/episode%2520(full).mp4?token=secret",
    ),
    "https://fansly-upload.s3.eu-central-1.amazonaws.com/[id]/[id]/[file].mp4",
  );
  assert.equal(
    hooks.sanitizeResourceUrl(
      "https://onlyfans.com/api2/v2/upload/my-private-release/users/1234567/abcdef1234567890?token=secret",
    ),
    "https://onlyfans.com/api2/v2/upload/[id]/users/[id]/[id]",
  );
  assert.equal(
    hooks.sanitizeText(
      "Upload complete for creator@example.com at https://fansly.com/post/123?token=secret",
    ),
    "Upload complete for [email] at [url]",
  );

  let events = hooks.appendBoundedEvent(
    [],
    { type: "route", at: "first", ms: 0, data: { url: "/post/123" } },
    2,
  );
  events = hooks.appendBoundedEvent(
    events,
    { type: "route", at: "later", ms: 20, data: { url: "/post/123" } },
    2,
  );
  assert.equal(events.length, 1, "equivalent consecutive events must dedupe");
  events = hooks.appendBoundedEvent(
    events,
    { type: "click", at: "second", ms: 30, data: { tag: "button" } },
    2,
  );
  events = hooks.appendBoundedEvent(
    events,
    { type: "submit", at: "third", ms: 40, data: { tag: "form" } },
    2,
  );
  assert.equal(events.length, 2, "event cap must preserve a bounded trace");
});

test("recorder persists a sanitized two-click upload trace across refresh", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ acceptDownloads: true });

  try {
    await page.addInitScript(() => {
      const storageSlot = "__uploadTraceTestStorage";
      const listeners = new Set();
      const nativeGetComputedStyle =
        globalThis.getComputedStyle.bind(globalThis);

      globalThis.__uploadTraceStyleReads = 0;
      globalThis.getComputedStyle = (...args) => {
        globalThis.__uploadTraceStyleReads += 1;
        return nativeGetComputedStyle(...args);
      };

      function readAll() {
        return JSON.parse(sessionStorage.getItem(storageSlot) || "{}");
      }

      globalThis.chrome = globalThis.chrome || {};
      globalThis.chrome.storage = {
        local: {
          async get(keys) {
            const stored = readAll();
            const selected = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.hasOwn(stored, key)) {
                selected[key] = structuredClone(stored[key]);
              }
            }
            return selected;
          },
          async set(values) {
            const stored = readAll();
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
              changes[key] = {
                oldValue: stored[key],
                newValue: structuredClone(value),
              };
              stored[key] = structuredClone(value);
            }
            sessionStorage.setItem(storageSlot, JSON.stringify(stored));
            for (const listener of listeners) listener(changes, "local");
          },
          async remove(key) {
            const stored = readAll();
            delete stored[key];
            sessionStorage.setItem(storageSlot, JSON.stringify(stored));
          },
        },
        onChanged: {
          addListener(listener) {
            listeners.add(listener);
          },
          removeListener(listener) {
            listeners.delete(listener);
          },
        },
      };
    });

    await page.route("https://fansly.com/**", async (route) => {
      if (route.request().resourceType() === "fetch") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: "{}",
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `
          <main data-testid="upload-composer">
            <form id="upload-form" data-testid="upload-composer">
              <input id="video-file" name="video" type="file">
              <label for="audience">Audience</label>
              <select id="audience" name="audience">
                <option>Bisexual</option>
                <option>Gay</option>
              </select>
              <textarea id="caption">private caption creator@example.com</textarea>
              <input id="native-caption" role="textbox" aria-label="Caption" />
              <div id="rich-caption" role="textbox" contenteditable="true" aria-label="Post description"></div>
              <div id="plain-caption" contenteditable="plaintext-only"></div>
              <div id="custom-schedule" class="schedule-control" tabindex="0"><span id="schedule-label">Schedule post</span></div>
              <div id="schedule-day" class="calendar-day" tabindex="0"><span id="schedule-day-label">28</span></div>
              <div id="private-post-card" class="post-card" tabindex="0"><span id="private-post-card-label">Post my private episode title</span></div>
              <button id="private-action" type="button"><span id="private-action-label">Post my private button title</span></button>
              <button id="private-aria-action" type="button" aria-label="Post my private accessible title"><span>Post</span></button>
              <button id="private-title-action" type="button" title="Post my private title attribute"><span>Post</span></button>
              <button id="upload-button" type="submit"><span id="upload-button-label">Upload video</span></button>
            </form>
            <div id="upload-progress" role="progressbar" aria-valuenow="0">Uploading</div>
            <div id="private-status" role="status">Upload complete: My private status title</div>
            <a id="external-post" href="https://evil.example/post/my-private-external-title">View post</a>
            <a id="slug-post" href="/post/123/my-private-route-title">View post</a>
            <div style="display:none"><a id="ancestor-hidden-post" href="/post/999">View post</a></div>
            <a id="delayed-post" href="/post/456?token=private" hidden>View finished post</a>
            <div id="result"></div>
          </main>
        `,
      });
    });
    await page.route(
      "https://fansly-upload.s3.eu-central-1.amazonaws.com/**",
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "access-control-allow-origin": "*" },
          body: "",
        });
      },
    );

    await page.goto("https://fansly.com/upload?account=private");
    await page.addScriptTag({ path: recorderPath });
    await page.addScriptTag({ path: registryPath });
    await page.addScriptTag({ path: commonPath });
    const controlIds = await page.evaluate(() =>
      Object.fromEntries(
        [
          "rich-caption",
          "native-caption",
          "plain-caption",
          "custom-schedule",
          "schedule-day",
          "upload-button",
        ].map((id) => [
          id,
          CreatorUploadTraceRecorder.elementSignature(
            document.getElementById(id),
          ).id,
        ]),
      ),
    );
    assert.equal(
      await page.locator("#creator-upload-trace-recorder-host").count(),
      0,
      "an idle recorder must not cover the site until the user asks to see it",
    );
    await page.evaluate(() => CreatorUploadTraceRecorder.showPanel());
    await page.locator("#creator-upload-trace-recorder-host").waitFor();
    await page.getByRole("button", { name: "Hide trace recorder" }).click();
    assert.equal(
      await page.locator("#creator-upload-trace-recorder-host").count(),
      0,
      "hiding the recorder must remove its page overlay",
    );
    await page.evaluate(() => CreatorUploadTraceRecorder.showPanel());
    await page.locator("#creator-upload-trace-recorder-host").waitFor();
    const formBefore = await page
      .locator("#upload-form")
      .evaluate((form) => form.outerHTML);
    const platformStateBefore = await page
      .locator("#upload-form")
      .evaluate((form) => ({
        html: form.outerHTML,
        controls: Array.from(form.elements).map((control) => ({
          id: control.id,
          value: control.value,
          checked: "checked" in control ? control.checked : undefined,
          selectedIndex:
            "selectedIndex" in control ? control.selectedIndex : undefined,
        })),
        editors: Array.from(form.querySelectorAll("[contenteditable]")).map(
          (editor) => ({ id: editor.id, html: editor.innerHTML }),
        ),
      }));

    await page.getByRole("button", { name: "Start trace" }).click();
    await page.waitForTimeout(400);
    assert.deepEqual(
      await page.locator("#upload-form").evaluate((form) => ({
        html: form.outerHTML,
        controls: Array.from(form.elements).map((control) => ({
          id: control.id,
          value: control.value,
          checked: "checked" in control ? control.checked : undefined,
          selectedIndex:
            "selectedIndex" in control ? control.selectedIndex : undefined,
        })),
        editors: Array.from(form.querySelectorAll("[contenteditable]")).map(
          (editor) => ({ id: editor.id, html: editor.innerHTML }),
        ),
      })),
      platformStateBefore,
      "starting and polling the recorder must not mutate form markup or live values",
    );
    await page.evaluate(() => {
      const decoys = document.createElement("section");
      for (let index = 0; index < 1500; index += 1) {
        const button = document.createElement("button");
        button.textContent = `Profile item ${index}`;
        const link = document.createElement("a");
        link.href = `/profile/${index}`;
        link.textContent = `Profile link ${index}`;
        decoys.append(button, link);
      }
      document.body.append(decoys);
      globalThis.__uploadTraceStyleReads = 0;
    });
    await page.waitForTimeout(400);
    assert.ok(
      (await page.evaluate(() => globalThis.__uploadTraceStyleReads)) < 200,
      "a semantic snapshot must not style-check an unbounded feed DOM",
    );
    await page.locator("#audience").selectOption("Gay");
    await page.locator("#caption").fill("manual private learning text");
    await page.locator("#native-caption").fill("native private learning text");
    await page
      .locator("#rich-caption")
      .fill("rich editor private learning text");
    await page.locator("#plain-caption").evaluate((element) => {
      element.textContent = "\u200B \n";
      element.dispatchEvent(new InputEvent("input", { bubbles: true }));
      element.textContent = "plaintext private learning text";
      element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await page.locator("#schedule-label").click();
    await page.locator("#schedule-day-label").click();
    await page.locator("#private-post-card-label").click();
    await page.locator("#private-action-label").click();
    await page.locator("#private-aria-action span").click();
    await page.locator("#private-title-action span").click();
    await page.locator("#upload-button").focus();
    await page.evaluate(() => {
      const panel = CreatorToolkit.createToolPanel({
        id: "testAutofill",
        title: "Test autofill helper",
      });
      const runner = CreatorToolkit.createActionRunner({
        toolId: "testAutofill",
        panel,
        lifecycleSignal: new AbortController().signal,
      });
      panel.addAction({
        id: "preview",
        label: "Preview helper",
        onClick() {
          panel.showPlan({
            summary: "Review structured choices.",
            items: ["Audience: Bisexual"],
            confirmLabel: "Apply helper",
            onConfirm: () =>
              runner.run("Applying helper", async () => {
                CreatorToolkit.setControlValue(
                  document.querySelector("#caption"),
                  "plugin private learning text",
                );
                CreatorToolkit.setSelectValues(
                  document.querySelector("#audience"),
                  ["Bisexual"],
                );
                return {
                  status: "success",
                  summary: "Structured helper completed.",
                  items: [
                    {
                      label: "Audience Bisexual",
                      status: "changed",
                      detail: "sensitive result detail",
                    },
                  ],
                };
              }),
          });
        },
      });
    });
    await page.getByRole("button", { name: "Preview helper" }).click();
    await page.getByRole("button", { name: "Apply helper" }).click();
    await page.locator("#video-file").setInputFiles({
      name: "episode (full).mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("top-secret-video-bytes"),
    });
    await page.evaluate(() =>
      fetch(
        "https://fansly-upload.s3.eu-central-1.amazonaws.com/8ddff1e0-5678-4ed6-9a57-f51da14b0504/947128129548206081/episode%2520(full).mp4?token=secret",
      ),
    );
    await page.evaluate(() => {
      document
        .querySelector("#upload-form")
        .addEventListener("submit", (event) => event.preventDefault());
    });
    await page.locator("#upload-button-label").click();
    await page.evaluate(async () => {
      const result = document.querySelector("#result");
      result.innerHTML = `
        <div role="alert">Upload complete for creator@example.com</div>
        <a href="/post/123?token=secret">View published post</a>
      `;
      await fetch("/api/upload/finalize?token=secret");
      history.pushState({}, "", "/post/123?token=secret");
    });
    await page.waitForTimeout(900);
    await page
      .locator("#upload-progress")
      .evaluate((element) => element.setAttribute("aria-valuenow", "50"));
    await page.waitForTimeout(500);

    const signature = await page.evaluate(() => {
      const caption = document.querySelector("#caption");
      return CreatorUploadTraceRecorder.elementSignature(caption);
    });
    assert.doesNotMatch(JSON.stringify(signature), /private caption|@example/i);

    const traceBeforeReload = await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("__uploadTraceTestStorage"))
          .creatorUploadTraceRecorderV1,
    );
    assert.equal(traceBeforeReload.active, true);
    assert.equal(traceBeforeReload.platform, "Fansly");
    assert.match(
      JSON.stringify(traceBeforeReload),
      /"progress":"50"/,
      "progress-only attribute changes must produce a new semantic snapshot",
    );

    await page.reload();
    await page.addScriptTag({ path: recorderPath });
    await page.locator("#creator-upload-trace-recorder-host").waitFor();
    await page.getByRole("status").filter({ hasText: "Recording" }).waitFor();
    await page.waitForTimeout(500);
    await page
      .locator("#delayed-post")
      .evaluate((element) => (element.hidden = false));
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const progress = document.querySelector("#upload-progress");
          let value = 0;
          const churn = setInterval(() => {
            value = (value + 1) % 100;
            progress.setAttribute("aria-valuenow", String(value));
          }, 80);
          setTimeout(() => {
            clearInterval(churn);
            resolve();
          }, 1300);
        }),
    );

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Stop and download" }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const downloadedTrace = JSON.parse(fs.readFileSync(downloadPath, "utf8"));

    const traceAfterStop = await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("__uploadTraceTestStorage"))
          .creatorUploadTraceRecorderV1,
    );
    assert.equal(traceAfterStop.active, false);
    assert.equal(downloadedTrace.active, false);

    const eventTypes = new Set(
      downloadedTrace.events.map((event) => event.type),
    );
    for (const expectedType of [
      "session-start",
      "file-selected",
      "click",
      "submit",
      "semantic-snapshot",
      "resource",
      "route",
      "control-change",
      "toolkit-panel-action",
      "toolkit-control-action",
      "toolkit-run-start",
      "toolkit-run-result",
      "session-stop",
    ]) {
      assert.ok(eventTypes.has(expectedType), `missing ${expectedType} event`);
    }

    assert.ok(
      downloadedTrace.events.some(
        (event) =>
          event.type === "control-change" &&
          event.data.control?.id === controlIds["rich-caption"] &&
          event.data.valueState === "nonempty",
      ),
      "contenteditable description changes must be captured without their text",
    );
    assert.equal(
      downloadedTrace.events.find(
        (event) =>
          event.type === "control-change" &&
          event.data.control?.id === controlIds["native-caption"],
      )?.data.valueState,
      "nonempty",
      "native role=textbox inputs must read state from value, not textContent",
    );
    assert.deepEqual(
      downloadedTrace.events
        .filter(
          (event) =>
            event.type === "control-change" &&
            event.data.control?.id === controlIds["plain-caption"],
        )
        .map((event) => event.data.valueState),
      ["empty", "nonempty"],
      "plaintext-only editors must treat whitespace and zero-width text as empty",
    );
    assert.ok(
      downloadedTrace.events.some(
        (event) =>
          event.type === "click" &&
          event.data.control?.id === controlIds["custom-schedule"] &&
          event.data.control?.label === "Schedule post",
      ),
      "a nested click must resolve to its custom actionable ancestor",
    );
    assert.ok(
      downloadedTrace.events.some(
        (event) =>
          event.type === "click" &&
          event.data.control?.id === controlIds["schedule-day"] &&
          event.data.control?.label === "28",
      ),
      "a numeric calendar choice must retain its non-private label",
    );
    assert.ok(
      downloadedTrace.events.some(
        (event) =>
          event.type === "click" &&
          event.data.control?.id === controlIds["upload-button"],
      ),
      "a click on button content must resolve to the containing button",
    );
    assert.ok(
      downloadedTrace.events.some(
        (event) =>
          event.type === "semantic-snapshot" &&
          event.data.links?.includes("https://fansly.com/post/456"),
      ),
      "periodic snapshots must detect a result link revealed without a route change",
    );
    assert.ok(
      downloadedTrace.events.some(
        (event) =>
          event.type === "semantic-snapshot" &&
          event.data.statuses?.some(
            (status) =>
              status.states?.includes("upload") &&
              status.states?.includes("complete"),
          ),
      ),
      "status snapshots must retain only enumerated lifecycle states",
    );

    const serialized = JSON.stringify(downloadedTrace);
    assert.match(serialized, /\[redacted\]\.mp4/);
    assert.match(
      serialized,
      /fansly-upload\.s3\.eu-central-1\.amazonaws\.com\/\[id\]\/\[id\]\/\[file\]\.mp4/,
    );
    assert.doesNotMatch(serialized, /episode(?:%25?20| )\(full\)\.mp4/i);
    assert.match(serialized, /https:\/\/fansly\.com\/post\/123/);
    assert.match(serialized, /"actor":"user"/);
    assert.match(serialized, /"selectedLabels":\["opaque-\d+"\]/);
    assert.match(serialized, /"toolId":"opaque-\d+"/);
    assert.doesNotMatch(serialized, /Audience Bisexual|testAutofill|"Gay"/);
    assert.doesNotMatch(serialized, /top-secret-video-bytes/);
    assert.doesNotMatch(serialized, /private caption/);
    assert.doesNotMatch(serialized, /manual private learning text/);
    assert.doesNotMatch(serialized, /rich editor private learning text/);
    assert.doesNotMatch(serialized, /native private learning text/);
    assert.doesNotMatch(serialized, /plaintext private learning text/);
    assert.doesNotMatch(serialized, /my private episode title/);
    assert.doesNotMatch(serialized, /my private button title/);
    assert.doesNotMatch(serialized, /my private accessible title/);
    assert.doesNotMatch(serialized, /my private title attribute/);
    assert.doesNotMatch(serialized, /my private status title/);
    assert.doesNotMatch(serialized, /evil\.example/);
    assert.doesNotMatch(serialized, /my-private-route-title/);
    assert.doesNotMatch(serialized, /fansly\.com\/post\/999/);
    assert.doesNotMatch(serialized, /plugin private learning text/);
    assert.doesNotMatch(serialized, /sensitive result detail/);
    assert.doesNotMatch(serialized, /creator@example\.com/);
    assert.doesNotMatch(serialized, /token=secret|account=private/);
    assert.equal(
      await page.locator("#upload-form").evaluate((form) => form.outerHTML),
      formBefore,
      "the recorder must not mutate the platform form",
    );
  } finally {
    await browser.close();
  }
});
