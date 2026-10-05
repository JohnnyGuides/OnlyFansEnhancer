"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { personalRoot } = require("../support/paths.cjs");
const backgroundPath = path.resolve(personalRoot, "background.js");
const manifestPath = path.resolve(personalRoot, "manifest.json");

// --- Page observer ---------------------------------------------------------

function loadObserver(videoId = null) {
  const timers = [];
  const events = [];
  class Xhr {
    listeners = [];
    addEventListener(_name, listener) {
      this.listeners.push(listener);
    }
    open() {}
    send() {}
    complete(payload, status = 200) {
      this.status = status;
      this.responseType = "json";
      this.response = payload;
      this.listeners.forEach((listener) => listener());
    }
  }
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  const context = vm.createContext({
    URL,
    URLSearchParams,
    CustomEvent,
    location: {
      href: videoId
        ? `https://www.manyvids.com/Edit-vid/${videoId}`
        : "https://onlyfans.com/posts/create",
    },
    document: {
      querySelector() {
        return videoId ? { value: videoId } : null;
      },
      dispatchEvent(event) {
        events.push({ type: event.type, ...JSON.parse(event.detail) });
      },
    },
    XMLHttpRequest: Xhr,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
  });
  for (const file of ["catalogue-contract.js", "upload-response-observer.js"])
    vm.runInContext(
      fs.readFileSync(path.resolve(personalRoot, "workflows", file), "utf8"),
      context,
    );
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    api: context.CreatorUploadResponseObserver,
    Xhr,
    events,
    timers,
    settle,
  };
}

const WATCH = "0123456789abcdef0123456789abcdef";
const OBSERVER_SESSION = "manual-session-123456";

function post(Xhr, url = "https://onlyfans.com/api2/v2/posts") {
  const xhr = new Xhr();
  xhr.open("POST", url);
  return xhr;
}

test("a manual watch captures only the first post opened after arming", async () => {
  const { api, Xhr, events, settle } = loadObserver();
  // An unrelated deferred observer patches XHR before the early request.
  api
    .install({
      sessionId: "other-session-123456",
      platform: "onlyfans",
      deferred: true,
    })
    .catch(() => {});
  const early = post(Xhr);
  assert.equal(
    api.watch({
      sessionId: OBSERVER_SESSION,
      platform: "onlyfans",
      watchId: WATCH,
      timeoutMs: 6 * 60 * 60_000,
    }),
    true,
  );
  early.complete({ id: 111111111 });
  await settle();
  assert.deepEqual(events, [], "a request opened before arming is ignored");
  post(Xhr, "https://onlyfans.com/api2/v2/users/me").complete({ id: 1234567 });
  await settle();
  assert.deepEqual(events, [], "another endpoint is ignored");
  post(Xhr).complete({ id: 222222222 });
  await settle();
  post(Xhr).complete({ id: 333333333 });
  await settle();
  assert.deepEqual(events, [
    {
      type: "creator-upload-manual-publish",
      watchId: WATCH,
      outcome: "captured",
      postUrl: "https://onlyfans.com/222222222/johnny_guides",
    },
  ]);
});

test("a manual watch survives a rejected publish and captures the retry", async () => {
  const { api, Xhr, events, settle } = loadObserver();
  api.watch({
    sessionId: OBSERVER_SESSION,
    platform: "fansly",
    watchId: WATCH,
    timeoutMs: 60_000,
  });
  post(Xhr, "https://apiv3.fansly.com/api/v1/post").complete(
    { success: false },
    400,
  );
  await settle();
  assert.deepEqual(events, []);
  post(Xhr, "https://apiv3.fansly.com/api/v1/post").complete({
    response: { id: "987654321" },
  });
  await settle();
  assert.equal(events.length, 1);
  assert.equal(events[0].postUrl, "https://fansly.com/post/987654321");
});

test("ManyVids records only the bound editor's accepted final Save", async () => {
  const { api, Xhr, events, settle } = loadObserver("7470821");
  assert.equal(
    api.watch({
      sessionId: OBSERVER_SESSION,
      platform: "manyvids",
      videoId: "7470821",
      watchId: WATCH,
      timeoutMs: 60_000,
    }),
    true,
  );
  const save = (body, payload, status = 200) => {
    const xhr = post(Xhr, "https://www.manyvids.com/includes/saveVideo.php");
    xhr.send(body);
    xhr.complete(payload, status);
  };
  save("vid_id=999&edit_video=true", {});
  save("vid_id=7470821&edit_video=false", {});
  save("vid_id=7470821&edit_video=true", { error: "validation failed" });
  save("vid_id=7470821&edit_video=true", {}, 500);
  await settle();
  assert.deepEqual(events, []);
  save("vid_id=7470821&edit_video=true", {});
  await settle();
  assert.equal(events.length, 1);
  assert.equal(events[0].postUrl, "https://www.manyvids.com/Video/7470821");
});

