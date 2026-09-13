"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const root = require("../support/paths.cjs").repositoryRoot;

function bridge() {
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
