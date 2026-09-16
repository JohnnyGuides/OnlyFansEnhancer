"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { chromium } = require("../support/browser.cjs");
const root = path.resolve(__dirname, "../../extensions/personal");
const source = fs.readFileSync(path.join(root, "background.js"), "utf8");
function span(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(
    start >= 0 && end > start,
    "Missing foreground-observation production boundary: " + from,
  );
  return source.slice(start, end);
}
function bindingFixture({
  busy = false,
  changed = false,
  denied = false,
} = {}) {
  const events = [];
  const port = {};
  const target = {
    platform: "manyvids",
    stage: "upload",
    status: "uploading-full",
    tabId: 12,
    documentId: "owned-document",
    boundUrl: "https://www.manyvids.com/upload-video",
  };
  const session = {
    id: "owned-session",
    executionPort: port,
    platforms: new Map([["manyvids", target]]),
  };
  const sender = {
    tab: { id: 12 },
    documentId: target.documentId,
    frameId: 0,
    url: target.boundUrl,
  };
  let frame = {
    frameId: 0,
    documentId: target.documentId,
    url: target.boundUrl,
  };
  let active = false;
  let focused = false;
  const sandbox = vm.createContext({
    Date,
    Promise,
    URL,
    Map,
    Set,
    creatorUploadFileRequests: new Map(busy ? [["pending-file", {}]] : []),
    creatorUploadForeground: null,
    CREATOR_UPLOAD_TERMINAL_STATUSES: new Set([
      "failed",
      "manual-submit-required",
    ]),
    creatorUploadPort: () => port,
    chrome: {
      tabs: {
        get: async () => ({ id: 12, windowId: 4, url: frame.url, active }),
        update: async (tabId, patch) => {
          assert.equal(tabId, 12);
          assert.deepEqual(Object.keys(patch), ["active"]);
          assert.equal(patch.active, true);
          events.push("activate-owned-tab");
          active = true;
          if (changed) frame = { ...frame, documentId: "replacement-document" };
          return { id: 12, windowId: 4, active, url: frame.url };
        },
      },
      windows: {
        update: async (windowId, patch) => {
          assert.equal(windowId, 4);
          assert.deepEqual(Object.keys(patch), ["focused"]);
          assert.equal(patch.focused, true);
          events.push("focus-owned-window");
          focused = !denied;
          return { id: 4, focused };
        },
        get: async () => ({ id: 4, focused }),
      },
      webNavigation: { getAllFrames: async () => [{ ...frame }] },
    },
  });
  vm.runInContext(
    span(
      "async function assertCreatorUploadPageBinding(",
      "function creatorUploadSessionRecord(",
    ),
    sandbox,
  );
  vm.runInContext(
    span(
      "async function focusCreatorUploadObservation(",
      "function creatorUploadRandomToken(",
    ),
    sandbox,
  );
  return {
    target,
    session,
    sender,
    events,
    sandbox,
    run: () => sandbox.focusCreatorUploadObservation(session, target, sender),
  };
}
test("foreground assist activates only the exact bound upload tab and its window without navigation", async () => {
  const f = bindingFixture();
  const before = JSON.stringify(f.target);
  const result = await f.run();
  assert.equal(result.focused, true);
  assert.deepEqual(f.events, ["activate-owned-tab", "focus-owned-window"]);
  assert.equal(f.target.documentId, "owned-document");
  assert.equal(f.target.boundUrl, "https://www.manyvids.com/upload-video");
  assert.equal(f.target.stage, "upload");
  assert.ok(before.includes("owned-document"));
});
test("foreground assist defers while any sibling file delivery owns browser interaction", async () => {
  const f = bindingFixture({ busy: true });
  assert.equal((await f.run()).deferred, true);
  assert.deepEqual(f.events, []);
});
for (const kind of [
  "tab",
  "document",
  "frame",
  "route",
  "cancelled",
  "port",
  "editor",
  "submitted",
  "foreign-platform",
]) {
  test(
    "foreground assist rejects " + kind + " without any focus action",
    async () => {
      const f = bindingFixture();
      if (kind === "tab") f.sender.tab.id++;
      if (kind === "document") f.sender.documentId = "foreign-document";
      if (kind === "frame") f.sender.frameId = 1;
      if (kind === "route") f.sender.url += "?foreign=1";
      if (kind === "cancelled") f.session.cancelled = true;
      if (kind === "port") f.session.executionPort = {};
      if (kind === "editor") f.target.stage = "edit";
      if (kind === "submitted") f.target.submitAttempted = true;
      if (kind === "foreign-platform") f.target.platform = "pornhub";
      await assert.rejects(f.run());
      assert.deepEqual(f.events, []);
    },
  );
}
test("document replacement during activation stops before window focus", async () => {
  const f = bindingFixture({ changed: true });
  await assert.rejects(f.run(), /binding|document/);
  assert.deepEqual(f.events, ["activate-owned-tab"]);
});
test("denied real window focus is visible failure and never replays automatically", async () => {
  const f = bindingFixture({ denied: true });
  await assert.rejects(f.run(), /focus|foreground/i);
  assert.deepEqual(f.events, ["activate-owned-tab", "focus-owned-window"]);
});

