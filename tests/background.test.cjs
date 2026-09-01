"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backgroundPath = path.resolve(__dirname, "..", "background.js");
const manifestPath = path.resolve(__dirname, "..", "manifest.json");
const gelbooruRulesPath = path.resolve(__dirname, "..", "gelbooru-rules.json");
const storage = {};
const sessionStorage = {};
let messageListener;
let installListener;
let startupListener;
let storageChangeListener;
let permissionAddedListener;
let permissionRemovedListener;
let lastFetchUrl = "";
const realbooruListingUrls = [];
const fetchedFingerprints = new Set();
const registeredContentScripts = new Map();
const openTabs = new Map([
  [
    41,
    {
      id: 41,
      url: "https://onlyfans.com/my/home",
      status: "complete",
      active: false,
    },
  ],
]);
const tabUpdatedListeners = new Set();
const probeExecutionOrder = [];
const recorderInjectionTabs = [];
const recorderShowTabs = [];
const deniedOrigins = new Set();
let nextTabId = 50;
let offscreenOpen = false;
let nextTabGetHook = null;
let navigateAfterProbeFileTo = "";
let navigateBeforeRecorderInjection = null;
let nextProbeFailure = "";

function tabDocumentId(tab) {
  return `document-${tab.id}-${tab.documentVersion || 0}`;
}

const gelbooruPosts = [
  {
    id: 1001,
    md5: "11111111111111111111111111111111",
    rating: "general",
    tags: "1girl selfie solo looking_at_viewer smile",
    preview_url: "https://img.example/1001.jpg",
  },
  {
    id: 1002,
    md5: "22222222222222222222222222222222",
    rating: "general",
    tags: "1girl selfie solo looking_at_viewer trans",
    preview_url: "https://img.example/1002.jpg",
  },
  {
    id: 1003,
    md5: "33333333333333333333333333333333",
    rating: "general",
    tags: "1girl selfie solo looking_at_viewer outdoors",
    preview_url: "https://img.example/1003.jpg",
  },
  {
    id: 1004,
    md5: "44444444444444444444444444444444",
    rating: "explicit",
    tags: "1girl selfie solo looking_at_viewer lingerie",
    preview_url: "https://img.example/1004.jpg",
  },
  {
    id: 1005,
    md5: "11111111111111111111111111111111",
    rating: "explicit",
    tags: "1girl selfie solo looking_at_viewer lingerie",
    preview_url: "https://img.example/1005-duplicate.jpg",
  },
];

const realbooruPosts = [
  {
    source: "realbooru",
    id: "9001",
    url: "https://realbooru.com/images/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg",
    postUrl: "https://realbooru.com/index.php?page=post&s=view&id=9001",
    fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tags: ["1girl", "female", "selfie", "solo", "looking_at_viewer", "topless"],
  },
  {
    source: "realbooru",
    id: "9002",
    url: "https://realbooru.com/images/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg",
    postUrl: "https://realbooru.com/index.php?page=post&s=view&id=9002",
    fingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    tags: ["female", "selfie", "solo", "looking_at_viewer", "lingerie"],
  },
  {
    source: "realbooru",
    id: "9003",
    url: "https://realbooru.com/images/cc/cccccccccccccccccccccccccccccccc.jpg",
    postUrl: "https://realbooru.com/index.php?page=post&s=view&id=9003",
    fingerprint: "cccccccccccccccccccccccccccccccc",
    tags: ["female_only", "selfie", "solo", "looking_at_viewer", "nude"],
  },
  {
    source: "realbooru",
    id: "9004",
    url: "https://realbooru.com/images/dd/dddddddddddddddddddddddddddddddd.jpg",
    postUrl: "https://realbooru.com/index.php?page=post&s=view&id=9004",
    fingerprint: "dddddddddddddddddddddddddddddddd",
    tags: ["1girl", "selfie", "solo", "looking_at_viewer", "trans"],
  },
];

const chrome = {
  permissions: {
    contains: async ({ origins = [] }) =>
      !origins.some((origin) => deniedOrigins.has(origin)),
    onAdded: {
      addListener(listener) {
        permissionAddedListener = listener;
      },
    },
    onRemoved: {
      addListener(listener) {
        permissionRemovedListener = listener;
      },
    },
  },
  runtime: {
    id: "test-extension",
    getURL(relativePath) {
      return `chrome-extension://test-extension/${relativePath}`;
    },
    async getContexts(filter = {}) {
      if (filter.documentUrls?.length) {
        return Array.from(openTabs.values())
          .filter((tab) => filter.documentUrls.includes(tab.url))
          .map((tab) => ({ contextType: "TAB", tabId: tab.id }));
      }
      return offscreenOpen ? [{}] : [];
    },
    async sendMessage(message) {
      assert.equal(message.target, "realbooru-offscreen-parser");
      if (message.kind === "listing") {
        return {
          ok: true,
          result: {
            maxPid: 0,
            posts: realbooruPosts.map((post) => ({
              id: post.id,
              postUrl: post.postUrl,
              thumbnailUrl: post.url.replace("/images/", "/thumbnails/"),
              tags: post.tags,
            })),
          },
        };
      }
      if (message.kind === "detail") {
        const post = realbooruPosts.find(
          (candidate) => candidate.id === message.expectedId,
        );
        return {
          ok: true,
          result: {
            id: post.id,
            url: post.url,
            postUrl: post.postUrl,
            fingerprint: post.fingerprint,
          },
        };
      }
      return { ok: false, error: "Unexpected parser operation." };
    },
    onInstalled: {
      addListener(listener) {
        installListener = listener;
      },
    },
    onStartup: {
      addListener(listener) {
        startupListener = listener;
      },
    },
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      },
    },
  },
  offscreen: {
    async createDocument() {
      offscreenOpen = true;
    },
    async closeDocument() {
      offscreenOpen = false;
    },
  },
  webNavigation: {
    async getAllFrames({ tabId }) {
      const tab = openTabs.get(tabId);
      return tab
        ? [
            {
              frameId: 0,
              documentId: tabDocumentId(tab),
              url: tab.url,
            },
          ]
        : [];
    },
  },
  storage: {
    onChanged: {
      addListener(listener) {
        storageChangeListener = listener;
      },
    },
    local: {
      async get(keys) {
        const selected = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (Object.hasOwn(storage, key))
            selected[key] = structuredClone(storage[key]);
        }
        return selected;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) {
          const oldValue = storage[key];
          storage[key] = structuredClone(value);
          storageChangeListener?.(
            {
              [key]: {
                oldValue,
                newValue: structuredClone(value),
              },
            },
            "local",
          );
        }
      },
    },
    session: {
      async get(keys) {
        const selected = {};
        const wanted =
          keys == null
            ? Object.keys(sessionStorage)
            : Array.isArray(keys)
              ? keys
              : [keys];
        for (const key of wanted) {
          if (Object.hasOwn(sessionStorage, key)) {
            selected[key] = structuredClone(sessionStorage[key]);
          }
        }
        return selected;
      },
      async set(values) {
        Object.assign(sessionStorage, structuredClone(values));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete sessionStorage[key];
        }
      },
    },
  },
  scripting: {
    async getRegisteredContentScripts({ ids } = {}) {
      const values = Array.from(registeredContentScripts.values());
      return ids?.length
        ? values.filter((entry) => ids.includes(entry.id))
        : values;
    },
    async unregisterContentScripts({ ids }) {
      for (const id of ids) registeredContentScripts.delete(id);
    },
    async registerContentScripts(entries) {
      for (const entry of entries) {
        registeredContentScripts.set(entry.id, structuredClone(entry));
      }
    },
    async executeScript(details) {
      if (details.files) {
        if (details.files.includes("creator-tools/upload-trace-recorder.js")) {
          const tab = openTabs.get(details.target.tabId);
          if (navigateBeforeRecorderInjection?.tabId === details.target.tabId) {
            tab.url = navigateBeforeRecorderInjection.url;
            tab.documentVersion = (tab.documentVersion || 0) + 1;
            navigateBeforeRecorderInjection = null;
          }
          if (
            details.target.documentIds?.length &&
            !details.target.documentIds.includes(tabDocumentId(tab))
          ) {
            throw new Error("The target document no longer exists.");
          }
          recorderInjectionTabs.push(details.target.tabId);
          return [{ frameId: 0 }];
        }
        if (nextProbeFailure) {
          const message = nextProbeFailure;
          nextProbeFailure = "";
          throw new Error(message);
        }
        const tab = openTabs.get(details.target.tabId);
        const route = tab.url;
        const platform = route.includes("onlyfans.com") ? "onlyfans" : "fansly";
        probeExecutionOrder.push(platform);
        if (navigateAfterProbeFileTo) {
          tab.url = navigateAfterProbeFileTo;
          navigateAfterProbeFileTo = "";
        }
        return [
          {
            frameId: 0,
            result: {
              platform,
              route,
              status: "page-detected",
              capabilities: {},
            },
          },
        ];
      }
      if (details.func?.name === "showCreatorUploadTraceRecorderPanel") {
        recorderShowTabs.push(details.target.tabId);
        return [{ frameId: 0, result: true }];
      }
      throw new Error("Unexpected function-based capability probe.");
    },
  },
  tabs: {
    async query({ url, active } = {}) {
      let tabs = Array.from(openTabs.values());
      if (url) {
        const prefix = String(url).replace(/\*$/, "");
        tabs = tabs.filter((tab) => String(tab.url || "").startsWith(prefix));
      }
      if (active === true) tabs = tabs.filter((tab) => tab.active === true);
      return tabs;
    },
    async create({ url, active }) {
      const tab = { id: nextTabId, url, active, status: "complete" };
      nextTabId += 1;
      openTabs.set(tab.id, tab);
      return structuredClone(tab);
    },
    async update(tabId, patch) {
      Object.assign(openTabs.get(tabId), patch);
      return structuredClone(openTabs.get(tabId));
    },
    async get(tabId) {
      const snapshot = structuredClone(openTabs.get(tabId));
      const hook = nextTabGetHook;
      nextTabGetHook = null;
      hook?.(tabId);
      return snapshot;
    },
    onUpdated: {
      addListener(listener) {
        tabUpdatedListeners.add(listener);
      },
      removeListener(listener) {
        tabUpdatedListeners.delete(listener);
      },
    },
  },
};

