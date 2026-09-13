"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { webcrypto } = require("node:crypto");

function harness() {
  const source = fs.readFileSync(
    path.join(__dirname, "../../extensions/personal/background.js"),
    "utf8",
  );
  const start = source.indexOf(
    "async function invokeCreatorUploadAdapter(args)",
  );
  const end = source.indexOf(
    "async function prepareCreatorUploadResponseObserver",
    start,
  );
  const messages = [];
  const runtime = {
    lastError: null,
    sendMessage(message, callback) {
      messages.push(message);
      callback({ ok: true });
    },
  };
  const context = vm.createContext({
    AbortController,
    crypto: webcrypto,
    addEventListener() {},
    removeEventListener() {},
    chrome: { runtime },
    CreatorUploadPlatformAdapters: {},
    CreatorUploadFileBridge: {
      async waitFor() {
        return { selected: true };
      },
    },
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    context,
    messages,
    runtime,
    args: {
      sessionId: "recovery-test",
      platform: "fansly",
      draft: { publishMode: "manual" },
      selectors: { full: "#file" },
    },
  };
}

test("same-document re-entry observes the original run without repeating attachment", async () => {
  const { context, messages, args } = harness();
  let executions = 0;
  context.CreatorUploadPlatformAdapters.runFansly = async (run) => {
    executions++;
    await run.attachFile("full", "#file");
    return { status: "manual-submit-required" };
  };
  await Promise.all([
    context.invokeCreatorUploadAdapter(args),
    context.invokeCreatorUploadAdapter(args),
  ]);
  await context.invokeCreatorUploadAdapter(args);
  assert.equal(executions, 1);
  assert.equal(
    messages.filter((m) => m.type === "DELIVER_CREATOR_UPLOAD_FILE").length,
    1,
  );
  assert.equal(
    context.CreatorUploadRuns.get("recovery-test:fansly:upload").state.status,
    "completed",
  );
});

test("interrupted checkpoint resumes the same command before the next mutation", async () => {
  const { context, messages, runtime, args } = harness();
  let mutations = 0;
  let failures = 1;
  runtime.sendMessage = (message, callback) => {
    messages.push(message);
    callback(
      failures-- > 0
        ? { ok: false, error: "worker interrupted" }
        : { ok: true },
    );
  };
  context.CreatorUploadPlatformAdapters.runFansly = async (run) => {
    await run.checkpointStep("attach-media", "command-identity", "intent");
    mutations++;
    return { status: "manual-submit-required" };
  };
  const completion = context.invokeCreatorUploadAdapter(args);
  await new Promise((resolve) => setImmediate(resolve));
  const run = context.CreatorUploadRuns.get("recovery-test:fansly:upload");
  assert.equal(run.state.status, "paused");
  assert.equal(mutations, 0);
  assert.equal(run.resumeObservation(), true);
  await completion;
  assert.equal(mutations, 1);
  assert.deepEqual(messages[0], messages[1]);
});

test("uncertain file delivery is never automatically replayed", async () => {
  const { context, messages, runtime, args } = harness();
  runtime.sendMessage = (message, callback) => {
    messages.push(message);
    callback({ ok: message.type !== "DELIVER_CREATOR_UPLOAD_FILE" });
  };
  context.CreatorUploadPlatformAdapters.runFansly = (run) =>
    run.attachFile("full", "#file");
  await assert.rejects(context.invokeCreatorUploadAdapter(args));
  await assert.rejects(context.invokeCreatorUploadAdapter(args));
  assert.equal(
    messages.filter((m) => m.type === "DELIVER_CREATOR_UPLOAD_FILE").length,
    1,
  );
});
