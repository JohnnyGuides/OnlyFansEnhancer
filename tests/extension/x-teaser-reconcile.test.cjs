"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = path.join(
  require("../support/paths.cjs").personalRoot,
  "workflows",
  "x-teaser-reconcile.js",
);

function fixture(stage = "status-captured") {
  const events = [];
  let session = {
    id: "session123",
    stage,
    reconciliationSource: {
      backend: "apps-script",
      workbookId: "fixture-workbook",
      sheetName: "Catalogue",
      endpoint:
        "https://script.google.com/macros/s/fixture12345678901234567890/exec",
    },
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
      if (patch.stage) events.push(`save:${patch.stage}`);
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
    getReconciliationSnapshot: async () => {
      events.push("sheet:read");
      return { rows: [session.pairing.catalogue] };
    },
    appendVerifiedTwitterTeaser: async () => {
      events.push("sheet:append");
      return { status: "updated" };
    },
  };
  const remoteCommit = {
    backend: "apps-script",
    workbookId: "fixture-workbook",
    sheetName: "Catalogue",
    row: 9,
    itemId: "claire",
    statusUrl: session.capture.statusUrl,
  };
  catalogueClient.appendVerifiedTwitterTeaser = async () => {
    events.push("sheet:append");
    return { status: "updated", remoteCommit };
  };
  return { events, store, nativeSend, catalogueClient, remoteCommit };
}

test("local idempotency and old sheet checkpoints cannot authorize a move", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8"), context);
  const value = fixture("audit-complete");
  for (const status of ["recorded-local", "idempotent", "idempotent"]) {
    value.catalogueClient.appendVerifiedTwitterTeaser = async () => ({
      status,
      googleSynced: false,
    });
    await assert.rejects(() =>
      context.globalThis.CreatorXTeaserReconcile.run({
        sessionId: "session123",
        ...value,
      }),
    );
    assert.equal(value.events.includes("native:move"), false);
  }
  const old = fixture("sheet-complete");
  await assert.rejects(() =>
    context.globalThis.CreatorXTeaserReconcile.run({
      sessionId: "session123",
      ...old,
    }),
  );
  assert.equal(old.events.includes("native:move"), false);
});

test("uncertain append retries only read and never submit the write again", async () => {
  const value = fixture("audit-complete");
  let appends = 0;
  value.catalogueClient.appendVerifiedTwitterTeaser = async () => {
    appends++;
    throw new Error("timeout after dispatch");
  };
  for (let restart = 0; restart < 3; restart++) {
    const context = { globalThis: {} };
    vm.runInNewContext(fs.readFileSync(source, "utf8"), context);
    await assert.rejects(() =>
      context.globalThis.CreatorXTeaserReconcile.run({
        sessionId: "session123",
        ...value,
      }),
    );
  }
  assert.equal(appends, 1);
  assert.equal(value.events.includes("native:move"), false);
});

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
  value.catalogueClient.getReconciliationSnapshot = async () => ({ rows: [] });
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
  value.catalogueClient.appendVerifiedTwitterTeaser = async () => ({
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

test("recovery recognizes an already-appended URL after checkpoint loss", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8"), context);
  const value = fixture("audit-complete");
  value.catalogueClient.getReconciliationSnapshot = async () => ({
    rows: [{ row: 9, id: "claire", fingerprint: "changed-by-column-o" }],
  });
  value.catalogueClient.appendVerifiedTwitterTeaser = async (payload) => {
    assert.equal(payload.fingerprint, "1234abcd");
    value.events.push("sheet:idempotent");
    return { status: "idempotent", remoteCommit: value.remoteCommit };
  };
  const result = await context.globalThis.CreatorXTeaserReconcile.run({
    sessionId: "session123",
    frames: [],
    ...value,
  });
  assert.equal(result.stage, "moved");
  assert.equal(value.events.includes("sheet:idempotent"), true);
});
