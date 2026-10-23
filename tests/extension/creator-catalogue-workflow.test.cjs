"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const repositoryRoot = require("../support/paths.cjs").repositoryRoot;
const MODULE = "workflows/catalogue-workflow.js";
const PREFIX = "creatorCatalogueWorkflowOutboxV1:";

function harness(send = async () => ({ status: "recorded" })) {
  const values = {};
  const storage = {
    async get(keys) {
      const wanted =
        keys == null
          ? Object.keys(values)
          : Array.isArray(keys)
            ? keys
            : [keys];
      return Object.fromEntries(
        wanted
          .filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, structuredClone(values[key])]),
      );
    },
    async set(next) {
      Object.assign(values, structuredClone(next));
    },
    async remove(key) {
      delete values[key];
    },
  };
  const context = vm.createContext({
    URL,
    structuredClone,
    Date,
    crypto: webcrypto,
    TextEncoder,
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "extensions/personal/workflows/catalogue-contract.js",
      ),
      "utf8",
    ),
    context,
  );
  vm.runInContext(
    fs.readFileSync(
      path.join(repositoryRoot, "extensions/personal", MODULE),
      "utf8",
    ),
    context,
  );
  return {
    create: (sender = send) =>
      context.CreatorCatalogueWorkflow.create({
        storage,
        send: sender,
        now: () => 1_800_000_000_000,
      }),
    values,
    storage,
    api: context.CreatorCatalogueWorkflow,
  };
}

test("upload snapshot maps catalogue source identity and only file-proof metadata", () => {
  const f = harness();
  const snapshot = f.api.uploadSnapshot({
    id: "upload-run-0001",
    catalogue: {
      source: "desktop",
      id: "episode-ashley",
      itemId: "internal-item-id",
      title: "Title",
      destination: { workbookId: "workbook-a", sheetId: "0" },
    },
    draft: {
      fullFilename: "C:\\private\\full.mp4",
      fileProof: {
        full: { name: "full.mp4", size: 100, lastModified: 1_700_000_000_000 },
        script: {
          name: "episode.funscript",
          size: 20,
          lastModified: 1_700_000_000_000,
        },
      },
    },
    platforms: {
      onlyfans: {
        status: "published-local",
        submitAttempted: true,
        postUrl: "https://onlyfans.com/123/johnny_guides",
      },
      fansly: { status: "failed", error: "session token=secret" },
      manyvids: { status: "failed", error: "A1B2C3D4" },
    },
    scriptState: {
      status: "sent",
      urls: [
        "https://johnnyguides.com/sync/scripts/episode.funscript",
        "https://www.johnnyguides.com/sync/scripts/hash.funscript",
        "https://evil.example/sync/scripts/secret.funscript",
      ],
      sentKeys: ["episode-ashley"],
    },
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.equal(snapshot.sourceKey, "episode-ashley");
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.destination)), {
    workbookId: "workbook-a",
    sheetId: "0",
  });
  assert.equal(snapshot.script.writebackState, "synced");
  assert.equal(snapshot.targets[0].status, "uploaded");
  assert.equal(snapshot.targets[1].status, "failed");
  assert.equal(snapshot.targets[1].error, undefined);
  assert.equal(snapshot.targets[2].error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.script.links)), [
    "https://johnnyguides.com/sync/scripts/episode.funscript",
    "https://johnnyguides.com/sync/scripts/hash.funscript",
  ]);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(snapshot.assets.map(({ name, role }) => ({ name, role }))),
    ),
    [
      { name: "full.mp4", role: "video" },
      { name: "episode.funscript", role: "script" },
    ],
  );
  assert.equal(JSON.stringify(snapshot).includes("internal-item-id"), false);
  assert.equal(JSON.stringify(snapshot).includes("C:\\\\private"), false);
  assert.equal(JSON.stringify(snapshot).includes("token=secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("A1B2C3D4"), false);
  assert.equal(JSON.stringify(snapshot).includes("bytes"), false);
});

