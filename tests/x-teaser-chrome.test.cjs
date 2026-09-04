"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

test("personal Chrome manifest exposes the recorder without Firefox metadata", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, "0.20.0");
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.ok(manifest.host_permissions.includes("https://x.com/*"));
  assert.equal(
    manifest.optional_host_permissions.includes("https://x.com/*"),
    false,
  );
  assert.equal(manifest.browser_specific_settings, undefined);
  assert.match(
    fs.readFileSync(path.join(root, "popup.html"), "utf8"),
    /id="showTraceRecorder"/,
  );
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.match(background, /onCompleted/);
  assert.match(background, /onHistoryStateUpdated/);
  assert.match(background, /rebindXTeaserObservation/);
});

test("restored-status confirmation cannot reuse pre-confirmation audit frames", () => {
  const recorder = fs.readFileSync(path.join(root, "x-teaser.js"), "utf8");
  assert.match(recorder, /suppressAutoReconcile = true/);
  assert.match(recorder, /fileInput\.disabled = true/);
  assert.match(recorder, /frames = \[\]/);
  assert.match(
    recorder,
    /if \(suppressAutoReconcile \|\| frames\.length !== 3\)/,
  );
});

test("X observer captures one unambiguous canonical video status", () => {
  const context = { globalThis: {}, URL };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(root, "creator-tools", "x-teaser-observer.js"),
      "utf8",
    ),
    context,
  );
  const video = {
    duration: 12.5,
    poster: "https://pbs.twimg.com/amplify_video_thumb/a.jpg",
  };
  const article = {
    innerText: "teaser caption",
    querySelector(selector) {
      if (selector === "time[datetime]")
        return { dateTime: "2026-09-01T10:00:00.000Z" };
      if (selector === "video") return video;
      if (selector === "div[lang]") return { textContent: "teaser caption" };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "a[href]")
        return [{ href: "https://x.com/johnny_guides/status/123456789" }];
      return [];
    },
  };
  const document = {
    querySelectorAll: (selector) => (selector === "article" ? [article] : []),
  };
  const result = context.globalThis.CreatorXTeaserObserver.capture(
    document,
    "https://x.com/johnny_guides/status/123456789",
  );
  assert.equal(result.articleCount, 1);
  assert.equal(result.caption, "teaser caption");
  assert.equal(result.video, true);
  assert.equal(result.warningGate, false);
});

test("X observer fails closed for multiple articles and warning gates", () => {
  const context = { globalThis: {}, URL };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(root, "creator-tools", "x-teaser-observer.js"),
      "utf8",
    ),
    context,
  );
  const gated = {
    innerText: "Content warning",
    querySelector: () => null,
    querySelectorAll: (selector) =>
      selector === "a[href]"
        ? [{ href: "https://x.com/johnny_guides/status/123" }]
        : [{ textContent: "Show" }],
  };
  const result = context.globalThis.CreatorXTeaserObserver.capture(
    { querySelectorAll: () => [gated, gated] },
    "https://x.com/johnny_guides/status/123",
  );
  assert.equal(result.articleCount, 2);
  assert.equal(result.warningGate, true);
  assert.equal(result.video, false);
});

test("X observer ignores reply articles that do not own the current status URL", () => {
  const context = { globalThis: {}, URL };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(root, "creator-tools", "x-teaser-observer.js"),
      "utf8",
    ),
    context,
  );
  const article = (href, video) => ({
    innerText: "caption",
    querySelector: (selector) =>
      selector === "video"
        ? video
        : selector === "time[datetime]"
          ? { dateTime: "2026-09-01T10:00:00.000Z" }
          : selector === "div[lang]"
            ? { textContent: "caption" }
            : null,
    querySelectorAll: (selector) => (selector === "a[href]" ? [{ href }] : []),
  });
  const targetVideo = { duration: 4, poster: "https://pbs.twimg.com/a.jpg" };
  const result = context.globalThis.CreatorXTeaserObserver.capture(
    {
      querySelectorAll: () => [
        article("https://x.com/other/status/999", null),
        article("https://x.com/johnny_guides/status/123", targetVideo),
      ],
    },
    "https://x.com/johnny_guides/status/123",
  );
  assert.equal(result.articleCount, 1);
  assert.equal(result.video, true);
});