let context;
context = vm.createContext({
  Blob,
  btoa,
  chrome,
  console,
  fetch: async (url) => {
    lastFetchUrl = String(url);
    if (
      /^https:\/\/realbooru\.com\/index\.php\?/.test(lastFetchUrl) &&
      lastFetchUrl.includes("s=list")
    ) {
      realbooruListingUrls.push(lastFetchUrl);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/html; charset=UTF-8" },
        text: async () => "<html>listing fixture</html>",
      };
    }
    if (
      /^https:\/\/realbooru\.com\/index\.php\?/.test(lastFetchUrl) &&
      lastFetchUrl.includes("s=view")
    ) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/html; charset=UTF-8" },
        text: async () => "<html>detail fixture</html>",
      };
    }
    if (/^https:\/\/realbooru\.com\/images\//.test(lastFetchUrl)) {
      const post = realbooruPosts.find((item) => item.url === lastFetchUrl);
      assert.equal(
        storage.fimStateV1?.usedRealbooruIds?.[post.id],
        true,
        "A Realbooru ID must be durably reserved before its image bytes are fetched.",
      );
      assert.equal(storage.fimStateV1?.usedAvatarUrls?.[post.url], true);
      assert.equal(
        storage.fimStateV1?.usedAvatarFingerprints?.[post.fingerprint],
        true,
      );
      assert.equal(fetchedFingerprints.has(post.fingerprint), false);
      fetchedFingerprints.add(post.fingerprint);
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["real-image"], { type: "image/jpeg" }),
      };
    }
    if (/^https:\/\/img\.example\//.test(lastFetchUrl)) {
      const imageId = lastFetchUrl.match(/\/(\d+)/)?.[1];
      const post = gelbooruPosts.find((item) => String(item.id) === imageId);
      assert.equal(
        storage.fimStateV1?.usedAvatarIds?.[imageId],
        true,
        "A Gelbooru ID must be durably reserved before its image bytes are fetched.",
      );
      assert.equal(
        storage.fimStateV1?.usedAvatarUrls?.[lastFetchUrl],
        true,
        "A Gelbooru source URL must be durably reserved before its image bytes are fetched.",
      );
      assert.equal(
        storage.fimStateV1?.usedAvatarFingerprints?.[post.md5],
        true,
        "A Gelbooru MD5 must be durably reserved before its image bytes are fetched.",
      );
      assert.equal(
        fetchedFingerprints.has(post.md5),
        false,
        "The same Gelbooru asset fingerprint must never be fetched twice.",
      );
      fetchedFingerprints.add(post.md5);
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["fake-image"], { type: "image/jpeg" }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: {
        get: () => "application/json",
      },
      text: async () =>
        JSON.stringify({ post: structuredClone(gelbooruPosts) }),
    };
  },
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
  setTimeout,
  URL,
  URLSearchParams,
});

vm.runInContext(fs.readFileSync(backgroundPath, "utf8"), context, {
  filename: backgroundPath,
});

