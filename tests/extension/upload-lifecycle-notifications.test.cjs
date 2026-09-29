"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundPath = path.resolve(
  require("../support/paths.cjs").personalRoot,
  "background.js",
);
const manifestPath = path.resolve(
  require("../support/paths.cjs").personalRoot,
  "manifest.json",
);

// Any chrome API the worker touches at load time but this suite does not
// exercise resolves to an inert callable.
function inert() {
  return new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : inert()),
    apply: () => undefined,
  });
}

function createStorageArea() {
  const values = {};
  return {
    async get(keys) {
      const wanted =
        keys == null
          ? Object.keys(values)
          : Array.isArray(keys)
            ? keys
            : [keys];
      const selected = {};
      for (const key of wanted)
        if (Object.hasOwn(values, key))
          selected[key] = structuredClone(values[key]);
      return selected;
    },
    async set(entries) {
      Object.assign(values, structuredClone(entries));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

function load() {
  const scriptCalls = [];
  const chrome = new Proxy(
    {
      runtime: new Proxy(
        {
          id: "test-extension",
          lastError: null,
          getManifest: () => JSON.parse(fs.readFileSync(manifestPath, "utf8")),
        },
        { get: (target, key) => (key in target ? target[key] : inert()) },
      ),
      storage: {
        onChanged: { addListener() {} },
        local: createStorageArea(),
        session: createStorageArea(),
      },
      scripting: {
        async executeScript(details) {
          scriptCalls.push(details);
          return chrome.scripting.onExecute?.(details);
        },
      },
    },
    { get: (target, key) => (key in target ? target[key] : inert()) },
  );
  const context = vm.createContext({
    AbortController,
    TextEncoder,
    Blob,
    btoa,
    chrome,
    console,
    crypto,
    fetch: async () => ({ ok: false, status: 500 }),
    importScripts(...relativePaths) {
      for (const relativePath of relativePaths) {
        const sourcePath = path.resolve(
          path.dirname(backgroundPath),
          relativePath,
        );
        vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, {
          filename: sourcePath,
        });
      }
    },
    structuredClone,
    clearTimeout,
    // Worker timers must not keep the test process alive.
    setTimeout: (...args) => setTimeout(...args).unref(),
    setInterval: (...args) => setInterval(...args).unref(),
    URL,
    URLSearchParams,
    addEventListener() {},
    removeEventListener() {},
  });
  vm.runInContext(fs.readFileSync(backgroundPath, "utf8"), context, {
    filename: backgroundPath,
  });
  const run = (source) => vm.runInContext(source, context);
  return { chrome, context, run, scriptCalls };
}

let nextId = 0;
function sessionId() {
  nextId += 1;
  return `${String(nextId).padStart(2, "0")}${"ab".repeat(23)}`;
}

function addSession(env, id, platforms, draft = { title: "Episode" }) {
  env.context.spec = { id, platforms, draft };
  return env.run(`(() => {
    const session = {
      id: spec.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      draft: spec.draft,
      catalogue: null,
      launcher: "extension",
      platforms: new Map(
        spec.platforms.map((platform, index) => [
          platform,
          { platform, status: "prepared", stage: "prepared", tabId: 100 + index, documentId: "doc-" + index },
        ]),
      ),
      commitChain: Promise.resolve(),
      cleanupTimer: null,
    };
    creatorUploadSessions.set(spec.id, session);
    return session;
  })()`);
}

function connect(env, id, onMessage = () => {}) {
  const port = {
    creatorUploadSessionId: id,
    dead: false,
    messages: [],
    postMessage(message) {
      if (port.dead) throw new Error("Attempting to use a disconnected port.");
      port.messages.push(message);
      onMessage(message);
    },
  };
  env.context.port = port;
  env.run("creatorUploadConsolePorts.add(port)");
  return port;
}

async function storedStatuses(env, id) {
  env.context.lookup = id;
  const record = await env.run("CreatorUploadSessionStore.load(lookup)");
  return Object.fromEntries(
    Object.entries(record?.platforms || {}).map(([name, target]) => [
      name,
      target.status,
    ]),
  );
}

function abortCalls(scriptCalls) {
  return scriptCalls
    .filter((call) => String(call.func).includes("run.controller.abort"))
    .map((call) => call.target.tabId);
}

test("cancelling three platforms with no console port cancels all, aborts every page run and checkpoints", async () => {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans", "fansly", "manyvids"]);
  await env.run(`stopCreatorUploadSession(creatorUploadSessions.get("${id}"))`);
  assert.deepEqual(
    [...session.platforms.values()].map((target) => target.status),
    ["cancelled", "cancelled", "cancelled"],
  );
  assert.deepEqual(abortCalls(env.scriptCalls), [100, 101, 102]);
  assert.deepEqual(await storedStatuses(env, id), {
    onlyfans: "cancelled",
    fansly: "cancelled",
    manyvids: "cancelled",
  });
});

test("the console disconnecting during the second platform's cancellation changes nothing", async () => {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans", "fansly", "manyvids"]);
  const port = connect(env, id);
  env.chrome.scripting.onExecute = (details) => {
    if (details.target.tabId === 101) {
      port.dead = true;
      env.run("creatorUploadConsolePorts.delete(port)");
    }
  };
  await env.run(`stopCreatorUploadSession(creatorUploadSessions.get("${id}"))`);
  assert.deepEqual(
    [...session.platforms.values()].map((target) => target.status),
    ["cancelled", "cancelled", "cancelled"],
  );
  assert.deepEqual(abortCalls(env.scriptCalls), [100, 101, 102]);
  assert.equal(port.messages.length, 1);
  assert.deepEqual(await storedStatuses(env, id), {
    onlyfans: "cancelled",
    fansly: "cancelled",
    manyvids: "cancelled",
  });
});

test("retiring two stored sessions with no console port retires both", async () => {
  const env = load();
  const ids = [sessionId(), sessionId()];
  for (const id of ids) {
    env.context.record = {
      id,
      draft: { title: "Stored episode" },
      platforms: {
        onlyfans: { platform: "onlyfans", tabId: 41, status: "prepared" },
        fansly: { platform: "fansly", tabId: 42, status: "prepared" },
      },
    };
    await env.run(`(async () => {
      await ensureCreatorUploadRuntimeVersion();
      await CreatorUploadSessionStore.save(record);
    })()`);
  }
  const result = await env.run("retireCreatorUploadSessions()");
  assert.equal(result.retired, 2);
  for (const id of ids) assert.deepEqual(await storedStatuses(env, id), {});
  assert.equal(abortCalls(env.scriptCalls).length, 4);
});

// Drives the generic (OnlyFans/Fansly) completion path with the page-side and
// catalogue work replaced, and the console closing once the site has acted.
function completionEnvironment(adapterStatus, disconnectAt = "adapter") {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans"], {
    title: "Episode",
    publishMode: "autonomous",
  });
  const target = session.platforms.get("onlyfans");
  target.documentId = "doc-0";
  const port = connect(env, id);
  env.context.adapterStatus = adapterStatus;
  env.context.disconnectAt = disconnectAt;
  env.context.disconnect = () => {
    port.dead = true;
  };
  env.context.saves = [];
  env.run(`
    prepareCreatorUploadResponseObserver = async () => {};
    startCreatorUploadResponseObserver = async (tabId, sessionId) => [
      { result: { sessionId, status: "link-captured", postUrl: "12345" } },
    ];
    resolveCreatorUploadAdapterResult = async () => {
      if (disconnectAt === "adapter") disconnect();
      return { status: adapterStatus };
    };
    commitCreatorUploadResult = async () => {
      if (disconnectAt === "commit") disconnect();
      return { status: "updated" };
    };
    const originalCheckpoint = checkpointCreatorUploadSession;
    checkpointCreatorUploadSession = (session) => {
      saves.push(session.platforms.get("onlyfans").status);
      return originalCheckpoint(session);
    };
  `);
  const observerCancels = () =>
    env.scriptCalls.filter((call) =>
      String(call.func).includes("CreatorUploadResponseObserver"),
    ).length;
  return { env, id, target, port, observerCancels };
}

