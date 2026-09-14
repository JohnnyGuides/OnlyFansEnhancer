"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const modulePath = path.resolve(
  require("../support/paths.cjs").personalRoot,
  "workflows",
  "local-file-attacher.js",
);
const privatePath = "C:\\private\\episode.mp4";

function createChrome(options = {}) {
  const calls = [];
  const fileInputs = [];
  const commands = [];
  let frameRead = 0;
  const chrome = {
    extension: {
      isAllowedFileSchemeAccess(callback) {
        callback(options.fileAccess !== false);
      },
    },
    runtime: { lastError: null },
    tabs: {
      async get(tabId) {
        calls.push(["tabs.get", tabId]);
        return {
          id: tabId,
          url:
            options.url === undefined
              ? "https://onlyfans.com/my/home"
              : options.url,
        };
      },
    },
    debugger: {
      attach(target, version, callback) {
        calls.push(["debugger.attach", target.tabId, version]);
        reply("attach", callback);
      },
      sendCommand(target, method, parameters, callback) {
        commands.push({ method, parameters });
        calls.push(["debugger.sendCommand", target.tabId, method]);
        if (method === "DOM.setFileInputFiles")
          fileInputs.push([...parameters.files]);
        if (options.failAt === method) return reply(method, callback);
        const values = {
          "Page.getFrameTree": {
            frameTree: {
              frame: {
                id: "main-frame",
                loaderId: `loader-${frameRead}`,
                url:
                  options.frameUrls?.[
                    Math.min(frameRead++, options.frameUrls.length - 1)
                  ] ||
                  options.url ||
                  "https://onlyfans.com/my/home",
              },
            },
          },
          "DOM.getDocument": { root: { nodeId: 1 } },
          "DOM.querySelectorAll": { nodeIds: options.nodeIds || [7] },
          "DOM.describeNode": {
            node: {
              localName: options.localName || "input",
              attributes: options.attributes || ["type", "file"],
            },
          },
          "DOM.setFileInputFiles": {},
          "DOM.resolveNode": { object: { objectId: "input-object" } },
          "Runtime.callFunctionOn": { result: { value: true } },
        };
        callback(values[method]);
      },
      detach(target, callback) {
        calls.push(["debugger.detach", target.tabId]);
        reply("detach", callback);
      },
    },
  };

  function reply(stage, callback) {
    if (options.failAt === stage) {
      chrome.runtime.lastError = { message: `${stage} leaked ${privatePath}` };
      callback(undefined);
      chrome.runtime.lastError = null;
      return;
    }
    callback();
  }

  return { calls, chrome, fileInputs, commands };
}

function load(timers = {}) {
  const context = vm.createContext({
    globalThis: {},
    URL,
    setTimeout,
    clearTimeout,
    ...timers,
  });
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), context, {
    filename: modulePath,
  });
  return context.globalThis.CreatorLocalFileAttacher;
}

