"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const root = require("../support/paths.cjs").repositoryRoot;

const signal = () => {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    emit: (...args) => listeners.forEach((fn) => fn(...args)),
  };
};

test("Fresh verifier reports disabled targets and an independent uninstall event, then removes itself", async () => {
  const onUninstalled = signal();
  const onMessage = signal();
  const onDisconnect = signal();
  const sent = [];
  const timers = [];
  let selfRemoved = false;
  const chrome = {
    runtime: {
      id: "nhllpejgihfneloninfpblbfdoigongm",
      connectNative: () => ({
        onMessage,
        onDisconnect,
        postMessage: (value) => sent.push(value),
      }),
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    management: {
      onUninstalled,
      getAll: async () => [
        { id: "aocoaajmhccmefmfebgiiogfdojciild", enabled: false },
        { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", enabled: true },
      ],
      uninstallSelf: async () => {
        selfRemoved = true;
      },
    },
  };
  vm.runInContext(
    fs.readFileSync(
      path.join(root, "packaging/windows/fresh-verifier/background.js"),
      "utf8",
    ),
    vm.createContext({
      chrome,
      crypto: webcrypto,
      setTimeout: (fn, delay) => {
        timers.push({ fn, delay });
      },
      clearTimeout() {},
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].payload.maintenanceVerifier.installed[0].enabled, false);
  onUninstalled.emit("aocoaajmhccmefmfebgiiogfdojciild");
  onMessage.emit({
    requestId: sent[0].requestId,
    ok: true,
    result: { removalVerified: false },
  });
  timers.find((item) => item.delay === 500).fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(sent.at(-1).payload.maintenanceVerifier.uninstalled),
    ),
    ["aocoaajmhccmefmfebgiiogfdojciild"],
  );
  onMessage.emit({
    requestId: sent.at(-1).requestId,
    ok: true,
    result: { removalVerified: true },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selfRemoved, true);
});
