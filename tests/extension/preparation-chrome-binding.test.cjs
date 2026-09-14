"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const test = require("node:test");
const { chromium } = require("../support/browser.cjs");
const root = path.resolve(__dirname, "../..");

test("preparation journal accepts a real Chrome content-script document binding", async () => {
  const scratch = path.join(root, ".local");
  fs.mkdirSync(scratch, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratch, "preparation-binding-"));
  const extension = path.join(directory, "extension");
  fs.mkdirSync(extension);
  fs.copyFileSync(
    path.join(root, "extensions/personal/workflows/upload-session-store.js"),
    path.join(extension, "store.js"),
  );
  fs.writeFileSync(
    path.join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Preparation binding harness",
      version: "1.0",
      permissions: ["storage"],
      background: { service_worker: "background.js" },
      content_scripts: [
        { matches: ["http://127.0.0.1/*"], js: ["content.js"] },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(extension, "background.js"),
    `importScripts('store.js'); chrome.runtime.onMessage.addListener((message,sender,reply)=>{ CreatorUploadSessionStore.recordStep('binding-harness', { actionId:'select-full',platform:'manyvids',outcome:'intent',commandId:crypto.randomUUID(),documentId:sender.documentId,frameId:sender.frameId,tabId:sender.tab.id,signature:'a'.repeat(64) }).then(step=>reply({ok:true,documentId:step.documentId}),error=>reply({ok:false,error:error.message,documentId:sender.documentId})); return true; });`,
  );
  fs.writeFileSync(
    path.join(extension, "content.js"),
    `chrome.runtime.sendMessage({probe:true},response=>{document.documentElement.dataset.result=JSON.stringify(response);});`,
  );
  const server = http.createServer((_request, response) =>
    response.end(
      "<!doctype html><title>Local preparation binding harness</title>",
    ),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let context;
  try {
    context = await chromium.launchPersistentContext(
      path.join(directory, "profile"),
      {
        headless: true,
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.documentElement.dataset.result);
    const result = await page.evaluate(() =>
      JSON.parse(document.documentElement.dataset.result),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.documentId);
  } finally {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
    if (!directory.startsWith(scratch + path.sep))
      throw new Error("Invalid harness cleanup path");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
