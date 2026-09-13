"use strict";
const path = require("node:path");
const repositoryRoot = path.resolve(__dirname, "../..");
module.exports = Object.freeze({
  repositoryRoot,
  personalRoot: path.join(repositoryRoot, "dist/extensions/personal"),
  storeRoot: path.join(repositoryRoot, "dist/extensions/store"),
  workspaceRoot: path.join(repositoryRoot, "shared/workspace"),
  catalogueBridge: path.join(
    repositoryRoot,
    "integrations/google-apps-script/catalogue-bridge.gs",
  ),
  fixturesRoot: path.join(repositoryRoot, "tests/fixtures"),
});
