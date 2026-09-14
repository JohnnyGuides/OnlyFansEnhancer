"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

test("privileged upload messages require the exact current top document and route", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../extensions/personal/background.js"),
    "utf8",
  );
  const start = source.indexOf(
    "async function assertCreatorUploadPageBinding(",
  );
  assert.notEqual(start, -1);
  const end = source.indexOf("\nfunction creatorUploadSessionRecord", start);
  const documentId = "11111111-1111-4111-8111-111111111111";
  const boundUrl = "https://onlyfans.com/posts/create";
  let frame = { frameId: 0, documentId, url: boundUrl };
  const port = {};
  const context = vm.createContext({
    chrome: { webNavigation: { getAllFrames: async () => [frame] } },
    creatorUploadPort: () => port,
  });
  vm.runInContext(source.slice(start, end), context);
  const target = { tabId: 42, documentId, boundUrl };
  const session = { id: "session", executionPort: port };
  const sender = { tab: { id: 42 }, documentId, frameId: 0, url: boundUrl };
  await context.assertCreatorUploadPageBinding(session, target, sender);
  for (const changed of [
    { ...sender, frameId: 1 },
    { ...sender, documentId: "foreign" },
    { ...sender, url: "https://onlyfans.com/my/settings" },
    { ...sender, tab: { id: 43 } },
  ])
    await assert.rejects(
      context.assertCreatorUploadPageBinding(session, target, changed),
      /binding/,
    );
  frame = { ...frame, documentId: "replacement" };
  await assert.rejects(
    context.assertCreatorUploadPageBinding(session, target, sender),
    /binding/,
  );
  frame = { frameId: 0, documentId, url: boundUrl };
  await assert.rejects(
    context.assertCreatorUploadPageBinding(
      { ...session, executionPort: {} },
      target,
      sender,
    ),
    /connection/,
  );
});
