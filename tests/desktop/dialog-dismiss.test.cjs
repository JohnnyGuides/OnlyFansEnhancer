"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { before, after, test } = require("node:test");
const { chromium } = require("../support/browser.cjs");
const { repositoryRoot } = require("../support/paths.cjs");
const helper = fs.readFileSync(
  path.join(repositoryRoot, "shared/workspace/dialog-dismiss.js"),
  "utf8",
);
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});
async function setup() {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(
    '<button id="opener">Open</button><dialog style="width:260px;height:180px;padding:24px"><button>Inside</button></dialog>',
  );
  await page.addScriptTag({ content: helper });
  await page.evaluate(() => OFEnhancerDialogDismiss.attach(document));
  await page.evaluate(() => {
    document.querySelector("#opener").focus();
    document.querySelector("dialog").showModal();
  });
  return page;
}
test("dynamic modals close on a genuine backdrop click, not inside padding or a drag out", async () => {
  const page = await setup();
  try {
    const rect = await page.locator("dialog").boundingBox();
    await page.mouse.click(rect.x + 8, rect.y + 8);
    assert.equal(await page.locator("dialog").evaluate((d) => d.open), true);
    await page.mouse.move(rect.x + 8, rect.y + 8);
    await page.mouse.down();
    await page.mouse.move(5, 5);
    await page.mouse.up();
    assert.equal(await page.locator("dialog").evaluate((d) => d.open), true);
    await page.mouse.click(5, 5, { button: "right" });
    assert.equal(await page.locator("dialog").evaluate((d) => d.open), true);
    await page.mouse.click(5, 5);
    await page.waitForFunction(() => !document.querySelector("dialog").open);
    assert.equal(
      await page
        .locator("#opener")
        .evaluate((n) => n === document.activeElement),
      true,
    );
    await page.evaluate(() => {
      const dynamic = document.createElement("dialog");
      dynamic.id = "dynamic";
      dynamic.textContent = "Created later";
      document.body.append(dynamic);
      dynamic.showModal();
    });
    await page.mouse.click(5, 5);
    await page.waitForFunction(() => !document.querySelector("#dynamic").open);
  } finally {
    await page.close();
  }
});
test("backdrop uses the cancellable close path, including older browser fallback", async () => {
  for (const fallback of [false, true]) {
    const page = await setup();
    try {
      await page.evaluate((fallback) => {
        const modal = document.querySelector("dialog");
        globalThis.closeAttempts = 0;
        globalThis.allowClose = false;
        modal.addEventListener("cancel", (event) => {
          closeAttempts++;
          if (!allowClose) event.preventDefault();
        });
        if (fallback)
          Object.defineProperty(modal, "requestClose", { value: undefined });
      }, fallback);
      await page.mouse.click(5, 5);
      assert.equal(await page.locator("dialog").evaluate((d) => d.open), true);
      assert.equal(await page.evaluate(() => closeAttempts), 1);
      await page.evaluate(() => {
        allowClose = true;
      });
      await page.mouse.click(5, 5);
      await page.waitForFunction(() => !document.querySelector("dialog").open);
      assert.equal(await page.evaluate(() => closeAttempts), 2);
    } finally {
      await page.close();
    }
  }
});
test("an iframe modal dismisses before its outer dialog and keeps its own cancel guard", async () => {
  const page = await setup();
  try {
    await page.evaluate(async () => {
      const outer = document.querySelector("dialog");
      const frame = document.createElement("iframe");
      frame.srcdoc = "<dialog>Inner modal</dialog>";
      const loaded = new Promise((resolve) => (frame.onload = resolve));
      outer.append(frame);
      await loaded;
      const inner = frame.contentDocument.querySelector("dialog");
      inner.addEventListener("cancel", (event) => {
        if (!globalThis.allowInnerClose) event.preventDefault();
      });
      inner.showModal();
    });
    await page.mouse.click(5, 5);
    assert.equal(
      await page
        .locator("iframe")
        .evaluate((f) => f.contentDocument.querySelector("dialog").open),
      true,
    );
    assert.equal(await page.locator("dialog").evaluate((d) => d.open), true);
    await page.evaluate(() => {
      globalThis.allowInnerClose = true;
    });
    await page.mouse.click(5, 5);
    await page.waitForFunction(
      () =>
        !document
          .querySelector("iframe")
          .contentDocument.querySelector("dialog").open,
    );
    assert.equal(await page.locator("dialog").evaluate((d) => d.open), true);
    await page.mouse.click(5, 5);
    await page.waitForFunction(() => !document.querySelector("dialog").open);
  } finally {
    await page.close();
  }
});

test("the shared helper stays off third-party documents and attaches only to our shadow dialog", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<dialog id="third-party">External modal</dialog><div id="owned"></div>',
    );
    await page.addScriptTag({ content: helper });
    await page.evaluate(() =>
      document.querySelector("#third-party").showModal(),
    );
    await page.mouse.click(5, 5);
    assert.equal(
      await page.locator("#third-party").evaluate((d) => d.open),
      true,
    );
    await page.evaluate(() => {
      document.querySelector("#third-party").close();
      const shadow = document
        .querySelector("#owned")
        .attachShadow({ mode: "open" });
      shadow.innerHTML =
        '<dialog style="width:220px;height:120px">Our editor</dialog>';
      OFEnhancerDialogDismiss.attach(shadow);
      shadow.querySelector("dialog").showModal();
    });
    await page.mouse.click(5, 5);
    await page.waitForFunction(
      () =>
        !document.querySelector("#owned").shadowRoot.querySelector("dialog")
          .open,
    );
  } finally {
    await page.close();
  }
});