function send(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Message timed out.")),
      1000,
    );
    messageListener(message, {}, (response) => {
      clearTimeout(timeout);
      if (!response?.ok) {
        reject(new Error(response?.error || "Unknown extension error."));
        return;
      }
      resolve(response);
    });
  });
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const gelbooruRules = JSON.parse(fs.readFileSync(gelbooruRulesPath, "utf8"));
  assert.ok(
    manifest.permissions.includes("declarativeNetRequestWithHostAccess"),
    "Gelbooru image-header rules require declarativeNetRequestWithHostAccess.",
  );
  assert.equal(
    manifest.minimum_chrome_version,
    "116",
    "The console singleton uses chrome.runtime.getContexts(), introduced in Chrome 116.",
  );
  assert.ok(
    manifest.optional_host_permissions.includes("https://realbooru.com/*"),
  );
  assert.equal(
    manifest.optional_host_permissions.includes("http://127.0.0.1/*"),
    false,
  );
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.equal(
    typeof context.CreatorSocialChromeRuntime?.create,
    "function",
    "The background worker must load the trace-approved social Chrome runtime.",
  );
  await assert.rejects(
    send({
      type: "PREPARE_CREATOR_SOCIAL_DISTRIBUTION",
      plan: {},
      caption: "",
    }),
    /invalid distribution plan ID/i,
  );
  assert.ok(
    manifest.permissions.includes("webNavigation"),
    "Existing-tab recorder injection must pin the document it inspected.",
  );
  assert.equal(
    gelbooruRules[0].action.requestHeaders[0].value,
    "https://gelbooru.com/",
  );
  assert.equal(
    gelbooruRules[1].action.requestHeaders[0].value,
    "https://realbooru.com/",
  );
  assert.match(gelbooruRules[0].condition.regexFilter, /gelbooru/);

  const restoredUploadSession = JSON.parse(
    await vm.runInContext(
      `(async () => {
        const id = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef";
        await CreatorUploadSessionStore.save({
          id,
          draft: { title: "Restored episode" },
          platforms: {
            onlyfans: {
              platform: "onlyfans",
              tabId: 41,
              status: "submitted",
              submitAttempted: true
            },
            fansly: {
              platform: "fansly",
              tabId: 50,
              status: "uploading-full",
              submitAttempted: false
            },
            manyvids: {
              platform: "manyvids",
              tabId: 51,
              status: "configuring",
              manyvidsId: "7783271",
              submitAttempted: false
            }
          }
        });
        creatorUploadSessions.delete(id);
        const restored = await getCreatorUploadSession(id);
        clearTimeout(restored.cleanupTimer);
        creatorUploadSessions.delete(id);
        await CreatorUploadSessionStore.remove(id);
        return JSON.stringify({
          title: restored.draft.title,
          onlyfans: restored.platforms.get("onlyfans"),
          fansly: restored.platforms.get("fansly"),
          manyvids: restored.platforms.get("manyvids")
        });
      })()`,
      context,
    ),
  );
  assert.equal(restoredUploadSession.title, "Restored episode");
  assert.equal(restoredUploadSession.onlyfans.submitAttempted, true);
  assert.equal(restoredUploadSession.onlyfans.status, "posted-link-unresolved");
  assert.equal(restoredUploadSession.fansly.status, "failed");
  assert.equal(restoredUploadSession.manyvids.status, "edit-failed");

  const validatedUpload = JSON.parse(
    vm.runInContext(
      `JSON.stringify(validateCreatorUploadRequest({
        sessionId: "0123456789abcdef0123456789abcdef0123456789abcdef",
        targets: ["onlyfans", "fansly", "manyvids"],
        draft: {
          title: "Episode 42",
          description: "Description",
          fullFilename: "Episode 42 (full).mp4",
          releaseDate: "2026-08-28",
          scheduledIso: "2026-08-28T15:00:00.000Z",
          timeZone: "Europe/Zurich",
          fanslyPreset: "defaulT",
          manyvidsThumbnail: true
        },
        catalogue: {
          row: 135,
          id: "episode-42",
          releaseDate: "2026-08-28",
          title: "Episode 42",
          description: "Description",
          seasonArc: "GameSync Season 4",
          episode: "42",
          pornhubLink: "https://www.pornhub.com/view_video.php?viewkey=episode42",
          onlyfansLink: "",
          fanslyLink: "",
          manyvidsLink: "",
          fingerprint: "1234abcd",
          status: "matched"
        }
      }))`,
      context,
    ),
  );
  assert.deepEqual(validatedUpload.targets, ["onlyfans", "fansly", "manyvids"]);
  assert.equal(validatedUpload.draft.fanslyPreset, "defaulT");
  assert.equal(validatedUpload.draft.fullFilename, "Episode 42 (full).mp4");
  assert.equal(validatedUpload.draft.manyvidsThumbnail, true);
  context.proofSession = {
    draft: validatedUpload.draft,
  };
  context.validProof = {
    fullFilename: validatedUpload.draft.fullFilename,
    pornhubFilename: validatedUpload.draft.pornhubFilename,
    manyvidsThumbnail: validatedUpload.draft.manyvidsThumbnail,
    profileSignature: validatedUpload.draft.profileSignature,
  };
  assert.equal(
    vm.runInContext(
      "creatorUploadSessionProofMatches(proofSession, validProof)",
      context,
    ),
    true,
  );
  context.changedProof = { ...context.validProof, fullFilename: "other.mp4" };
  assert.equal(
    vm.runInContext(
      "creatorUploadSessionProofMatches(proofSession, changedProof)",
      context,
    ),
    false,
  );
  assert.equal(validatedUpload.draft.profiles.manyvidsAutofill.price, "19.99");
  assert.equal(validatedUpload.draft.profiles.manyvidsAutofill.tags.length, 10);
  assert.equal(validatedUpload.catalogue.fanslyLink, "");
  assert.equal(validatedUpload.catalogue.manyvidsLink, "");
  assert.equal(validatedUpload.catalogue.seasonArc, "GameSync Season 4");
  assert.equal(validatedUpload.catalogue.episode, "42");
  assert.equal(
    validatedUpload.catalogue.pornhubLink,
    "https://www.pornhub.com/view_video.php?viewkey=episode42",
  );
  context.boundedCatalogueContext = {
    ...validatedUpload,
    catalogue: {
      ...validatedUpload.catalogue,
      seasonArc: "s".repeat(600),
      episode: "4".repeat(100),
      pornhubLink: `https://www.pornhub.com/view_video.php?viewkey=${"x".repeat(100)}`,
    },
  };
  const boundedCatalogueContext = vm.runInContext(
    "validateCreatorUploadRequest(boundedCatalogueContext)",
    context,
  );
  assert.equal(boundedCatalogueContext.catalogue.seasonArc.length, 500);
  assert.equal(boundedCatalogueContext.catalogue.episode.length, 40);
  assert.match(
    boundedCatalogueContext.catalogue.pornhubLink,
    /viewkey=x{100}$/,
  );
  context.historicalUploadRequest = {
    ...validatedUpload,
    draft: {
      ...validatedUpload.draft,
      releaseDate: "2026-09-11",
      scheduledIso: "2026-09-11T15:00:00.000Z",
    },
    catalogue: {
      ...validatedUpload.catalogue,
      releaseDate: "2026-05-08",
      status: "matched",
    },
  };
  const historicalUpload = vm.runInContext(
    "validateCreatorUploadRequest(historicalUploadRequest)",
    context,
  );
  assert.equal(historicalUpload.catalogue.releaseDate, "2026-05-08");
  context.historicalWeekdayRequest = {
    ...context.historicalUploadRequest,
    catalogue: {
      ...validatedUpload.catalogue,
      releaseDate: "2026-05-07",
      status: "matched",
    },
  };
  const historicalWeekday = vm.runInContext(
    "validateCreatorUploadRequest(historicalWeekdayRequest)",
    context,
  );
  assert.equal(historicalWeekday.catalogue.releaseDate, "2026-05-07");
  context.newRowDateMismatch = {
    ...context.historicalUploadRequest,
    catalogue: {
      ...validatedUpload.catalogue,
      releaseDate: "2026-05-08",
      status: "new",
    },
  };
  assert.throws(
    () =>
      vm.runInContext(
        "validateCreatorUploadRequest(newRowDateMismatch)",
        context,
      ),
    /Invalid catalogue upload preview/,
  );
  context.invalidHistoricalDate = {
    ...context.historicalUploadRequest,
    catalogue: {
      ...validatedUpload.catalogue,
      releaseDate: "2026-99-99",
      status: "matched",
    },
  };
  assert.throws(
    () =>
      vm.runInContext(
        "validateCreatorUploadRequest(invalidHistoricalDate)",
        context,
      ),
    /Invalid catalogue upload preview/,
  );
  context.uploadOnlyRequest = { ...validatedUpload, catalogue: null };
  const uploadOnly = vm.runInContext(
    "validateCreatorUploadRequest(uploadOnlyRequest)",
    context,
  );
  assert.equal(
    uploadOnly.catalogue,
    null,
    "An explicit upload-only plan must not require a catalogue row.",
  );
  for (const catalogue of [
    undefined,
    {},
    { ...validatedUpload.catalogue, fingerprint: "" },
  ]) {
    context.invalidUploadRequest = { ...validatedUpload, catalogue };
    assert.throws(
      () =>
        vm.runInContext(
          "validateCreatorUploadRequest(invalidUploadRequest)",
          context,
        ),
      /Invalid catalogue upload preview/,
    );
  }
  context.invalidUploadRequest = {
    ...context.uploadOnlyRequest,
    draft: { ...validatedUpload.draft, fanslyPreset: "default" },
  };
  assert.throws(
    () =>
      vm.runInContext(
        "validateCreatorUploadRequest(invalidUploadRequest)",
        context,
      ),
    /exact defaulT/,
  );

  // Exercise the real coordinator, substituting only Chrome's page-execution boundary.
  const originalExecuteScript = chrome.scripting.executeScript;
  const originalFetch = context.fetch;
  const originalTabs = structuredClone([...openTabs]);
  const originalNextTabId = nextTabId;
  const uploadExecutions = [];
  const fileBridgePlatforms = [];
  const manyVidsStages = [];
  let manyVidsEditFailuresRemaining = 0;
  let manyVidsPostCheckpointFailuresRemaining = 0;
  context.armManyVidsEditFailure = () => {
    manyVidsEditFailuresRemaining = 1;
  };
  context.armManyVidsPostCheckpointFailure = () => {
    manyVidsPostCheckpointFailuresRemaining = 1;
  };
  context.crypto = require("node:crypto").webcrypto;
  context.fetch = async () => {
    throw new Error("Upload-only must never contact the catalogue bridge.");
  };
  chrome.scripting.executeScript = async (details) => {
    if (details.files) return [{ frameId: 0 }];
    const name = details.func.name;
    uploadExecutions.push(name);
    if (name === "markCreatorToolkitMasterRun") return [{ frameId: 0 }];
    if (name === "installCreatorUploadFileBridge") {
      fileBridgePlatforms.push(details.args[0].platform);
      return [{ frameId: 0 }];
    }
    if (name === "invokeCreatorPornhubPreparation") {
      return [
        {
          frameId: 0,
          result: {
            platform: "pornhub",
            status: "manual-submit-required",
            effectiveFilename: details.args[0].effectiveFilename,
            preset: details.args[0].contentPreset,
          },
        },
      ];
    }
    if (name === "invokeCreatorUploadAdapter") {
      const args = details.args[0];
      if (args.platform !== "manyvids") {
        return [{ frameId: 0, result: { status: "submitted" } }];
      }
      manyVidsStages.push(args.stage);
      const tab = openTabs.get(details.target.tabId);
      if (!args.draft.manyvidsId) {
        tab.url = "https://www.manyvids.com/Edit-vid/7783271";
        return [{ frameId: 0, result: { status: "edit-requested" } }];
      }
      if (manyVidsEditFailuresRemaining > 0) {
        manyVidsEditFailuresRemaining -= 1;
        throw new Error("fixture edit failure");
      }
      if (manyVidsPostCheckpointFailuresRemaining > 0) {
        manyVidsPostCheckpointFailuresRemaining -= 1;
        const target = await vm.runInContext(
          `getCreatorUploadSession("${args.sessionId}").then((session) => session.platforms.get("manyvids"))`,
          context,
        );
        target.commitArmed = true;
        target.submitAttempted = true;
        await context.CreatorUploadSessionStore.save(
          await vm.runInContext(
            `getCreatorUploadSession("${args.sessionId}").then(creatorUploadSessionRecord)`,
            context,
          ),
        );
        throw new Error("fixture response lost after durable checkpoint");
      }
      tab.url = "https://www.manyvids.com/upload-video";
      return [
        {
          frameId: 0,
          result: {
            status: "save-clicked",
            manyvidsId: args.draft.manyvidsId,
          },
        },
      ];
    }
    if (name === "installCreatorUploadResponseObserver") {
      const platform = details.args[0].platform;
      return [
        {
          frameId: 0,
          result: {
            status: "link-captured",
            postUrl:
              platform === "onlyfans"
                ? "https://onlyfans.com/123456789/johnny_guides"
                : "https://fansly.com/post/987654321",
          },
        },
      ];
    }
    throw new Error(`Unexpected page execution: ${name}`);
  };
  try {
    const directRun = JSON.parse(
      await vm.runInContext(
        `(async () => {
      const port = { creatorUploadSessionId: uploadOnlyRequest.sessionId, postMessage() {} };
      creatorUploadConsolePorts.add(port);
      try {
        const prepared = await prepareCreatorUpload(uploadOnlyRequest);
        const first = await startCreatorUpload(uploadOnlyRequest.sessionId, uploadOnlyRequest.targets);
        const retry = await retryCreatorUploadPlatform(uploadOnlyRequest.sessionId, "fansly");
        const storedAfterSuccess = await CreatorUploadSessionStore.load(uploadOnlyRequest.sessionId);
        const correctionRequest = {
          ...uploadOnlyRequest,
          sessionId: "111111111111111111111111111111111111111111111111",
          targets: ["manyvids"]
        };
        const correctionPort = {
          creatorUploadSessionId: correctionRequest.sessionId,
          postMessage() {}
        };
        creatorUploadConsolePorts.add(correctionPort);
        armManyVidsEditFailure();
        await prepareCreatorUpload(correctionRequest);
        const correctionFirst = await startCreatorUpload(correctionRequest.sessionId, ["manyvids"]);
        const correctionRetry = await retryCreatorUploadPlatform(correctionRequest.sessionId, "manyvids");
        const uncertainRequest = {
          ...uploadOnlyRequest,
          sessionId: "333333333333333333333333333333333333333333333333",
          targets: ["manyvids"]
        };
        const uncertainPort = {
          creatorUploadSessionId: uncertainRequest.sessionId,
          postMessage() {}
        };
        creatorUploadConsolePorts.add(uncertainPort);
        armManyVidsPostCheckpointFailure();
        await prepareCreatorUpload(uncertainRequest);
        const uncertainResult = await startCreatorUpload(uncertainRequest.sessionId, ["manyvids"]);
        let uncertainRetryError = "";
        try {
          await retryCreatorUploadPlatform(uncertainRequest.sessionId, "manyvids");
        } catch (error) {
          uncertainRetryError = error.message;
        }
        const storedAfterUncertain = await CreatorUploadSessionStore.load(uncertainRequest.sessionId);
        const pornhubRequest = {
          ...uploadOnlyRequest,
          sessionId: "222222222222222222222222222222222222222222222222",
          targets: ["pornhub"],
          draft: {
            ...uploadOnlyRequest.draft,
            pornhubFilename: "episode-limited.mp4",
            contentPreset: "Straight"
          }
        };
        const pornhubPort = {
          creatorUploadSessionId: pornhubRequest.sessionId,
          postMessage() {}
        };
        creatorUploadConsolePorts.add(pornhubPort);
        const pornhubPrepared = await prepareCreatorUpload(pornhubRequest);
        const pornhubResult = await startCreatorUpload(
          pornhubRequest.sessionId,
          pornhubRequest.targets
        );
        clearTimeout(creatorUploadSessions.get(pornhubRequest.sessionId)?.cleanupTimer);
        creatorUploadSessions.delete(pornhubRequest.sessionId);
        creatorUploadConsolePorts.delete(pornhubPort);
        clearTimeout(creatorUploadSessions.get(correctionRequest.sessionId)?.cleanupTimer);
        creatorUploadSessions.delete(correctionRequest.sessionId);
        creatorUploadConsolePorts.delete(correctionPort);
        clearTimeout(creatorUploadSessions.get(uncertainRequest.sessionId)?.cleanupTimer);
        creatorUploadSessions.delete(uncertainRequest.sessionId);
        creatorUploadConsolePorts.delete(uncertainPort);
        await CreatorUploadSessionStore.remove(uncertainRequest.sessionId);
        return JSON.stringify({
          prepared,
          first,
          retry,
          storedAfterSuccess,
          correctionFirst,
          correctionRetry,
          uncertainResult,
          uncertainRetryError,
          storedAfterUncertain,
          pornhubPrepared,
          pornhubResult
        });
      } finally {
        clearTimeout(creatorUploadSessions.get(uploadOnlyRequest.sessionId)?.cleanupTimer);
        creatorUploadSessions.delete(uploadOnlyRequest.sessionId);
        creatorUploadConsolePorts.delete(port);
      }
    })()`,
        context,
      ),
    );
    assert.deepEqual(
      directRun.prepared.platforms.map((entry) => entry.status),
      ["prepared", "prepared", "prepared"],
    );
    assert.equal(
      openTabs.get(directRun.prepared.platforms[0].tabId).url,
      "https://onlyfans.com/posts/create",
    );
    assert.equal(
      openTabs.get(directRun.prepared.platforms[1].tabId).url,
      "https://fansly.com/",
    );
    assert.deepEqual(directRun.first, [
      {
        platform: "onlyfans",
        postUrl: "https://onlyfans.com/123456789/johnny_guides",
        status: "uploaded-no-sheet",
      },
      {
        platform: "fansly",
        postUrl: "https://fansly.com/post/987654321",
        status: "uploaded-no-sheet",
      },
      {
        platform: "manyvids",
        postUrl: "https://www.manyvids.com/Video/7783271",
        status: "uploaded-no-sheet",
      },
    ]);
    assert.equal(directRun.retry[0].status, "uploaded-no-sheet");
    assert.equal(directRun.storedAfterSuccess, null);
    assert.equal(directRun.pornhubPrepared.platforms[0].status, "prepared");
    assert.deepEqual(directRun.pornhubResult, [
      {
        platform: "pornhub",
        status: "manual-submit-required",
        effectiveFilename: "episode-limited.mp4",
        preset: "Straight",
      },
    ]);
    assert.equal(fileBridgePlatforms.includes("pornhub"), false);
    assert.equal(
      directRun.correctionFirst[0].status,
      "edit-failed",
      JSON.stringify(directRun.correctionFirst[0]),
    );
    assert.equal(directRun.correctionFirst[0].manyvidsId, "7783271");
    assert.equal(directRun.correctionRetry[0].status, "uploaded-no-sheet");
    assert.equal(
      directRun.uncertainResult[0].status,
      "posted-link-unresolved",
      JSON.stringify(directRun.uncertainResult[0]),
    );
    assert.match(directRun.uncertainRetryError, /manual link recovery/i);
    assert.equal(
      directRun.storedAfterUncertain.platforms.manyvids.submitAttempted,
      true,
    );
    assert.deepEqual(manyVidsStages, [
      "upload",
      "edit",
      "upload",
      "edit",
      "edit",
      "upload",
      "edit",
    ]);
    assert.equal(
      uploadExecutions.filter((name) => name === "invokeCreatorUploadAdapter")
        .length,
      9,
      "Completed retries and uncertain submissions must never invoke another adapter run.",
    );
  } finally {
    chrome.scripting.executeScript = originalExecuteScript;
    context.fetch = originalFetch;
    openTabs.clear();
    for (const [id, tab] of originalTabs) openTabs.set(id, tab);
    nextTabId = originalNextTabId;
  }
  await assert.rejects(
    vm.runInContext(
      `Promise.resolve().then(() => validateCreatorUploadRequest({
        sessionId: "0123456789abcdef0123456789abcdef0123456789abcdef",
        targets: ["fansly"],
        draft: {
          title: "Episode 42",
          description: "Description",
          releaseDate: "2026-08-28",
          scheduledIso: "2026-08-28T15:00:00.000Z",
          timeZone: "Europe/Zurich",
          fanslyPreset: "defaulT"
        },
        catalogue: {
          row: 135,
          id: "episode-42",
          releaseDate: "2026-08-28",
          title: "Episode 42",
          description: "Description",
          onlyfansLink: "",
          fanslyLink: "https://fansly.com/post/777777777",
          fingerprint: "1234abcd",
          status: "matched"
        }
      }))`,
      context,
    ),
    /already has a Fansly link/i,
  );
  await assert.rejects(
    vm.runInContext(
      `Promise.resolve().then(() => validateCreatorUploadRequest({
        sessionId: "0123456789abcdef0123456789abcdef0123456789abcdef",
        targets: ["fansly"],
        draft: {
          title: "Episode 42",
          description: "Description",
          releaseDate: "2026-08-27",
          scheduledIso: "2026-08-27T15:00:00.000Z",
          timeZone: "Europe/Zurich",
          fanslyPreset: "default"
        },
        catalogue: { row: 135, id: "episode-42", releaseDate: "2026-08-27", title: "Episode 42", description: "Description", fingerprint: "1234abcd", status: "matched" }
      }))`,
      context,
    ),
    /Friday|defaulT/,
  );
  const coordinator = JSON.parse(
    await vm.runInContext(
      `(async () => {
        const id = "abcdef0123456789abcdef0123456789abcdef0123456789";
        const calls = [];
        const session = {
          id,
          platforms: new Map([
            ["onlyfans", { platform: "onlyfans", tabId: 41, status: "prepared" }],
            ["fansly", { platform: "fansly", tabId: 50, status: "prepared" }],
            ["manyvids", { platform: "manyvids", tabId: 51, status: "prepared" }],
            ["pornhub", { platform: "pornhub", tabId: 52, status: "prepared" }]
          ])
        };
        creatorUploadSessions.set(id, session);
        runCreatorUploadPlatform = async (_session, platform) => {
          calls.push(platform);
          if (platform === "fansly") {
            return { platform, status: "failed", error: "fixture failure" };
          }
          return {
            platform,
            status:
              platform === "pornhub"
                ? "manual-submit-required"
                : "catalogue-updated"
          };
        };
        const first = await startCreatorUpload(id, [
          "onlyfans",
          "fansly",
          "manyvids",
          "pornhub"
        ]);
        prepareCreatorUploadPlatform = async (_session, platform, tabId) => {
          calls.push("prepare:" + platform + ":" + tabId);
          const prepared = { platform, tabId, status: "prepared" };
          _session.platforms.set(platform, prepared);
          return prepared;
        };
        const retry = await retryCreatorUploadPlatform(id, "fansly");
        return JSON.stringify({ first, retry, calls });
      })()`,
      context,
    ),
  );
  assert.deepEqual(coordinator.first, [
    { platform: "onlyfans", status: "catalogue-updated" },
    { platform: "fansly", status: "failed", error: "fixture failure" },
    { platform: "manyvids", status: "catalogue-updated" },
    { platform: "pornhub", status: "manual-submit-required" },
  ]);
  assert.deepEqual(coordinator.retry, [
    { platform: "fansly", status: "failed", error: "fixture failure" },
  ]);
  assert.deepEqual(coordinator.calls, [
    "onlyfans",
    "fansly",
    "manyvids",
    "pornhub",
    "prepare:fansly:50",
    "fansly",
  ]);
  const safeRetries = JSON.parse(
    await vm.runInContext(
      `(async () => {
        const id = "fedcba9876543210fedcba9876543210fedcba9876543210";
        const calls = [];
        const session = {
          id,
          catalogue: { fingerprint: "1234abcd" },
          commitChain: Promise.resolve(),
          platforms: new Map()
        };
        creatorUploadSessions.set(id, session);
        prepareCreatorUploadPlatform = async () => {
          calls.push("prepare");
          const prepared = { platform: "fansly", tabId: 50, status: "prepared" };
          session.platforms.set("fansly", prepared);
          return prepared;
        };
        runCreatorUploadPlatform = async () => {
          calls.push("platform");
          return { platform: "fansly", status: "failed" };
        };
        commitCreatorUploadResult = async (_session, platform, postUrl) => {
          calls.push("commit:" + platform + ":" + postUrl);
          return { status: "updated", fingerprint: "87654321" };
        };

        session.platforms.set("fansly", {
          platform: "fansly",
          tabId: 50,
          status: "catalogue-commit-failed",
          submitted: true,
          postUrl: "https://fansly.com/post/987654321"
        });
        const commitRetry = await retryCreatorUploadPlatform(id, "fansly");

        session.platforms.set("fansly", {
          platform: "fansly",
          tabId: 50,
          status: "posted-link-unresolved",
          submitAttempted: true
        });
        let unresolvedError = "";
        try {
          await retryCreatorUploadPlatform(id, "fansly");
        } catch (error) {
          unresolvedError = error.message;
        }
        session.platforms.set("onlyfans", {
          platform: "onlyfans",
          tabId: 41,
          status: "prepared"
        });
        const checkpoint = await checkpointCreatorUploadCommit(id, "onlyfans", 41);
        let duplicateCheckpointError = "";
        try {
          await checkpointCreatorUploadCommit(id, "onlyfans", 41);
        } catch (error) {
          duplicateCheckpointError = error.message;
        }
        return JSON.stringify({
          commitRetry,
          unresolvedError,
          checkpoint,
          duplicateCheckpointError,
          calls
        });
      })()`,
      context,
    ),
  );
  assert.deepEqual(safeRetries.commitRetry, [
    {
      platform: "fansly",
      status: "catalogue-updated",
      submitted: true,
      postUrl: "https://fansly.com/post/987654321",
    },
  ]);
  assert.match(safeRetries.unresolvedError, /manual link recovery/i);
  assert.deepEqual(safeRetries.checkpoint, { armed: true });
  assert.match(safeRetries.duplicateCheckpointError, /manual link recovery/i);
  assert.deepEqual(safeRetries.calls, [
    "commit:fansly:https://fansly.com/post/987654321",
  ]);

  assert.equal(typeof installListener, "function");
  assert.equal(typeof startupListener, "function");
  assert.equal(typeof messageListener, "function");
  assert.equal(
    typeof permissionAddedListener,
    "function",
    "Granting an optional creator-site permission must resynchronize content scripts.",
  );
  assert.equal(typeof permissionRemovedListener, "function");
  await installListener();
  assert.ok(storage.creatorToolkitV2);
  assert.ok(
    registeredContentScripts.has("creator-toolkit-reddit"),
    "The default fail-closed Reddit censor should be dynamically registered.",
  );
  for (const [id, match] of [
    ["creator-toolkit-upload-trace-onlyfans", "https://onlyfans.com/*"],
    ["creator-toolkit-upload-trace-fansly", "https://fansly.com/*"],
    ["creator-toolkit-upload-trace-manyvids", "https://www.manyvids.com/*"],
    ["creator-toolkit-upload-trace-pornhub", "https://pornhub.mainhub.com/*"],
    ["creator-toolkit-upload-trace-x", "https://x.com/*"],
    ["creator-toolkit-upload-trace-redgifs", "https://www.redgifs.com/*"],
  ]) {
    const registration = registeredContentScripts.get(id);
    assert.ok(registration, `${id} should register independently.`);
    assert.deepEqual(registration.matches, [match]);
    assert.deepEqual(registration.js, [
      "creator-tools/upload-trace-recorder.js",
    ]);
    assert.equal(registration.runAt, "document_start");
  }
  const redditTrace = registeredContentScripts.get(
    "creator-toolkit-upload-trace-reddit",
  );
  assert.deepEqual(redditTrace.matches, [
    "https://www.reddit.com/*",
    "https://sh.reddit.com/*",
    "https://old.reddit.com/*",
  ]);

  openTabs.get(41).active = true;
  recorderInjectionTabs.length = 0;
  recorderShowTabs.length = 0;
  const shownRecorder = await send({ type: "SHOW_UPLOAD_TRACE_RECORDER" });
  assert.equal(
    JSON.stringify(shownRecorder.traceRecorder),
    '{"tabId":41,"platform":"OnlyFans"}',
  );
  assert.deepEqual(recorderInjectionTabs, [41]);
  assert.deepEqual(recorderShowTabs, [41]);

  const uploadProbe = await send({
    type: "PROBE_CREATOR_UPLOAD_TARGETS",
    targets: ["onlyfans", "fansly"],
  });
  assert.equal(
    JSON.stringify(uploadProbe.results.map((result) => result.platform)),
    '["onlyfans","fansly"]',
  );
  assert.deepEqual(probeExecutionOrder, ["onlyfans", "fansly"]);
  assert.equal(openTabs.get(41).url, "https://onlyfans.com/my/home");
  assert.ok(
    Array.from(openTabs.values()).some(
      (tab) => tab.url === "https://fansly.com/",
    ),
  );
  recorderInjectionTabs.length = 0;
  await permissionAddedListener({ origins: ["https://fansly.com/*"] });
  const openFanslyTab = Array.from(openTabs.values()).find(
    (tab) => tab.url === "https://fansly.com/",
  );
  assert.ok(
    recorderInjectionTabs.includes(openFanslyTab.id),
    "Permission synchronization must mount the enabled recorder in the already-open Fansly tab.",
  );

  recorderInjectionTabs.length = 0;
  navigateBeforeRecorderInjection = {
    tabId: openFanslyTab.id,
    url: "https://onlyfans.com/posts/create",
  };
  await permissionAddedListener({ origins: ["https://fansly.com/*"] });
  assert.equal(
    recorderInjectionTabs.includes(openFanslyTab.id),
    false,
    "Recorder injection must fail closed if the matched Fansly document navigates before injection.",
  );

  openFanslyTab.url = "https://fansly.com/";
  openFanslyTab.documentVersion = (openFanslyTab.documentVersion || 0) + 1;
  deniedOrigins.add("https://fansly.com/*");
  recorderInjectionTabs.length = 0;
  await permissionRemovedListener({ origins: ["https://fansly.com/*"] });
  assert.equal(
    registeredContentScripts.has("creator-toolkit-upload-trace-fansly"),
    false,
    "Removing Fansly access must unregister its recorder.",
  );
  assert.equal(recorderInjectionTabs.includes(openFanslyTab.id), false);

  deniedOrigins.delete("https://fansly.com/*");
  storage.creatorToolkitV2.tools.uploadTraceRecorder.enabled = false;
  recorderInjectionTabs.length = 0;
  await permissionAddedListener({ origins: ["https://fansly.com/*"] });
  assert.equal(
    registeredContentScripts.has("creator-toolkit-upload-trace-fansly"),
    false,
    "A disabled recorder must remain unregistered after permission changes.",
  );
  assert.equal(recorderInjectionTabs.includes(openFanslyTab.id), false);

  storage.creatorToolkitV2.tools.uploadTraceRecorder.enabled = true;
  await permissionAddedListener({ origins: ["https://fansly.com/*"] });

  openTabs.set(60, {
    id: 60,
    url: "https://fansly.com/one",
    status: "complete",
  });
  const ambiguousTabs = await send({
    type: "PROBE_CREATOR_UPLOAD_TARGETS",
    targets: ["fansly"],
  });
  assert.equal(ambiguousTabs.results[0].status, "ambiguous-tabs");

  const unsupported = await send({
    type: "PROBE_CREATOR_UPLOAD_TARGETS",
    targets: ["unknown", "__proto__", "constructor"],
  });
  assert.equal(
    JSON.stringify(unsupported.results.map((result) => result.status)),
    '["unsupported","unsupported","unsupported"]',
    "Prototype keys must not escape the explicit platform allow-list.",
  );

  const consoleUrl = chrome.runtime.getURL("upload-console.html");
  const consoleCountBefore = Array.from(openTabs.values()).filter(
    (tab) => tab.url === consoleUrl,
  ).length;
  const [firstConsole, secondConsole] = await Promise.all([
    send({ type: "OPEN_UPLOAD_CONSOLE" }),
    send({ type: "OPEN_UPLOAD_CONSOLE" }),
  ]);
  assert.equal(
    firstConsole.uploadConsole.tabId,
    secondConsole.uploadConsole.tabId,
  );
  assert.equal(
    Array.from(openTabs.values()).filter((tab) => tab.url === consoleUrl)
      .length,
    consoleCountBefore + 1,
    "Concurrent open requests must coalesce into one console tab.",
  );
  const sequentialConsole = await send({ type: "OPEN_UPLOAD_CONSOLE" });
  assert.equal(
    sequentialConsole.uploadConsole.tabId,
    firstConsole.uploadConsole.tabId,
  );
  assert.equal(
    Array.from(openTabs.values()).filter((tab) => tab.url === consoleUrl)
      .length,
    consoleCountBefore + 1,
    "An immediate follow-up request must reuse the tab before Chrome registers its context.",
  );
  const hiddenUrlTab = openTabs.get(firstConsole.uploadConsole.tabId);
  delete hiddenUrlTab.url;
  delete hiddenUrlTab.pendingUrl;
  const replacementConsole = await send({ type: "OPEN_UPLOAD_CONSOLE" });
  assert.notEqual(
    replacementConsole.uploadConsole.tabId,
    firstConsole.uploadConsole.tabId,
    "A tracked tab with an unavailable URL must not be trusted as the console.",
  );

  openTabs.set(70, {
    id: 70,
    url: "https://onlyfans.com/loading",
    status: "loading",
  });
  nextTabGetHook = (tabId) => {
    openTabs.get(tabId).status = "complete";
    for (const listener of tabUpdatedListeners) {
      listener(tabId, { status: "complete" });
    }
  };
  await vm.runInContext("waitForCreatorTab(70, 20)", context);
  openTabs.delete(70);

  openTabs.set(71, {
    id: 71,
    url: "https://fansly.com/loading",
    status: "loading",
  });
  const listenerCountBeforeTimeout = tabUpdatedListeners.size;
  await assert.rejects(
    vm.runInContext("waitForCreatorTab(71, 5)", context),
    /Timed out waiting for the platform tab/,
  );
  assert.equal(tabUpdatedListeners.size, listenerCountBeforeTimeout);
  openTabs.delete(71);

  openTabs.set(72, {
    id: 72,
    url: "https://www.manyvids.com/upload-video",
    status: "complete",
  });
  const manyVidsEditRoute = vm.runInContext(
    'waitForManyVidsRoute(72, "edit", 100)',
    context,
  );
  setTimeout(() => {
    const tab = openTabs.get(72);
    tab.url = "https://www.manyvids.com/Edit-vid/7783271";
    for (const listener of tabUpdatedListeners) {
      listener(72, { url: tab.url, status: "complete" });
    }
  }, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(await manyVidsEditRoute)), {
    url: "https://www.manyvids.com/Edit-vid/7783271",
    manyvidsId: "7783271",
  });
  openTabs.get(72).url = "https://www.manyvids.com/upload-video";
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        await vm.runInContext(
          'waitForManyVidsRoute(72, "success", 20)',
          context,
        ),
      ),
    ),
    { url: "https://www.manyvids.com/upload-video" },
  );
  openTabs.delete(72);

  navigateAfterProbeFileTo = "https://example.com/escaped";
  const navigatedProbe = await send({
    type: "PROBE_CREATOR_UPLOAD_TARGETS",
    targets: ["onlyfans"],
  });
  assert.equal(
    navigatedProbe.results[0].status,
    "probe-failed",
    "A tab leaving its requested platform during inspection must fail closed.",
  );

  nextProbeFailure = "Injection was blocked.";
  const failedInjection = await send({
    type: "PROBE_CREATOR_UPLOAD_TARGETS",
    targets: ["onlyfans"],
  });
  assert.equal(failedInjection.results[0].status, "probe-failed");
  assert.match(failedInjection.results[0].error, /Injection was blocked/);
  assert.equal(
    vm.runInContext(
      'JSON.stringify(preferredRemoteSources({avatarMode:"mixed",realbooruPercentage:10}, 9))',
      context,
    ),
    '["realbooru","gelbooru"]',
  );
  assert.equal(
    vm.runInContext(
      'JSON.stringify(preferredRemoteSources({avatarMode:"mixed",realbooruPercentage:10}, 10))',
      context,
    ),
    '["gelbooru","realbooru"]',
  );
  assert.equal(
    vm.runInContext(
      'JSON.stringify(preferredRemoteSources({avatarMode:"mixed",realbooruPercentage:90}, 89))',
      context,
    ),
    '["realbooru","gelbooru"]',
  );
  assert.equal(
    vm.runInContext(
      'JSON.stringify(preferredRemoteSources({avatarMode:"mixed",realbooruPercentage:90}, 90))',
      context,
    ),
    '["gelbooru","realbooru"]',
  );

  const batch = await send({
    type: "RESOLVE_IDENTITIES",
    items: [
      {
        primaryKey: "user:1",
        aliases: ["handle:first"],
      },
      {
        primaryKey: "user:2",
        aliases: [],
      },
    ],
  });
  const first = batch.items[0];
  const second = batch.items[1];
  const same = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "handle:first",
    aliases: [],
  });

  assert.equal(
    JSON.stringify(same.identity),
    JSON.stringify(first.identity),
    "Aliases must resolve persistently.",
  );
  assert.notEqual(
    second.identity.handle,
    first.identity.handle,
    "Handles must be unique.",
  );
  assert.notEqual(
    second.identity.avatarId,
    first.identity.avatarId,
    "Generated avatars must remain account-specific.",
  );

  await send({
    type: "SET_SETTINGS",
    patch: {
      avatarMode: "gelbooru",
      gelbooruUserId: "123",
      gelbooruApiKey: "test-key",
    },
  });

  const connection = await send({
    type: "TEST_GELBOORU",
    gelbooruUserId: "123",
    gelbooruApiKey: "test-key",
  });
  assert.equal(connection.test.returnedPosts, 5);
  assert.equal(connection.test.usablePosts, 4);
  assert.equal(connection.test.ratingMode, "any");
  const requestedUrl = new URL(lastFetchUrl);
  assert.equal(
    requestedUrl.searchParams.get("tags"),
    "1girl solo selfie score:>=50",
  );
  assert.equal(requestedUrl.searchParams.get("user_id"), "123");

  const generalConnection = await send({
    type: "TEST_GELBOORU",
    gelbooruUserId: "123",
    gelbooruApiKey: "test-key",
    gelbooruRatingMode: "general",
  });
  assert.equal(generalConnection.test.usablePosts, 2);

  await send({
    type: "SET_SETTINGS",
    patch: {
      avatarMode: "gelbooru",
      gelbooruUserId: "wrong-name",
      gelbooruApiKey: "&api_key=fragment-key&user_id=456",
    },
  });
  const fragmentSettings = await send({ type: "GET_SETTINGS" });
  assert.equal(fragmentSettings.settings.gelbooruUserId, "456");
  assert.equal(fragmentSettings.settings.gelbooruApiKey, "fragment-key");

  await send({
    type: "SET_SETTINGS",
    patch: {
      avatarMode: "gelbooru",
      gelbooruUserId: "123",
      gelbooruApiKey: "test-key",
    },
  });

  await assert.rejects(
    send({
      type: "TEST_GELBOORU",
      gelbooruUserId: "my-username",
      gelbooruApiKey: "test-key",
    }),
    /must be numeric/i,
  );

  const animeOne = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "user:3",
    aliases: [],
  });
  const animeTwo = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "user:4",
    aliases: [],
  });
  const animeSame = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "user:3",
    aliases: [],
  });

  assert.equal(animeOne.identity.avatarKind, "gelbooru");
  assert.equal(animeTwo.identity.avatarKind, "gelbooru");
  assert.match(animeOne.identity.avatarUrl, /^data:image\/jpeg;base64,/);
  assert.match(animeTwo.identity.avatarUrl, /^data:image\/jpeg;base64,/);
  assert.notEqual(
    animeOne.identity.avatarId,
    animeTwo.identity.avatarId,
    "Anime selfies must never be reused across accounts.",
  );
  assert.equal(
    JSON.stringify(animeSame.identity),
    JSON.stringify(animeOne.identity),
    "The same account must keep the same anime selfie.",
  );
  assert.notEqual(
    animeOne.identity.avatarId,
    "1002",
    "Forbidden tags must be rejected.",
  );
  assert.notEqual(
    animeTwo.identity.avatarId,
    "1002",
    "Forbidden tags must be rejected.",
  );

  const rotated = await send({
    type: "ROTATE_AVATAR",
    primaryKey: "user:3",
    aliases: [],
  });
  assert.equal(
    rotated.result.identity.displayName,
    animeOne.identity.displayName,
  );
  assert.equal(rotated.result.identity.handle, animeOne.identity.handle);
  assert.notEqual(rotated.result.identity.avatarId, animeOne.identity.avatarId);
  assert.notEqual(rotated.result.identity.avatarId, animeTwo.identity.avatarId);
  assert.match(rotated.result.identity.avatarUrl, /^data:image\/jpeg;base64,/);

  const { history } = await send({ type: "GET_GELBOORU_HISTORY" });
  assert.equal(history.length, 3);
  assert.equal(new Set(history.map((item) => item.id)).size, history.length);
  assert.equal(
    Object.keys(storage.fimStateV1.usedAvatarFingerprints).length,
    3,
    "Gelbooru MD5 fingerprints must remain unique.",
  );

  await send({
    type: "SET_SETTINGS",
    patch: {
      avatarMode: "realbooru",
    },
  });
  const realConnection = await send({ type: "TEST_REALBOORU" });
  assert.equal(realConnection.test.returnedPosts, 4);
  assert.equal(realConnection.test.usablePosts, 3);
  const realRequestedUrl = new URL(realbooruListingUrls[0]);
  assert.equal(
    realRequestedUrl.searchParams.get("tags"),
    "1girl solo selfie score:>=20",
  );

  const realOne = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "user:6",
    aliases: [],
  });
  assert.equal(realOne.identity.avatarKind, "realbooru");
  assert.match(realOne.identity.avatarUrl, /^data:image\/jpeg;base64,/);
  assert.notEqual(realOne.identity.avatarId, "9004");

  const realRotated = await send({
    type: "ROTATE_AVATAR",
    primaryKey: "user:6",
    aliases: [],
  });
  assert.equal(realRotated.result.identity.avatarKind, "realbooru");
  assert.notEqual(
    realRotated.result.identity.avatarId,
    realOne.identity.avatarId,
  );
  assert.equal(
    storage.fimControlV1?.kind,
    "pictures",
    "A per-account reroll must refresh the same identity in other open tabs.",
  );

  const managementView = await send({ type: "GET_AVATAR_MANAGEMENT_VIEW" });
  const currentReal = managementView.avatarView.current.find(
    (item) => item.primaryKey === "user:6",
  );
  assert.ok(currentReal, "The current masked identity must be manageable.");
  assert.equal(currentReal.displayName, realOne.identity.displayName);
  assert.equal(currentReal.handle, realOne.identity.handle);
  assert.match(currentReal.avatarUrl, /^data:image\/jpeg;base64,/);
  assert.equal(currentReal.avatarKind, "realbooru");
  assert.equal(
    Object.hasOwn(currentReal, "aliases"),
    false,
    "Account aliases must not leak into the options view.",
  );
  assert.equal(
    managementView.avatarView.retired.some(
      (item) =>
        item.source === "realbooru" &&
        item.id === realRotated.result.identity.avatarId,
    ),
    false,
    "A currently assigned picture must not be shown as retired.",
  );
  const retiredReal = managementView.avatarView.retired.find(
    (item) =>
      item.source === "realbooru" && item.id === realOne.identity.avatarId,
  );
  assert.ok(retiredReal, "The previous picture must be shown as retired.");
  assert.match(retiredReal.sourceUrl, /^https:\/\/realbooru\.com\/images\//);

  const remoteHistory = await send({ type: "GET_GELBOORU_HISTORY" });
  assert.equal(remoteHistory.history.length, 5);
  assert.equal(
    remoteHistory.history.filter((item) => item.source === "realbooru").length,
    2,
  );

  await assert.rejects(
    send({
      type: "REENABLE_REMOTE_AVATAR",
      source: "realbooru",
      id: realRotated.result.identity.avatarId,
    }),
    /currently assigned/i,
  );
  const retiredRecord = storage.fimStateV1.gelbooruHistory.find(
    (item) =>
      item.source === "realbooru" && item.id === realOne.identity.avatarId,
  );
  await send({
    type: "REENABLE_REMOTE_AVATAR",
    source: "realbooru",
    id: realOne.identity.avatarId,
  });
  assert.equal(
    storage.fimStateV1.gelbooruHistory.some(
      (item) =>
        item.source === "realbooru" && item.id === realOne.identity.avatarId,
    ),
    false,
  );
  assert.equal(
    storage.fimStateV1.usedRealbooruIds[realOne.identity.avatarId],
    undefined,
  );
  assert.equal(
    storage.fimStateV1.usedAvatarUrls[retiredRecord.sourceUrl],
    undefined,
  );
  assert.equal(
    storage.fimStateV1.usedAvatarFingerprints[retiredRecord.fingerprint],
    undefined,
  );
  assert.equal(
    storage.fimStateV1.usedRealbooruIds[realRotated.result.identity.avatarId],
    true,
  );

  const sharedUrl = "https://img.example/shared.jpg";
  const sharedFingerprint = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  Object.assign(storage.fimStateV1.usedAvatarIds, {
    "shared-a": true,
    "shared-b": true,
  });
  storage.fimStateV1.usedAvatarUrls[sharedUrl] = true;
  storage.fimStateV1.usedAvatarFingerprints[sharedFingerprint] = true;
  storage.fimStateV1.gelbooruHistory.push(
    {
      source: "gelbooru",
      id: "shared-a",
      sourceUrl: sharedUrl,
      fingerprint: sharedFingerprint,
    },
    {
      source: "gelbooru",
      id: "shared-b",
      sourceUrl: sharedUrl,
      fingerprint: sharedFingerprint,
    },
  );
  await send({
    type: "REENABLE_REMOTE_AVATAR",
    source: "gelbooru",
    id: "shared-a",
  });
  assert.equal(storage.fimStateV1.usedAvatarIds["shared-a"], undefined);
  assert.equal(storage.fimStateV1.usedAvatarIds["shared-b"], true);
  assert.equal(storage.fimStateV1.usedAvatarUrls[sharedUrl], true);
  assert.equal(
    storage.fimStateV1.usedAvatarFingerprints[sharedFingerprint],
    true,
  );
  await send({
    type: "REENABLE_REMOTE_AVATAR",
    source: "gelbooru",
    id: "shared-b",
  });

  await send({
    type: "ADD_CUSTOM_AVATARS",
    avatars: [
      {
        id: "custom-1",
        detection: "smart",
        url: "data:image/webp;base64,AAAA",
      },
    ],
  });
  await send({
    type: "SET_SETTINGS",
    patch: {
      avatarMode: "custom",
    },
  });
  const custom = await send({
    type: "RESOLVE_IDENTITY",
    primaryKey: "user:5",
    aliases: [],
  });
  assert.equal(custom.identity.avatarKind, "custom");
  assert.equal(custom.identity.avatarId, "custom-1");

  const { stats } = await send({ type: "GET_STATS" });
  assert.equal(stats.mappedAccounts, 6);
  assert.equal(stats.usedAnimeSelfies, 3);
  assert.equal(stats.usedRealSelfies, 1);
  assert.equal(stats.usedRemoteSelfies, 4);
  assert.equal(stats.importedAvatars, 1);
  assert.equal(stats.usedImportedAvatars, 1);

  const beforeDimensionResets = structuredClone(storage.fimStateV1);
  const resetNameResult = await send({ type: "RESET_NAMES" });
  assert.equal(resetNameResult.resetAccounts, 6);
  const afterNameReset = structuredClone(storage.fimStateV1);
  assert.equal(storage.fimControlV1.kind, "names");
  assert.deepEqual(
    Object.keys(afterNameReset.identities),
    Object.keys(beforeDimensionResets.identities),
  );
  for (const key of Object.keys(beforeDimensionResets.identities)) {
    const before = beforeDimensionResets.identities[key];
    const after = afterNameReset.identities[key];
    assert.notEqual(after.displayName, before.displayName);
    assert.notEqual(after.handle, before.handle);
    assert.equal(after.avatarId, before.avatarId);
    assert.equal(after.avatarUrl, before.avatarUrl);
  }
  assert.deepEqual(
    afterNameReset.gelbooruHistory,
    beforeDimensionResets.gelbooruHistory,
  );

  const resetPictureResult = await send({ type: "RESET_PICTURES" });
  assert.equal(resetPictureResult.resetAccounts, 6);
  const afterPictureReset = structuredClone(storage.fimStateV1);
  assert.equal(storage.fimControlV1.kind, "pictures");
  for (const key of Object.keys(afterNameReset.identities)) {
    const before = afterNameReset.identities[key];
    const after = afterPictureReset.identities[key];
    assert.equal(after.displayName, before.displayName);
    assert.equal(after.handle, before.handle);
    assert.notEqual(after.avatarId, before.avatarId);
    assert.equal(after.avatarKind, "pending");
  }
  assert.deepEqual(
    afterPictureReset.gelbooruHistory,
    beforeDimensionResets.gelbooruHistory,
  );
  assert.deepEqual(
    afterPictureReset.usedAvatarIds,
    beforeDimensionResets.usedAvatarIds,
  );
  assert.deepEqual(
    afterPictureReset.usedRealbooruIds,
    beforeDimensionResets.usedRealbooruIds,
  );
  assert.deepEqual(
    afterPictureReset.usedAvatarFingerprints,
    beforeDimensionResets.usedAvatarFingerprints,
  );

  await send({ type: "RESET_MAPPINGS" });
  const historyAfterReset = await send({ type: "GET_GELBOORU_HISTORY" });
  assert.equal(
    historyAfterReset.history.length,
    4,
    "Resetting identity mappings must not allow old remote pictures to be reused.",
  );

  console.log("PASS: persistent aliases and unique avatar assignments");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
