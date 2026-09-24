const test = require("node:test");
const assert = require("node:assert/strict");

test("season streak changes the first queue recommendation", async () => {
  const { recommendQueue } = await import("../../tools/x-teaser-planner.mjs");
  const catalogue = [
    { id: "s2", season: "Season 2" },
    { id: "s1", season: "Season 1" },
  ];
  const assets = [
    {
      assetId: "s2-a",
      catalogueId: "s2",
      state: "pending",
      basename: "s2.mp4",
    },
    {
      assetId: "s1-a",
      catalogueId: "s1",
      state: "pending",
      basename: "s1.mp4",
    },
  ];
  const posts = [0, 1, 2].map((index) => ({
    catalogueId: "s2",
    publishedAt: new Date(2026, 8, 20 - index).toISOString(),
  }));
  assert.equal(recommendQueue(catalogue, assets, posts)[0].catalogueId, "s1");
});

test("season streak counts consecutive posts only", async () => {
  const { recommendQueue } = await import("../../tools/x-teaser-planner.mjs");
  const catalogue = [
    { id: "s2", season: "Season 2" },
    { id: "s1", season: "Season 1" },
  ];
  const assets = [
    { assetId: "a", catalogueId: "s2", state: "pending", basename: "a.mp4" },
    { assetId: "b", catalogueId: "s1", state: "pending", basename: "b.mp4" },
  ];
  const posts = ["s2", "s1", "s2"].map((catalogueId, index) => ({
    catalogueId,
    publishedAt: new Date(2026, 8, 20 - index).toISOString(),
  }));
  assert.equal(recommendQueue(catalogue, assets, posts)[0].catalogueId, "s1");
});

test("queue does not recommend a linked row with no teasers left", async () => {
  const { recommendQueue } = await import("../../tools/x-teaser-planner.mjs");
  const catalogue = [
    { id: "posted", season: "Season 1", links: ["123"], unposted: 0 },
    { id: "ready", season: "Season 2", links: ["456"], unposted: 1 },
  ];
  const assets = catalogue.map((item) => ({
    assetId: item.id,
    basename: `${item.id}.mp4`,
    catalogueId: item.id,
    state: "pending",
  }));
  assert.deepEqual(
    recommendQueue(catalogue, assets, []).map((item) => item.catalogueId),
    ["ready"],
  );
});

test("revamp needs ten posts measured at comparable ages", async () => {
  const { performanceReview } =
    await import("../../tools/x-teaser-planner.mjs");
  const publishedAt = "2026-09-01T12:00:00Z";
  const posts = Array.from({ length: 10 }, (_, index) => ({
    statusId: String(index),
    publishedAt,
  }));
  const observedAt = "2026-09-02T12:00:00Z";
  const snapshots = posts.map((post, index) => ({
    statusId: post.statusId,
    observedAt,
    views: index === 0 ? 100 : 1000,
  }));
  assert.deepEqual(
    performanceReview(posts, snapshots)
      .filter((result) => result.status === "review-revamp")
      .map((result) => result.statusId),
    ["0"],
  );
  assert.equal(
    performanceReview(posts.slice(0, 9), snapshots)[0].status,
    "insufficient-cohort",
  );
});

test("reconciliation never infers a sheet row from an unpaired X post", async () => {
  const { reconcileTeasers } = await import("../../tools/x-teaser-planner.mjs");
  const result = reconcileTeasers({
    catalogue: [{ id: "item", links: ["1"], season: "S1" }],
    xPosts: [{ statusId: "2", teaser: true }, { statusId: "3" }],
    assets: [],
    receipts: [],
  });
  assert.deepEqual(result.xWithoutSheet, ["2"]);
  assert.deepEqual(result.xNeedsClassification, ["3"]);
  assert.deepEqual(result.sheetNotObservedOnX, ["1"]);
  assert.equal(result.queue.length, 0);
});
