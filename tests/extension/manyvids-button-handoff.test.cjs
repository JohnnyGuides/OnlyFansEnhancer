"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs
  .readFileSync(
    path.resolve(__dirname, "../../extensions/personal/background.js"),
    "utf8",
  )
  .replace(/\r\n/g, "\n");
const start = source.indexOf(
  '        if (\n          message.actionId === "open-editor"',
);
const end = source.indexOf("        return { step };", start);
assert.ok(start >= 0 && end > start);

for (const variant of [
  "owned",
  "foreign-origin",
  "query",
  "wrong-document",
  "lost-port",
  "late",
  "no-proof",
]) {
  test(`ManyVids button-only handoff navigation binding: ${variant}`, async () => {
    const listeners = new Set();
    const history = new Set();
    const event = (set) => ({
      addListener: (fn) => set.add(fn),
      removeListener: (fn) => set.delete(fn),
    });
    const port = {};
    let currentPort = port;
    let now = 1000;
    const target = {
      platform: "manyvids",
      stage: "upload",
      tabId: 42,
      documentId: "source",
    };
    const session = {
      id: "session",
      draft: { fullFilename: "neutral.mp4" },
      executionPort: port,
    };
    const sender = { documentId: "source" };
    const message = {
      actionId: "open-editor",
      outcome: "intent",
      platform: "manyvids",
      commandId: "command",
      evidence: { completedCard: true },
    };
    const context = vm.createContext({
      URL,
      Date: { now: () => now },
      creatorUploadPort: () => currentPort,
      checkpointCreatorUploadSession: async () => {},
      assertCreatorUploadPageBinding: async () => {},
      manyVidsRoute: (value) => {
        try {
          const url = new URL(value);
          const match = /^\/Edit-vid\/(\d+)\/?$/.exec(url.pathname);
          return url.origin === "https://www.manyvids.com" && match
            ? { url: url.href, manyvidsId: match[1] }
            : null;
        } catch {
          return null;
        }
      },
      chrome: {
        scripting: {
          executeScript: async () => [
            {
              frameId: 0,
              documentId: "source",
              result: variant !== "no-proof",
            },
          ],
        },
        webNavigation: {
          onCommitted: event(listeners),
          onHistoryStateUpdated: event(history),
        },
      },
    });
    vm.runInContext(
      `async function arm(message, target, session, sender) { ${source.slice(start, end)} }`,
      context,
    );
    if (variant === "no-proof") {
      await assert.rejects(
        context.arm(message, target, session, sender),
        /proof.*unavailable/,
      );
      assert.equal(listeners.size, 0);
      return;
    }
    await context.arm(message, target, session, sender);
    assert.equal(listeners.size, 1);
    assert.equal(target.editorHandoff.expectedUrl, "");
    if (variant === "late") now += 31000;
    if (variant === "lost-port") currentPort = {};
    const route =
      variant === "foreign-origin"
        ? "https://example.test/Edit-vid/123"
        : "https://www.manyvids.com/Edit-vid/123" +
          (variant === "query" ? "?other=1" : "");
    for (const listener of [...listeners])
      listener({
        tabId: 42,
        frameId: 0,
        documentId: variant === "wrong-document" ? "source" : "editor",
        url: route,
      });
    assert.equal(listeners.size, 0);
    assert.equal(history.size, 0);
    assert.equal(target.editorHandoff.invalid, variant !== "owned");
    if (variant === "owned") {
      assert.equal(target.editorHandoff.videoId, "123");
      assert.equal(target.editorHandoff.documentId, "editor");
      assert.equal(target.editorHandoff.expectedUrl, route);
    }
  });
}
