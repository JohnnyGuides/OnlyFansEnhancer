"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = require("../support/paths.cjs").personalRoot;
test("physical worksheet indices are distinct from the 5000 item limit", () => {
  const context = vm.createContext({ URL });
  for (const file of ["catalogue-contract", "x-teaser-contract"])
    vm.runInContext(
      fs.readFileSync(path.join(root, `workflows/${file}.js`), "utf8"),
      context,
    );
  const contract = context.CreatorXTeaserContract;
  const file = {
    basename: "fixture.mp4",
    size: 1,
    lastModified: 1,
    duration: 1,
    sha256: "a".repeat(64),
  };
  const rows = [5000, 5001, 5002].map((row) => ({
    row,
    id: `fixture${row}`,
    title: "Fixture",
    fingerprint: "abcd1234",
  }));
  assert.equal(contract.rankCatalogueRows(file, rows).rows.length, 3);
  assert.throws(() =>
    contract.rankCatalogueRows(file, [{ ...rows[0], row: 5003 }]),
  );
  assert.throws(() =>
    contract.rankCatalogueRows(file, Array(5001).fill(rows[0])),
  );
});