test("social snapshot preserves frozen reply and source identity while filtering unsafe URLs", () => {
  const f = harness();
  const snapshot = f.api.socialSnapshot({
    plan: {
      id: "social-run-0001",
      catalogue: {
        row: 50,
        id: "episode-ashley",
        title: "Title",
        fingerprint: "1234abcd",
        destination: { workbookId: "workbook-a", sheetId: "0" },
      },
      socialFile: {
        basename: "teaser.mp4",
        size: 50,
        lastModified: 1_700_000_000_000,
        sha256: "a".repeat(64),
      },
      paidUrl: "https://fansly.com/Johnny_Guides/posts",
      targets: { x: true, reddit: [] },
      xOptions: { autoReply: true, replyDelayMinutes: 15 },
    },
    jobs: {
      x: {
        stage: "result-captured",
        resultUrl: "https://x.com/creator/status/12345",
        replyResultUrl: "https://x.com/creator/status/12346",
        replyDueAt: 1_800_000_000_000,
        replyLine: "Full video -> {link}",
        replySubmitAttempted: true,
      },
    },
    catalogueAssociation: {
      id: "episode-ashley",
      row: 50,
      destination: { workbookId: "workbook-b", sheetId: "12" },
    },
    clipId: "clip-123",
  });
  assert.equal(snapshot.sourceKey, "episode-ashley");
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.destination)), {
    workbookId: "workbook-b",
    sheetId: "12",
  });
  assert.equal(
    snapshot.reply.paidUrl,
    "https://fansly.com/Johnny_Guides/posts",
  );
  assert.equal(
    snapshot.reply.mainStatusUrl,
    "https://x.com/creator/status/12345",
  );
  assert.equal(
    snapshot.reply.replyStatusUrl,
    "https://x.com/creator/status/12346",
  );
  assert.equal(snapshot.reply.attempted, true);
  assert.equal(snapshot.clip.episodeKey, "episode-ashley");
  assert.equal(snapshot.assets[0].sha256, "a".repeat(64));

  const pornhub = f.api.socialSnapshot({
    plan: {
      id: "social-run-0003",
      paidUrl: "https://www.pornhub.com/view_video.php?viewkey=publicKey_123",
      targets: { x: true, reddit: [] },
      socialFile: {
        basename: "teaser.mp4",
        size: 1,
        lastModified: 1_700_000_000_000,
      },
    },
    jobs: { x: { stage: "planned" } },
  });
  assert.equal(
    pornhub.reply.paidUrl,
    "https://www.pornhub.com/view_video.php?viewkey=publicKey_123",
  );

  const unsafe = f.api.socialSnapshot({
    plan: {
      ...snapshot.plan,
      id: "social-run-0002",
      paidUrl: "https://onlyfans.com/profile?token=secret",
    },
    jobs: { x: { stage: "planned" } },
  });
  assert.equal(unsafe.reply, undefined);
});

test("mixed Reddit outcomes retain every confirmed post and stay partial when another result is unresolved", () => {
  const f = harness();
  const snapshot = f.api.socialSnapshot({
    plan: {
      id: "reddit-mixed-run-0001",
      targets: {
        reddit: [
          { subreddit: "first_community" },
          { subreddit: "second_community" },
          { subreddit: "third_community" },
          { subreddit: "fourth_community" },
        ],
      },
      socialFile: {
        basename: "teaser.mp4",
        size: 12,
        lastModified: 1_700_000_000_000,
      },
    },
    jobs: {
      "reddit:first_community": {
        status: "uploaded",
        resultUrl:
          "https://www.reddit.com/r/first_community/comments/abc123/posted/",
      },
      "reddit:second_community": {
        status: "uploaded",
        resultUrl:
          "https://www.reddit.com/r/second_community/comments/def456/posted/",
      },
      "reddit:third_community": {
        status: "failed",
        errorCode: "destination_failed",
      },
      "reddit:fourth_community": {
        status: "posted-link-unresolved",
        submitAttempted: true,
      },
    },
  });

  assert.equal(snapshot.targets[0].platform, "reddit");
  assert.equal(snapshot.targets[0].status, "partial");
  assert.equal(snapshot.targets[0].submitted, true);
  assert.equal(
    snapshot.targets[0].postUrl,
    "https://www.reddit.com/r/first_community/comments/abc123/posted",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.targets[0].postUrls)), [
    "https://www.reddit.com/r/first_community/comments/abc123/posted",
    "https://www.reddit.com/r/second_community/comments/def456/posted",
  ]);
  assert.equal(snapshot.targets[0].error, "destination_failed");
});

test("outbox revisions increase for same-time updates and survive restart after native failure", async () => {
  const f = harness(async () => {
    throw new Error("private path C:\\secret");
  });
  let api = f.create();
  const first = await api.enqueue({
    runId: "run-0001",
    kind: "upload",
    revision: 1,
    sourceKey: null,
    targets: [],
    assets: [],
  });
  const second = await api.enqueue({
    ...first.snapshot,
    targets: [{ platform: "x", status: "submitted", submitted: true }],
  });
  assert.equal(first.snapshot.revision, 1);
  assert.equal(second.snapshot.revision, 2);
  const failed = await api.flush();
  assert.equal(failed.results[0].status, "pending");
  const key = `${PREFIX}run-0001`;
  assert.equal(f.values[key].state, "pending");
  assert.equal(f.values[key].lastError, "native_unavailable");

  api = f.create(async (command, snapshot) => {
    assert.equal(command, "recordCreatorWorkflow");
    assert.equal(snapshot.revision, 2);
    return { status: "recorded" };
  });
  const sent = await api.flush();
  assert.equal(sent.results[0].status, "recorded");
  assert.equal(Object.hasOwn(f.values, key), false);
  const later = await api.enqueue({
    runId: "run-0001",
    kind: "upload",
    revision: 1,
    sourceKey: null,
    targets: [{ platform: "x", status: "uploaded", submitted: true }],
    assets: [],
  });
  assert.equal(later.snapshot.revision, 3);
});