test("catalogue-updated stays terminal when the completion notification fails", async () => {
  const { env, id, target, observerCancels } = completionEnvironment(
    "submitted",
    "commit",
  );
  const result = await env.run(
    `runCreatorUploadPlatform(creatorUploadSessions.get("${id}"), "onlyfans")`,
  );
  assert.equal(result.status, "catalogue-updated");
  assert.equal(target.status, "catalogue-updated");
  assert.equal(target.postUrl, "https://onlyfans.com/12345/johnny_guides");
  assert.equal(observerCancels(), 0);
  assert.equal(
    env.context.saves.at(-1),
    "catalogue-updated",
    "No checkpoint may follow the terminal status.",
  );
});

test("a failed notification after submission keeps the link observer armed and records the link", async () => {
  const { env, id, target, observerCancels } =
    completionEnvironment("submitted");
  const result = await env.run(
    `runCreatorUploadPlatform(creatorUploadSessions.get("${id}"), "onlyfans")`,
  );
  assert.equal(observerCancels(), 0);
  assert.equal(target.submitted, true);
  assert.equal(target.postUrl, "https://onlyfans.com/12345/johnny_guides");
  assert.notEqual(result.status, "posted-link-unresolved");
  assert.notEqual(result.status, "catalogue-commit-failed");
  assert.ok(env.context.saves.includes("link-captured"));
});

