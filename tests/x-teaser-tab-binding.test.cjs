"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("stale Chrome binding never silently chooses among restored X tabs", () => {
  const context = { globalThis: {} };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "..", "creator-tools", "x-teaser-tab-binding.js"),
      "utf8",
    ),
    context,
  );
  const canonical = (url) => (/\/status\/\d+$/.test(url) ? url : null);
  const choose = context.globalThis.CreatorXTeaserTabBinding.choose;
  assert.equal(choose([], canonical).action, "open-compose");
  assert.equal(
    choose([{ id: 1, url: "https://x.com/compose/post" }], canonical).action,
    "bind",
  );
  assert.deepEqual(
    {
      ...choose(
        [{ id: 2, url: "https://x.com/johnny_guides/status/123" }],
        canonical,
      ),
    },
    {
      action: "confirm-status",
      tabId: 2,
      statusUrl: "https://x.com/johnny_guides/status/123",
    },
  );
  assert.equal(
    choose(
      [
        { id: 1, url: "https://x.com/home" },
        { id: 2, url: "https://x.com/johnny_guides/status/123" },
      ],
      canonical,
    ).action,
    "ambiguous",
  );
});
