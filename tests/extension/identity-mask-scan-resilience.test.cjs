"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { repositoryRoot } = require("../support/paths.cjs");

function readShared(name) {
  return fs.readFileSync(
    path.join(repositoryRoot, "shared/identity-mask", name),
    "utf8",
  );
}

test("core: a malformed percent escape yields no identity and does not throw", () => {
  class Element {
    constructor(hrefs = []) {
      this.hrefs = hrefs;
    }
    matches() {
      return false;
    }
    querySelector() {
      return null;
    }
    querySelectorAll(selector) {
      return selector === "a[href]"
        ? this.hrefs.map((href) => ({ getAttribute: () => href }))
        : [];
    }
  }
  const mixed = new Element(["/alice", "/%zz", "/bob"]);
  const broken = new Element(["/%zz"]);
  const neighbour = new Element(["/carol"]);
  const documentRoot = {
    querySelectorAll: (selector) =>
      selector.includes(".b-fans__item") ? [mixed, broken, neighbour] : [],
  };
  const context = vm.createContext({
    Element,
    URL,
    location: { origin: "https://onlyfans.com" },
    window: { addEventListener() {}, dispatchEvent() {} },
    document: documentRoot,
    console,
  });
  vm.runInContext(readShared("core.js"), context, { filename: "core.js" });
  const core = context.FanIdentityMaskCore;

  assert.equal(core.keyFromHref("/%zz"), null);
  const contexts = core.collectContexts(documentRoot, {});
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        contexts.map((item) => [item.primaryKey, [...item.aliases]]),
      ),
    ),
    [
      ["handle:alice", ["handle:bob"]],
      ["handle:carol", []],
    ],
  );
});

function startContent({ holdResolve = true } = {}) {
  const sent = [];
  const held = [];
  const masked = [];
  const classes = { add() {}, remove() {} };
  const container = { dataset: {}, classList: classes };
  const state = { primaryKey: "handle:a" };
  let changeListener;
  let observerCallback;
  const settings = { enabled: true, consentAccepted: true, ownHandles: [] };
  const core = {
    collectContexts: () => [
      { container, primaryKey: state.primaryKey, aliases: [] },
    ],
    maskContext: (item, identity) => masked.push([item.primaryKey, identity]),
  };
  const context = vm.createContext({
    FanIdentityMaskCore: core,
    FanIdentityMaskDefaults: undefined,
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage(message, callback) {
          sent.push(message);
          if (message.type === "GET_SETTINGS") {
            callback({ ok: true, settings });
            return;
          }
          if (holdResolve) held.push({ message, callback });
        },
      },
      storage: {
        onChanged: {
          addListener: (listener) => {
            changeListener = listener;
          },
        },
      },
    },
    document: { documentElement: { classList: classes } },
    window: {
      addEventListener() {},
      setTimeout: (callback) => setTimeout(callback, 0),
    },
    requestAnimationFrame: (callback) => callback(),
    MutationObserver: class {
      constructor(callback) {
        observerCallback = callback;
      }
      observe() {}
    },
    location: { reload() {} },
    console: { warn() {} },
  });
  vm.runInContext(readShared("runtime.js"), context, {
    filename: "runtime.js",
  });
  vm.runInContext(readShared("content.js"), context, {
    filename: "content.js",
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  const respond = (entry, identity) =>
    entry.callback({
      ok: true,
      items: entry.message.items.map((item) => ({ ...item, identity })),
    });
  return {
    sent,
    held,
    masked,
    state,
    settle,
    respond,
    control: () => changeListener({ fimControlV1: {} }, "local"),
    mutate: () => observerCallback(),
  };
}

const resolveCalls = (env) =>
  env.sent.filter((message) => message.type === "RESOLVE_IDENTITIES");

test("content: a resolve response arriving after a reset is not applied or cached", async () => {
  const env = startContent();
  await env.settle();
  assert.equal(env.held.length, 1);
  env.control();
  env.respond(env.held[0], { handle: "stale" });
  await env.settle();
  assert.equal(
    env.masked.some(([, identity]) => identity.handle === "stale"),
    false,
  );
  assert.equal(env.held.length, 2, "the follow-up scan must resolve again");
  env.respond(env.held[1], { handle: "fresh" });
  await env.settle();
  assert.deepEqual(
    env.masked.map(([, identity]) => identity.handle),
    ["fresh"],
  );
});

test("content: a context whose primary key changed during the await is skipped", async () => {
  const env = startContent();
  await env.settle();
  env.state.primaryKey = "handle:b";
  env.respond(env.held[0], { handle: "old-owner" });
  await env.settle();
  assert.equal(
    env.masked.some(([key]) => key === "handle:a"),
    false,
  );
});

test("content: mutations during an in-flight scan cause exactly one follow-up scan", async () => {
  const env = startContent();
  await env.settle();
  assert.equal(env.held.length, 1);
  env.mutate();
  env.mutate();
  env.mutate();
  await env.settle();
  env.respond(env.held[0], { handle: "same" });
  await env.settle();
  assert.equal(env.masked.length, 2, "first scan plus exactly one follow-up");
  assert.equal(resolveCalls(env).length, 1, "the follow-up reuses the cache");
});
