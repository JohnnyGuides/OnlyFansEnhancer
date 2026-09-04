"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..", "app");
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
  const browser = await chromium.launch({ headless: true });
  try {
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
              productVersion: "0.18.0",
              protocolVersion: 1,
              capabilities: [
                "desktop-shell",
                "local-file-attach",
                "native-bridge",
              ],
              testData: true,
            };
          }
          if (operation === "openChromeUploader")
            return { opened: true, testData: true };
          throw new Error("unsupported-operation");
        };
      });
      await page.goto(`http://127.0.0.1:${address.port}/index.html`);
      await page.getByText("Connected", { exact: true }).waitFor();

      assert.equal(
        await page.getByRole("navigation").count(),
        1,
        viewport.name,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Open Chrome uploader" })
          .count(),
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
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(
    "PASS: shared desktop shell rendered at desktop, compact, and mobile widths",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
