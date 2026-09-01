"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = path.resolve(__dirname, "..");
const contractPath = path.join(
  repositoryRoot,
  "creator-tools/social-trace-contract.js",
);

function loadContract() {
  const context = vm.createContext({ URL });
  if (fs.existsSync(contractPath)) {
    vm.runInContext(fs.readFileSync(contractPath, "utf8"), context, {
      filename: "creator-tools/social-trace-contract.js",
    });
  }
  assert.ok(
    context.CreatorSocialTraceContract,
    "CreatorSocialTraceContract must be exposed",
  );
  return context.CreatorSocialTraceContract;
}

function fixture(name) {
  return JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, "tests/fixtures/social-traces", name),
      "utf8",
    ),
  );
}

test("accepts the recorded X post, preview dismissal, first reply, and canonical results", () => {
  const result = loadContract().validate(fixture("x-success.json"), "X");
  assert.equal(result.successfulFlow, true);
  assert.equal(result.mainResultId, "9000000000000000001");
  assert.equal(result.replyResultId, "9000000000000000002");
  assert.equal(result.linkPreviewDismissed, true);
  assert.equal(result.deleteConfirmationCount, 2);
  assert.deepEqual([...result.privateDataFindings], []);
});

test("refuses X evidence that omits the OnlyFans preview-card dismissal", () => {
  const trace = fixture("x-success.json");
  trace.events.splice(8, 1);
  const result = loadContract().validate(trace, "X");
  assert.equal(result.successfulFlow, false);
  assert.match(result.errors.join(" "), /preview card/i);
});

test("reports private paths, headers, and entered values instead of accepting them", () => {
  const trace = fixture("x-success.json");
  trace.events.push({
    ms: 18000,
    type: "unsafe-test-event",
    data: {
      path: "C:\\private\\teaser.mp4",
      authorization: "Bearer secret-value",
      value: "private caption text",
    },
  });
  const result = loadContract().validate(trace, "X");
  assert.equal(result.successfulFlow, false);
  assert.deepEqual([...result.privateDataFindings].sort(), [
    "entered-value",
    "header-shaped-secret",
    "local-path",
  ]);
});

test("preserves the recorded X schedule-menu evidence without claiming labelled selects", () => {
  const result = loadContract().inspectSchedule(
    fixture("x-schedule-menu.json"),
  );
  assert.equal(result.menuObserved, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.selectChanges, 6);
  assert.equal(result.controlsIdentified, false);
});