for (const variant of ["owned", "focus-denied", "foreign-card"]) {
  test(
    "ManyVids only adopts its completion editor after foreground observation: " +
      variant,
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          '<div class="uppy-Dashboard"><input type="file" class="uppy-Dashboard-input" hidden><button class="uppy-StatusBar-actionBtn--upload" hidden>Upload 1 file</button></div>',
        );
        await page.addScriptTag({
          path: path.join(root, "workflows/upload-platform-adapters.js"),
        });
        const result = await page.evaluate(async (variant) => {
          const events = [];
          const checkpoints = [];
          const dashboard = document.querySelector(".uppy-Dashboard");
          const upload = dashboard.querySelector("button");
          let card;
          let foreground = false;
          Object.defineProperty(document, "hasFocus", {
            value: () => foreground,
            configurable: true,
          });
          Object.defineProperty(document, "visibilityState", {
            get: () => (foreground ? "visible" : "hidden"),
            configurable: true,
          });
          const reveal = () => {
            if (
              !foreground ||
              !card.matches(".is-complete") ||
              card.querySelector("a")
            )
              return;
            const edit = document.createElement("a");
            edit.textContent = "Edit";
            edit.href = "https://www.manyvids.com/Edit-vid/123456";
            edit.onclick = (event) => {
              event.preventDefault();
              events.push("edit");
            };
            card.append(edit);
          };
          upload.onclick = () => {
            events.push("upload");
            card.dataset.state = "uploading";
            setTimeout(() => {
              card.classList.add("is-complete");
              if (variant === "foreign-card") {
                const other = card.cloneNode(true);
                other.dataset.uploadId = "foreign";
                card.replaceWith(other);
                card = other;
              }
              reveal();
            }, 120);
          };
          const result = await CreatorUploadPlatformAdapters.runManyVidsUpload({
            draft: { fullFilename: "neutral.mp4", publishMode: "manual" },
            signal: AbortSignal.timeout(1800),
            attachFile: async () => {
              events.push("file");
              card = document.createElement("article");
              card.className = "uppy-Dashboard-Item";
              card.dataset.uploadId = "owned";
              card.innerHTML =
                '<span class="uppy-Dashboard-Item-name">neutral.mp4</span>';
              dashboard.append(card);
              upload.hidden = false;
              return { role: "full", name: "neutral.mp4", size: 8 };
            },
            focusPage: async () => {
              events.push("focus-request");
              if (variant === "focus-denied")
                throw new Error(
                  "ManyVids foreground denied; activate the existing upload tab.",
                );
              foreground = true;
              reveal();
              return { focused: true };
            },
            checkpointStep: async (action, id, outcome, details) =>
              checkpoints.push({ action, id, outcome, details }),
          }).catch((error) => ({ status: "failed", error: error.message }));
          return { result, events, checkpoints };
        }, variant);
        assert.equal(result.events.filter((e) => e === "file").length, 1);
        assert.equal(result.events.filter((e) => e === "upload").length, 1);
        assert.equal(
          result.events.filter((e) => e === "focus-request").length,
          1,
        );
        if (variant === "owned") {
          assert.equal(
            result.result.status,
            "edit-requested",
            result.result.error,
          );
          assert.equal(result.events.filter((e) => e === "edit").length, 1);
          assert.deepEqual(result.checkpoints.at(-1).details, {
            destinationUrl: "https://www.manyvids.com/Edit-vid/123456",
            videoId: "123456",
          });
        } else {
          assert.equal(result.result.status, "failed");
          assert.equal(result.events.includes("edit"), false);
          assert.match(result.result.error, /foreground|identity|changed/i);
        }
      } finally {
        await browser.close();
      }
    },
  );
}

test("foreground observation defers during a sibling platform's composer interaction", async () => {
  const f = bindingFixture();
  f.session.platforms.set("fansly", {
    platform: "fansly",
    status: "configuring",
  });
  assert.equal((await f.run()).deferred, true);
  assert.deepEqual(f.events, []);
});

for (const drift of ["moved-window", "sibling-interaction"]) {
  test(
    "foreground assist rechecks " +
      drift +
      " between tab and window activation",
    async () => {
      const f = bindingFixture();
      const update = f.sandbox.chrome.tabs.update;
      f.sandbox.chrome.tabs.update = async (...args) => {
        const result = await update(...args);
        if (drift === "moved-window") {
          const get = f.sandbox.chrome.tabs.get;
          f.sandbox.chrome.tabs.get = async (...getArgs) => ({
            ...(await get(...getArgs)),
            windowId: 99,
          });
        } else {
          f.session.platforms.set("fansly", {
            platform: "fansly",
            status: "configuring",
          });
        }
        return result;
      };
      if (drift === "moved-window")
        await assert.rejects(f.run(), /tab|window|changed/i);
      else assert.equal((await f.run()).deferred, true);
      assert.deepEqual(
        f.events,
        ["activate-owned-tab"],
        "Never focus an outdated window or interrupt a newly interactive sibling",
      );
    },
  );
}