test("manual-submit-required stays manual-submit-required when its notification fails", async () => {
  const { env, id, target } = completionEnvironment("manual-submit-required");
  const result = await env.run(
    `runCreatorUploadPlatform(creatorUploadSessions.get("${id}"), "onlyfans")`,
  );
  assert.equal(result.status, "manual-submit-required");
  assert.equal(target.status, "manual-submit-required");
  assert.equal(target.error, undefined);
  assert.equal(env.context.saves.at(-1), "manual-submit-required");
});

test("required file and control transport still throws without a console port", async () => {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans"]);
  session.platforms.get("onlyfans").tokens = { full: "token".repeat(6) };
  env.context.transportSession = session;
  assert.throws(
    () => env.run(`creatorUploadPost("${id}", { type: "file-request" })`),
    /upload console is not connected/,
  );
  await assert.rejects(
    env.run(`creatorUploadRequestFile(transportSession, "onlyfans", "full")`),
    /upload console was closed/,
  );
  const port = connect(env, id);
  port.dead = true;
  assert.throws(
    () => env.run(`creatorUploadPost("${id}", { type: "file-request" })`),
    /upload port disconnected/,
  );
});

test("an aborted page run releases a role wait through the adapter context", async () => {
  const env = load();
  const revision = fs
    .readFileSync(
      path.resolve(
        path.dirname(backgroundPath),
        "workflows/upload-platform-adapters.js",
      ),
      "utf8",
    )
    .match(/revision: "([^"]+)"/)[1];
  const waits = [];
  env.context.waits = waits;
  env.context.revision = revision;
  env.run(`
    globalThis.CreatorUploadRuns = undefined;
    globalThis.CreatorUploadPlatformAdapters = {
      revision,
      runOnlyFans: (context) => context.attachFile("full", "#file_upload_input"),
    };
    globalThis.CreatorUploadFileBridge = {
      waitFor: (sessionId, role, timeoutMs, signal) =>
        new Promise((resolve, reject) => {
          waits.push({ sessionId, role, signal });
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    chrome.runtime.sendMessage = (message, callback) => callback({ ok: true });
  `);
  const args = {
    sessionId: sessionId(),
    platform: "onlyfans",
    selectors: { full: "#file_upload_input" },
    draft: {},
  };
  env.context.args = args;
  const running = env.run("invokeCreatorUploadAdapter(args)");
  const outcome = running.then(
    () => "resolved",
    (error) => error.message,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(waits.length, 1);
  assert.ok(waits[0].signal, "The role wait must receive the run's signal.");
  env.run(`
    for (const run of globalThis.CreatorUploadRuns.values())
      run.controller.abort();
  `);
  assert.match(await outcome, /aborted|cancelled/i);
});
