"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(
  path.resolve(__dirname, "../../extensions/personal/upload-console.js"),
  "utf8",
);
function span(startText, endText) {
  const start = source.indexOf(startText),
    end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
test("a late retry result from an old draft cannot populate a new draft queue", async () => {
  const changes = [];
  let reply;
  const context = vm.createContext({
    activeSession: { id: "old-session" },
    setPlatformState: (platform, state) => changes.push({ platform, state }),
    sendMessage: () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  });
  vm.runInContext(
    span(
      "    async function retryPlatform(",
      "    async function recheckProposalBeforeUpload(",
    ),
    context,
  );
  const pending = context.retryPlatform("fansly", { disabled: false });
  assert.equal(changes.length, 1);
  context.activeSession.closed = true;
  context.activeSession = { id: "new-session" };
  reply({
    results: [{ platform: "fansly", status: "manual-submit-required" }],
  });
  await pending;
  assert.equal(changes.length, 1, "Old reply must not resurrect its card");
});
test("a late social observation result cannot resurrect a retired draft queue", async () => {
  let task, reply;
  const changes = [];
  const context = vm.createContext({
    activeSession: { id: "old-session" },
    socialPollTimer: null,
    clearTimeout() {},
    setTimeout: (fn) => {
      task = fn;
      return 1;
    },
    sendMessage: () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
    applySocialJob: (job) => changes.push(job),
    setPlatformState: (p, s) => changes.push(s),
  });
  vm.runInContext(
    span("    function scheduleSocialResume(", "    function randomSessionId("),
    context,
  );
  context.scheduleSocialResume("old-session", { stage: "waiting" });
  const pending = task();
  context.activeSession.closed = true;
  context.activeSession = { id: "new-session" };
  reply({ socialDistribution: { jobs: { x: { stage: "sheet-complete" } } } });
  await pending;
  assert.equal(
    changes.length,
    0,
    "Old observation must not resurrect its card",
  );
});