test("late debugger attach after timeout is cleaned up and cannot overlap a new owner", async () => {
  const timers = new Map();
  let nextTimer = 0;
  const attacher = load({
    setTimeout(callback) {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const fake = createChrome();
  let attached;
  fake.chrome.debugger.attach = (_target, _version, callback) => {
    if (attached) {
      fake.chrome.runtime.lastError = { message: "already attached" };
      callback();
      fake.chrome.runtime.lastError = null;
    } else attached = callback;
  };
  const first = assert.rejects(
    attacher.attach(request(), fake.chrome),
    /debugger-attach-failed-timeout/,
  );
  await new Promise(setImmediate);
  [...timers.values()][0]();
  await first;
  await assert.rejects(
    attacher.attach(request(), fake.chrome),
    /attachment-in-progress/,
  );
  attached();
  await new Promise(setImmediate);
  assert.equal(
    fake.calls.filter(([name]) => name === "debugger.detach").length,
    1,
  );
  assert.deepEqual(fake.fileInputs, []);
  fake.chrome.debugger.attach = (_target, _version, callback) => callback();
  await attacher.attach(request(), fake.chrome);
  assert.equal(
    fake.calls.filter(([name]) => name === "debugger.detach").length,
    2,
  );
});

test("cancelled pending debugger attach cleans up a late success without delivering a file", async () => {
  const fake = createChrome();
  const attacher = load();
  const controller = new AbortController();
  let attached;
  fake.chrome.debugger.attach = (_target, _version, callback) => {
    attached = callback;
  };
  const stopped = assert.rejects(
    attacher.attach(request({ signal: controller.signal }), fake.chrome),
    /attachment-cancelled/,
  );
  await new Promise(setImmediate);
  controller.abort();
  attached();
  await stopped;
  await new Promise(setImmediate);
  assert.equal(
    fake.calls.filter(([name]) => name === "debugger.detach").length,
    1,
  );
  assert.deepEqual(fake.fileInputs, []);
});

function request(overrides = {}) {
  return {
    tabId: 41,
    selector: "input[type=file]",
    filePath: privatePath,
    allowedOrigins: ["https://onlyfans.com"],
    ...overrides,
  };
}

test("attaches one exact local file and dispatches the native events", async () => {
  const attacher = load();
  const fake = createChrome();

  assert.deepEqual(
    JSON.parse(JSON.stringify(await attacher.attach(request(), fake.chrome))),
    { attached: true },
  );
  assert.deepEqual(fake.fileInputs, [[privatePath]]);
  assert.equal(
    fake.calls.filter(([name]) => name === "debugger.detach").length,
    1,
  );
});

test("file access permission refusal happens before debugger attachment", async () => {
  const fake = createChrome({ fileAccess: false });
  await assert.rejects(
    load().attach(request(), fake.chrome),
    /file-access-required/,
  );
  assert.equal(fake.calls.length, 0);
});

test("large-video metadata uses bounded CDP controls without reading media bytes", async () => {
  const fake = createChrome();
  await load().attach(
    request({
      expected: {
        name: "episode.mp4",
        size: 6_000_000_001,
        lastModified: 1_700_000_000_001,
      },
    }),
    fake.chrome,
  );
  const verification = fake.commands.find(
    (item) =>
      item.method === "Runtime.callFunctionOn" &&
      item.parameters.arguments[0]?.value?.size === 6_000_000_001,
  );
  assert.equal(verification.parameters.arguments[0].value.size, 6_000_000_001);
  assert.ok(JSON.stringify(fake.commands).length < 5000);
  assert.doesNotMatch(
    JSON.stringify(fake.commands),
    /arrayBuffer|readAsDataURL|base64|FileReader/,
  );
  assert.deepEqual(fake.fileInputs, [[privatePath]]);
});

test("rejects navigation away from the authorized origin before attachment", async () => {
  const attacher = load();
  const fake = createChrome({
    frameUrls: ["https://onlyfans.com/my/home", "https://example.com/upload"],
  });

  await assert.rejects(
    attacher.attach(request(), fake.chrome),
    /origin-not-allowed/,
  );
  assert.deepEqual(fake.fileInputs, []);
  assert.equal(
    fake.calls.filter(([name]) => name === "debugger.detach").length,
    1,
  );
});

test("validates the attached frame when Chrome hides the tab URL", async () => {
  const attacher = load();
  const fake = createChrome({ url: "" });

  assert.deepEqual(
    JSON.parse(JSON.stringify(await attacher.attach(request(), fake.chrome))),
    { attached: true },
  );
  assert.deepEqual(fake.fileInputs, [[privatePath]]);
});

for (const scenario of [
  {
    name: "rejects the wrong tab origin before attaching",
    options: { url: "https://example.com/upload" },
    expected: "origin-not-allowed",
    attachCalled: false,
    detachCalled: false,
  },
  {
    name: "rejects an ambiguous selector and detaches",
    options: { nodeIds: [7, 8] },
    expected: "file-control-ambiguous",
    attachCalled: true,
    detachCalled: true,
  },
  {
    name: "rejects a non-file input and detaches",
    options: { attributes: ["type", "text"] },
    expected: "file-control-invalid",
    attachCalled: true,
    detachCalled: true,
  },
  {
    name: "reports a debugger attach failure without detaching",
    options: { failAt: "attach" },
    expected: "debugger-attach-failed",
    attachCalled: true,
    detachCalled: false,
  },
  {
    name: "reports a command failure and still detaches",
    options: { failAt: "DOM.getDocument" },
    expected: "debugger-command-failed",
    attachCalled: true,
    detachCalled: true,
  },
  {
    name: "reports a detach failure without leaking the path",
    options: { failAt: "detach" },
    expected: "debugger-detach-failed",
    attachCalled: true,
    detachCalled: true,
  },
]) {
  test(scenario.name, async () => {
    const attacher = load();
    const fake = createChrome(scenario.options);
    await assert.rejects(attacher.attach(request(), fake.chrome), (error) => {
      assert.equal(error.message, scenario.expected);
      assert.equal(error.message.includes(privatePath), false);
      return true;
    });
    assert.equal(
      fake.calls.some(([name]) => name === "debugger.attach"),
      scenario.attachCalled,
    );
    assert.equal(
      fake.calls.filter(([name]) => name === "debugger.detach").length,
      scenario.detachCalled ? 1 : 0,
    );
    assert.equal(JSON.stringify(fake.calls).includes(privatePath), false);
  });
}

test("rejects a non-absolute local path before attaching", async () => {
  const attacher = load();
  const fake = createChrome();
  await assert.rejects(
    attacher.attach(request({ filePath: "episode.mp4" }), fake.chrome),
    /invalid-file-path/,
  );
  assert.equal(fake.calls.length, 0);
});
