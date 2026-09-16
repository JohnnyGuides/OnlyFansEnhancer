"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("../support/browser.cjs");
const repository = path.resolve(__dirname, "../..");
const source = fs.readFileSync(
  path.join(repository, "extensions/personal/background.js"),
  "utf8",
);
function span(from, to) {
  const start = source.indexOf(from),
    end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
test("real Chrome foreground activation selects only the bound tab without re-navigation", async () => {
  const base = path.join(repository, ".local");
  fs.mkdirSync(base, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(base, "foreground-chrome-"));
  const extension = path.join(scratch, "extension");
  fs.mkdirSync(extension);
  fs.writeFileSync(
    path.join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Owned foreground fixture",
      version: "1.0",
      permissions: ["tabs", "webNavigation"],
      host_permissions: ["https://www.manyvids.com/*"],
      background: { service_worker: "background.js" },
      content_scripts: [
        {
          matches: ["https://www.manyvids.com/upload-video"],
          js: ["content.js"],
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(extension, "background.js"),
    "const port={}; const creatorUploadPort=()=>port; const creatorUploadFileRequests=new Map(); let creatorUploadForeground=null; let session; let target;\n" +
      span(
        "async function assertCreatorUploadPageBinding(",
        "function creatorUploadSessionRecord(",
      ) +
      span(
        "async function focusCreatorUploadObservation(",
        "function creatorUploadRandomToken(",
      ) +
      'chrome.runtime.onMessage.addListener((message,sender,reply)=>{ if(message.kind==="bind"){ target={platform:"manyvids",stage:"upload",status:"uploading-full",tabId:sender.tab.id,documentId:sender.documentId,boundUrl:sender.url}; session={id:"foreground-fixture",executionPort:port,platforms:new Map([["manyvids",target]])};reply({bound:true,documentId:sender.documentId});return; } if(message.kind==="focus"){ focusCreatorUploadObservation(session,target,sender).then(reply,error=>reply({error:error.message}));return true; } });',
  );
  fs.writeFileSync(
    path.join(extension, "content.js"),
    'chrome.runtime.sendMessage({kind:"bind"},r=>document.documentElement.dataset.bound=JSON.stringify(r)); document.addEventListener("test-owned-focus",()=>chrome.runtime.sendMessage({kind:"focus"},r=>document.documentElement.dataset.result=JSON.stringify(r)));',
  );
  let context;
  try {
    context = await chromium.launchPersistentContext(
      path.join(scratch, "profile"),
      {
        headless: true,
        args: [
          "--disable-extensions-except=" + extension,
          "--load-extension=" + extension,
        ],
      },
    );
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Inert foreground fixture</title>",
      }),
    );
    const upload = await context.newPage();
    await upload.goto("https://www.manyvids.com/upload-video");
    await upload.waitForFunction(() => document.documentElement.dataset.bound);
    const original = await upload.evaluate(
      () => JSON.parse(document.documentElement.dataset.bound).documentId,
    );
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    // Browser automation emulates focused Pages. Verify the actual Chrome tab
    // activation here; adapter tests separately enforce visible/focused readback.
    const before = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const owned = tabs.find(
        (tab) => tab.url === "https://www.manyvids.com/upload-video",
      );
      const other = await chrome.tabs.create({
        windowId: owned.windowId,
        url: "https://example.test/blank",
        active: true,
      });
      return {
        owned: owned.id,
        other: other.id,
        active: (await chrome.tabs.get(owned.id)).active,
      };
    });
    assert.equal(
      before.active,
      false,
      "The owned upload tab must initially be inactive in Chrome.",
    );
    await upload.evaluate(() =>
      document.dispatchEvent(new Event("test-owned-focus")),
    );
    await upload.waitForFunction(() => document.documentElement.dataset.result);
    const result = await upload.evaluate(() => ({
      proof: JSON.parse(document.documentElement.dataset.result),
      visible: document.visibilityState,
      focused: document.hasFocus(),
      documentId: JSON.parse(document.documentElement.dataset.bound).documentId,
    }));
    assert.equal(result.proof.focused, true, JSON.stringify(result));
    const after = await worker.evaluate(
      async (ids) => ({
        owned: (await chrome.tabs.get(ids.owned)).active,
        other: (await chrome.tabs.get(ids.other)).active,
      }),
      before,
    );
    assert.deepEqual(after, { owned: true, other: false });
    assert.equal(result.visible, "visible");
    assert.equal(result.focused, true);
    assert.equal(result.documentId, original);
    assert.equal(upload.url(), "https://www.manyvids.com/upload-video");
  } finally {
    await context?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
