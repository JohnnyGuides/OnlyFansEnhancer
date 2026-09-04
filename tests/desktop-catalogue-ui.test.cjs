"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const appRoot = path.resolve(__dirname, "..", "app");
const populated = {
  items: [
    {
      itemId: "11111111-1111-1111-1111-111111111111",
      sourceKey: "ashley-04",
      sourceRow: 42,
      title: "Ashley episode 04",
      description: "Description",
      plannedDate: "2026-09-11",
      series: "Ashley",
      episode: "04",
      xTeasers: 2,
      redditTeasers: 1,
      platformLinks: {
        onlyfans: "https://onlyfans.com/123/johnny_guides",
        fansly: "https://fansly.com/post/1",
      },
      archived: false,
      thumbnailAssetId: null,
      thumbnailStatus: "missing",
      candidates: null,
    },
    {
      itemId: "22222222-2222-2222-2222-222222222222",
      sourceKey: "ashley-05",
      sourceRow: 43,
      title: "Ashley episode 05",
      description: "Description",
      plannedDate: "2026-09-18",
      series: "Ashley",
      episode: "05",
      xTeasers: 0,
      redditTeasers: 0,
      platformLinks: {},
      archived: false,
      thumbnailAssetId: null,
      thumbnailStatus: "missing",
      candidates: null,
    },
  ],
  unmatchedAssets: [],
  availableThumbnails: 0,
  inventoryStatus: "not-scanned",
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function routeThumbnails(page) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("https://thumbs.ofenhancer.local/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png }),
  );
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function withServer(run) {
  const server = http.createServer((request, response) => {
    const requested = new URL(request.url, "http://127.0.0.1").pathname;
    const relative = requested === "/" ? "index.html" : requested.slice(1);
    const file = path.resolve(appRoot, relative);
    if (!file.startsWith(`${appRoot}${path.sep}`) || !fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": contentType(file) });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function installHost(page, initialState = null) {
  await page.addInitScript(
    ({ initial, populatedState }) => {
      let catalogue = initial || {
        items: [],
        unmatchedAssets: [],
        availableThumbnails: 0,
        inventoryStatus: "not-scanned",
      };
      let failNextScan = true;
      globalThis.__catalogueImportCalls = 0;
      globalThis.__catalogueConfirmCalls = 0;
      globalThis.__OFENHANCER_TEST_HOST__ = async (operation, payload) => {
        if (operation === "getStatus") {
          return {
            productVersion: "0.19.0",
            protocolVersion: 1,
            capabilities: ["desktop-shell"],
            testData: true,
          };
        }
        if (operation === "getCatalogue") return structuredClone(catalogue);
        if (operation === "importCatalogueSnapshot") {
          globalThis.__catalogueImportCalls += 1;
          JSON.parse(payload.json);
          catalogue = structuredClone(populatedState);
          return { activeItems: 2, archivedItems: 0, unchanged: false };
        }
        if (operation === "scanThumbnails") {
          if (failNextScan) {
            failNextScan = false;
            throw new Error("thumbnail-root-missing");
          }
          catalogue.inventoryStatus = "ready";
          catalogue.availableThumbnails = 1;
          catalogue.unmatchedAssets = [
            {
              assetId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              fileName: "ashley_04_cover.png",
              role: "curated",
              candidates: [
                {
                  itemId: catalogue.items[0].itemId,
                  title: catalogue.items[0].title,
                  plannedDate: catalogue.items[0].plannedDate,
                  score: 154,
                  thumbnailAssetId: null,
                },
                {
                  itemId: catalogue.items[1].itemId,
                  title: catalogue.items[1].title,
                  plannedDate: catalogue.items[1].plannedDate,
                  score: 22,
                  thumbnailAssetId: null,
                },
              ],
            },
          ];
          return { availableAssets: 1, newAssets: 1, unavailableAssets: 0 };
        }
        if (operation === "confirmAssetBinding") {
          globalThis.__catalogueConfirmCalls += 1;
          catalogue.items[0].thumbnailAssetId = payload.assetId;
          catalogue.items[0].thumbnailStatus = "bound";
          catalogue.unmatchedAssets = [];
          return { ...payload, changed: true };
        }
        if (operation === "openChromeUploader") return { opened: true };
        throw new Error("unsupported-operation");
      };
    },
    { initial: initialState, populatedState: populated },
  );
}

async function main() {
  await withServer(async (port) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      const errors = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await routeThumbnails(page);
      await installHost(page);
      await page.goto(`http://127.0.0.1:${port}/index.html`);
      await page.getByRole("button", { name: "Catalogue" }).click();
      await page.getByRole("heading", { name: "No videos yet" }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Import catalogue" }).count(),
        1,
      );

      await page.locator("#catalogueFile").setInputFiles({
        name: "too-large.json",
        mimeType: "application/json",
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0x20),
      });
      await page
        .getByText("That catalogue file is too large.", { exact: true })
        .waitFor();
      assert.equal(await page.evaluate(() => __catalogueImportCalls), 0);

      await page.locator("#catalogueFile").setInputFiles({
        name: "catalogue.json",
        mimeType: "application/json",
        buffer: Buffer.from('{"version":1,"items":[]}'),
      });
      await page.getByText("Ashley episode 04", { exact: true }).waitFor();
      assert.equal(await page.getByText("X 2", { exact: true }).count(), 1);
      assert.equal(
        await page.getByText("Reddit 1", { exact: true }).count(),
        1,
      );
      assert.equal(
        await page.getByText("OnlyFans", { exact: true }).count(),
        1,
      );

      await page.getByRole("button", { name: "Needs thumbnail" }).click();
      assert.equal(await page.locator("[data-catalogue-row]").count(), 2);
      await page.getByRole("button", { name: "Scan thumbnails" }).click();
      await page
        .getByText("Thumbnail folder was not found.", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Scan thumbnails" }).click();
      await page.getByText("ashley_04_cover.png", { exact: true }).waitFor();
      const chooseVideo = page.getByRole("button", { name: "Choose video" });
      await chooseVideo.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Match thumbnail" });
      await dialog.waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Close" })
          .evaluate((button) => button === document.activeElement),
        true,
        "dialog did not focus its first control",
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await chooseVideo.evaluate(
          (button) => button === document.activeElement,
        ),
        true,
        "dialog did not restore focus to its opener",
      );
      await page.keyboard.press("Enter");
      await dialog.waitFor();
      assert.equal(
        await dialog.getByText("Ashley episode 04", { exact: true }).count(),
        1,
      );
      await page.keyboard.press("Tab");
      const firstCandidate = dialog.getByRole("button", {
        name: "Use Ashley episode 04",
      });
      assert.equal(
        await firstCandidate.evaluate(
          (button) => button === document.activeElement,
        ),
        true,
        "keyboard did not reach the first candidate",
      );
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => __catalogueConfirmCalls === 1);
      await page.getByText("Thumbnail matched.", { exact: true }).waitFor();
      assert.equal(
        await page.locator("#catalogueStatus").getAttribute("role"),
        "status",
        "match success is not announced through a status region",
      );
      await page.getByRole("button", { name: "Bound" }).click();
      assert.equal(await page.locator("[data-catalogue-row]").count(), 1);
      assert.match(
        await page.locator("[data-catalogue-row] img").getAttribute("src"),
        /^https:\/\/thumbs\.ofenhancer\.local\/[a-f0-9-]+$/,
      );

      await page
        .getByRole("searchbox", { name: "Search catalogue" })
        .fill("nothing");
      await page.getByText("No matching videos", { exact: true }).waitFor();
      assert.equal(
        (await page.locator("body").innerText()).includes("C:\\"),
        false,
      );
      assert.deepEqual(errors, []);
      await page.close();

      for (const viewport of [
        { name: "compact", width: 800, height: 700 },
        { name: "mobile", width: 390, height: 844 },
      ]) {
        const responsive = await browser.newPage({ viewport });
        const responsiveErrors = [];
        responsive.on("console", (message) => {
          if (message.type() === "error") responsiveErrors.push(message.text());
        });
        responsive.on("pageerror", (error) =>
          responsiveErrors.push(error.message),
        );
        await routeThumbnails(responsive);
        await installHost(responsive, populated);
        await responsive.goto(`http://127.0.0.1:${port}/index.html`);
        await responsive.getByRole("button", { name: "Catalogue" }).click();
        await responsive
          .getByText("Ashley episode 04", { exact: true })
          .waitFor();
        assert.equal(
          await responsive.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `${viewport.name} overflows`,
        );
        await responsive
          .getByRole("searchbox", { name: "Search catalogue" })
          .focus();
        assert.equal(
          await responsive.locator(":focus-visible").count(),
          1,
          `${viewport.name} focus`,
        );
        assert.deepEqual(
          responsiveErrors,
          [],
          `${viewport.name} console errors`,
        );
        await responsive.close();
      }
    } finally {
      await browser.close();
    }
  });
  console.log(
    "PASS: desktop catalogue works at desktop, compact, and mobile widths",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
