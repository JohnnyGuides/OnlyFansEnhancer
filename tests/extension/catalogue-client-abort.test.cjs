"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const personalRoot = require("../support/paths.cjs").personalRoot;

function load() {
  const sent = [];
  const chrome = {
    storage: {
      local: {
        async get() {
          return {};
        },
      },
    },
    runtime: {
      getManifest: () => ({ version: "0.0.0" }),
      sendNativeMessage(host, message, callback) {
        sent.push(message);
        callback({ ok: true, result: { status: "updated" } });
      },
    },
  };
  const context = vm.createContext({
    chrome,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    console,
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(personalRoot, "workflows/catalogue-client.js"),
      "utf8",
    ),
    context,
    { filename: "workflows/catalogue-client.js" },
  );
  return { client: context.CreatorCatalogueClient, sent };
}

const bridge = {
  endpoint:
    "https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789/exec",
  secret: "fixture-secret-1234567890-abcdef",
};
const teaser = {
  row: 125,
  id: "resident-evil-ashley",
  fingerprint: "1234abcd",
  statusUrl: "https://x.com/Johnny_Guides/status/2094523397057237306",
};

for (const [name, config, action, payload] of [
  ["bridge read", bridge, "getCatalogueSnapshot", {}],
  ["bridge write", bridge, "appendTwitterTeaser", teaser],
  ["desktop read", { source: "desktop" }, "getCatalogueSnapshot", {}],
  ["desktop write", { source: "desktop" }, "appendTwitterTeaser", teaser],
]) {
  test(`a pre-aborted ${name} rejects before any dispatch`, async () => {
    const { client, sent } = load();
    let fetched = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      client.request(config, action, payload, {
        signal: controller.signal,
        fetchImpl: async () => {
          fetched += 1;
          return { ok: true, json: async () => ({ ok: true, result: {} }) };
        },
      }),
      /timed out or was cancelled/,
    );
    assert.equal(fetched, 0);
    assert.equal(sent.length, 0);
  });
}
