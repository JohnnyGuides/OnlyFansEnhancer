"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

const root = require("../support/paths.cjs").workspaceRoot;
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "compact", width: 800, height: 700 },
  { name: "mobile", width: 390, height: 844 },
];

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function main() {
  assert.equal(
    fs.existsSync(path.join(root, "index.html")),
    true,
    "shared app is missing",
  );
  const server = http.createServer((request, response) => {
    const requested = new URL(request.url, "http://127.0.0.1").pathname;
    const relative = requested === "/" ? "index.html" : requested.slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": contentType(file) });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    await testOfflineBridgeRecovery(browser, address.port);
    await testChromeReadinessStates(browser, address.port);
    await testStaleChromeObservation(browser, address.port);
    await testChromeExtensionsCopyAndConnectedAction(browser, address.port);
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        globalThis.__OFENHANCER_TEST_HOST__ = async (operation) => {
          if (operation === "getStatus") {
            return {
              productVersion: "0.20.45",
              protocolVersion: 1,
              capabilities: [
                "desktop-shell",
                "local-file-attach",
                "native-bridge",
                "chrome-readiness",
              ],
              testData: true,
            };
          }
          if (operation === "getChromeReadiness")
            return {
              state: "not-found",
              chromeFound: false,
              prepared: false,
              message:
                "Google Chrome was not found in the standard installation locations.",
            };
          if (operation === "openChromeUploader")
            return { opened: true, testData: true };
          throw new Error("unsupported-operation");
        };
      });
      await page.goto(`http://127.0.0.1:${address.port}/index.html`);
      await page
        .locator("#connectionLabel")
        .getByText("Chrome not found", { exact: true })
        .waitFor();
      assert.equal(
        await page.locator("body").getAttribute("data-connected"),
        "false",
      );

      assert.equal(
        await page.getByRole("navigation").count(),
        1,
        viewport.name,
      );
      assert.equal(
        await page.getByRole("button", { name: "Upload a video" }).count(),
        1,
        viewport.name,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${viewport.name} overflows`,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await page.locator(":focus-visible").count(),
        1,
        `${viewport.name} focus`,
      );
      await page.getByRole("button", { name: "Teasers" }).click();
      assert.equal(
        await page
          .getByRole("button", { name: "Teasers" })
          .getAttribute("aria-current"),
        "page",
      );
      assert.deepEqual(errors, [], `${viewport.name} console errors`);
      await page.locator("#chromeConnection").focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page
          .locator("#chromeSetupDialog")
          .evaluate(
            (node) =>
              node.open && node.getBoundingClientRect().right <= innerWidth,
          ),
        true,
        `${viewport.name} setup dialog fits`,
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page
          .locator("#chromeConnection")
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await page.close();
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(
    "PASS: shared desktop shell rendered at desktop, compact, and mobile widths",
  );
}

async function testChromeExtensionsCopyAndConnectedAction(browser, port) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.addInitScript(() => {
    globalThis.__OFENHANCER_TEST_HOST__ = async (operation) => {
      if (operation === "getStatus")
        return {
          productVersion: "0.20.45",
          protocolVersion: 1,
          capabilities: ["chrome-readiness"],
        };
      if (operation === "getChromeReadiness")
        return {
          state: "setup",
          chromeFound: true,
          prepared: true,
          extensionFolder: "C:\\OFEnhancer\\extension-keyed",
          canOpenExtensions: true,
          message: "Synthetic Chrome setup evidence.",
        };
      throw new Error("unsupported-operation");
    };
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.locator("#chromeConnection").click();
  const dialog = page.locator("#chromeSetupDialog");
  const actions = dialog.locator("button:visible");
  const extensionButton = dialog.getByRole("button", {
    name: "Open Chrome extensions",
    exact: true,
  });
  await extensionButton.waitFor();
  const extensionBox = await extensionButton.boundingBox();
  const otherBoxes = await actions.evaluateAll((buttons) =>
    buttons
      .filter(
        (button) => button.textContent.trim() !== "Open Chrome extensions",
      )
      .map((button) => button.getBoundingClientRect().top),
  );
  assert.equal(
    otherBoxes.some((top) => Math.abs(top - extensionBox.y) < 1),
    false,
    "Open Chrome extensions must be the only button on its row",
  );
  await page.close();
}

async function testChromeReadinessStates(browser, port) {
  const labels = {
    setup: "Set up Chrome",
    offline: "Chrome not connected",
    repair: "Chrome setup needs repair",
    connected: "Chrome connected",
    choose: "Choose Chrome browser",
  };
  for (const [state, label] of Object.entries(labels)) {
    const page = await browser.newPage();
    await page.addInitScript(
      ({ state }) => {
        globalThis.__OFENHANCER_TEST_HOST__ = async (operation) => {
          if (operation === "getStatus")
            return {
              productVersion: "0.20.45",
              protocolVersion: 1,
              capabilities: ["chrome-readiness"],
            };
          if (operation === "getChromeReadiness")
            return {
              state,
              chromeFound: true,
              prepared: state !== "setup",
              message: "Synthetic integration evidence only.",
              browserStatus: { expiresInMilliseconds: 500 },
            };
          throw new Error("unsupported-operation");
        };
      },
      { state },
    );
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page
      .locator("#connectionLabel")
      .getByText(label, { exact: true })
      .waitFor();
    assert.equal(
      await page.locator("body").getAttribute("data-connected"),
      String(state === "connected"),
    );
    await page.locator("#chromeConnection").focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await page.locator("#chromeSetupDialog").evaluate((node) => node.open),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .locator("#chromeConnection")
        .evaluate((node) => node === document.activeElement),
      true,
    );
    if (state === "connected") {
      await page.waitForFunction(
        () => document.body.dataset.connected === "false",
      );
      assert.equal(
        await page.locator("#connectionLabel").textContent(),
        "Checking Chrome…",
      );
    }
    await page.close();
  }
}

async function testStaleChromeObservation(browser, port) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    globalThis.__observations = [];
    globalThis.__OFENHANCER_TEST_HOST__ = async (operation) => {
      if (operation === "getStatus")
        return {
          productVersion: "0.20.45",
          protocolVersion: 1,
          capabilities: ["chrome-readiness"],
        };
      if (operation === "getChromeReadiness")
        return new Promise((resolve) =>
          globalThis.__observations.push(resolve),
        );
      throw new Error("unsupported-operation");
    };
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => __observations.length >= 1);
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => __observations.length >= 2);
  await page.evaluate(() =>
    __observations.at(-1)({
      state: "offline",
      message: "New observation: offline.",
    }),
  );
  await page
    .locator("#connectionLabel")
    .getByText("Chrome not connected", { exact: true })
    .waitFor();
  await page.evaluate(() =>
    __observations[0]({
      state: "connected",
      message: "Stale observation.",
      browserStatus: { expiresInMilliseconds: 10000 },
    }),
  );
  assert.equal(
    await page.locator("body").getAttribute("data-connected"),
    "false",
  );
  assert.equal(
    await page.locator("#connectionLabel").textContent(),
    "Chrome not connected",
  );
  await page.close();
}

async function testOfflineBridgeRecovery(browser, port) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page
    .locator("#connectionLabel")
    .getByText("Desktop agent unavailable", { exact: true })
    .waitFor();

  await page.getByRole("button", { name: "Attention" }).click();
  await page
    .getByRole("heading", { name: "Desktop agent unavailable", exact: true })
    .waitFor();
  await page
    .getByText("Start OFEnhancer to reconnect.", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByText("The desktop agent is connected", { exact: false })
      .count(),
    0,
  );

  await page.getByRole("button", { name: "Catalogue" }).click();
  await page
    .locator("#googleCatalogue")
    .getByText(
      "Desktop app is not connected. Start OFEnhancer, then try again.",
      {
        exact: true,
      },
    )
    .waitFor();
  await page.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
