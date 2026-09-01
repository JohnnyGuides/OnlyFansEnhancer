"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = path.resolve(__dirname, "..");

function plan(id, mode = "manual") {
  return {
    id,
    mode,
    catalogue: {
      row: 125,
      id: "resident-evil-ashley",
      title: "gooning to Ashley",
      fingerprint: "1234abcd",
    },
    socialFile: {
      basename: "ashley-social-teaser.mp4",
      size: 6,
      lastModified: 1_788_244_200_000,
      sha256:
        "3e860f41a5ea92c49803d6ec96d452693b6dcefb0e8c0bf0125b0e3debac5281",
    },
    caption: {
      state: "nonempty",
      sha256:
        "87d296ec94898c86baf805dbcc47af48e618ec25df0441f7471c60a7d6b05b4e",
    },
    paidUrl: "https://onlyfans.com/1/johnny_guides",
    targets: { x: true, reddit: [] },
    evidence: { x: "f".repeat(64) },
    authorization: {
      at: 1_788_280_000_000,
      sha256: "a".repeat(64),
    },
  };
}

function loadRuntime() {
  const values = {};
  const sessionValues = {};
  const tabs = new Map();
  const actions = [];
  const injections = [];
  const files = [];
  const sheet = [];
  let nextTabId = 10;
  let replyLive = false;
  let observedMainUrl = "";
  const chrome = {
    runtime: {
      getURL(relative) {
        return `chrome-extension://fixture/${relative}`;
      },
    },
    storage: {
      local: {
        async get(keys) {
          const wanted = keys == null ? Object.keys(values) : [keys].flat();
          return Object.fromEntries(
            wanted
              .filter((key) => Object.hasOwn(values, key))
              .map((key) => [key, structuredClone(values[key])]),
          );
        },
        async set(next) {
          Object.assign(values, structuredClone(next));
        },
      },
      session: {
        async get(keys) {
          const wanted =
            keys == null ? Object.keys(sessionValues) : [keys].flat();
          return Object.fromEntries(
            wanted
              .filter((key) => Object.hasOwn(sessionValues, key))
              .map((key) => [key, structuredClone(sessionValues[key])]),
          );
        },
        async set(next) {
          Object.assign(sessionValues, structuredClone(next));
        },
        async remove(keys) {
          for (const key of [keys].flat()) delete sessionValues[key];
        },
      },
    },
    tabs: {
      async query({ url } = {}) {
        const prefix = String(url || "").replace(/\*$/, "");
        return [...tabs.values()]
          .filter((tab) => !prefix || tab.url.startsWith(prefix))
          .map((tab) => structuredClone(tab));
      },
      async create({ url, active }) {
        const tab = { id: nextTabId++, url, active, status: "complete" };
        tabs.set(tab.id, tab);
        return structuredClone(tab);
      },
      async update(id, patch) {
        Object.assign(tabs.get(id), patch, { status: "complete" });
        return structuredClone(tabs.get(id));
      },
      async get(id) {
        return structuredClone(tabs.get(id));
      },
    },
    scripting: {
      async executeScript(details) {
        if (details.files) {
          injections.push([...details.files]);
          return [{ frameId: 0 }];
        }
        if (details.func.name === "installCreatorSocialFileBridge") {
          actions.push("bridge");
          return [{ frameId: 0, result: { installed: true } }];
        }
        if (details.func.name !== "invokeCreatorSocialXAdapter") {
          throw new Error(`Unexpected function ${details.func.name}`);
        }
        const input = details.args[0];
        actions.push(input.action);
        const tab = tabs.get(details.target.tabId);
        if (input.action === "prepare") {
          return [{ frameId: 0, result: { status: "prepared" } }];
        }
        if (input.action === "submit") {
          tab.url = "https://x.com/RecordedCreator/status/9000000000000000001";
          observedMainUrl = tab.url;
          return [{ frameId: 0, result: { status: "submitted" } }];
        }
        if (input.action === "main-identity") {
          if (!observedMainUrl || tab.url !== observedMainUrl) {
            throw new Error("The current X status no longer matches this run.");
          }
          return [
            {
              frameId: 0,
              result: {
                handle: "recordedcreator",
                resultId: "9000000000000000001",
                resultUrl: observedMainUrl,
              },
            },
          ];
        }
        if (input.action === "prepare-reply") {
          return [
            {
              frameId: 0,
              result: replyLive
                ? {
                    resultId: "9000000000000000001",
                    resultUrl:
                      "https://x.com/RecordedCreator/status/9000000000000000001",
                    replyResultId: "9000000000000000002",
                    replyResultUrl:
                      "https://x.com/RecordedCreator/status/9000000000000000002",
                  }
                : {
                    status: "reply-prepared",
                    resultId: "9000000000000000001",
                    resultUrl:
                      "https://x.com/RecordedCreator/status/9000000000000000001",
                  },
            },
          ];
        }
        if (input.action === "submit-reply") {
          replyLive = true;
          return [
            {
              frameId: 0,
              result: {
                resultId: "9000000000000000001",
                resultUrl:
                  "https://x.com/RecordedCreator/status/9000000000000000001",
                replyResultId: "9000000000000000002",
                replyResultUrl:
                  "https://x.com/RecordedCreator/status/9000000000000000002",
              },
            },
          ];
        }
        if (input.action === "capture-only") {
          if (!replyLive) throw new Error("reply unresolved");
          return [
            {
              frameId: 0,
              result: {
                resultId: "9000000000000000001",
                resultUrl:
                  "https://x.com/RecordedCreator/status/9000000000000000001",
                replyResultId: "9000000000000000002",
                replyResultUrl:
                  "https://x.com/RecordedCreator/status/9000000000000000002",
              },
            },
          ];
        }
        throw new Error(`Unexpected X action ${input.action}`);
      },
    },
  };
  const context = vm.createContext({
    chrome,
    crypto,
    structuredClone,
    TextEncoder,
    URL,
    clearTimeout,
    setTimeout,
  });
  for (const relative of [
    "creator-tools/social-distribution-contract.js",
    "creator-tools/social-distribution-session-store.js",
    "creator-tools/social-distribution-orchestrator.js",
    "creator-tools/social-chrome-runtime.js",
  ]) {
    const sourcePath = path.join(repositoryRoot, relative);
    if (fs.existsSync(sourcePath)) {
      vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, {
        filename: relative,
      });
    }
  }
  assert.ok(
    context.CreatorSocialChromeRuntime,
    "CreatorSocialChromeRuntime must be exposed",
  );
  const catalogueClient = {
    async appendDistributionLedger(payload) {
      sheet.push(["ledger", structuredClone(payload)]);
      return { status: "updated" };
    },
    async appendTwitterTeaser(payload) {
      sheet.push(["x", structuredClone(payload)]);
      return { status: "updated", fingerprint: "feed0001" };
    },
    async appendRedditPost() {
      throw new Error("Reddit is not enabled in the X milestone.");
    },
  };
  function createRuntime() {
    return context.CreatorSocialChromeRuntime.create({
      chrome,
      contract: context.CreatorSocialDistributionContract,
      store: context.CreatorSocialDistributionSessionStore,
      orchestratorFactory: context.CreatorSocialDistributionOrchestrator,
      catalogueClient,
      async fileRequest(request) {
        files.push(structuredClone(request));
      },
      now: () => 1_788_280_100_000,
    });
  }
  const runtime = createRuntime();
  return {
    actions,
    context,
    files,
    injections,
    runtime,
    restart: createRuntime,
    sessionValues,
    sheet,
    store: context.CreatorSocialDistributionSessionStore,
    tabs,
    setReplyLive(value) {
      replyLive = value;
    },
    setObservedMainUrl(value) {
      observedMainUrl = value;
    },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("manual X mode prepares once, polls without submitting, and records user-posted results", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-manual-0001";
  const prepared = plain(
    await fixture.runtime.prepare({ plan: plan(id), caption: "Caption" }),
  );
  assert.equal(prepared.targets.x.status, "ready");
  let session = plain(await fixture.runtime.start(id));
  assert.equal(session.jobs.x.stage, "prepared");
  assert.equal(fixture.actions.includes("submit"), false);
  assert.equal(fixture.files.length, 1);

  const [tab] = fixture.tabs.values();
  tab.url = "https://x.com/RecordedCreator/status/9000000000000000001";
  fixture.setObservedMainUrl(tab.url);
  session = plain(await fixture.runtime.resume(id));
  assert.equal(session.jobs.x.stage, "prepared");
  fixture.setReplyLive(true);
  session = plain(await fixture.runtime.resume(id));
  assert.equal(
    session.jobs.x.stage,
    "sheet-complete",
    JSON.stringify({ actions: fixture.actions, job: session.jobs.x }),
  );
  assert.equal(fixture.actions.includes("submit-reply"), false);
  assert.deepEqual(
    fixture.sheet.map(([kind, value]) => [
      kind,
      value.jobId || value.statusUrl,
    ]),
    [
      ["ledger", "x"],
      ["ledger", "x:reply"],
      ["x", "https://x.com/RecordedCreator/status/9000000000000000001"],
    ],
  );
});

