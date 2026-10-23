"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");

const repositoryRoot = require("../support/paths.cjs").repositoryRoot;
const sourceRoot = path.join(repositoryRoot, "extensions/personal");
const background = fs.readFileSync(
  path.join(sourceRoot, "background.js"),
  "utf8",
);

function declaration(source, name) {
  const program = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  const node = program.body.find(
    (item) => item.type === "FunctionDeclaration" && item.id?.name === name,
  );
  assert.ok(node, `missing ${name}`);
  return source.slice(node.start, node.end);
}

async function scriptCheckpointFiltersAlreadySentKeys() {
  const syncSource = fs.readFileSync(
    path.join(sourceRoot, "workflows/sync-script.js"),
    "utf8",
  );
  const stored = { status: "", scriptState: null };
  const requests = [];
  const context = vm.createContext({
    console,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Set,
    Map,
    Date,
    fetch: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return {
        ok: true,
        json: async () => ({
          url: "https://johnnyguides.com/sync/scripts/run-123.funscript",
        }),
      };
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({
            johnnyGuidesSyncScriptV1: {
              origin: "https://johnnyguides.com",
              token: "synthetic-token-123",
            },
          }),
        },
      },
    },
  });
  vm.runInContext(syncSource, context);
  context.getCreatorUploadSession = async () => stored;
  context.checkpointCreatorUploadSession = async (session) => {
    stored.scriptState = structuredClone(session.scriptState);
    return { ...session };
  };
  context.commitCreatorUploadResult = async () => ({
    status: "uploaded-no-sheet",
  });
  context.creatorCatalogueErrorCode = (error) =>
    String(error?.message || error || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 64);
  context.CREATOR_SYNC_SCRIPT_PARTS = {
    take: () => ({
      title: "Neutral test script",
      uploads: [{ keys: ["123"], funscript: { actions: [{ at: 0, pos: 1 }] } }],
    }),
  };
  context.uploadCreatorSyncScripts = vm.runInContext(
    `(${declaration(background, "uploadCreatorSyncScripts")})`,
    context,
  );

  Object.assign(stored, {
    id: "session-neutral-123",
    catalogue: null,
    draft: {
      fileProof: {
        script: { name: "neutral.funscript", sha256: "a".repeat(64) },
      },
    },
    platforms: new Map([
      ["onlyfans", { status: "uploaded", postUrl: "https://onlyfans.com/123" }],
      ["fansly", { status: "posted-link-unresolved", postUrl: "" }],
    ]),
  });
  const first = await context.uploadCreatorSyncScripts({
    sessionId: stored.id,
    uploadId: "synthetic",
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].keys, ["123"]);
  assert.equal(
    stored.scriptState.status,
    "partial",
    "an unresolved selected platform remains visible as pending",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(stored.scriptState.sentKeys)), [
    "123",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(stored.scriptState.urls)), [
    "https://johnnyguides.com/sync/scripts/run-123.funscript",
  ]);
  assert.equal(
    "actions" in stored.scriptState,
    false,
    "script bytes are not persisted",
  );

  await context.uploadCreatorSyncScripts({
    sessionId: stored.id,
    uploadId: "synthetic",
  });
  assert.equal(
    requests.length,
    1,
    "a provider-confirmed key is never sent twice",
  );
  assert.ok(first[0].url);
}

async function ownerConfirmedLinkUsesOnlyTheSelectedPreparedTarget() {
  const context = vm.createContext({
    chrome: {
      runtime: {
        id: "synthetic-extension",
        getURL: (value) => `chrome-extension://synthetic/${value}`,
      },
    },
    Object,
    Date,
  });
  const target = {
    platform: "onlyfans",
    status: "posted-link-unresolved",
    submitAttempted: true,
    postUrl: "",
  };
  const session = {
    id: "session-neutral-123",
    platforms: new Map([["onlyfans", target]]),
  };
  let savedUrl = "";
  context.CREATOR_UPLOAD_TARGETS = { onlyfans: {} };
  context.CREATOR_CATALOGUE_CONTRACT = {
    canonicalPostUrl: (platform, value) =>
      platform === "onlyfans" && value === "https://onlyfans.com/123"
        ? value
        : null,
  };
  context.getCreatorUploadSession = async () => session;
  context.finishCreatorManualPublish = async (_session, record, url) => {
    savedUrl = url;
    record.postUrl = url;
    return {
      platform: record.platform,
      status: "catalogue-updated",
      postUrl: url,
    };
  };
  context.reconcileCreatorUploadResult = vm.runInContext(
    `(${declaration(background, "reconcileCreatorUploadResult")})`,
    context,
  );
  const sender = {
    id: "synthetic-extension",
    url: "chrome-extension://synthetic/upload-console.html",
    documentId: "synthetic-document",
  };
  await assert.rejects(
    context.reconcileCreatorUploadResult(
      {
        sessionId: session.id,
        platform: "onlyfans",
        postUrl: "https://onlyfans.com/123?unrelated=1",
        confirmSource: true,
      },
      sender,
    ),
    /canonical published link/,
  );
  const result = await context.reconcileCreatorUploadResult(
    {
      sessionId: session.id,
      platform: "onlyfans",
      postUrl: "https://onlyfans.com/123",
      confirmSource: true,
    },
    sender,
  );
  assert.equal(result.accepted, true);
  assert.equal(savedUrl, "https://onlyfans.com/123");
  assert.equal(target.receiptEvidence.kind, "owner-confirmed");
  assert.equal(target.postUrl, savedUrl);
  await context.reconcileCreatorUploadResult(
    {
      sessionId: session.id,
      platform: "onlyfans",
      postUrl: savedUrl,
      confirmSource: true,
    },
    { id: "synthetic-extension", desktopUploadRuntime: true },
  );
  await assert.rejects(
    context.reconcileCreatorUploadResult(
      {
        sessionId: session.id,
        platform: "onlyfans",
        postUrl: savedUrl,
        confirmSource: true,
      },
      { id: "foreign-extension", desktopUploadRuntime: true },
    ),
    /restricted/,
  );
  await assert.rejects(
    context.reconcileCreatorUploadResult(
      {
        sessionId: session.id,
        platform: "onlyfans",
        postUrl: "https://onlyfans.com/123",
      },
      sender,
    ),
    /Confirm that this post belongs/,
  );
}

