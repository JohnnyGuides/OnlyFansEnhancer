"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = require("../support/paths.cjs").repositoryRoot;
function implementations() {
  const js = vm.createContext({ URL });
  vm.runInContext(
    fs.readFileSync(
      path.join(root, "extensions/personal/workflows/catalogue-contract.js"),
      "utf8",
    ),
    js,
  );
  // Apps Script V8 has neither URL nor URLSearchParams.
  const gas = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(
      path.join(root, "integrations/google-apps-script/catalogue-bridge.gs"),
      "utf8",
    ),
    gas,
  );
  return [
    js.CreatorCatalogueContract,
    {
      canonicalPostUrl: gas.creatorUploadCanonicalUrl,
      canonicalXStatusUrl: gas.creatorUploadCanonicalTwitterStatus,
      canonicalRedditPostUrl: gas.creatorUploadCanonicalRedditPost,
    },
  ];
}
test("supported Pornhub aliases work without browser globals", () => {
  for (const api of implementations())
    for (const route of ["view_video.php", "video/show"]) {
      assert.equal(
        api.canonicalPostUrl(
          "pornhub",
          `https://www.pornhub.com/${route}?viewkey=abc_123`,
        ),
        "https://www.pornhub.com/view_video.php?viewkey=abc_123",
      );
    }
});
test("URL evidence rejects foreign authority and ambiguous parameters", () => {
  for (const api of implementations()) {
    assert.equal(
      api.canonicalRedditPostUrl(
        "https://www.reddit.com/r/fixture/comments/abc123/title/",
      ),
      "https://www.reddit.com/r/fixture/comments/abc123/title",
    );
    for (const authority of [
      "user:secret@x.com",
      "x.com:444",
      "x.com.evil.test",
    ])
      assert.equal(
        api.canonicalXStatusUrl(`https://${authority}/fixture/status/123`),
        null,
      );
    for (const authority of [
      "user:secret@www.reddit.com",
      "www.reddit.com:444",
      "www.reddit.com.evil.test",
    ])
      assert.equal(
        api.canonicalRedditPostUrl(
          `https://${authority}/r/fixture/comments/abc123/title`,
        ),
        null,
      );
    for (const suffix of ["&viewkey=second", "&other=1", "#fragment"])
      assert.equal(
        api.canonicalPostUrl(
          "pornhub",
          `https://www.pornhub.com/view_video.php?viewkey=abc123${suffix}`,
        ),
        null,
      );
    for (const suffix of ["?utm_source=share", "#fragment"])
      assert.equal(
        api.canonicalRedditPostUrl(
          `https://www.reddit.com/r/fixture/comments/abc123/title${suffix}`,
        ),
        null,
      );
  }
});