test("autonomous X mode durably arms main and reply before the two clicks", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-auto-0001";
  await fixture.runtime.prepare({
    plan: plan(id, "autonomous"),
    caption: "Caption",
  });
  const session = plain(await fixture.runtime.start(id));
  assert.equal(
    session.jobs.x.stage,
    "sheet-complete",
    JSON.stringify({ actions: fixture.actions, job: session.jobs.x }),
  );
  assert.equal(session.jobs.x.submitAttempted, true);
  assert.equal(session.jobs.x.replySubmitAttempted, true);
  assert.deepEqual(
    fixture.actions.filter((action) => action !== "bridge"),
    ["prepare", "submit", "main-identity", "prepare-reply", "submit-reply"],
  );
});

test("worker restart after prepare restores the exact composer without storing caption text", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-prepared-restart-0001";
  await fixture.runtime.prepare({
    plan: plan(id, "autonomous"),
    caption: "Caption",
  });
  const before = plain(await fixture.store.load(id));
  assert.equal(before.jobs.x.stage, "prepared");

  const restarted = fixture.restart();
  const session = plain(await restarted.start(id));
  assert.equal(
    session.jobs.x.stage,
    "sheet-complete",
    JSON.stringify({ actions: fixture.actions, job: session.jobs.x }),
  );
  assert.equal(fixture.files.length, 1);
  assert.equal(JSON.stringify(before).includes("Caption"), false);
  assert.equal(
    JSON.stringify(fixture.sessionValues).includes("Caption"),
    false,
  );
});