async function scriptCatalogueRetryNeverRepeatsProviderUpload() {
  const session = {
    id: "session-neutral-456",
    catalogue: {
      source: "desktop",
      destination: { workbookId: "synthetic-workbook", sheetId: "0" },
    },
    scriptState: {
      status: "uploaded",
      filename: "neutral.funscript",
      sha256: "b".repeat(64),
      urls: ["https://johnnyguides.com/sync/scripts/run-456.funscript"],
      sentKeys: ["456"],
      sheetPending: true,
      results: [
        {
          url: "https://johnnyguides.com/sync/scripts/run-456.funscript",
          keys: ["456"],
          sheetError: "catalogue_writeback_pending",
        },
      ],
    },
  };
  const context = vm.createContext({});
  let commitCount = 0;
  let googleAvailable = false;
  context.getCreatorUploadSession = async () => session;
  context.commitCreatorUploadResult = async () => {
    commitCount++;
    if (!googleAvailable) throw new Error("google-unavailable");
    return { status: "updated", googleSynced: true };
  };
  context.checkpointCreatorUploadSession = async () => ({});
  context.creatorCatalogueErrorCode = (error) =>
    String(error?.message || error || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 64);
  context.retryCreatorScriptCatalogue = vm.runInContext(
    `(${declaration(background, "retryCreatorScriptCatalogue")})`,
    context,
  );
  const pending = await context.retryCreatorScriptCatalogue(session.id);
  assert.equal(commitCount, 1);
  assert.equal(session.scriptState.status, "uploaded");
  assert.equal(session.scriptState.sheetPending, true);
  assert.equal(pending.scripts[0].status, "uploaded-sheet-pending");
  googleAvailable = true;
  const response = await context.retryCreatorScriptCatalogue(session.id);
  assert.equal(commitCount, 2);
  assert.equal(session.scriptState.status, "uploaded");
  assert.equal(session.scriptState.sheetPending, false);
  assert.deepEqual(JSON.parse(JSON.stringify(session.scriptState.sentKeys)), [
    "456",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(response.scripts[0].keys)), [
    "456",
  ]);
  assert.equal(response.scripts[0].status, "complete");
  session.scriptState.status = "partial";
  await context.retryCreatorScriptCatalogue(session.id, true);
  assert.equal(
    session.scriptState.status,
    "partial",
    "Google recovery cannot erase a real provider failure either",
  );
}

async function ownerAssociationAdoptsNativeRevisionAfterAnOlderMirrorConflict() {
  const calls = [];
  const row = {
    id: "episode-neutral",
    fingerprint: "a".repeat(64),
    destination: { workbookId: "workbook", sheetId: "1" },
  };
  const context = vm.createContext({});
  context.CREATOR_CATALOGUE_WORKFLOW = {
    enqueue: async () => {
      calls.push("enqueue");
      return { state: "conflict" };
    },
    flush: async () => {
      calls.push("flush");
      return { remaining: 1 };
    },
    observeRevision: async (runId, revision) => {
      calls.push([runId, revision]);
    },
  };
  context.sendDesktopRequest = async (command, payload) => {
    assert.equal(command, "associateCreatorWorkflow");
    assert.equal(payload.confirmSource, true);
    assert.equal(payload.expectedFingerprint, row.fingerprint);
    calls.push("native-association");
    return {
      status: "recorded",
      snapshot: {
        runId: "run-native-bound",
        revision: 7,
        sourceKey: row.id,
        destination: row.destination,
      },
    };
  };
  context.sameCreatorCatalogueDestination = vm.runInContext(
    `(${declaration(background, "sameCreatorCatalogueDestination")})`,
    context,
  );
  context.associateCreatorWorkflowWithOwner = vm.runInContext(
    `(${declaration(background, "associateCreatorWorkflowWithOwner")})`,
    context,
  );
  await context.associateCreatorWorkflowWithOwner(
    { runId: "run-native-bound" },
    row,
  );
  assert.deepEqual(calls, [
    "enqueue",
    "flush",
    "native-association",
    ["run-native-bound", 7],
  ]);
}

