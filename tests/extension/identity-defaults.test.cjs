"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { repositoryRoot } = require("../support/paths.cjs");

async function startContent(edition, storedSettings) {
  const observedSettings = [];
  const classes = new Set();
  let observerStarts = 0;
  const context = vm.createContext({
    FanIdentityMaskCore: {
      collectContexts(_document, settings) {
        observedSettings.push(settings);
        return [];
      },
    },
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage(message, callback) {
          assert.equal(message.type, "GET_SETTINGS");
          if (storedSettings) callback({ ok: true, settings: storedSettings });
          else callback({ ok: false, error: "Fixture storage unavailable" });
        },
      },
      storage: { onChanged: { addListener() {} } },
    },
    document: {
      documentElement: {
        classList: {
          add: (value) => classes.add(value),
          remove: (value) => classes.delete(value),
        },
      },
    },
    window: { addEventListener() {}, setTimeout() {} },
    requestAnimationFrame() {},
    MutationObserver: class {
      observe() {
        observerStarts += 1;
      }
    },
    console: { warn() {} },
  });
  const run = (relativePath) => {
    vm.runInContext(
      fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
      context,
      { filename: relativePath },
    );
  };
  if (edition) run(`extensions/${edition}/identity-settings.js`);
  run("shared/identity-mask/content.js");
  await new Promise((resolve) => setImmediate(resolve));
  return {
    observerStarts,
    observedSettings,
    pending: classes.has("fim-mask-pending"),
  };
}

test("missing edition settings fail closed when storage is unavailable", async () => {
  const result = await startContent();
  assert.equal(result.observerStarts, 0);
  assert.equal(result.observedSettings.length, 0);
  assert.equal(result.pending, false);
});

test("store defaults never start masking before consent or on storage failure", async () => {
  for (const settings of [
    undefined,
    { enabled: false, consentAccepted: false },
  ]) {
    const result = await startContent("store", settings);
    assert.equal(result.observerStarts, 0);
    assert.equal(result.observedSettings.length, 0);
    assert.equal(result.pending, false);
  }
});

test("personal defaults preserve enabled masking and the owner's own-handle exclusion", async () => {
  const result = await startContent("personal");
  assert.equal(result.observerStarts, 1);
  assert.equal(result.observedSettings.length, 1);
  assert.equal(result.observedSettings[0].enabled, true);
  assert.deepEqual(Array.from(result.observedSettings[0].ownHandles), [
    "johnny_guides",
  ]);
});

test("stored disabled state overrides personal defaults", async () => {
  const result = await startContent("personal", { enabled: false });
  assert.equal(result.observerStarts, 0);
  assert.equal(result.observedSettings.length, 0);
  assert.equal(result.pending, false);
});

test("store content honors the background's explicitly consented enabled state", async () => {
  const settings = {
    enabled: true,
    consentAccepted: true,
    ownHandles: ["creator"],
  };
  const result = await startContent("store", settings);
  assert.equal(result.observerStarts, 1);
  assert.equal(result.observedSettings.length, 1);
  assert.equal(result.observedSettings[0], settings);
});
