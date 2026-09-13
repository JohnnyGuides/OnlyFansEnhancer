"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const root = require("../support/paths.cjs").repositoryRoot;
const signal = () => {
  const callbacks = [];
  return {
    addListener: (fn) => callbacks.push(fn),
    removeListener: (fn) => callbacks.splice(callbacks.indexOf(fn), 1),
    emit: (value) => callbacks.forEach((fn) => fn(value)),
  };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
function extension() {
  const storage = {};
  const timers = [];
  const sent = [];
  const nativePorts = [];
  const bound = [];
  const actions = [];
  const chrome = {
    runtime: {
      id: "fixture-extension",
      connectNative() {
        const port = {
          onMessage: signal(),
          onDisconnect: signal(),
          postMessage: (message) => sent.push(message),
          disconnect() {
            this.onDisconnect.emit();
          },
        };
        nativePorts.push(port);
        return port;
      },
    },
    permissions: { contains: async () => false },
    storage: {
      onChanged: signal(),
      session: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (value) => Object.assign(storage, value),
      },
      local: {
        get: async (keys) =>
          Object.fromEntries(keys.map((key) => [key, storage[key]])),
        set: async (value) => Object.assign(storage, value),
      },
    },
  };
  const context = vm.createContext({
    chrome,
    crypto: webcrypto,
    setTimeout: (fn, delay) => {
      const item = { fn, delay, cleared: false };
      timers.push(item);
      return item;
    },
    clearTimeout: (item) => {
      if (item) item.cleared = true;
    },
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(
        root,
        "extensions/personal/workflows/desktop-upload-runtime.js",
      ),
      "utf8",
    ),
    context,
  );
  const runtime = context.CreatorDesktopUploadRuntime.create({
    chrome,
    handleMessage(message, sender, reply) {
      actions.push(message);
      reply({ ok: true, sender: sender.id });
      return true;
    },
    bindPort(port, message) {
      bound.push(port);
      port.sessionId = message.sessionId;
      port.postMessage({
        type: "file-request",
        requestId: "file-one",
        sessionId: message.sessionId,
      });
    },
    unbindPort(port) {
      port.unbound = true;
    },
    async attachFile(command, ports) {
      if (
        ![...ports.values()].some(
          (port) => port.sessionId === command.sessionId,
        )
      )
        throw new Error("wrong-file-session");
      return { delivered: true };
    },
  });
  return {
    runtime,
    context,
    chrome,
    timers,
    sent,
    nativePorts,
    bound,
    actions,
    tick(delay) {
      const timer = timers.find(
        (item) => !item.cleared && item.delay === delay,
      );
      assert.ok(timer, `timer ${delay}`);
      timer.cleared = true;
      timer.fn();
    },
    respond(commands = []) {
      const request = sent.at(-1);
      nativePorts.at(-1).onMessage.emit({
        requestId: request.requestId,
        ok: true,
        result: { commands, connectionId: request.payload.connectionId },
      });
    },
  };
}

function host(
  transport,
  status = () => ({
    browsers: ["browser-one"],
    selected: "browser-one",
    connected: true,
  }),
) {
  let listener;
  const requests = [];
  const webview = {
    addEventListener: (_, fn) => {
      listener = fn;
    },
    postMessage: send,
    postMessageWithAdditionalObjects: (message, files) => send(message, files),
  };
  function send(message, files) {
    const request = JSON.parse(message);
    requests.push(request);
    const result =
      request.operation === "getUploadBrowsers"
        ? status()
        : transport(request, files);
    Promise.resolve(result).then(
      (value) =>
        listener({
          data: { requestId: request.requestId, ok: true, result: value },
        }),
      (error) =>
        listener({
          data: {
            requestId: request.requestId,
            ok: false,
            error: { code: error.message },
          },
        }),
    );
  }
  const context = vm.createContext({
    chrome: { webview },
    crypto: webcrypto,
    URL,
    location: { href: "https://app.ofenhancer.local/upload-console.html" },
    setTimeout,
    clearTimeout,
    document: { readyState: "loading", addEventListener() {} },
    addEventListener() {},
    console,
  });
  vm.runInContext(
    fs.readFileSync(path.join(root, "shared/workspace/upload-host.js"), "utf8"),
    context,
  );
  return {
    context,
    requests,
    event: (value) => listener({ data: { uploadEvent: value } }),
  };
}