async function terminalCheckpointPreservesSessionOnPendingScriptOrMirrorFailure() {
  const context = vm.createContext({ Date });
  const events = [];
  context.CREATOR_UPLOAD_TERMINAL_STATUSES = new Set(["uploaded"]);
  context.creatorUploadSessionRecord = (session) => ({
    id: session.id,
    scriptState: session.scriptState,
  });
  context.enqueueCreatorUploadSnapshot = async () => {
    events.push("enqueue");
    return context.mirrorError || "";
  };
  context.CREATOR_UPLOAD_SESSION_STORE = {
    save: async (record) => {
      events.push("save");
      return record;
    },
    remove: async () => {
      events.push("remove");
    },
  };
  context.checkpointCreatorUploadSession = vm.runInContext(
    `(${declaration(background, "checkpointCreatorUploadSession")})`,
    context,
  );
  const session = {
    id: "session-neutral-789",
    createdAt: 1,
    platforms: new Map([["onlyfans", { status: "uploaded", createdAt: 1 }]]),
    scriptState: { status: "pending" },
  };
  await context.checkpointCreatorUploadSession(session);
  assert.deepEqual(
    events.splice(0),
    ["save", "enqueue"],
    "the durable Chrome checkpoint precedes mirror enqueue",
  );
  context.mirrorError = "native_unavailable";
  session.scriptState = { status: "uploaded" };
  const result = await context.checkpointCreatorUploadSession(session);
  assert.deepEqual(
    events,
    ["save", "enqueue"],
    "a mirror queue failure preserves a recoverable Chrome session",
  );
  assert.equal(result.catalogueMirrorError, "native_unavailable");
}

async function persistedUploadIsReplayedIntoCatalogueMirrorAfterWorkerRestart() {
  const data = {};
  const calls = [];
  const storage = {
    async get(key) {
      if (key === null) return structuredClone(data);
      if (Array.isArray(key))
        return Object.fromEntries(
          key
            .filter((item) => item in data)
            .map((item) => [item, structuredClone(data[item])]),
        );
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(value) {
      Object.assign(data, structuredClone(value));
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete data[item];
    },
  };
  const workflowSource = fs.readFileSync(
    path.join(sourceRoot, "workflows/catalogue-workflow.js"),
    "utf8",
  );
  const context = vm.createContext({
    URL,
    Date,
    console,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  vm.runInContext(workflowSource, context);
  context.CREATOR_CATALOGUE_WORKFLOW_API = context.CreatorCatalogueWorkflow;
  context.CREATOR_CATALOGUE_WORKFLOW = context.CreatorCatalogueWorkflow.create({
    storage,
    send: async (operation, snapshot) => {
      calls.push({ operation, snapshot });
      return { status: "recorded" };
    },
  });
  context.CREATOR_UPLOAD_SESSION_STORE = {
    list: async () => [
      {
        id: "session-neutral-123",
        draft: { title: "Neutral upload", fileProof: {} },
        catalogue: null,
        platforms: {
          onlyfans: { status: "uploaded", postUrl: "https://onlyfans.com/123" },
        },
        scriptState: {
          status: "uploaded",
          urls: ["https://johnnyguides.com/sync/scripts/run-123.funscript"],
          sentKeys: ["123"],
        },
      },
    ],
  };
  context.CREATOR_SOCIAL_SESSION_STORE_BASE = { list: async () => [] };
  context.creatorCatalogueFlushTimer = null;
  for (const name of [
    "creatorCatalogueErrorCode",
    "enqueueCreatorUploadSnapshot",
    "enqueueCreatorSocialSnapshot",
    "scheduleCreatorCatalogueWorkflowFlush",
    "flushCreatorCatalogueWorkflow",
    "bootstrapCreatorCatalogueWorkflow",
  ])
    vm.runInContext(declaration(background, name), context);
  await context.bootstrapCreatorCatalogueWorkflow();
  assert.equal(
    calls.length,
    1,
    "the worker startup replays a durable Chrome session to the mirror",
  );
  assert.equal(calls[0].operation, "recordCreatorWorkflow");
  assert.equal(calls[0].snapshot.runId, "session-neutral-123");
  assert.equal(calls[0].snapshot.kind, "upload");
  assert.equal(
    Object.keys(data).filter((key) =>
      key.startsWith(context.CreatorCatalogueWorkflow.KEY_PREFIX),
    ).length,
    0,
  );
}

(async () => {
  await scriptCheckpointFiltersAlreadySentKeys();
  await ownerConfirmedLinkUsesOnlyTheSelectedPreparedTarget();
  await scriptCatalogueRetryNeverRepeatsProviderUpload();
  await ownerAssociationAdoptsNativeRevisionAfterAnOlderMirrorConflict();
  await terminalCheckpointPreservesSessionOnPendingScriptOrMirrorFailure();
  await persistedUploadIsReplayedIntoCatalogueMirrorAfterWorkerRestart();
  console.log(
    "PASS: worker script recovery, owner link reconciliation and restart mirror replay",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
