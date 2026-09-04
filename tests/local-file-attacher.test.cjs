"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const modulePath = path.resolve(
  __dirname,
  "..",
  "creator-tools",
  "local-file-attacher.js",
);
const privatePath = "C:\\private\\episode.mp4";

function createChrome(options = {}) {
  const calls = [];
  const fileInputs = [];
  let frameRead = 0;
  const chrome = {
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

  return { calls, chrome, fileInputs };
}

function load() {
  const context = vm.createContext({ globalThis: {}, URL });
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), context, {
    filename: modulePath,
  });
  return context.globalThis.CreatorLocalFileAttacher;
}

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
