"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = path.join(
  __dirname,
  "..",
  "creator-tools",
  "x-teaser-reconcile.js",
);

function fixture(stage = "status-captured") {
  const events = [];
  let session = {
    id: "session123",
    stage,
    pairing: {
      file: { basename: "teaser.mp4" },
      catalogue: {
        row: 9,
        id: "claire",
        title: "Claire",
        fingerprint: "1234abcd",
      },
    },
    capture: {
      statusId: "123",
      statusUrl: "https://x.com/johnny_guides/status/123",
    },
    auditReceipt:
      stage === "audit-complete" || stage === "sheet-complete"
        ? "receipt_123456789"
        : undefined,
  };
  const store = {
    load: async () => session,
    save: async (patch) => {
      events.push(`save:${patch.stage}`);
      session = { ...session, ...patch };
      return session;
    },
  };
  const nativeSend = async (request) => {
    events.push(`native:${request.operation}`);
    return request.operation === "audit"
      ? { auditOutcome: "updated", receipt: "receipt_123456789" }
      : { moveOutcome: "moved" };
  };
  const catalogueClient = {
    getCatalogueSnapshot: async () => {
      events.push("sheet:read");
      return { rows: [session.pairing.catalogue] };
    },
    appendTwitterTeaser: async () => {
      events.push("sheet:append");
      return { status: "updated" };
    },
  };
  return { events, store, nativeSend, catalogueClient };
}

test("reconciliation orders audit before Sheet before move", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8"), context);
  const value = fixture();
  const result = await context.globalThis.CreatorXTeaserReconcile.run({
    sessionId: "session123",
    frames: ["a", "b", "c"],
    ...value,
  });
  assert.equal(result.stage, "moved");
  assert.deepEqual(value.events, [
    "native:audit",
    "save:audit-complete",
    "sheet:read",
    "sheet:append",
    "save:sheet-complete",
    "native:move",
    "save:moved",
  ]);
});

test("reconciliation resumes after audit without repeating it", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8"), context);
  const value = fixture("audit-complete");
  await context.globalThis.CreatorXTeaserReconcile.run({
    sessionId: "session123",
    frames: [],
    ...value,
  });
  assert.equal(value.events.includes("native:audit"), false);
  assert.equal(value.events.at(-2), "native:move");
});

test("Sheet drift stops before append and move", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8"), context);
  const value = fixture("audit-complete");
  value.catalogueClient.getCatalogueSnapshot = async () => ({ rows: [] });
  await assert.rejects(
    () =>
      context.globalThis.CreatorXTeaserReconcile.run({
        sessionId: "session123",
        frames: [],
        ...value,
      }),
    /changed after pairing/,
  );
  assert.equal(
    value.events.some(
      (event) => event === "sheet:append" || event === "native:move",
    ),
    false,
  );
});

test("locked Sheet conflict never advances to move", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8"), context);
  const value = fixture("audit-complete");
  value.catalogueClient.appendTwitterTeaser = async () => ({
    status: "conflict",
  });
  await assert.rejects(
    () =>
      context.globalThis.CreatorXTeaserReconcile.run({
        sessionId: "session123",
        frames: [],
        ...value,
      }),
    /did not durably append/i,
  );
  assert.equal(value.events.includes("native:move"), false);
  assert.equal(value.events.includes("save:sheet-complete"), false);
});
