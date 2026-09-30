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

// Runs a ManyVids edit-stage or Pornhub upload-stage platform with the page
// work stubbed and the console closing at the chosen point.
function siteEnvironment(platform, disconnectAt) {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, [platform], {
    title: "Episode",
    publishMode: "autonomous",
  });
  const target = session.platforms.get(platform);
  target.tokens = {};
  if (platform === "manyvids") target.manyvidsId = "123456";
  const port = connect(env, id);
  env.context.disconnectAt = disconnectAt;
  env.context.disconnect = () => {
    port.dead = true;
  };
  env.context.saves = [];
  env.chrome.tabs = {
    get: async () => ({ url: "https://pornhub.mainhub.com/upload/uploader" }),
  };
  env.run(`
    prepareCreatorManyVidsEdit = async () => {};
    resolveCreatorUploadAdapterResult = async () => {
      if (disconnectAt === "adapter") disconnect();
      return ${
        platform === "manyvids"
          ? '{ status: "save-clicked", accepted: true }'
          : '{ status: "manual-submit-required" }'
      };
    };
    commitCreatorUploadResult = async () => {
      if (disconnectAt === "commit") disconnect();
      return { status: "updated" };
    };
    const originalCheckpoint = checkpointCreatorUploadSession;
    checkpointCreatorUploadSession = (session) => {
      saves.push(session.platforms.values().next().value.status);
      return originalCheckpoint(session);
    };
  `);
  return { env, id, target };
}

test("ManyVids save-clicked notification failing does not change the recorded outcome", async () => {
  const { env, id, target } = siteEnvironment("manyvids", "adapter");
  const result = await env.run(
    `runCreatorUploadPlatform(creatorUploadSessions.get("${id}"), "manyvids")`,
  );
  assert.ok(env.context.saves.includes("save-clicked"));
  assert.equal(result.status, "catalogue-updated");
  assert.equal(target.status, "catalogue-updated");
  assert.equal(env.context.saves.at(-1), "catalogue-updated");
  // A fully terminal session is retired from the store.
  assert.equal((await storedStatuses(env, id)).manyvids, undefined);
});

test("ManyVids final result notification failing keeps the catalogue-updated record", async () => {
  const { env, id, target } = siteEnvironment("manyvids", "commit");
  const result = await env.run(
    `runCreatorUploadPlatform(creatorUploadSessions.get("${id}"), "manyvids")`,
  );
  assert.equal(result.status, "catalogue-updated");
  assert.equal(target.error, undefined);
  assert.equal(env.context.saves.at(-1), "catalogue-updated");
  assert.equal((await storedStatuses(env, id)).manyvids, undefined);
});

test("Pornhub manual result notification failing keeps manual-submit-required", async () => {
  const { env, id, target } = siteEnvironment("pornhub", "adapter");
  const result = await env.run(
    `runCreatorUploadPlatform(creatorUploadSessions.get("${id}"), "pornhub")`,
  );
  assert.equal(result.status, "manual-submit-required");
  assert.equal(target.status, "manual-submit-required");
  assert.equal(target.error, undefined);
  assert.equal(env.context.saves.at(-1), "manual-submit-required");
  assert.deepEqual(await storedStatuses(env, id), {});
});

test("cancellation still writes its final checkpoint when a platform step throws a non-disconnect error", async () => {
  const env = load();
  const id = sessionId();
  addSession(env, id, ["onlyfans", "fansly", "manyvids"]);
  env.context.saved = [];
  env.run(`
    creatorUploadPost = (sessionId, message) => {
      if (message.platform === "fansly") throw new TypeError("step failed");
    };
    const originalCheckpoint = checkpointCreatorUploadSession;
    checkpointCreatorUploadSession = (session) => {
      saved.push([...session.platforms.values()].map((t) => t.status));
      return originalCheckpoint(session);
    };
  `);
  await assert.rejects(
    env.run(`stopCreatorUploadSession(creatorUploadSessions.get("${id}"))`),
    /step failed/,
  );
  assert.equal(env.context.saved.length, 1, "The final checkpoint is written.");
  // Platforms after the throwing step are not cancelled by this loop; that is
  // reported as a finding rather than pinned here.
  const stored = await storedStatuses(env, id);
  assert.equal(stored.onlyfans, "cancelled");
  assert.equal(stored.fansly, "cancelled");
});