test("identical workflow replay after native success keeps its revision and does not write twice", async () => {
  let nativeWrites = 0;
  const f = harness(async (_command, snapshot) => {
    nativeWrites += 1;
    assert.equal(snapshot.revision, 4);
    return { status: "recorded" };
  });
  let api = f.create();
  const snapshot = {
    runId: "run-replayed",
    kind: "upload",
    revision: 4,
    sourceKey: "episode-4",
    targets: [{ platform: "x", status: "uploaded", submitted: true }],
    assets: [
      {
        role: "video",
        name: "episode.mp4",
        size: 1024,
        lastModified: Date.parse("2026-09-01T12:00:00.000Z"),
        sha256: "a".repeat(64),
      },
    ],
  };
  const first = await api.enqueue(snapshot);
  assert.equal(first.snapshot.revision, 4);
  await api.flush();
  api = f.create();
  const replay = await api.enqueue({ ...snapshot, revision: 1 });
  assert.equal(replay.unchanged, true);
  assert.equal(replay.snapshot.revision, 4);
  assert.equal(replay.status, "unchanged");
  assert.equal((await api.flush()).processed, 0);
  assert.equal(nativeWrites, 1);
  const signature =
    f.values["creatorCatalogueWorkflowSignatureV1:run-replayed"];
  assert.equal(signature.revision, 4);
  assert.match(signature.signature, /^sha256:[0-9a-f]{64}$/);
  assert.ok(signature.signature.length < 80);
});

test("observed native revision survives restart without changing pending workflow data", async () => {
  const f = harness(async () => {
    throw new Error("native-unavailable");
  });
  const runId = "observe-run-01";
  const initial = {
    runId,
    kind: "upload",
    revision: 4,
    sourceKey: "episode-ashley",
    destination: { workbookId: "workbook-a", sheetId: "0" },
    targets: [{ platform: "x", status: "submitted", submitted: true }],
    assets: [],
  };
  let api = f.create();
  const queued = await api.enqueue(initial);
  await api.flush();
  const outboxKey = `${PREFIX}${runId}`;
  const revisionKey = `creatorCatalogueWorkflowRevisionV1:${runId}`;
  const signatureKey = `creatorCatalogueWorkflowSignatureV1:${runId}`;
  const pendingBefore = structuredClone(f.values[outboxKey]);
  const signatureBefore = structuredClone(f.values[signatureKey]);
  assert.equal(queued.snapshot.revision, 4);
  assert.equal(pendingBefore.state, "pending");

  assert.equal(await api.observeRevision(runId, 5), 5);
  assert.equal(await api.observeRevision(runId, 5), 5);
  assert.equal(await api.observeRevision(runId, 3), 5);
  assert.equal(f.values[revisionKey], 5);
  assert.deepEqual(f.values[outboxKey], pendingBefore);
  assert.deepEqual(f.values[signatureKey], signatureBefore);

  api = f.create();
  assert.deepEqual(JSON.parse(JSON.stringify(await api.scanPersisted())), [
    pendingBefore,
  ]);
  const checkpoint = await api.enqueue({
    ...initial,
    targets: [{ platform: "x", status: "uploaded", submitted: true }],
  });
  assert.equal(checkpoint.snapshot.revision, 6);
  assert.equal(checkpoint.snapshot.sourceKey, "episode-ashley");
  assert.deepEqual(
    JSON.parse(JSON.stringify(checkpoint.snapshot.destination)),
    { workbookId: "workbook-a", sheetId: "0" },
  );
  assert.equal(f.values[revisionKey], 6);
  await assert.rejects(api.observeRevision("short", 7), /run ID/);
  await assert.rejects(api.observeRevision(runId, 0), /revision/);
  await assert.rejects(
    api.observeRevision(runId, Number.MAX_SAFE_INTEGER + 1),
    /revision/,
  );
});

test("conflicts remain visible and only fifty persisted runs are attempted per flush", async () => {
  let calls = 0;
  const f = harness(async () => {
    calls += 1;
    return { status: "conflict", code: "creator-workflow-identity-conflict" };
  });
  const api = f.create();
  for (let index = 0; index < 51; index++)
    await api.enqueue({
      runId: `run-${String(index).padStart(4, "0")}`,
      kind: "upload",
      revision: 1,
      sourceKey: null,
      targets: [],
      assets: [],
    });
  const result = await api.flush();
  assert.equal(result.processed, 50);
  assert.equal(calls, 50);
  assert.equal(result.remaining, 51);
  assert.equal((await api.scanPersisted()).length, 50);
  assert.equal(
    Object.values(f.values).filter((value) => value.state === "conflict")
      .length,
    50,
  );
  assert.equal((await api.flush()).processed, 1);
  assert.equal(calls, 51);
  assert.equal((await api.flush()).processed, 0);
  assert.equal(calls, 51);
});