test("ManyVids manual preparation watches Save and refuses a different video's result", async () => {
  const env = await loadWorker();
  const id = sessionId();
  const session = addSession(env, id, { platforms: ["manyvids"] });
  const target = session.platforms.get("manyvids");
  target.manyvidsId = "7470821";
  assert.equal(
    (await prepare(env, id, "manyvids")).status,
    "awaiting-manual-publish",
  );
  await assert.rejects(
    deliver(
      env,
      outcome(id, target, {
        postUrl: "https://www.manyvids.com/Video/999/",
      }),
      senderFor(target),
    ),
    /different video/,
  );
  assert.deepEqual(env.commits, []);
  const captured = await deliver(
    env,
    outcome(id, target, {
      postUrl: "https://www.manyvids.com/Video/7470821/",
    }),
    senderFor(target),
  );
  assert.equal(captured.result.status, "catalogue-updated");
});

test("a manual watch announces unresolved, cancelled and expired outcomes", async () => {
  const { api, Xhr, events, timers, settle } = loadObserver();
  api.watch({
    sessionId: OBSERVER_SESSION,
    platform: "onlyfans",
    watchId: WATCH,
    timeoutMs: 6 * 60 * 60_000,
  });
  assert.equal(timers.at(-1).delay, 6 * 60 * 60_000);
  post(Xhr).complete({ ok: true });
  await settle();
  assert.equal(events.at(-1).outcome, "unresolved");

  const second = "fedcba9876543210fedcba9876543210";
  api.watch({
    sessionId: OBSERVER_SESSION,
    platform: "onlyfans",
    watchId: second,
    timeoutMs: 24 * 60 * 60_000,
  });
  assert.equal(timers.at(-1).delay, 12 * 60 * 60_000, "the watch is bounded");
  api.cancel(OBSERVER_SESSION, "onlyfans");
  await settle();
  assert.deepEqual(events.at(-1), {
    type: "creator-upload-manual-publish",
    watchId: second,
    outcome: "cancelled",
    postUrl: "",
  });

  api.watch({
    sessionId: OBSERVER_SESSION,
    platform: "onlyfans",
    watchId: WATCH,
    timeoutMs: 60_000,
  });
  timers.at(-1).callback();
  await settle();
  assert.equal(events.at(-1).outcome, "expired");
  assert.equal(api.watch({ sessionId: OBSERVER_SESSION, watchId: "x" }), false);
});

test("autonomous observation still fails on a rejected final request", async () => {
  const { api, Xhr } = loadObserver();
  const result = api.install({
    sessionId: OBSERVER_SESSION,
    platform: "onlyfans",
    timeoutMs: 60 * 60_000,
  });
  post(Xhr).complete({ error: "no" }, 400);
  await assert.rejects(result, /rejected the final post request \(400\)/);
});

// --- Extension worker ------------------------------------------------------

function inert() {
  return new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : inert()),
    apply: () => undefined,
  });
}