test("creatorUploadNotify propagates an error that is not a disconnect", () => {
  const env = load();
  env.run(
    `creatorUploadPost = () => { throw new TypeError("port exploded"); }`,
  );
  assert.throws(
    () => env.run(`creatorUploadNotify("x", { type: "platform-result" })`),
    /port exploded/,
  );
});

test("a file request with a bound port whose postMessage throws rejects", async () => {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans"]);
  session.platforms.get("onlyfans").tokens = { full: "token".repeat(6) };
  env.context.transportSession = session;
  const port = connect(env, id);
  port.dead = true;
  const outcome = await Promise.race([
    env
      .run(`creatorUploadRequestFile(transportSession, "onlyfans", "full")`)
      .then(
        () => "resolved",
        (error) => error.message,
      ),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 200)),
  ]);
  assert.match(outcome, /disconnected port/);
});

function relayProgress(env, id, status) {
  return new Promise((resolve) => {
    env.context.relayResponse = resolve;
    env.run(`handleExtensionMessage(
      { type: "CREATOR_UPLOAD_PLATFORM_PROGRESS", sessionId: "${id}",
        platform: "onlyfans", sequence: 1, status: "${status}" },
      { tab: { id: 100 }, documentId: "doc-0", url: "https://onlyfans.com/" },
      relayResponse,
    )`);
  });
}

test("the progress relay rejects with the console-disconnected code", async () => {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans"]);
  const target = session.platforms.get("onlyfans");
  env.run("assertCreatorUploadPageBinding = async () => {};");
  const missing = await relayProgress(env, id, "configuring");
  assert.equal(missing.ok, false);
  assert.equal(missing.rejectionCode, "upload-console-disconnected");
  assert.equal(target.status, "configuring", "The status is recorded first.");
  const port = connect(env, id);
  port.dead = true;
  target.progressSequence = 0;
  const dead = await relayProgress(env, id, "upload-ready");
  assert.equal(dead.ok, false);
  assert.equal(dead.rejectionCode, "upload-console-disconnected");
});

test("the page run pauses and resumes observation when the console disconnects", async () => {
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
  const sent = [];
  env.context.sent = sent;
  env.context.revision = revision;
  env.run(`
    globalThis.CreatorUploadRuns = undefined;
    globalThis.CreatorUploadPlatformAdapters = {
      revision,
      runOnlyFans: (context) => context.checkpointStep("select-full", "command-1", "intent"),
    };
    chrome.runtime.sendMessage = (message, callback) => {
      sent.push(message);
      callback(
        message.type === "CHECKPOINT_CREATOR_UPLOAD_STEP"
          ? { ok: false, rejectionCode: "upload-console-disconnected" }
          : { ok: true },
      );
    };
  `);
  env.context.args = {
    sessionId: sessionId(),
    platform: "onlyfans",
    selectors: { full: "#file_upload_input" },
    draft: {},
  };
  const outcome = env.run("invokeCreatorUploadAdapter(args)").then(
    () => "resolved",
    (error) => error.message,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    sent.map((message) => message.type),
    ["CHECKPOINT_CREATOR_UPLOAD_STEP", "CREATOR_UPLOAD_PLATFORM_PROGRESS"],
  );
  assert.equal(sent[1].status, "upload-attention-required");
  env.run(`
    for (const run of globalThis.CreatorUploadRuns.values())
      run.controller.abort();
  `);
  assert.match(await outcome, /cancelled/i);
});

