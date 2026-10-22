"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const nodeCrypto = require("node:crypto");
const repositoryRoot = require("../support/paths.cjs").personalRoot;

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

function loadRuntime(options = {}) {
  let clock = 1_788_280_100_000;
  const values = {};
  const sessionValues = {};
  const tabs = new Map();
  const actions = [];
  const xInputs = [];
  const injections = [];
  const files = [];
  const sheet = [];
  let nextTabId = 10;
  let replyLive = false;
  let observedMainUrl = "";
  let editorText = "";
  const submitRejections = [];
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
          return [
            { frameId: 0, documentId: `document-${details.target.tabId}` },
          ];
        }
        if (details.func.name === "installCreatorSocialFileBridge") {
          actions.push("bridge");
          return [{ frameId: 0, result: { installed: true } }];
        }
        if (details.func.name === "invokeCreatorSocialPreparationAdapter") {
          const input = details.args[0];
          actions.push(`${input.platform}:${input.action}`);
          return [
            {
              frameId: 0,
              result: {
                platform: input.platform,
                status: input.action === "link" ? "ready" : "review-required",
                manualFields: [],
              },
            },
          ];
        }
        if (details.func.name !== "invokeCreatorSocialXAdapter") {
          throw new Error(`Unexpected function ${details.func.name}`);
        }
        const input = details.args[0];
        actions.push(input.action);
        xInputs.push(structuredClone(input));
        const tab = tabs.get(details.target.tabId);
        if (input.action === "prepare") {
          editorText = options.composerText ?? input.caption;
          return [
            {
              frameId: 0,
              result: {
                status: "prepared",
                preparedCaptionSha256: nodeCrypto
                  .createHash("sha256")
                  .update(editorText)
                  .digest("hex"),
              },
            },
          ];
        }
        if (input.action === "submit") {
          if (
            nodeCrypto.createHash("sha256").update(editorText).digest("hex") !==
            input.captionSha256
          ) {
            submitRejections.push(input.captionSha256);
            throw new Error("The X caption changed after the post was armed.");
          }
          if (input.xOptions?.scheduledUtc) {
            tab.url = "https://x.com/home";
            return [{ frameId: 0, result: { status: "scheduled-unresolved" } }];
          }
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
    "workflows/catalogue-contract.js",
    "workflows/social-distribution-contract.js",
    "workflows/social-distribution-session-store.js",
    "workflows/social-distribution-orchestrator.js",
    "workflows/x-reply-policy.js",
    "workflows/x-collector-contract.js",
    "workflows/social-chrome-runtime.js",
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
  function createRuntime(orchestratorFactory) {
    return context.CreatorSocialChromeRuntime.create({
      chrome,
      contract: context.CreatorSocialDistributionContract,
      store: context.CreatorSocialDistributionSessionStore,
      orchestratorFactory:
        orchestratorFactory || context.CreatorSocialDistributionOrchestrator,
      catalogueClient,
      async fileRequest(request) {
        files.push(structuredClone(request));
      },
      now: () => clock,
      resolveScheduledResult: options.resolveScheduledResult,
      getPublicationContext: options.getPublicationContext,
      resolvePublication: options.resolvePublication,
      refreshPublications: options.refreshPublications,
      replyRunner: options.replyRunner,
    });
  }
  const runtime = createRuntime();
  return {
    actions,
    xInputs,
    context,
    files,
    injections,
    runtime,
    setNow(value) {
      clock = value;
    },
    restart: createRuntime,
    submitRejections,
    values,
    setEditorText(value) {
      editorText = value;
    },
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

function publicationFixture(overrides = {}) {
  const calls = [];
  let found = null;
  const preparedUtc = new Date(1_788_280_100_000).toISOString();
  const context = {
    accountId: "123",
    handle: "RecordedCreator",
    preparedUtc,
    latestStatusId: "100",
  };
  const main = {
    matched: true,
    resultId: "9000000000000000001",
    resultUrl: "https://x.com/RecordedCreator/status/9000000000000000001",
    postedUtc: new Date(Date.parse(preparedUtc) + 120_000).toISOString(),
  };
  const replyRunner = {
    async open(item) {
      calls.push(["open", plain(item)]);
      return { tabId: 800 };
    },
    async prepare() {
      calls.push(["prepare"]);
      return overrides.prepare ? overrides.prepare() : { status: "ready" };
    },
    async submit() {
      calls.push(["submit"]);
      if (overrides.submit) return overrides.submit();
      return {
        replyId: "9000000000000000002",
        replyUrl: "https://x.com/RecordedCreator/status/9000000000000000002",
      };
    },
    async capture() {
      calls.push(["capture"]);
      if (overrides.capture) return overrides.capture();
      throw new Error("unconfirmed");
    },
    async close() {
      calls.push(["close"]);
    },
  };
  const fixture = loadRuntime({
    getPublicationContext: async () => context,
    resolvePublication: async () => found,
    refreshPublications: async () => {
      calls.push(["refresh"]);
    },
    replyRunner,
    composerText: overrides.composerText,
  });
  const input = {
    ...plan("publication-independent-0001"),
    xOptions: {
      sensitive: true,
      scheduledUtc: "",
      timeZone: "Europe/Zurich",
      replyDelayMinutes: 15,
      autoReply: true,
    },
  };
  return {
    ...fixture,
    vm: fixture.context,
    calls,
    main,
    context,
    input,
    publish(value = main) {
      found = value;
    },
    async armMedia() {
      await fixture.runtime.observePublication(
        {
          publicationAttempt: {
            accountId: "123",
            text: "Caption",
            mediaIds: ["77"],
          },
        },
        { tab: { id: 10 }, documentId: "document-10" },
      );
    },
  };
}

test("manual publication is found without status navigation after complete Chrome session loss, and delay uses publication time", async () => {
  const f = publicationFixture();
  await f.runtime.prepare({ plan: f.input, caption: "Caption" });
  await f.armMedia();
  assert.deepEqual(
    plain((await f.store.load(f.input.id)).jobs.x.publicationContext),
    f.context,
  );
  // A full browser restart loses session storage and all tab/document state.
  f.tabs.clear();
  for (const key of Object.keys(f.sessionValues)) delete f.sessionValues[key];
  f.setNow(Date.parse(f.main.postedUtc) + 5 * 60_000);
  await f.restart().resume(f.input.id);
  assert.equal(
    f.calls.some((row) => row[0] === "refresh"),
    true,
  );
  assert.equal(
    f.calls.some((row) => row[0] === "submit"),
    false,
  );
  f.publish();
  await f.restart().resume(f.input.id);
  const due = Date.parse(f.main.postedUtc) + 15 * 60_000;
  assert.equal((await f.store.load(f.input.id)).jobs.x.replyDueAt, due);
  f.setNow(due - 1);
  await f.restart().resume(f.input.id);
  assert.equal(
    f.calls.some((row) => row[0] === "open"),
    false,
  );
  f.setNow(due);
  await f.restart().resume(f.input.id);
  await f.restart().resume(f.input.id);
  assert.equal(f.calls.filter((row) => row[0] === "submit").length, 1);
  assert.equal((await f.store.load(f.input.id)).jobs.x.stage, "sheet-complete");
  assert.equal(f.actions.includes("main-identity"), false);
  assert.equal(
    f.actions.includes("submit"),
    false,
    "User owns the main Post click.",
  );
});

test("uncertain reply is capture-only after restart, including a lost successful response", async () => {
  let delivered = false;
  const f = publicationFixture({
    submit() {
      delivered = true;
      throw new Error("lost acknowledgement");
    },
    capture() {
      assert.equal(delivered, true);
      return {
        replyId: "9000000000000000002",
        replyUrl: "https://x.com/RecordedCreator/status/9000000000000000002",
      };
    },
  });
  await f.runtime.prepare({ plan: f.input, caption: "Caption" });
  await f.armMedia();
  f.publish();
  f.setNow(Date.parse(f.main.postedUtc) + 16 * 60_000);
  await f.runtime.resume(f.input.id);
  assert.equal(
    (await f.store.load(f.input.id)).jobs.x.replySubmitAttempted,
    true,
  );
  f.setNow(Date.parse(f.main.postedUtc) + 21 * 60_000);
  f.tabs.clear();
  Object.keys(f.sessionValues).forEach((key) => delete f.sessionValues[key]);
  await f.restart().resume(f.input.id);
  assert.equal(f.calls.filter((row) => row[0] === "submit").length, 1);
  assert.equal(f.calls.filter((row) => row[0] === "capture").length, 1);
  assert.equal((await f.store.load(f.input.id)).jobs.x.stage, "sheet-complete");
});

test("a manual owner reply suppresses automation; wrong account and unrelated status evidence never trigger a click", async () => {
  const existing = publicationFixture({
    prepare: () => ({ status: "existing-reply", replyId: "200" }),
  });
  await existing.runtime.prepare({ plan: existing.input, caption: "Caption" });
  await existing.armMedia();
  existing.publish();
  existing.setNow(Date.parse(existing.main.postedUtc) + 16 * 60_000);
  await existing.runtime.resume(existing.input.id);
  assert.equal(
    existing.calls.some((row) => row[0] === "submit"),
    false,
  );
  assert.equal(
    (await existing.store.load(existing.input.id)).jobs.x.stage,
    "sheet-complete",
  );
  const wrong = publicationFixture({
    prepare() {
      throw new Error("wrong-account: signed in as someone else");
    },
  });
  await wrong.runtime.prepare({ plan: wrong.input, caption: "Caption" });
  await wrong.armMedia();
  wrong.publish({
    ...wrong.main,
    resultUrl: wrong.main.resultUrl.replace("RecordedCreator", "SomeoneElse"),
  });
  wrong.setNow(Date.parse(wrong.main.postedUtc) + 16 * 60_000);
  await wrong.runtime.resume(wrong.input.id);
  assert.equal(
    wrong.calls.some((row) => row[0] === "open"),
    false,
  );
  wrong.publish();
  await wrong.runtime.resume(wrong.input.id);
  assert.equal(
    wrong.calls.some((row) => row[0] === "submit"),
    false,
  );
  assert.match(
    (await wrong.store.load(wrong.input.id)).jobs.x.error,
    /wrong-account/,
  );
});

test("two prepared runs with the same caption and media cannot silently claim one publication", async () => {
  const f = publicationFixture();
  await f.runtime.prepare({ plan: f.input, caption: "Caption" });
  await f.armMedia();
  await f.runtime.prepare({
    plan: { ...f.input, id: "publication-independent-0002" },
    caption: "Caption",
  });
  await f.runtime.observePublication(
    {
      publicationAttempt: {
        accountId: "123",
        text: "Caption",
        mediaIds: ["77"],
      },
    },
    { tab: { id: 11 }, documentId: "document-11" },
  );
  f.publish();
  f.setNow(Date.parse(f.main.postedUtc) + 16 * 60_000);
  await f.runtime.resume(f.input.id);
  assert.equal(
    f.calls.some((row) => row[0] === "submit"),
    false,
  );
  assert.match((await f.store.load(f.input.id)).jobs.x.error, /more than one/);
});

test("publication receipts require this run's document; recovery requires the actual uploaded media identity", async () => {
  const f = publicationFixture();
  await f.runtime.prepare({ plan: f.input, caption: "Caption" });
  const row = {
    statusId: f.main.resultId,
    authorId: "123",
    authorHandle: "RecordedCreator",
    createdAt: f.main.postedUtc,
    text: "Caption",
    inReplyToStatusId: null,
    conversationId: f.main.resultId,
    isRetweet: false,
    media: [
      { type: "video", mediaKey: "7_77", durationMs: 1000, posterUrl: null },
    ],
    urls: [],
    metrics: null,
    source: "network",
  };
  const message = {
    operation: "CreateTweet",
    batch: {
      owner: { accountId: "123", handle: "RecordedCreator" },
      observations: [row],
    },
  };
  f.setNow(Date.parse(f.main.postedUtc));
  await f.runtime.observePublication(message, {
    tab: { id: 11 },
    documentId: "different-document",
  });
  assert.equal(
    (await f.store.load(f.input.id)).jobs.x.resultUrl,
    undefined,
    "Another tab's same caption is insufficient.",
  );
  await f.armMedia();
  const wrongMedia = structuredClone(message);
  wrongMedia.batch.observations[0].media[0].mediaKey = "7_88";
  await f.runtime.observePublication(wrongMedia, {
    tab: { id: 11 },
    documentId: "different-document",
  });
  assert.equal((await f.store.load(f.input.id)).jobs.x.resultUrl, undefined);
  f.tabs.clear();
  Object.keys(f.sessionValues).forEach((key) => delete f.sessionValues[key]);
  await f
    .restart()
    .observePublication(
      { ...message, operation: "UserTweets" },
      { tab: { id: 800 }, documentId: "profile-after-restart" },
    );
  assert.equal(
    (await f.store.load(f.input.id)).jobs.x.resultUrl,
    f.main.resultUrl,
  );
  assert.equal(
    (
      await f.vm.CreatorXReplyPolicy.forStorage(
        f.vm.chrome.storage.local,
      ).lookup(f.main.resultId)
    ).owner,
    "editor",
  );
  assert.equal(
    f.calls.some((row) => row[0] === "submit"),
    false,
  );
});

test("a CreateTweet receipt on the prepared document persists without visiting any status URL", async () => {
  const f = publicationFixture();
  await f.runtime.prepare({ plan: f.input, caption: "Caption" });
  f.setNow(Date.parse(f.main.postedUtc));
  const receipt = {
    operation: "CreateTweet",
    batch: {
      owner: { accountId: "123", handle: "RecordedCreator" },
      observations: [
        {
          statusId: f.main.resultId,
          authorId: "123",
          authorHandle: "RecordedCreator",
          createdAt: f.main.postedUtc,
          text: "Caption",
          inReplyToStatusId: null,
          conversationId: f.main.resultId,
          isRetweet: false,
          media: [
            {
              type: "video",
              mediaKey: "7_77",
              durationMs: 1000,
              posterUrl: null,
            },
          ],
          urls: [],
          metrics: null,
          source: "network",
        },
      ],
    },
  };
  const sender = { tab: { id: 10 }, documentId: "document-10" };
  await f.runtime.observePublication(receipt, sender);
  assert.equal(
    (await f.store.load(f.input.id)).jobs.x.resultUrl,
    undefined,
    "A response cannot bind before the request media is known.",
  );
  await f.armMedia();
  const mismatched = structuredClone(receipt);
  mismatched.batch.observations[0].media[0].mediaKey = "7_88";
  await f.runtime.observePublication(mismatched, sender);
  assert.equal(
    (await f.store.load(f.input.id)).jobs.x.resultUrl,
    undefined,
    "Even the original document must return the requested media.",
  );
  await f.runtime.observePublication(receipt, sender);
  assert.equal(
    (await f.store.load(f.input.id)).jobs.x.resultUrl,
    f.main.resultUrl,
  );
  f.tabs.clear();
  Object.keys(f.sessionValues).forEach((key) => delete f.sessionValues[key]);
  f.setNow(Date.parse(f.main.postedUtc) + 15 * 60_000);
  await f.restart().resume(f.input.id);
  assert.equal(f.calls.filter((row) => row[0] === "submit").length, 1);
});

test("network matching uses the authorized multiline caption rather than flattened composer text", async () => {
  const f = publicationFixture({ composerText: "FirstSecond" });
  const caption = "First\nSecond";
  f.input.caption.sha256 = nodeCrypto
    .createHash("sha256")
    .update(caption)
    .digest("hex");
  await f.runtime.prepare({ plan: f.input, caption });
  await f.runtime.observePublication(
    {
      publicationAttempt: { accountId: "123", text: caption, mediaIds: ["77"] },
    },
    { tab: { id: 10 }, documentId: "document-10" },
  );
  assert.deepEqual(
    plain((await f.store.load(f.input.id)).jobs.x.publicationMediaIds),
    ["77"],
  );
});

test("non-calendar X posts use the same publication and guarded reply path with a 15-minute default", async () => {
  for (const mode of ["manual", "autonomous"]) {
    const f = publicationFixture();
    delete f.input.xOptions;
    f.input.mode = mode;
    await f.runtime.prepare({ plan: f.input, caption: "Caption" });
    await f.armMedia();
    f.publish();
    f.setNow(Date.parse(f.main.postedUtc) + 899_999);
    await f.runtime.resume(f.input.id);
    assert.equal(
      f.calls.some((row) => row[0] === "submit"),
      false,
    );
    f.setNow(Date.parse(f.main.postedUtc) + 900_000);
    await f.runtime.resume(f.input.id);
    assert.equal(
      f.calls.filter((row) => row[0] === "submit").length,
      mode === "autonomous" ? 1 : 0,
    );
    assert.equal(f.actions.includes("main-identity"), false);
  }
});

test("disabling automatic replies completes the main result without opening a reply tab", async () => {
  const f = publicationFixture();
  f.input.xOptions.autoReply = false;
  await f.runtime.prepare({ plan: f.input, caption: "Caption" });
  await f.armMedia();
  f.publish();
  f.setNow(Date.parse(f.main.postedUtc) + 16 * 60_000);
  await f.runtime.resume(f.input.id);
  await f.restart().resume(f.input.id);
  assert.equal(
    f.calls.some((row) => row[0] === "open"),
    false,
  );
  assert.equal((await f.store.load(f.input.id)).jobs.x.replyOutcome, "manual");
  assert.equal((await f.store.load(f.input.id)).jobs.x.stage, "sheet-complete");
});

test("uncertain replies stop bounded recovery and retain the confirmed main post plus an honest outcome", async () => {
  const f = publicationFixture({
    submit() {
      throw new Error("lost acknowledgement");
    },
  });
  await f.runtime.prepare({ plan: f.input, caption: "Caption" });
  await f.armMedia();
  f.publish();
  for (const minutes of [16, 21, 26, 31]) {
    f.setNow(Date.parse(f.main.postedUtc) + minutes * 60_000);
    await f.restart().resume(f.input.id);
  }
  const job = (await f.store.load(f.input.id)).jobs.x;
  assert.equal(f.calls.filter((row) => row[0] === "submit").length, 1);
  assert.equal(f.calls.filter((row) => row[0] === "capture").length, 2);
  assert.equal(job.stage, "sheet-complete");
  assert.equal(job.replyOutcome, "unconfirmed");
  assert.match(job.error, /unconfirmed/);
  assert.equal(
    f.sheet.some((row) => row[0] === "x"),
    true,
  );
});

test("a late return beyond the existing 24-hour reply window records the teaser without a stale automatic reply", async () => {
  const late = publicationFixture();
  await late.runtime.prepare({ plan: late.input, caption: "Caption" });
  await late.armMedia();
  late.publish();
  await late.store.checkpoint(late.input.id, "x", {
    resultId: late.main.resultId,
    resultUrl: late.main.resultUrl,
    replyDueAt: Date.parse(late.main.postedUtc) + 15 * 60_000,
  });
  late.setNow(Date.parse(late.main.postedUtc) + 25 * 60 * 60_000);
  await late.restart().resume(late.input.id);
  assert.equal(
    late.calls.some((row) => row[0] === "open"),
    false,
  );
  assert.equal(
    (await late.store.load(late.input.id)).jobs.x.replyOutcome,
    "expired",
  );
});

test("calendar post delays its reply durably and a restarted worker cannot reply early", async () => {
  const fixture = loadRuntime();
  const id = "social-calendar-delay-0001";
  const input = {
    ...plan(id, "autonomous"),
    xOptions: {
      sensitive: true,
      scheduledUtc: "",
      timeZone: "Europe/Zurich",
      replyDelayMinutes: 15,
    },
  };
  await fixture.context.CreatorXReplyPolicy.forStorage(
    fixture.context.chrome.storage.local,
  ).save({ variants: ["First line\nOnlyFans: {link}\nLast line"] });
  await fixture.runtime.prepare({ plan: input, caption: "Caption" });
  const frozenLine = (await fixture.store.load(id)).jobs.x.replyLine;
  assert.equal(frozenLine, "First line\nOnlyFans: {link}\nLast line");
  await fixture.context.CreatorXReplyPolicy.forStorage(
    fixture.context.chrome.storage.local,
  ).save({ variants: ["New wording"] });
  await fixture.runtime.start(id);
  let job = (await fixture.store.load(id)).jobs.x;
  assert.equal(job.stage, "submit-attempted");
  assert.equal(Boolean(job.resultUrl), true);
  assert.equal(fixture.actions.includes("prepare-reply"), false);
  assert.equal(job.replyDueAt, 1_788_281_000_000);
  await fixture.restart().resume(id);
  assert.equal(fixture.actions.includes("submit-reply"), false);
  fixture.setNow(job.replyDueAt);
  fixture.tabs.clear();
  await fixture.restart().resume(id);
  const replyInput = fixture.xInputs.find(
    (input) => input.action === "prepare-reply",
  );
  assert.equal(
    replyInput.text,
    `First line\nOnlyFans: ${input.paidUrl}\nLast line`,
  );
  job = (await fixture.store.load(id)).jobs.x;
  assert.equal(job.stage, "sheet-complete");
  assert.equal(
    fixture.actions.filter((action) => action === "submit").length,
    1,
  );
  assert.equal(
    fixture.actions.filter((action) => action === "submit-reply").length,
    1,
  );
});

for (const mode of ["manual", "autonomous"]) {
  test(`${mode} calendar result requires owner evidence before an automatic delayed reply`, async () => {
    const scheduledUtc = new Date(
      Math.ceil(1_788_280_160_000 / 60_000) * 60_000,
    ).toISOString();
    let observed = false;
    const fixture = loadRuntime({
      resolveScheduledResult: async () =>
        observed
          ? {
              matched: true,
              resultId: "9000000000000000001",
              resultUrl:
                "https://x.com/RecordedCreator/status/9000000000000000001",
              postedUtc: scheduledUtc,
            }
          : { matched: false },
    });
    const id = "social-calendar-scheduled-0001";
    const input = {
      ...plan(id, mode),
      xOptions: {
        sensitive: true,
        scheduledUtc,
        timeZone: "Europe/Zurich",
        replyDelayMinutes: 15,
        autoReply: true,
      },
    };
    await fixture.runtime.prepare({ plan: input, caption: "Caption" });
    await fixture.runtime.start(id);
    fixture.setNow(Date.parse(scheduledUtc) + 60_000);
    await fixture.restart().resume(id);
    assert.equal((await fixture.store.load(id)).jobs.x.resultUrl, undefined);
    assert.equal(fixture.actions.includes("prepare-reply"), false);
    observed = true;
    await fixture.restart().resume(id);
    const pending = (await fixture.store.load(id)).jobs.x;
    assert.equal(pending.replyDueAt, Date.parse(scheduledUtc) + 900_000);
    assert.equal(fixture.actions.includes("prepare-reply"), false);
    fixture.setNow(pending.replyDueAt);
    await fixture.restart().resume(id);
    assert.equal((await fixture.store.load(id)).jobs.x.stage, "sheet-complete");
    assert.equal(
      fixture.actions.filter((action) => action === "submit").length,
      mode === "autonomous" ? 1 : 0,
    );
    assert.equal(
      fixture.actions.filter((action) => action === "submit-reply").length,
      1,
    );
  });
}

function redditPlan(id, mode = "manual") {
  const value = plan(id, mode);
  const hash = (text) =>
    require("node:crypto").createHash("sha256").update(text).digest("hex");
  value.targets = {
    x: false,
    reddit: [
      {
        subreddit: "example",
        presetId: "example",
        presetRevision: "abcd1234",
        title: { state: "nonempty", sha256: hash("Draft title") },
        body: { state: "empty", sha256: hash("") },
      },
    ],
  };
  value.evidence = { reddit: "a".repeat(64), redgifs: "b".repeat(64) };
  return value;
}

test("manual Reddit preparation attaches Redgifs teaser and opens selected draft without publishing", async () => {
  const fixture = loadRuntime();
  const id = "social-reddit-prepare-0001";
  const prepared = await fixture.runtime.prepare({
    plan: redditPlan(id),
    caption: "Caption",
    subreddits: [{ subreddit: "example", title: "Draft title", body: "" }],
  });
  assert.equal(prepared.targets.redgifs.status, "review-required");
  assert.equal(
    prepared.targets["reddit:example"].status,
    "waiting-for-redgifs",
  );
  assert.deepEqual(
    [...fixture.tabs.values()].map((tab) => tab.url),
    [
      "https://studio.redgifs.com/upload",
      "https://www.reddit.com/r/example/submit?type=LINK",
    ],
  );
  assert.equal(fixture.files[0].platform, "redgifs");
  assert.equal(fixture.files[0].role, "social");
  assert.equal(
    fixture.actions.some((action) => /submit|publish/.test(action)),
    false,
  );
  assert.deepEqual(fixture.sheet, []);
  const redditTab = [...fixture.tabs.values()].find((tab) =>
    tab.url.includes("reddit.com"),
  );
  redditTab.url = redditTab.url.replace("submit?", "submit/?");
  const linked = await fixture.runtime.prepareRedditLinks(
    id,
    "https://www.redgifs.com/watch/examplevideo",
  );
  assert.equal(linked.targets["reddit:example"].status, "ready");
  assert.equal(fixture.actions.includes("reddit:link"), true);
  assert.equal(fixture.tabs.size, 2);
});

test("Reddit preparation rejects autonomous mode and copy drift before any tab or file request", async () => {
  for (const [mode, title] of [
    ["autonomous", "Draft title"],
    ["manual", "Changed title"],
  ]) {
    const fixture = loadRuntime();
    await assert.rejects(
      fixture.runtime.prepare({
        plan: redditPlan("social-reddit-reject-0001", mode),
        caption: "Caption",
        subreddits: [{ subreddit: "example", title, body: "" }],
      }),
      /manual|no longer matches/i,
    );
    assert.equal(fixture.tabs.size, 0);
    assert.deepEqual(fixture.files, []);
  }
});

test("manual Redgifs link handoff rejects foreign URLs and navigated Reddit drafts", async () => {
  const fixture = loadRuntime();
  const id = "social-reddit-link-0001";
  await fixture.runtime.prepare({
    plan: redditPlan(id),
    caption: "Caption",
    subreddits: [{ subreddit: "example", title: "Draft title", body: "" }],
  });
  await assert.rejects(
    fixture.runtime.prepareRedditLinks(id, "https://example.com/watch/test"),
    /Redgifs URL/i,
  );
  const tab = [...fixture.tabs.values()].find((tab) =>
    tab.url.includes("reddit.com"),
  );
  tab.url = "https://www.reddit.com/r/somethingelse/submit?type=LINK";
  await assert.rejects(
    fixture.runtime.prepareRedditLinks(
      id,
      "https://www.redgifs.com/watch/examplevideo",
    ),
    /draft.*changed|matches/i,
  );
  assert.equal(fixture.actions.includes("reddit:link"), false);
});

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

test("autonomous X injections carry the armed caption hash, result id and paid URL", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-expectations-0001";
  const authorized = plan(id, "autonomous");
  await fixture.runtime.prepare({ plan: authorized, caption: "Caption" });
  await fixture.runtime.start(id);
  const submit = fixture.xInputs.find((input) => input.action === "submit");
  assert.equal(submit.captionSha256, authorized.caption.sha256);
  const reply = fixture.xInputs.find(
    (input) => input.action === "submit-reply",
  );
  assert.equal(reply.resultId, "9000000000000000001");
  assert.equal(reply.paidUrl, authorized.paidUrl);
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

test("prepare persists the composer hash and a restarted worker submits with it", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-persisted-hash-0001";
  await fixture.runtime.prepare({
    plan: plan(id, "autonomous"),
    caption: "Caption",
  });
  const persisted = plain(await fixture.store.load(id)).jobs.x
    .preparedComposerSha256;
  assert.equal(
    persisted,
    nodeCrypto.createHash("sha256").update("Caption").digest("hex"),
  );

  const restarted = fixture.restart();
  const session = plain(await restarted.start(id));
  assert.equal(session.jobs.x.stage, "sheet-complete");
  const submit = fixture.xInputs.find((input) => input.action === "submit");
  assert.equal(submit.captionSha256, persisted);
});

test("worker restart never posts an edited composer", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-restart-edited-0001";
  await fixture.runtime.prepare({
    plan: plan(id, "autonomous"),
    caption: "Caption",
  });
  fixture.setEditorText("Caption edited by hand");

  const session = plain(await fixture.restart().start(id));
  assert.notEqual(session.jobs.x.stage, "sheet-complete");
  assert.equal(session.jobs.x.stage, "posted-link-unresolved");
  assert.equal(fixture.submitRejections.length, 1);
  assert.notEqual(
    fixture.submitRejections[0],
    "",
    "the injection must still carry the persisted hash",
  );
  assert.equal(fixture.actions.includes("main-identity"), false);
  assert.equal(
    [...fixture.tabs.values()].some((tab) => /status/.test(tab.url)),
    false,
  );
});

test("a prepared job without a persisted hash is refused before the durable arm", async () => {
  const fixture = loadRuntime();
  const id = "social-runtime-no-hash-0001";
  await fixture.runtime.prepare({
    plan: plan(id, "autonomous"),
    caption: "Caption",
  });
  // A job prepared by an older version has no preparedComposerSha256.
  const key = `${fixture.store.KEY_PREFIX}${id}`;
  delete fixture.values[key].jobs.x.preparedComposerSha256;

  let arms = 0;
  const countingFactory = {
    create(options) {
      return fixture.context.CreatorSocialDistributionOrchestrator.create({
        ...options,
        adapterFor(jobId) {
          const adapter = options.adapterFor(jobId);
          return {
            ...adapter,
            submit(input) {
              return adapter.submit({
                ...input,
                async beforeCommit() {
                  arms += 1;
                  return input.beforeCommit();
                },
              });
            },
          };
        },
      });
    },
  };
  const session = plain(await fixture.restart(countingFactory).start(id));
  assert.equal(arms, 0);
  assert.equal(fixture.actions.includes("submit"), false);
  assert.notEqual(session.jobs.x.stage, "sheet-complete");
  assert.match(session.jobs.x.error, /Prepare the draft again/i);
});

for (const [mainMode, autoReply] of [
  ["manual", true],
  ["autonomous", false],
]) {
  test(`${mainMode} teaser and ${autoReply ? "automatic" : "manual"} delayed reply stay independent after restart`, async () => {
    const fixture = loadRuntime();
    const id = `social-split-${mainMode}-0001`;
    await fixture.runtime.prepare({
      plan: {
        ...plan(id, mainMode),
        xOptions: {
          sensitive: true,
          scheduledUtc: "",
          timeZone: "Europe/Zurich",
          replyDelayMinutes: 15,
          autoReply,
        },
      },
      caption: "Caption",
    });
    await fixture.runtime.start(id);
    assert.equal(fixture.actions.includes("submit"), mainMode === "autonomous");
    if (mainMode === "manual") {
      const [tab] = fixture.tabs.values();
      tab.url = "https://x.com/RecordedCreator/status/9000000000000000001";
      fixture.setObservedMainUrl(tab.url);
      await fixture.restart().resume(id);
    }
    const pending = (await fixture.store.load(id)).jobs.x;
    assert.equal(typeof pending.replyDueAt, "number");
    assert.equal(fixture.actions.includes("submit-reply"), false);
    fixture.setNow(pending.replyDueAt - 1);
    await fixture.restart().resume(id);
    assert.equal(fixture.actions.includes("prepare-reply"), false);
    fixture.setNow(pending.replyDueAt);
    await fixture.restart().resume(id);
    assert.equal(fixture.actions.includes("prepare-reply"), true);
    assert.equal(fixture.actions.includes("submit-reply"), autoReply);
    const job = (await fixture.store.load(id)).jobs.x;
    assert.equal(job.replySubmitAttempted === true, autoReply);
    if (autoReply) {
      assert.equal(job.stage, "sheet-complete");
      await fixture.restart().resume(id);
      assert.equal(
        fixture.actions.filter((a) => a === "submit-reply").length,
        1,
      );
    } else {
      fixture.setReplyLive(true);
      await fixture.restart().resume(id);
      assert.equal(
        (await fixture.store.load(id)).jobs.x.stage,
        "sheet-complete",
      );
    }
    assert.equal(
      fixture.actions.filter((a) => a === "submit").length,
      mainMode === "autonomous" ? 1 : 0,
    );
  });
}