test("worker restart after the prepared Post click recovers its uncheckpointed status", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-post-click-restart-0001";
  await fixture.runtime.prepare({
    plan: plan(id, "autonomous"),
    caption: "Caption",
  });
  await fixture.store.checkpoint(id, "x", {
    stage: "submit-attempted",
    updatedAt: 1_788_280_050_000,
  });
  const [tab] = fixture.tabs.values();
  tab.url = "https://x.com/RecordedCreator/status/9000000000000000001";
  fixture.setObservedMainUrl(tab.url);

  const session = plain(await fixture.restart().resume(id));
  assert.equal(
    session.jobs.x.stage,
    "sheet-complete",
    JSON.stringify({ actions: fixture.actions, job: session.jobs.x }),
  );
  assert.equal(fixture.actions.includes("main-identity"), true);
  assert.equal(fixture.actions.includes("submit"), false);
});

test("restart after an attempted X reply captures only and never clicks again", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-recover-0001";
  await fixture.store.create(plan(id, "autonomous"));
  await fixture.store.checkpoint(id, "x", {
    stage: "posted-link-unresolved",
    resultId: "9000000000000000001",
    resultUrl: "https://x.com/RecordedCreator/status/9000000000000000001",
    replySubmitAttempted: true,
  });
  fixture.tabs.set(88, {
    id: 88,
    url: "https://x.com/RecordedCreator/status/9000000000000000001",
    status: "complete",
    active: true,
  });
  fixture.setReplyLive(true);
  const session = plain(await fixture.runtime.resume(id));
  assert.equal(
    session.jobs.x.stage,
    "sheet-complete",
    JSON.stringify({ actions: fixture.actions, job: session.jobs.x }),
  );
  assert.equal(fixture.actions.includes("capture-only"), true);
  assert.equal(fixture.actions.includes("submit"), false);
  assert.equal(fixture.actions.includes("submit-reply"), false);
});

test("restart never binds an unproven sole X status tab", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-unrelated-0001";
  await fixture.store.create(plan(id, "autonomous"));
  await fixture.store.checkpoint(id, "x", {
    stage: "posted-link-unresolved",
    replySubmitAttempted: true,
  });
  fixture.tabs.set(99, {
    id: 99,
    url: "https://x.com/SomeoneElse/status/9999999999999999999",
    status: "complete",
    active: true,
  });
  fixture.setReplyLive(true);

  const session = plain(await fixture.runtime.resume(id));
  assert.equal(session.jobs.x.stage, "posted-link-unresolved");
  assert.equal(fixture.actions.includes("capture-only"), false);
  assert.deepEqual(fixture.sheet, []);
});

test("restart rejects a saved composer tab navigated to an uncheckpointed status", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-saved-tab-drift-0001";
  await fixture.runtime.prepare({ plan: plan(id), caption: "Caption" });
  const [tab] = fixture.tabs.values();
  tab.url = "https://x.com/SomeoneElse/status/9999999999999999999";
  fixture.setReplyLive(true);

  const restarted = fixture.restart();
  const session = plain(await restarted.resume(id));
  assert.equal(session.jobs.x.stage, "prepared");
  assert.equal(fixture.actions.includes("prepare-reply"), false);
  assert.deepEqual(fixture.sheet, []);
});

test("same worker rejects its bound composer tab after unrelated status navigation", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-live-tab-drift-0001";
  await fixture.runtime.prepare({ plan: plan(id), caption: "Caption" });
  const [tab] = fixture.tabs.values();
  tab.url = "https://x.com/SomeoneElse/status/9999999999999999999";
  fixture.setReplyLive(true);

  const session = plain(await fixture.runtime.resume(id));
  assert.equal(session.jobs.x.stage, "prepared");
  assert.equal(fixture.actions.includes("prepare-reply"), false);
  assert.deepEqual(fixture.sheet, []);
});
