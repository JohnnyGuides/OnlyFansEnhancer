"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const root = require("../support/paths.cjs").repositoryRoot;

function bridge(options = {}) {
  const rows = [Array(20).fill(""), Array(20).fill("")];
  Object.assign(rows[0], {
    0: "fixture-item",
    1: "2026-09-12",
    2: "Fixture",
    3: "Synthetic only",
  });
  rows[0][13] = "=COUNTA(O2)";
  const writes = [];
  let locks = 0;
  const sheet = {
    getLastRow: () => 2,
    getMaxRows: () => 3,
    getRange(row, column) {
      if (row === 2 && column === 1)
        return { getValues: () => structuredClone(rows) };
      return {
        setValue(value) {
          writes.push([row, column]);
          rows[row - 2][column - 1] = value;
        },
        setValues(values) {
          for (let i = 0; i < values[0].length; i++) {
            writes.push([row, column + i]);
            rows[row - 2][column - 1 + i] = values[0][i];
          }
        },
      };
    },
  };
  const context = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) =>
          key === "CREATOR_UPLOAD_SPREADSHEET_ID"
            ? "fixture-workbook"
            : "fixture-secret",
      }),
    },
    SpreadsheetApp: {
      openById: (id) => {
        assert.equal(id, "fixture-workbook");
        return { getSheetByName: () => sheet };
      },
      flush() {
        if (options.onFlush) options.onFlush(rows);
      },
    },
    Utilities: {
      formatDate: (date) => date.toISOString().slice(0, 10),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          locks++;
          return true;
        },
        releaseLock() {
          locks--;
        },
      }),
    },
  });
  vm.runInContext(
    fs.readFileSync(
      `${root}/integrations/google-apps-script/catalogue-bridge.gs`,
      "utf8",
    ),
    context,
  );
  return {
    context,
    rows,
    writes,
    locks: () => locks,
    current: () => context.creatorUploadReadRows(sheet)[0],
  };
}

test("Apps Script without URL globals commits supported URLs under its lock", () => {
  const value = bridge();
  const c = value.context;
  assert.equal(c.URL, undefined);
  let row = value.current();
  const result = c.creatorUploadHandle("commitPlatformLink", {
    row: 2,
    fingerprint: c.creatorUploadFingerprint(row),
    platform: "pornhub",
    postUrl: "https://www.pornhub.com/video/show?viewkey=fixture123",
    metadata: {},
  });
  assert.equal(result.status, "updated");
  assert.equal(
    value.rows[0][7],
    "https://www.pornhub.com/view_video.php?viewkey=fixture123",
  );
  row = value.current();
  const payload = {
    row: 2,
    id: row.id,
    fingerprint: c.creatorUploadFingerprint(row),
    statusUrl: "https://x.com/fixture/status/123",
    expectedSource: {
      backend: "apps-script",
      workbookId: "fixture-workbook",
      sheetName: "2026 Video Catalogue",
    },
  };
  const append = c.creatorUploadHandle("appendTwitterTeaser", payload);
  assert.equal(append.remoteCommit.itemId, "fixture-item");
  assert.equal(append.remoteCommit.workbookId, "fixture-workbook");
  const count = value.writes.length;
  assert.equal(
    c.creatorUploadHandle("appendTwitterTeaser", payload).status,
    "idempotent",
  );
  assert.equal(value.writes.length, count);
  assert.throws(
    () =>
      c.creatorUploadHandle("appendTwitterTeaser", {
        ...payload,
        expectedSource: {
          ...payload.expectedSource,
          workbookId: "other-workbook",
        },
      }),
    /source changed/,
  );
  assert.equal(value.writes.length, count);
  assert.equal(value.rows[0][13], "=COUNTA(O2)");
  assert.equal(value.locks(), 0);
});

function commitRequest(value, row, metadata, platform = "onlyfans") {
  return {
    row,
    fingerprint: value.context.creatorUploadFingerprint(
      value.context.creatorUploadReadRows({
        getMaxRows: () => 3,
        getLastRow: () => 2,
        getRange: () => ({ getValues: () => structuredClone(value.rows) }),
      })[row - 2],
    ),
    platform,
    postUrl: "https://onlyfans.com/123456789",
    metadata,
  };
}

const newRowMetadata = {
  id: "new-item",
  releaseDate: "2026-09-13",
  title: "New title",
  description: "New description",
};

test("link commit throws when the written link reads back changed", () => {
  const value = bridge({
    onFlush: (rows) => {
      rows[0][9] = "https://onlyfans.com/other";
    },
  });
  assert.throws(
    () =>
      value.context.creatorUploadHandle(
        "commitPlatformLink",
        commitRequest(value, 2, {}),
      ),
    /could not be verified/,
  );
  assert.equal(value.locks(), 0);
});

test("link commit on an empty row throws when metadata reads back changed", () => {
  const value = bridge({
    onFlush: (rows) => {
      rows[1][2] = "Replaced title";
    },
  });
  assert.throws(
    () =>
      value.context.creatorUploadHandle(
        "commitPlatformLink",
        commitRequest(value, 3, newRowMetadata),
      ),
    /could not be verified/,
  );
  assert.equal(value.locks(), 0);
});

