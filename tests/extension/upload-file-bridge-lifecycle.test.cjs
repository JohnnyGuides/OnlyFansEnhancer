"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const modulePath = path.resolve(
  require("../support/paths.cjs").personalRoot,
  "workflows",
  "upload-file-bridge.js",
);
const sessionId = "a".repeat(32);
const token = "t".repeat(24);

// A waiter that never settles must fail the test, not hang it.
function outcome(promise) {
  return Promise.race([
    promise.then(
      () => ({ status: "resolved" }),
      (reason) => ({ status: "rejected", reason }),
    ),
    new Promise((resolve) =>
      setImmediate(() => resolve({ status: "pending" })),
    ),
  ]);
}

function fakeSignal(aborted = false) {
  const listeners = new Set();
  return {
    aborted,
    listeners,
    addEventListener: (type, listener) => listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
    abort() {
      this.aborted = true;
      for (const listener of [...listeners]) listener({ type: "abort" });
    },
  };
}

function load() {
  const listeners = new Set();
  const timers = new Map();
  let nextTimer = 0;
  const iframe = {
    dataset: {},
    removed: false,
    setAttribute() {},
    remove() {
      this.removed = true;
    },
  };
  const context = vm.createContext({
    document: {
      createElement: () => iframe,
      documentElement: { append() {} },
    },
    addEventListener: (type, listener) => listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
    setTimeout(callback) {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), context, {
    filename: modulePath,
  });
  const bridge = vm.runInContext("CreatorUploadFileBridge", context);
  bridge.install({
    sessionId,
    platform: "onlyfans",
    bridgeUrl: "chrome-extension://test/bridge.html",
    bridgeOrigin: "chrome-extension://test",
    roles: {
      full: { selector: "input[type=file]", token, kind: "video" },
    },
  });
  return { bridge, iframe, listeners, timers };
}

test("dispose rejects every pending waiter and leaves no active timers", async () => {
  const { bridge, iframe, listeners, timers } = load();
  const first = bridge.waitFor(sessionId, "full");
  const second = bridge.waitFor(sessionId, "full");
  assert.equal(timers.size, 2);
  bridge.dispose(sessionId);
  const outcomes = await Promise.all([outcome(first), outcome(second)]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["rejected", "rejected"],
  );
  for (const outcome of outcomes)
    assert.equal(outcome.reason.name, "UploadFileBridgeDisposedError");
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  assert.equal(iframe.removed, true);
});

test("waitFor rejects at once for an already-aborted signal without adding a waiter", async () => {
  const { bridge, timers } = load();
  const signal = fakeSignal(true);
  const result = await outcome(
    bridge.waitFor(sessionId, "full", 600_000, signal),
  );
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.name, "AbortError");
  assert.equal(timers.size, 0);
  assert.equal(signal.listeners.size, 0);
});

test("abort during waitFor rejects, clears the timer and removes the listener", async () => {
  const { bridge, timers } = load();
  const signal = fakeSignal();
  const pending = bridge.waitFor(sessionId, "full", 600_000, signal);
  assert.equal(timers.size, 1);
  assert.equal(signal.listeners.size, 1);
  signal.abort();
  const result = await outcome(pending);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.name, "AbortError");
  assert.equal(timers.size, 0);
  assert.equal(signal.listeners.size, 0);
  // A later dispose has nothing left to reject and must not throw.
  bridge.dispose(sessionId);
});
