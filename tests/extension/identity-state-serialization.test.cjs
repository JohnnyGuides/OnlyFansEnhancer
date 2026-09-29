"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { personalRoot, storeRoot } = require("../support/paths.cjs");

const EDITIONS = [
  ["personal", personalRoot],
  ["store", storeRoot],
];

// Captured from the source before the allocation bound was added.
const UNSATURATED_CASES = [
  ["ava", "handle:one", []],
  ["ava", "handle:one", ["ava"]],
  ["ava", "handle:two", ["ava", "ava17"]],
  ["mia_k", "user:42", ["mia_k"]],
  ["girl", "handle:x", ["girl", "girl1", "girl2", "girl3", "girl50"]],
];
const UNSATURATED_GOLDEN = {
  personal: ["ava", "ava56", "ava27", "mia_k86", "girl70"],
  store: ["ava", "ava56", "ava27", "mia_k86", "girl70"],
};

function deepStub() {
  return new Proxy(() => undefined, {
    get: (_target, property) =>
      property === "then"
        ? undefined
        : property === "lastError"
          ? null
          : deepStub(),
    apply: () => undefined,
  });
}

function loadBackground(root) {
  const storage = {};
  const log = [];
  const gates = { holdStateRead: null, failNextStateWrite: false };
  let messageListener;
  const stub = deepStub();
  const chrome = new Proxy(stub, {
    get(target, property) {
      if (property === "storage") {
        return {
          onChanged: { addListener() {} },
          local: {
            async get(key) {
              const value = structuredClone(
                key in storage ? { [key]: storage[key] } : {},
              );
              const gate = gates.holdStateRead;
              if (gate && key === "fimStateV1") {
                gates.holdStateRead = null;
                await gate;
              }
              return value;
            },
            async set(values) {
              if ("fimStateV1" in values && gates.failNextStateWrite) {
                gates.failNextStateWrite = false;
                throw new Error("quota exceeded");
              }
              log.push(Object.keys(values)[0]);
              Object.assign(storage, structuredClone(values));
            },
          },
        };
      }
      if (property === "runtime") {
        return {
          id: "test-extension",
          lastError: null,
          getManifest: () => ({ version: "0.0.0" }),
          getURL: (relative) => `chrome-extension://test-extension/${relative}`,
          onMessage: {
            addListener(listener) {
              messageListener = listener;
            },
          },
          onInstalled: { addListener() {} },
          onStartup: { addListener() {} },
        };
      }
      return Reflect.get(target, property);
    },
  });
  const context = vm.createContext({
    TextEncoder,
    Blob,
    btoa,
    console,
    crypto,
    chrome,
    fetch: async () => {
      throw new Error("network unavailable in test");
    },
    importScripts(...relativePaths) {
      for (const relativePath of relativePaths) {
        const sourcePath = path.resolve(root, relativePath);
        vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, {
          filename: sourcePath,
        });
      }
    },
    structuredClone,
    clearTimeout,
    setTimeout,
    URL,
    URLSearchParams,
  });
  const file = path.join(root, "background.js");
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  const send = (message) =>
    new Promise((resolve) => messageListener(message, {}, resolve));
  return { context, storage, log, gates, send };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function resetBehindHeldResolve(env) {
  const first = await env.send({
    type: "RESOLVE_IDENTITIES",
    items: [{ primaryKey: "handle:alpha", aliases: [] }],
  });
  assert.equal(first.ok, true);
  assert.ok(env.storage.fimStateV1.identities["handle:alpha"]);
  env.log.length = 0;

  let release;
  env.gates.holdStateRead = new Promise((resolve) => {
    release = resolve;
  });
  const resolving = env.send({
    type: "RESOLVE_IDENTITIES",
    items: [{ primaryKey: "handle:beta", aliases: [] }],
  });
  await tick();
  const resetting = env.send({ type: "RESET_MAPPINGS" });
  await tick();
  release();
  return Promise.all([resolving, resetting]);
}

for (const [edition, root] of EDITIONS) {
  test(`${edition}: uniqueHandle terminates when the base and suffixes 1-99 are taken`, () => {
    const { context } = loadBackground(root);
    const usedHandles = { ava: "other" };
    for (let suffix = 1; suffix <= 99; suffix += 1) {
      usedHandles[`ava${suffix}`] = "other";
    }
    context.state = { usedHandles };
    const before = { ...usedHandles };
    const run = (key) =>
      vm.runInContext(
        `uniqueHandle("ava", state, ${JSON.stringify(key)})`,
        context,
        {
          timeout: 3000,
        },
      );
    const handle = run("k");
    assert.equal(before[handle], undefined);
    assert.equal(context.state.usedHandles[handle], "k");
    assert.equal(handle, "ava100");
    assert.equal(run("k2"), "ava101");
    assert.equal(run("k"), "ava100");
    for (const [used, owner] of Object.entries(before)) {
      assert.equal(context.state.usedHandles[used], owner);
    }
  });

  test(`${edition}: uniqueHandle leaves unsaturated results unchanged`, () => {
    const { context } = loadBackground(root);
    const observed = UNSATURATED_CASES.map(([base, key, taken]) => {
      context.state = { usedHandles: {} };
      for (const handle of taken) context.state.usedHandles[handle] = "other";
      context.args = [base, key];
      return vm.runInContext("uniqueHandle(args[0], state, args[1])", context, {
        timeout: 3000,
      });
    });
    assert.deepEqual(observed, UNSATURATED_GOLDEN[edition]);
  });

  test(`${edition}: reset waits for a queued resolve that already read state`, async () => {
    const env = loadBackground(root);
    const [resolved, reset] = await resetBehindHeldResolve(env);
    assert.equal(resolved.ok, true);
    assert.equal(reset.ok, true);
    assert.deepEqual(env.storage.fimStateV1.identities, {});
    assert.deepEqual(env.storage.fimStateV1.usedHandles, {});
  });

  test(`${edition}: a failed reset write does not stall later mutations`, async () => {
    const env = loadBackground(root);
    await env.send({
      type: "RESOLVE_IDENTITIES",
      items: [{ primaryKey: "handle:alpha", aliases: [] }],
    });
    env.gates.failNextStateWrite = true;
    const reset = await env.send({ type: "RESET_MAPPINGS" });
    assert.equal(reset.ok, false);
    const later = await Promise.race([
      env.send({
        type: "RESOLVE_IDENTITIES",
        items: [{ primaryKey: "handle:gamma", aliases: [] }],
      }),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ok: "stalled" }), 3000),
      ),
    ]);
    assert.equal(later.ok, true);
    assert.ok(env.storage.fimStateV1.identities["handle:gamma"]);
  });
}

test("store: reset signals a refresh only after the reset state committed", async () => {
  const env = loadBackground(storeRoot);
  await resetBehindHeldResolve(env);
  assert.deepEqual(env.log, ["fimStateV1", "fimStateV1", "fimControlV1"]);
  assert.deepEqual(env.storage.fimStateV1.identities, {});
});