// Runs the generic platform to its page run, cancels the session while the
// page run is still waiting, then lets the aborted page run fail.
async function cancelDuringFileWait({ submitted }) {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans"], { title: "Episode" });
  const target = session.platforms.get("onlyfans");
  connect(env, id);
  let failPage;
  env.chrome.scripting.onExecute = (details) =>
    details.func?.name === "invokeCreatorUploadAdapter"
      ? new Promise((_, reject) => {
          failPage = reject;
        })
      : undefined;
  const running = env.run(
    `runCreatorUploadPlatform(creatorUploadSessions.get("${id}"), "onlyfans")`,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(failPage, "The page run must be waiting.");
  if (submitted) target.submitAttempted = true;
  await env.run(`stopCreatorUploadSession(creatorUploadSessions.get("${id}"))`);
  failPage(new Error("Preparation was cancelled."));
  await running;
  return { env, id, target };
}

test("an aborted run keeps the cancelled status when nothing was submitted", async () => {
  const { env, id, target } = await cancelDuringFileWait({ submitted: false });
  assert.equal(target.status, "cancelled");
  assert.deepEqual(await storedStatuses(env, id), { onlyfans: "cancelled" });
});

// Starts the ManyVids or Pornhub page run with its adapter call parked, cancels
// the session, then lets the parked call fail as an aborted page run does.
async function cancelDuringSiteRun(platform, { submitted } = {}) {
  const { env, id, target } = siteEnvironment(platform, "none");
  let failPage;
  env.context.park = () =>
    new Promise((_, reject) => {
      failPage = reject;
    });
  env.run(`resolveCreatorUploadAdapterResult = () => park();`);
  const running = env.run(
    `runCreatorUploadPlatform(creatorUploadSessions.get("${id}"), "${platform}")`,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(failPage, "The page run must be waiting.");
  if (submitted) {
    target.submitAttempted = true;
    target.submitted = true;
    target.status = "save-clicked";
  }
  await env.run(`stopCreatorUploadSession(creatorUploadSessions.get("${id}"))`);
  failPage(new Error("Preparation was cancelled."));
  await running;
  return { env, id, target };
}

test("cancelling during the ManyVids page run before any save click stays cancelled", async () => {
  const { env, id, target } = await cancelDuringSiteRun("manyvids");
  assert.equal(target.status, "cancelled");
  assert.deepEqual(await storedStatuses(env, id), { manyvids: "cancelled" });
});

test("cancelling during the Pornhub page run before its manual result stays cancelled", async () => {
  const { env, id, target } = await cancelDuringSiteRun("pornhub");
  assert.equal(target.status, "cancelled");
  assert.deepEqual(await storedStatuses(env, id), { pornhub: "cancelled" });
});

test("cancelling during the ManyVids run after save-clicked keeps the uncertain outcome", async () => {
  const { env, id, target } = await cancelDuringSiteRun("manyvids", {
    submitted: true,
  });
  assert.equal(target.status, "posted-link-unresolved");
  assert.deepEqual(await storedStatuses(env, id), {
    manyvids: "posted-link-unresolved",
  });
});

test("a failing cancellation step does not stop later platforms and is rethrown", async () => {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans", "fansly", "manyvids"]);
  env.context.saved = [];
  env.run(`
    creatorUploadPost = (sessionId, message) => {
      if (message.platform === "fansly") throw new TypeError("step failed");
    };
    const originalCheckpoint = checkpointCreatorUploadSession;
    checkpointCreatorUploadSession = (session) => {
      saved.push([...session.platforms.values()].map((t) => t.status));
      return originalCheckpoint(session);
    };
  `);
  await assert.rejects(
    env.run(`stopCreatorUploadSession(creatorUploadSessions.get("${id}"))`),
    (error) => error.name === "TypeError" && /step failed/.test(error.message),
  );
  assert.deepEqual(
    [...session.platforms.values()].map((target) => target.status),
    ["cancelled", "cancelled", "cancelled"],
  );
  assert.deepEqual(abortCalls(env.scriptCalls), [100, 101, 102]);
  assert.equal(env.context.saved.length, 1, "The final checkpoint is written.");
  assert.deepEqual(await storedStatuses(env, id), {
    onlyfans: "cancelled",
    fansly: "cancelled",
    manyvids: "cancelled",
  });
});

test("a platform waiting for a file is cancelled when an earlier step throws", async () => {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans", "fansly", "manyvids"]);
  const third = session.platforms.get("manyvids");
  third.status = "uploading-full";
  third.stage = "upload";
  env.run(`
    creatorUploadPost = (sessionId, message) => {
      if (message.platform === "fansly") throw new TypeError("step failed");
    };
  `);
  await assert.rejects(
    env.run(`stopCreatorUploadSession(creatorUploadSessions.get("${id}"))`),
    /step failed/,
  );
  assert.equal(third.status, "cancelled");
  assert.equal((await storedStatuses(env, id)).manyvids, "cancelled");
  assert.ok(abortCalls(env.scriptCalls).includes(102));
});

test("an aborted run keeps the uncertain outcome when a submission was attempted", async () => {
  const { env, id, target } = await cancelDuringFileWait({ submitted: true });
  assert.equal(target.status, "posted-link-unresolved");
  assert.deepEqual(await storedStatuses(env, id), {
    onlyfans: "posted-link-unresolved",
  });
});

test("a cancel keeps a platform whose final control was clicked and still aborts its run", async () => {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans", "fansly", "manyvids"]);
  const second = session.platforms.get("fansly");
  second.status = "posted-link-unresolved";
  second.submitAttempted = true;
  await env.run(`stopCreatorUploadSession(creatorUploadSessions.get("${id}"))`);
  assert.deepEqual(
    [...session.platforms.values()].map((target) => target.status),
    ["cancelled", "posted-link-unresolved", "cancelled"],
  );
  assert.deepEqual(abortCalls(env.scriptCalls), [100, 101, 102]);
  assert.deepEqual(await storedStatuses(env, id), {
    onlyfans: "cancelled",
    fansly: "posted-link-unresolved",
    manyvids: "cancelled",
  });
});

test("a cancel leaves a submitted platform unchanged", async () => {
  const env = load();
  const id = sessionId();
  const session = addSession(env, id, ["onlyfans", "fansly"]);
  const second = session.platforms.get("fansly");
  second.status = "submitted";
  second.submitted = true;
  await env.run(`stopCreatorUploadSession(creatorUploadSessions.get("${id}"))`);
  assert.equal(second.status, "submitted");
  assert.equal(session.platforms.get("onlyfans").status, "cancelled");
  assert.deepEqual(abortCalls(env.scriptCalls), [100, 101]);
  assert.deepEqual(await storedStatuses(env, id), {
    onlyfans: "cancelled",
    fansly: "submitted",
  });
});

test("retirement continues past a session whose stop throws and rethrows that error", async () => {
  const env = load();
  const ids = [sessionId(), sessionId(), sessionId()];
  const platforms = ["onlyfans", "manyvids", "fansly"];
  for (const [index, id] of ids.entries()) {
    env.context.record = {
      id,
      draft: { title: "Stored episode" },
      platforms: {
        [platforms[index]]: {
          platform: platforms[index],
          tabId: 41 + index,
          status: "prepared",
        },
      },
    };
    await env.run(`(async () => {
      await ensureCreatorUploadRuntimeVersion();
      await CreatorUploadSessionStore.save(record);
    })()`);
  }
  env.run(`
    creatorUploadPost = (sessionId, message) => {
      if (message.platform === "manyvids") throw new TypeError("step failed");
    };
  `);
  await assert.rejects(
    env.run("retireCreatorUploadSessions()"),
    (error) => error.name === "TypeError" && /step failed/.test(error.message),
  );
  assert.deepEqual(await storedStatuses(env, ids[0]), {});
  assert.deepEqual(await storedStatuses(env, ids[2]), {});
});

test("retirement treats a stop timeout like a stop failure and keeps the first error", async () => {
  const env = load();
  const ids = [sessionId(), sessionId(), sessionId()];
  const platforms = ["manyvids", "onlyfans", "fansly"];
  for (const [index, id] of ids.entries()) {
    env.context.record = {
      id,
      draft: { title: "Stored episode" },
      platforms: {
        [platforms[index]]: {
          platform: platforms[index],
          tabId: 41 + index,
          status: "prepared",
        },
      },
    };
    await env.run(`(async () => {
      await ensureCreatorUploadRuntimeVersion();
      await CreatorUploadSessionStore.save(record);
    })()`);
  }
  env.context.hangingId = ids[1];
  await env.run(`(async () => {
    const session = await getCreatorUploadSession(hangingId);
    session.execution = new Promise(() => {});
    creatorUploadSessions.set(hangingId, session);
  })()`);
  // The 15 s stop wait elapses at once; every other timer is unchanged.
  const workerSetTimeout = env.context.setTimeout;
  env.context.setTimeout = (callback, delay, ...args) =>
    workerSetTimeout(callback, delay === 15_000 ? 0 : delay, ...args);
  env.run(`
    creatorUploadPost = (sessionId, message) => {
      if (message.platform === "manyvids") throw new TypeError("step failed");
    };
  `);
  await assert.rejects(
    env.run("retireCreatorUploadSessions()"),
    (error) => error.name === "TypeError" && /step failed/.test(error.message),
  );
  assert.deepEqual(await storedStatuses(env, ids[2]), {});
});