test("link commit on an empty row throws when the id reads back changed", () => {
  const value = bridge({
    onFlush: (rows) => {
      rows[1][0] = "replaced-item";
    },
  });
  assert.throws(
    () =>
      value.context.creatorUploadHandle(
        "commitPlatformLink",
        commitRequest(value, 3, newRowMetadata),
      ),
    /could not be verified/,
  );
  assert.equal(value.locks(), 0);
});

test("link commit on an empty row throws when the release date reads back changed", () => {
  const value = bridge({
    onFlush: (rows) => {
      rows[1][1] = new Date("2026-09-14T00:00:00Z");
    },
  });
  assert.throws(
    () =>
      value.context.creatorUploadHandle(
        "commitPlatformLink",
        commitRequest(value, 3, newRowMetadata),
      ),
    /could not be verified/,
  );
  assert.equal(value.locks(), 0);
});

test("link commit on an empty row throws when the description reads back changed", () => {
  const value = bridge({
    onFlush: (rows) => {
      rows[1][3] = "Replaced description";
    },
  });
  assert.throws(
    () =>
      value.context.creatorUploadHandle(
        "commitPlatformLink",
        commitRequest(value, 3, newRowMetadata),
      ),
    /could not be verified/,
  );
  assert.equal(value.locks(), 0);
});

test("link commit with exact readback still returns updated", () => {
  const value = bridge();
  const result = value.context.creatorUploadHandle(
    "commitPlatformLink",
    commitRequest(value, 3, newRowMetadata),
  );
  assert.equal(result.status, "updated");
  assert.equal(result.row.id, "new-item");
  assert.equal(result.row.releaseDate, "2026-09-13");
  assert.equal(
    result.row.onlyfansLink,
    "https://onlyfans.com/123456789/johnny_guides",
  );
  assert.equal(value.locks(), 0);
});

const ledgerRequest = {
  eventId: "published",
  runId: "social-distribution-0001",
  jobId: "x",
  platform: "x",
  catalogueRow: 125,
  catalogueId: "fixture-item",
  resultId: "2094523397057237306",
  resultUrl: "https://x.com/fixture/status/2094523397057237306",
  status: "published",
  recordedAt: 1_788_280_000_000,
};

function ledgerBridge({
  lastRow,
  maxRows,
  existing = {},
  sheetExists = true,
} = {}) {
  const calls = { insertSheet: 0, appendRow: 0, setValues: 0, hideSheet: 0 };
  // Every sheet mutation in call order, with the row each one targets.
  const writes = [];
  const byRow = { ...existing };
  let locks = 0;
  let last = lastRow ?? 1;
  // Apps Script sheets have a fixed row count that only appendRow or an
  // explicit insert grows; a range starting past it throws.
  let rowLimit = maxRows ?? Math.max(1000, last);
  const sheet = {
    getLastRow: () => last,
    getMaxRows: () => rowLimit,
    insertRowsAfter(afterPosition, howMany) {
      writes.push(["insertRowsAfter", afterPosition, howMany]);
      rowLimit += howMany;
    },
    getRange(row, column, count, columns) {
      if (row > rowLimit)
        throw new Error("The starting row of the range is too large.");
      return {
        getValues: () =>
          Array.from(
            { length: count },
            (_, i) => byRow[row + i] || Array(10).fill(""),
          ),
        setNumberFormat(format) {
          writes.push(["setNumberFormat", row, column, count, columns, format]);
        },
        setValues(values) {
          calls.setValues++;
          writes.push(["setValues", row, values[0][0]]);
          byRow[row] = values[0];
          last = Math.max(last, row);
        },
      };
    },
    appendRow(cells) {
      calls.appendRow++;
      writes.push(["appendRow", last + 1, cells[0]]);
      last++;
      rowLimit = Math.max(rowLimit, last);
      if (cells[0] !== "Key") byRow[last] = cells;
    },
    hideSheet() {
      calls.hideSheet++;
    },
  };
  let created = sheetExists;
  const context = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: () => "fixture-workbook",
      }),
    },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name) =>
          name === "Creator Distribution Ledger" && created ? sheet : null,
        insertSheet() {
          calls.insertSheet++;
          created = true;
          last = 0;
          rowLimit = 1000;
          return sheet;
        },
      }),
      flush() {},
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          locks++;
          return true;
        },
        releaseLock() {
          locks--;
        },
      }),
    },
  });
  vm.runInContext(
    fs.readFileSync(
      `${root}/integrations/google-apps-script/catalogue-bridge.gs`,
      "utf8",
    ),
    context,
  );
  return { context, calls, writes, byRow, locks: () => locks };
}

function ledgerRow(request) {
  return [
    `${request.runId}:${request.jobId}:${request.eventId}`,
    request.runId,
    request.jobId,
    request.platform,
    request.catalogueRow,
    request.catalogueId,
    request.resultId,
    request.resultUrl,
    request.status,
    request.recordedAt,
  ];
}

