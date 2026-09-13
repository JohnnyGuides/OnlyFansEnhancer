"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { chromium: engine } = require("playwright");

function browserExecutable() {
  const configured = process.env.OFENHANCER_CHROME_PATH;
  if (configured) {
    if (!fs.existsSync(configured))
      throw new Error("OFENHANCER_CHROME_PATH does not exist.");
    return configured;
  }
  const candidates = [
    engine.executablePath(),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ...[
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ]
      .filter(Boolean)
      .map((root) => path.join(root, "Google/Chrome/Application/chrome.exe")),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found)
    throw new Error(
      "Install Playwright Chromium or set OFENHANCER_CHROME_PATH.",
    );
  return found;
}

function options(value = {}) {
  return {
    ...value,
    executablePath:
      process.env.OFENHANCER_CHROME_PATH ||
      value.executablePath ||
      browserExecutable(),
    ...(process.env.OFENHANCER_HEADLESS === "1" ? { headless: true } : {}),
  };
}

module.exports = {
  browserExecutable,
  chromium: {
    executablePath: browserExecutable,
    launch: (value) => engine.launch(options(value)),
    launchPersistentContext: (profile, value) =>
      engine.launchPersistentContext(profile, options(value)),
    connectOverCDP: (...args) => engine.connectOverCDP(...args),
  },
};
