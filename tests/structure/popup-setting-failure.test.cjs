"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../../extensions/personal/popup.js"),
  "utf8",
);

async function openPopup({ reloadFails = false, storedAfterFailure = true }) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      const listeners = {};
      elements.set(selector, {
        textContent: "",
        value: "",
        checked: false,
        listeners,
        addEventListener(type, listener) {
          listeners[type] = listener;
        },
      });
    }
    return elements.get(selector);
  };
  let settingsReads = 0;
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === "GET_SETTINGS") {
          settingsReads += 1;
          if (settingsReads > 1 && reloadFails)
            callback({ ok: false, error: "Worker unreachable." });
          else
            callback({
              ok: true,
              settings: {
                enabled: settingsReads > 1 ? storedAfterFailure : true,
                avatarMode: "mixed",
                realbooruPercentage: 50,
              },
            });
        } else if (message.type === "GET_STATS")
          callback({ ok: true, stats: { mappedAccounts: 1 } });
        else callback({ ok: false, error: "Save failed." });
      },
    },
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  vm.runInNewContext(source, {
    document: { querySelector: element },
    chrome,
    confirm: () => true,
    Number,
    Math,
    Promise,
    Error,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const checkbox = element("#enabled");
  assert.equal(checkbox.checked, true);
  return {
    checkbox,
    note: element("#note"),
    async toggleOff() {
      checkbox.checked = false;
      try {
        await checkbox.listeners.change({ target: checkbox });
      } finally {
        await new Promise((resolve) => setImmediate(resolve));
        process.off("unhandledRejection", onUnhandled);
      }
      return unhandled;
    },
  };
}

test("a failed enabled-setting save returns the checkbox to the stored value", async () => {
  // Another page changed the setting to false after the popup opened as true,
  // so only a real reload (not the pre-toggle fallback) shows false.
  const popup = await openPopup({ storedAfterFailure: false });
  const unhandled = await popup.toggleOff();
  assert.equal(
    popup.checkbox.checked,
    false,
    "the checkbox must show the reloaded stored value",
  );
  assert.equal(popup.note.textContent, "Save failed.");
  assert.deepEqual(unhandled, []);
});

test("a failed save with a failed reload restores the pre-toggle value without a rejection", async () => {
  const popup = await openPopup({ reloadFails: true });
  const unhandled = await popup.toggleOff();
  assert.equal(popup.checkbox.checked, true);
  assert.equal(popup.note.textContent, "Save failed.");
  assert.deepEqual(unhandled, []);
});