test("offline mutations fail without replay when a browser later arrives", async () => {
  let live = false;
  let mutations = 0;
  const fixture = host(
    () => {
      mutations++;
      return {};
    },
    () => ({
      browsers: live ? ["browser-one"] : [],
      selected: live ? "browser-one" : null,
      connected: live,
    }),
  );
  await assert.rejects(
    fixture.context.chrome.storage.local.set({ creatorToolkitV2: {} }),
    /Chrome is unavailable/,
  );
  live = true;
  await fixture.context.OFEnhancerDesktopUpload.refreshBrowsers();
  assert.equal(mutations, 0);
});

test("observing a sole live unselected browser never selects it", async () => {
  const fixture = host(
    () => {
      throw new Error("Observation must not dispatch a selection or command.");
    },
    () => ({ browsers: ["browser-one"], selected: null, connected: false }),
  );
  await fixture.context.OFEnhancerDesktopUpload.refreshBrowsers();
  assert.deepEqual(
    fixture.requests.map((request) => request.operation),
    ["getUploadBrowsers"],
  );
});

test("desktop transport cannot rewrite publication checkpoints or read arbitrary browser settings", async () => {
  const fixture = extension();
  await assert.rejects(
    fixture.runtime.execute({
      kind: "storageSet",
      values: { creatorSocialDistributionSessionV1: { stage: "published" } },
    }),
    /settings/,
  );
  await assert.rejects(
    fixture.runtime.execute({
      kind: "message",
      message: { type: "RESET_NAMES" },
    }),
    /message/,
  );
  const permission = await fixture.runtime.execute({
    kind: "permissions",
    permissions: { origins: ["https://x.com/*"] },
  });
  assert.equal(permission.granted, false);
});

test("native transport correlates responses, deduplicates commands, and never replays after disconnect", async () => {
  const fixture = extension();
  await fixture.runtime.start();
  const command = {
    id: webcrypto.randomUUID(),
    command: { kind: "message", message: { type: "GET_CREATOR_SETTINGS" } },
  };
  fixture.respond([command]);
  await flush();
  fixture.tick(500);
  fixture.respond([command]);
  await flush();
  assert.equal(fixture.actions.length, 1);
  fixture.tick(500);
  const port = fixture.nativePorts.at(-1);
  port.onMessage.emit({
    requestId: webcrypto.randomUUID(),
    ok: true,
    result: { commands: [] },
  });
  fixture.tick(5000);
  await flush();
  assert.equal(fixture.sent.at(-1).payload.replies.length, 0);
  assert.ok(
    fixture.sent
      .at(-1)
      .payload.events.some((item) => item.uploadConnectionLost),
  );
  fixture.runtime.stop();
});

test("host Chrome callback storage reports native failure via runtime.lastError", async () => {
  const fixture = host(() => Promise.reject(new Error("browser-unavailable")));
  let callbackError;
  fixture.context.chrome.storage.local.get("creatorToolkitV2", () => {
    callbackError = fixture.context.chrome.runtime.lastError?.message;
  });
  await flush();
  await flush();
  assert.equal(callbackError, "browser-unavailable");
  assert.equal(fixture.context.chrome.runtime.lastError, undefined);
});

test("host delivers virtual port progress and files through the actual desktop runtime", async () => {
  const extensionFixture = extension();
  const ui = host((request) =>
    extensionFixture.runtime.execute(
      request.operation === "deliverUploadFile"
        ? { kind: "file", ...request.payload }
        : request.payload,
    ),
  );
  const port = ui.context.chrome.runtime.connect({
    name: "creator-upload-console",
  });
  const progress = [];
  port.onMessage.addListener((value) => progress.push(value));
  port.postMessage({ type: "bind-session", sessionId: "upload-session-one" });
  await flush();
  await flush();
  await extensionFixture.runtime.start();
  for (const event of extensionFixture.sent.at(-1).payload.events)
    ui.event(event);
  assert.equal(progress[0].type, "file-request");
  const result = await ui.context.OFEnhancerDesktopUpload.deliverFile(
    { port },
    {
      requestId: "file-one",
      sessionId: "upload-session-one",
      platform: "redgifs",
      role: "social",
      token: "token",
    },
    { name: "test.mp4", size: 10, lastModified: 5 },
  );
  assert.equal(result.delivered, true);
  await assert.rejects(
    ui.context.OFEnhancerDesktopUpload.deliverFile(
      { port },
      { requestId: "file-two", sessionId: "wrong-session" },
      { name: "test.mp4", size: 10, lastModified: 5 },
    ),
    /wrong-file-session/,
  );
  extensionFixture.runtime.stop();
});