function createStorageArea() {
  const values = {};
  return {
    values,
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

async function loadWorker({ armResult = true } = {}) {
  const scriptCalls = [];
  const removedListeners = [];
  const local = createStorageArea();
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
        local,
        session: createStorageArea(),
      },
      tabs: new Proxy(
        {
          onRemoved: {
            addListener: (listener) => removedListeners.push(listener),
          },
        },
        { get: (target, key) => (key in target ? target[key] : inert()) },
      ),
      scripting: {
        async executeScript(details) {
          scriptCalls.push(details);
          if (details.files) return [{ frameId: 0 }];
          const name = details.func?.name;
          if (
            name === "installCreatorManualPublishBridge" ||
            name === "watchCreatorManualPublishInPage"
          )
            return [{ frameId: 0, result: armResult }];
          return [{ frameId: 0 }];
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
  const commits = [];
  context.commits = commits;
  run(`
    globalThis.realCommitCreatorUploadResult = commitCreatorUploadResult;
    commitCreatorUploadResult = async (session, platform, postUrl) => {
      commits.push({ platform, postUrl });
      if (session.catalogue === null) return { status: "uploaded-no-sheet" };
      return { status: "updated" };
    };
  `);
  // The worker adopts its runtime version at startup, before any session.
  await run("ensureCreatorUploadRuntimeVersion()");
  return { chrome, context, run, scriptCalls, removedListeners, commits };
}

let nextId = 0;
function sessionId() {
  nextId += 1;
  return `${String(nextId).padStart(2, "0")}${"cd".repeat(23)}`;
}

function addSession(env, id, options = {}) {
  env.context.spec = {
    id,
    publishMode: options.publishMode || "manual",
    catalogue:
      options.catalogue === undefined
        ? { row: 7, id: "item-7", fingerprint: "f".repeat(64) }
        : options.catalogue,
    platforms: options.platforms || ["onlyfans"],
  };
  return env.run(`(() => {
    const session = {
      id: spec.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      draft: { title: "Benign episode", publishMode: spec.publishMode },
      catalogue: spec.catalogue,
      launcher: "extension",
      platforms: new Map(
        spec.platforms.map((platform, index) => [
          platform,
          {
            platform,
            status: "upload-observing",
            stage: "upload",
            tabId: 100 + index,
            documentId: "doc-" + index,
          },
        ]),
      ),
      commitChain: Promise.resolve(),
      cleanupTimer: null,
    };
    creatorUploadSessions.set(spec.id, session);
    return session;
  })()`);
}

function connect(env, id) {
  const port = {
    creatorUploadSessionId: id,
    dead: false,
    messages: [],
    postMessage(message) {
      if (port.dead) throw new Error("Attempting to use a disconnected port.");
      port.messages.push(message);
    },
  };
  env.context.port = port;
  env.run("creatorUploadConsolePorts.add(port)");
  return port;
}

async function prepare(env, id, platform = "onlyfans") {
  env.context.preparing = { id, platform };
  return env.run(
    `recordCreatorManualPreparation(creatorUploadSessions.get(preparing.id), creatorUploadSessions.get(preparing.id).platforms.get(preparing.platform))`,
  );
}

function deliver(env, message, sender) {
  env.context.delivery = { message, sender };
  return env.run(
    `acceptCreatorManualPublishOutcome(delivery.message, delivery.sender)`,
  );
}

function outcome(id, target, extra = {}) {
  return {
    type: "CREATOR_UPLOAD_MANUAL_PUBLISH_OBSERVED",
    sessionId: id,
    platform: target.platform,
    watchId: target.manualWatchId,
    outcome: "captured",
    postUrl: "https://onlyfans.com/424242424/johnny_guides",
    ...extra,
  };
}

function senderFor(target, extra = {}) {
  return {
    frameId: 0,
    tab: { id: target.tabId },
    documentId: target.documentId,
    url: "https://onlyfans.com/posts/create",
    ...extra,
  };
}

async function stored(env, id) {
  env.context.lookup = id;
  return env.run("CreatorUploadSessionStore.load(lookup)");
}

test("manual preparation arms a watch in the exact prepared document", async () => {
  const env = await loadWorker();
  const id = sessionId();
  const session = addSession(env, id);
  const port = connect(env, id);
  const result = await prepare(env, id);
  const target = session.platforms.get("onlyfans");
  assert.equal(result.status, "awaiting-manual-publish");
  assert.equal(target.status, "awaiting-manual-publish");
  assert.match(target.manualWatchId, /^[a-f0-9]{32}$/);
  assert.ok(target.manualWatchUntil > Date.now() + 5 * 60 * 60_000);
  const armCalls = env.scriptCalls.filter(
    (call) => call.files || /ManualPublish/.test(call.func?.name || ""),
  );
  assert.equal(armCalls.length, 3);
  for (const call of armCalls)
    assert.deepEqual(JSON.parse(JSON.stringify(call.target)), {
      tabId: 100,
      documentIds: ["doc-0"],
    });
  assert.equal(armCalls[0].func.name, "installCreatorManualPublishBridge");
  assert.equal(armCalls[0].world, undefined, "the relay runs isolated");
  assert.equal(armCalls[2].world, "MAIN");
  assert.equal(armCalls[2].args[0].watchId, target.manualWatchId);
  assert.equal(port.messages.at(-1).result.status, "awaiting-manual-publish");
  const record = await stored(env, id);
  assert.equal(record.platforms.onlyfans.status, "awaiting-manual-publish");
  assert.equal(record.platforms.onlyfans.manualWatchId, target.manualWatchId);
  assert.equal(
    record.platforms.onlyfans.manualWatchUntil,
    target.manualWatchUntil,
  );
});

test("a matching post commits its link once; duplicates are inert", async () => {
  const env = await loadWorker();
  const id = sessionId();
  const session = addSession(env, id);
  connect(env, id);
  await prepare(env, id);
  const target = session.platforms.get("onlyfans");
  const message = outcome(id, target);
  const sender = senderFor(target);
  const [first, duplicate] = await Promise.all([
    deliver(env, message, sender),
    deliver(env, message, sender),
  ]);
  assert.equal(first.accepted, true);
  assert.equal(first.result.status, "catalogue-updated");
  assert.equal(duplicate.accepted, false);
  const again = await deliver(env, message, sender);
  assert.equal(again.accepted, false);
  assert.deepEqual(JSON.parse(JSON.stringify(env.commits)), [
    {
      platform: "onlyfans",
      postUrl: "https://onlyfans.com/424242424/johnny_guides",
    },
  ]);
  assert.equal(target.status, "catalogue-updated");
  assert.equal(target.postUrl, "https://onlyfans.com/424242424/johnny_guides");
  assert.equal(target.submitAttempted, undefined, "no publication journal");
  assert.equal(
    (await stored(env, id))?.platforms?.onlyfans,
    undefined,
    "a fully terminal session retires from the store",
  );
});

test("an unrelated tab, document, frame or superseded watch cannot commit", async () => {
  const env = await loadWorker();
  const id = sessionId();
  const session = addSession(env, id, { platforms: ["onlyfans", "fansly"] });
  await prepare(env, id, "onlyfans");
  await prepare(env, id, "fansly");
  const target = session.platforms.get("onlyfans");
  const fansly = session.platforms.get("fansly");
  for (const sender of [
    senderFor(target, { tab: { id: 999 } }),
    senderFor(target, { documentId: "doc-other" }),
    senderFor(target, { frameId: 3 }),
    senderFor(fansly),
  ])
    await assert.rejects(
      deliver(env, outcome(id, target), sender),
      /Unauthorized manual publish observation/,
    );
  const stale = await deliver(
    env,
    outcome(id, target, { watchId: "f".repeat(32) }),
    senderFor(target),
  );
  assert.equal(stale.accepted, false);
  const unknown = await deliver(
    env,
    outcome(sessionId(), target),
    senderFor(target),
  );
  assert.equal(unknown.accepted, false);
  assert.deepEqual(env.commits, []);
  assert.equal(target.status, "awaiting-manual-publish");
  assert.equal(fansly.status, "awaiting-manual-publish");
});

test("tab close, leaving the page, expiry and stop end the watch without a commit", async () => {
  const env = await loadWorker();
  const id = sessionId();
  const session = addSession(env, id, {
    platforms: ["onlyfans", "fansly"],
  });
  const port = connect(env, id);
  await prepare(env, id, "onlyfans");
  await prepare(env, id, "fansly");
  const onlyfans = session.platforms.get("onlyfans");
  const fansly = session.platforms.get("fansly");

  assert.equal(env.removedListeners.length, 1);
  env.removedListeners[0](101);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fansly.status, "manual-link-watch-ended");
  assert.match(fansly.error, /tab was closed/);
  assert.equal(onlyfans.status, "awaiting-manual-publish");

  const left = await deliver(
    env,
    outcome(id, onlyfans, { outcome: "left", postUrl: "" }),
    senderFor(onlyfans),
  );
  assert.equal(left.result.status, "manual-link-watch-ended");
  assert.match(onlyfans.error, /page was left/);
  assert.equal(port.messages.at(-1).result.status, "manual-link-watch-ended");

  const expiredId = sessionId();
  const expiring = addSession(env, expiredId);
  await prepare(env, expiredId);
  const late = expiring.platforms.get("onlyfans");
  late.manualWatchUntil = Date.now() - 1;
  const expired = await deliver(env, outcome(expiredId, late), senderFor(late));
  assert.equal(expired.result.status, "manual-link-watch-ended");
  assert.match(late.error, /6 hours/);

  const stopId = sessionId();
  const stopping = addSession(env, stopId);
  await prepare(env, stopId);
  const stopped = stopping.platforms.get("onlyfans");
  const before = env.scriptCalls.length;
  await env.run(
    `stopCreatorUploadSession(creatorUploadSessions.get("${stopId}"))`,
  );
  assert.equal(stopped.status, "manual-link-watch-ended");
  assert.match(stopped.error, /Stopped watching/);
  assert.ok(
    env.scriptCalls
      .slice(before)
      .some((call) =>
        String(call.func).includes("CreatorUploadResponseObserver?.cancel"),
      ),
  );
  const afterStop = await deliver(
    env,
    outcome(stopId, stopped),
    senderFor(stopped),
  );
  assert.equal(afterStop.accepted, false);
  assert.deepEqual(env.commits, []);
});

test("the link still commits with the console closed and after a worker restart", async () => {
  const env = await loadWorker();
  const id = sessionId();
  const session = addSession(env, id);
  const port = connect(env, id);
  await prepare(env, id);
  const target = { ...session.platforms.get("onlyfans") };
  port.dead = true;
  env.run("creatorUploadConsolePorts.clear(); creatorUploadSessions.clear()");
  const result = await deliver(env, outcome(id, target), senderFor(target));
  assert.equal(result.result.status, "catalogue-updated");
  assert.equal(env.commits.length, 1);
});

test("an expired watch restored after a worker restart ends without a commit", async () => {
  const env = await loadWorker();
  const id = sessionId();
  const session = addSession(env, id);
  await prepare(env, id);
  const target = session.platforms.get("onlyfans");
  target.manualWatchUntil = Date.now() - 1;
  await env.run(
    `checkpointCreatorUploadSession(creatorUploadSessions.get("${id}"))`,
  );
  env.run("creatorUploadSessions.clear()");
  const result = await deliver(env, outcome(id, target), senderFor(target));
  assert.equal(result.accepted, false);
  assert.deepEqual(env.commits, []);
});

test("without a catalogue row the captured post keeps uploaded-no-sheet semantics", async () => {
  const env = await loadWorker();
  const id = sessionId();
  const session = addSession(env, id, { catalogue: null });
  await prepare(env, id);
  const target = session.platforms.get("onlyfans");
  env.run("commitCreatorUploadResult = realCommitCreatorUploadResult");
  const result = await deliver(env, outcome(id, target), senderFor(target));
  assert.equal(result.result.status, "uploaded-no-sheet");
  assert.equal(target.postUrl, "https://onlyfans.com/424242424/johnny_guides");
});

test("an unresolvable post response records posted-link-unresolved", async () => {
  const env = await loadWorker();
  const id = sessionId();
  const session = addSession(env, id);
  await prepare(env, id);
  const target = session.platforms.get("onlyfans");
  const result = await deliver(
    env,
    outcome(id, target, { outcome: "unresolved", postUrl: "" }),
    senderFor(target),
  );
  assert.equal(result.result.status, "posted-link-unresolved");
  assert.deepEqual(env.commits, []);
});

test("autonomous mode, ManyVids and a failed arm keep manual-submit-required", async () => {
  const env = await loadWorker();
  const id = sessionId();
  addSession(env, id, {
    publishMode: "autonomous",
    platforms: ["onlyfans", "manyvids"],
  });
  assert.equal(
    (await prepare(env, id, "onlyfans")).status,
    "manual-submit-required",
  );
  assert.equal(
    (await prepare(env, id, "manyvids")).status,
    "manual-submit-required",
  );
  assert.equal(
    env.scriptCalls.filter((call) =>
      /ManualPublish/.test(call.func?.name || ""),
    ).length,
    0,
  );

  const failing = await loadWorker({ armResult: false });
  const failedId = sessionId();
  const session = addSession(failing, failedId);
  const result = await prepare(failing, failedId);
  assert.equal(result.status, "manual-submit-required");
  assert.match(result.error, /will not be recorded automatically/);
  assert.equal(session.platforms.get("onlyfans").manualWatchId, undefined);
});

test("New keeps a watch-only session and hides it from resume", async () => {
  const env = await loadWorker();
  const id = sessionId();
  const session = addSession(env, id);
  await prepare(env, id);
  const reset = await env.run("retireCreatorUploadSessions()");
  assert.equal(reset.retired, 0);
  assert.equal(
    session.platforms.get("onlyfans").status,
    "awaiting-manual-publish",
  );
  const resumable = await new Promise((resolve) =>
    env.run("handleExtensionMessage")(
      { type: "GET_CREATOR_UPLOAD_RESUMABLE" },
      { id: "test-extension" },
      resolve,
    ),
  );
  assert.equal(resumable.resumable ?? null, null);
  const target = session.platforms.get("onlyfans");
  const result = await deliver(env, outcome(id, target), senderFor(target));
  assert.equal(result.result.status, "catalogue-updated");
});