test("ledger append at the last readable row succeeds and verifies", () => {
  const value = ledgerBridge({ lastRow: 19999 });
  const result = value.context.creatorUploadHandle(
    "appendDistributionLedger",
    ledgerRequest,
  );
  assert.equal(result.status, "updated");
  assert.equal(value.calls.setValues, 1);
  assert.equal(value.calls.appendRow, 0);
  assert.equal(value.locks(), 0);
});

test("ledger append beyond the readable range is rejected before writing", () => {
  const value = ledgerBridge({ lastRow: 20000 });
  assert.throws(
    () =>
      value.context.creatorUploadHandle(
        "appendDistributionLedger",
        ledgerRequest,
      ),
    /ledger is full/,
  );
  assert.equal(value.calls.appendRow, 0);
  assert.equal(value.calls.setValues, 0);
  assert.equal(value.locks(), 0);
});

test("ledger retry of an identical existing event stays idempotent at capacity", () => {
  const value = ledgerBridge({
    lastRow: 20000,
    existing: { 5: ledgerRow(ledgerRequest) },
  });
  const result = value.context.creatorUploadHandle(
    "appendDistributionLedger",
    ledgerRequest,
  );
  assert.equal(result.status, "idempotent");
  assert.equal(value.calls.appendRow, 0);
  assert.equal(value.calls.setValues, 0);
  assert.equal(value.locks(), 0);
});

test("invalid ledger payload creates and hides nothing", () => {
  const value = ledgerBridge({ sheetExists: false });
  assert.throws(
    () =>
      value.context.creatorUploadHandle("appendDistributionLedger", {
        ...ledgerRequest,
        platform: "unknown",
      }),
    /Invalid distribution ledger event/,
  );
  assert.deepEqual(
    { ...value.calls },
    {
      insertSheet: 0,
      appendRow: 0,
      setValues: 0,
      hideSheet: 0,
    },
  );
  assert.equal(value.locks(), 0);
});

test("valid ledger request without a sheet creates, hides and appends", () => {
  const value = ledgerBridge({ sheetExists: false });
  const result = value.context.creatorUploadHandle(
    "appendDistributionLedger",
    ledgerRequest,
  );
  assert.equal(result.status, "updated");
  assert.equal(value.calls.insertSheet, 1);
  assert.equal(value.calls.hideSheet, 1);
  assert.equal(value.calls.appendRow, 1);
  assert.equal(value.calls.setValues, 1);
  assert.equal(value.locks(), 0);
});

test("ledger append formats only the new row as text before writing it", () => {
  const value = ledgerBridge({
    lastRow: 5,
    existing: {
      5: ledgerRow({ ...ledgerRequest, eventId: "earlier" }),
    },
  });
  const result = value.context.creatorUploadHandle(
    "appendDistributionLedger",
    ledgerRequest,
  );
  assert.equal(result.status, "updated");
  assert.equal(result.row.resultId, "2094523397057237306");
  assert.deepEqual(value.writes, [
    ["setNumberFormat", 6, 1, 1, 10, "@"],
    ["setValues", 6, "social-distribution-0001:x:published"],
  ]);
});

test("ledger append at the sheet's row limit grows it by one row and verifies", () => {
  const value = ledgerBridge({
    lastRow: 1000,
    maxRows: 1000,
    existing: {
      1000: ledgerRow({ ...ledgerRequest, eventId: "earlier" }),
    },
  });
  const result = value.context.creatorUploadHandle(
    "appendDistributionLedger",
    ledgerRequest,
  );
  assert.equal(result.status, "updated");
  assert.equal(result.row.resultId, "2094523397057237306");
  assert.deepEqual(value.writes, [
    ["insertRowsAfter", 1000, 1],
    ["setNumberFormat", 1001, 1, 1, 10, "@"],
    ["setValues", 1001, "social-distribution-0001:x:published"],
  ]);
  assert.equal(value.byRow[1001][6], "2094523397057237306");
  assert.equal(value.locks(), 0);
});

test("ledger append with rows remaining does not grow the sheet", () => {
  const value = ledgerBridge({ lastRow: 999, maxRows: 1000 });
  const result = value.context.creatorUploadHandle(
    "appendDistributionLedger",
    ledgerRequest,
  );
  assert.equal(result.status, "updated");
  assert.deepEqual(value.writes, [
    ["setNumberFormat", 1000, 1, 1, 10, "@"],
    ["setValues", 1000, "social-distribution-0001:x:published"],
  ]);
});

test("ledger append on a new sheet formats the first event row, not the header", () => {
  const value = ledgerBridge({ sheetExists: false });
  const result = value.context.creatorUploadHandle(
    "appendDistributionLedger",
    ledgerRequest,
  );
  assert.equal(result.status, "updated");
  assert.deepEqual(value.writes, [
    ["appendRow", 1, "Key"],
    ["setNumberFormat", 2, 1, 1, 10, "@"],
    ["setValues", 2, "social-distribution-0001:x:published"],
  ]);
});
