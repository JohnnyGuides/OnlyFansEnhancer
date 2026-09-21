"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const root = require("../support/paths.cjs").repositoryRoot;

function fixture() {
  const source = path.join(
    root,
    "extensions/personal/workflows/extension-lifecycle.js",
  );
  assert.ok(
    fs.existsSync(source),
    "Personal extension needs a true-install receipt and supported reset lifecycle.",
  );
  const areas = Object.fromEntries(
    ["local", "session", "sync"].map((key) => [key, { oldCheckpoint: true }]),
  );
  const calls = [];
  const listeners = [];
  const chrome = {
    runtime: { onInstalled: { addListener: (fn) => listeners.push(fn) } },
    management: {
      uninstallSelf: async (options) => calls.push(["uninstallSelf", options]),
    },
    storage: Object.fromEntries(
      Object.keys(areas).map((key) => [
        key,
        {
          get: async (name) =>
            name ? { [name]: areas[key][name] } : { ...areas[key] },
          set: async (values) => Object.assign(areas[key], values),
          clear: async () => {
            calls.push(["clear", key]);
            areas[key] = {};
          },
        },
      ]),
    ),
  };
  const context = vm.createContext({ crypto: webcrypto, Date, console });
  vm.runInContext(fs.readFileSync(source, "utf8"), context);
  const lifecycle = context.CreatorExtensionLifecycle.create({ chrome });
  return {
    lifecycle,
    areas,
    calls,
    chrome,
    installed: (details) => listeners[0](details),
  };
}

test("only a real Chrome install creates a new receipt; update/reload cannot satisfy a fresh reset", async () => {
  const f = fixture();
  assert.equal(await f.lifecycle.getInstallation(), null);
  await f.installed({ reason: "update" });
  assert.equal(await f.lifecycle.getInstallation(), null);
  assert.equal(f.areas.local.oldCheckpoint, true);
  await f.installed({ reason: "install" });
  assert.equal(await f.lifecycle.getInstallation(), null);
  assert.equal(await f.lifecycle.needsInitialization(), true);
  await f.lifecycle.completeInstallation();
  const receipt = await f.lifecycle.getInstallation();
  assert.match(receipt.id, /^[a-f0-9-]{36}$/);
  assert.ok(receipt.installedAt > 0);
  for (const area of Object.values(f.areas))
    assert.equal(area.oldCheckpoint, undefined);
  await f.installed({ reason: "update" });
  assert.deepEqual(await f.lifecycle.getInstallation(), receipt);
});

test("explicit reset preserves recovery storage until Chrome accepts uninstallSelf", async () => {
  const f = fixture();
  await f.lifecycle.uninstall();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
    ["uninstallSelf", { showConfirmDialog: false }],
  ]);
  for (const area of Object.values(f.areas))
    assert.equal(area.oldCheckpoint, true);
});

test("unavailable or refused self-removal stops with an actionable manual removal error", async () => {
  const f = fixture();
  delete f.chrome.management;
  await assert.rejects(
    f.lifecycle.uninstall(),
    /Remove.*Creator Workflow Toolkit.*chrome:\/\/extensions/i,
  );
  assert.equal(
    f.areas.local.oldCheckpoint,
    true,
    "Do not clear state when removal API is unavailable.",
  );
  f.chrome.management = {
    uninstallSelf: async () => {
      throw new Error("blocked");
    },
  };
  await assert.rejects(
    f.lifecycle.uninstall(),
    /refused.*Remove.*Creator Workflow Toolkit/i,
  );
});

test("interrupted initialization resumes the same install identity", async () => {
  const f = fixture();
  await f.installed({ reason: "install" });
  const pending = f.areas.local.ofenhancerInstallationV1;
  assert.equal(pending.status, "initializing");
  assert.equal(await f.lifecycle.needsInitialization(), true);
  await f.lifecycle.completeInstallation();
  const receipt = await f.lifecycle.getInstallation();
  assert.equal(receipt.id, pending.id);
  assert.equal(receipt.installedAt, pending.installedAt);
});
