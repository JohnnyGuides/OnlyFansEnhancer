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
  assert.equal(manifest.version, "0.14.0");
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.ok(manifest.optional_host_permissions.includes("https://x.com/*"));
  assert.equal(manifest.browser_specific_settings, undefined);
  assert.match(
    fs.readFileSync(path.join(root, "popup.html"), "utf8"),
    /id="xTeaserRecorder"/,
  );
});

test("X observer captures one unambiguous canonical video status", () => {
  const context = { globalThis: {} };
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
    querySelectorAll() {
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
  const context = { globalThis: {} };
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
    querySelectorAll: () => [{ textContent: "Show" }],
  };
  const result = context.globalThis.CreatorXTeaserObserver.capture(
    { querySelectorAll: () => [gated, gated] },
    "https://x.com/johnny_guides/status/123",
  );
  assert.equal(result.articleCount, 2);
  assert.equal(result.warningGate, true);
  assert.equal(result.video, false);
});
