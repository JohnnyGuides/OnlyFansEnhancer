"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { repositoryRoot } = require("../support/paths.cjs");
const context = vm.createContext({});
for (const file of [
  "extensions/personal/workflows/catalogue-contract.js",
  "shared/workspace/teaser-link-picker.js",
])
  vm.runInContext(
    fs.readFileSync(path.join(repositoryRoot, file), "utf8"),
    context,
  );
const rank = context.OFEnhancerTeaserLinkPicker.rank;

test("reply suggestions prioritize OnlyFans, then series, category and title similarity", () => {
  const reference = {
    title: "River rescue",
    description: "A rescue by the river",
    seasonArc: "River Stories",
    category: "Games",
  };
  const result = rank(
    [
      {
        id: "other",
        title: "Different story",
        platform: "onlyfans",
        category: "Other",
      },
      {
        id: "same-category",
        title: "River rescue aftermath",
        platform: "onlyfans",
        category: "Games",
      },
      {
        id: "same-series",
        title: "Next adventure",
        platform: "onlyfans",
        category: "Games",
        seasonArc: "River Stories",
      },
      {
        id: "manyvids",
        title: "River rescue",
        platform: "manyvids",
        category: "Games",
        seasonArc: "River Stories",
      },
    ],
    reference,
  );
  assert.deepEqual(
    Array.from(result, (row) => row.id),
    ["same-series", "same-category", "other", "manyvids"],
  );
  assert.equal(result[0].reason, "Same series");
  assert.equal(result[1].reason, "Same category");
});

test("reply search is accent insensitive and deterministic without shared metadata", () => {
  const videos = [
    { id: "b", title: "Café adventure", platform: "onlyfans" },
    { id: "a", title: "Café adventure", platform: "onlyfans" },
    { id: "c", title: "Different story", platform: "onlyfans" },
  ];
  assert.deepEqual(
    Array.from(rank(videos, {}, "cafe"), (row) => row.id),
    ["a", "b"],
  );
  assert.equal(videos[0].id, "b", "ranking does not mutate the catalogue");
  assert.equal(rank(videos, {}, "missing").length, 0);
});
