"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");

const extensionRoot = require("../support/paths.cjs").personalRoot;

function chromeExecutable() {
  return require("../support/browser.cjs").browserExecutable();
}

async function main() {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ofenhancer-file-proof-"),
  );
  const profilePath = path.join(temporary, "profile");
  const filePath = path.join(temporary, "inert-proof.mp4");
  fs.writeFileSync(filePath, "inert local attachment proof");
  const server = http.createServer((request, response) => {
    if (request.url !== "/ofenhancer-local-file-proof") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><body>
        <input id="upload" type="file">
        <script>
          globalThis.proof = { input: 0, change: 0 };
          upload.addEventListener("input", () => { proof.input += 1; });
          upload.addEventListener("change", () => { proof.change += 1; });
        </script>
      </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  let context;

  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"),
    );
    assert.equal(
      [
        ...(manifest.host_permissions || []),
        ...(manifest.optional_host_permissions || []),
      ].some((permission) => /(?:127\.0\.0\.1|localhost)/i.test(permission)),
      false,
      "the personal manifest grants the synthetic loopback origin",
    );
    context = await chromium.launchPersistentContext(profilePath, {
      executablePath: chromeExecutable(),
      headless: false,
      args: [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        "--window-position=-32000,-32000",
        "--window-size=1,1",
      ],
    });
    let workers = context.serviceWorkers();
    if (workers.length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 10000 });
      workers = context.serviceWorkers();
    }
    assert.equal(
      workers.length,
      1,
      "the personal extension worker did not load",
    );
    const worker = workers[0];
    const page = await context.newPage();
    await page.goto(`${origin}/ofenhancer-local-file-proof`);
    await page.bringToFront();
    const tabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      return tabs[0]?.id || 0;
    });
    assert.ok(
      tabId > 0,
      "the isolated loopback tab was not visible to the extension",
    );

    await worker.evaluate(
      async ({ filePath: exactPath, origin: exactOrigin, tabId: exactTab }) =>
        CreatorLocalFileAttacher.attach(
          {
            tabId: exactTab,
            selector: "#upload",
            filePath: exactPath,
            allowedOrigins: [exactOrigin],
          },
          chrome,
        ),
      { filePath, origin, tabId },
    );
    assert.deepEqual(
      await page.locator("#upload").evaluate((input) => ({
        name: input.files?.[0]?.name || "",
        count: input.files?.length || 0,
        inputEvents: proof.input,
        changeEvents: proof.change,
      })),
      {
        name: "inert-proof.mp4",
        count: 1,
        inputEvents: 1,
        changeEvents: 1,
      },
    );

    const missing = await worker.evaluate(
      async ({ filePath: exactPath, origin: exactOrigin, tabId: exactTab }) => {
        try {
          await CreatorLocalFileAttacher.attach(
            {
              tabId: exactTab,
              selector: "#missing",
              filePath: exactPath,
              allowedOrigins: [exactOrigin],
            },
            chrome,
          );
          return "unexpected-success";
        } catch (error) {
          return error.message;
        }
      },
      { filePath, origin, tabId },
    );
    assert.equal(missing, "file-control-missing");
    assert.deepEqual(
      await worker.evaluate(
        async ({ filePath: exactPath, origin: exactOrigin, tabId: exactTab }) =>
          CreatorLocalFileAttacher.attach(
            {
              tabId: exactTab,
              selector: "#upload",
              filePath: exactPath,
              allowedOrigins: [exactOrigin],
            },
            chrome,
          ),
        { filePath, origin, tabId },
      ),
      { attached: true },
      "a failed selector left the extension debugger attached",
    );
    await page.evaluate(() => {
      const input = document.querySelector("#upload");
      input.value = "";
      input.addEventListener("change", () => {
        input.value = "";
        input.remove();
      });
    });
    assert.deepEqual(
      await worker.evaluate(
        async ({ filePath, origin, tabId, size }) =>
          CreatorLocalFileAttacher.attach(
            {
              tabId,
              selector: "#upload",
              filePath,
              allowedOrigins: [origin],
              expected: { name: "inert-proof.mp4", size },
            },
            chrome,
          ),
        { filePath, origin, tabId, size: fs.statSync(filePath).size },
      ),
      { attached: true },
      "selection receipt must survive a site's synchronous input clearing/removal",
    );
    assert.equal(await page.locator("#upload").count(), 0);
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "activate";
      button.type = "button";
      button.textContent = "Add media";
      button.onclick = () => {
        const input = document.createElement("input");
        input.id = "detached";
        input.type = "file";
        input.onchange = () => {
          proof.detachedName = input.files[0].name;
          input.value = "";
        };
        input.click();
      };
      document.body.append(button);
    });
    assert.deepEqual(
      await worker.evaluate(
        async ({ filePath, origin, tabId, size }) =>
          CreatorLocalFileAttacher.attach(
            {
              tabId,
              selector: "#detached",
              pickerSelector: "#activate",
              filePath,
              allowedOrigins: [origin],
              expected: { name: "inert-proof.mp4", size },
            },
            chrome,
          ),
        { filePath, origin, tabId, size: fs.statSync(filePath).size },
      ),
      { attached: true },
    );
    assert.equal(
      await page.evaluate(() => proof.detachedName),
      "inert-proof.mp4",
    );
    await page.evaluate(() => {
      proof.detachedName = "";
      const stale = document.createElement("input");
      stale.type = "file";
      stale.id = "detached";
      document.body.append(stale);
    });
    await worker.evaluate(
      async ({ filePath, origin, tabId, size }) =>
        CreatorLocalFileAttacher.attach(
          {
            tabId,
            selector: "#detached",
            pickerSelector: "#activate",
            activatePicker: true,
            filePath,
            allowedOrigins: [origin],
            expected: { name: "inert-proof.mp4", size },
          },
          chrome,
        ),
      { filePath, origin, tabId, size: fs.statSync(filePath).size },
    );
    assert.equal(
      await page.evaluate(() => proof.detachedName),
      "inert-proof.mp4",
      "visible activation must run even with an existing input",
    );
    assert.equal(
      await page.locator("#detached").evaluate((input) => input.files.length),
      0,
      "the unrelated pre-existing input must not receive the file",
    );
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "shadow-host";
      host.attachShadow({ mode: "open" }).innerHTML =
        '<input id="scoped" type="file">';
      document.body.append(host);
      const frame = document.createElement("iframe");
      frame.id = "file-frame";
      frame.src = location.href;
      document.body.append(frame);
    });
    await page.frameLocator("#file-frame").locator("#upload").waitFor();
    for (const [scope, selector] of [
      [[{ kind: "shadow", selector: "#shadow-host" }], "#scoped"],
      [[{ kind: "frame", selector: "#file-frame" }], "#upload"],
    ]) {
      assert.deepEqual(
        await worker.evaluate(
          async ({ filePath, origin, tabId, scope, selector }) =>
            CreatorLocalFileAttacher.attach(
              { tabId, filePath, allowedOrigins: [origin], scope, selector },
              chrome,
            ),
          { filePath, origin, tabId, scope, selector },
        ),
        { attached: true },
      );
    }
    assert.equal(
      await page
        .locator("#shadow-host #scoped")
        .evaluate((input) => input.files[0].name),
      "inert-proof.mp4",
    );
    assert.equal(
      await page
        .frameLocator("#file-frame")
        .locator("#upload")
        .evaluate((input) => input.files[0].name),
      "inert-proof.mp4",
    );
  } finally {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  console.log(
    "PASS: real Chromium attached one inert local file and detached cleanly",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
