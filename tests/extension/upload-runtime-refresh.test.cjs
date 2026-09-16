"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(
  path.join(__dirname, "../../extensions/personal/background.js"),
  "utf8",
);
const bridgeFunction = source.slice(
  source.indexOf("function installCreatorUploadFileBridge("),
  source.indexOf("function installCreatorUploadResponseObserver("),
);
for (const revision of [undefined, "old-revision"]) {
  test(`stale page adapter ${revision} cannot install a new file bridge`, () => {
    let installed = 0;
    const context = vm.createContext({
      CreatorUploadPlatformAdapters: { revision },
      CreatorUploadFileBridge: {
        install() {
          installed++;
        },
      },
    });
    vm.runInContext(bridgeFunction, context);
    assert.throws(
      () => context.installCreatorUploadFileBridge({}),
      /stale.*runtime|reload.*page/i,
    );
    assert.equal(installed, 0);
  });
}
test("current adapter revision permits bridge installation without mutating old runs", () => {
  let installed = 0;
  const context = vm.createContext({
    CreatorUploadPlatformAdapters: {
      revision:
        "upload-hub-" +
        JSON.parse(
          fs.readFileSync(
            path.join(__dirname, "../../extensions/personal/manifest.json"),
            "utf8",
          ),
        ).version,
    },
    CreatorUploadFileBridge: {
      install() {
        installed++;
        return true;
      },
    },
  });
  vm.runInContext(bridgeFunction, context);
  assert.equal(context.installCreatorUploadFileBridge({}), true);
  assert.equal(installed, 1);
});

test("page adapter revision must identify the installed product version", () => {
  const base = path.resolve(__dirname, "../../extensions/personal");
  const version = JSON.parse(
    fs.readFileSync(path.join(base, "manifest.json"), "utf8"),
  ).version;
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(
      path.join(base, "workflows/upload-platform-adapters.js"),
      "utf8",
    ),
    context,
  );
  assert.equal(
    context.CreatorUploadPlatformAdapters.revision,
    "upload-hub-" + version,
  );
});
