importScripts(
  "workflows/registry.js",
  "workflows/local-file-attacher.js",
  "workflows/desktop-upload-runtime.js",
  "workflows/extension-lifecycle.js",
  "workflows/catalogue-contract.js",
  "workflows/catalogue-client.js",
  "workflows/subreddit-presets.js",
  "workflows/upload-session-store.js",
  "workflows/social-distribution-contract.js",
  "workflows/social-distribution-session-store.js",
  "workflows/social-distribution-orchestrator.js",
  "workflows/social-chrome-runtime.js",
  "workflows/x-teaser-contract.js",
  "workflows/x-teaser-session-store.js",
  "workflows/x-teaser-reconcile.js",
  "workflows/x-teaser-tab-binding.js",
);

("use strict");

const SETTINGS_KEY = "fimSettingsV1";
const STATE_KEY = "fimStateV1";
const CONTROL_KEY = "fimControlV1";
const AVATAR_CACHE_SIZE = 96;
const GELBOORU_QUERY_TAGS = "1girl solo selfie score:>=50";
const GELBOORU_PAGE_SIZE = 100;
const GELBOORU_REQUIRED_POST_TAGS = ["selfie", "1girl", "solo"];
const REALBOORU_QUERY_TAGS = "1girl solo selfie score:>=20";
const REALBOORU_BATCH_SIZE = 12;
const REALBOORU_PAGE_SIZE = 42;
const REALBOORU_ORIGIN = "https://realbooru.com";
const REALBOORU_PARSER_PATH = "realbooru-parser.html";
const REALBOORU_MAX_HTML_LENGTH = 2_000_000;
const CREATOR_REGISTRY = globalThis.CreatorToolkitRegistry;
const CREATOR_CATALOGUE_CLIENT = globalThis.CreatorCatalogueClient;
const CREATOR_CATALOGUE_CONTRACT = globalThis.CreatorCatalogueContract;
const CREATOR_UPLOAD_SESSION_STORE = globalThis.CreatorUploadSessionStore;
const CREATOR_SOCIAL_CONTRACT = globalThis.CreatorSocialDistributionContract;
const CREATOR_SOCIAL_SESSION_STORE =
  globalThis.CreatorSocialDistributionSessionStore;
const CREATOR_SOCIAL_ORCHESTRATOR =
  globalThis.CreatorSocialDistributionOrchestrator;
const X_TEASER_CONTRACT = globalThis.CreatorXTeaserContract;
const X_TEASER_SESSION_STORE = globalThis.CreatorXTeaserSessionStore;
const X_TEASER_BINDING_KEY = "creatorXTeaserChromeBindingV1";
const X_TEASER_NATIVE_HOST = "com.johnnyguides.creator_x_teaser";
const DESKTOP_NATIVE_HOST = "com.johnnyguides.ofenhancer";
const extensionLifecycle = globalThis.CreatorExtensionLifecycle?.create({
  chrome,
});
const DESKTOP_CAPABILITIES = [
  "desktop-shell",
  "local-file-attach",
  "native-bridge",
];

function getDesktopStatus() {
  const request = {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    operation: "getStatus",
  };
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(
      DESKTOP_NATIVE_HOST,
      request,
      (response) => {
        if (chrome.runtime.lastError)
          return reject(new Error("desktop-unavailable"));
        const status = response?.status;
        if (
          !response?.ok ||
          response.requestId !== request.requestId ||
          status?.protocolVersion !== 1 ||
          !/^\d+\.\d+\.\d+$/.test(status?.productVersion || "") ||
          !Array.isArray(status?.capabilities) ||
          status.capabilities.length !== DESKTOP_CAPABILITIES.length ||
          status.capabilities.some(
            (capability, index) => capability !== DESKTOP_CAPABILITIES[index],
          )
        ) {
          return reject(new Error("desktop-invalid-response"));
        }
        resolve({
          productVersion: status.productVersion,
          protocolVersion: status.protocolVersion,
          capabilities: [...status.capabilities],
        });
      },
    );
  });
}

async function routeOFEnhancerAppRequest(operation, payload = {}) {
  if (operation === "getStatus") return getDesktopStatus();
  if (operation === "openChromeUploader") {
    await openUploadConsole();
    return { opened: true };
  }
  if (
    new Set([
      "getCatalogue",
      "getUploadCatalogueSnapshot",
      "getUploadThumbnailOptions",
      "getUploadThumbnailPreview",
      "getCatalogueThumbnailPreviews",
      "recordUploadResult",
      "writeUploadCatalogueEntry",
      "getSubredditPresets",
    ]).has(operation)
  )
    return sendDesktopRequest(operation, payload);
  throw new Error("unsupported-operation");
}

async function sendDesktopRequest(operation, payload = {}) {
  const installation = await extensionLifecycle?.getInstallation();
  const request = {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    operation,
    payload: {
      ...payload,
      extensionVersion: chrome.runtime.getManifest().version,
      installation: installation || null,
    },
  };
  return new Promise((resolve, reject) =>
    chrome.runtime.sendNativeMessage(
      DESKTOP_NATIVE_HOST,
      request,
      (response) => {
        if (
          chrome.runtime.lastError ||
          !response?.ok ||
          response.requestId !== request.requestId
        )
          return reject(
            new Error(
              response?.error?.code ||
                "Open OFEnhancer on this PC to connect your catalogue.",
            ),
          );
        resolve(response.result);
      },
    ),
  );
}

function sendXTeaserNative(request) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(
      X_TEASER_NATIVE_HOST,
      request,
      (response) => {
        if (chrome.runtime.lastError)
          return reject(new Error(chrome.runtime.lastError.message));
        if (!response?.ok)
          return reject(
            new Error(
              response?.error ||
                "The X teaser native host rejected the request.",
            ),
          );
        resolve(response);
      },
    );
  });
}

async function reconcileXTeaser(sessionId, frames) {
  return globalThis.CreatorXTeaserReconcile.run({
    sessionId,
    frames,
    store: X_TEASER_SESSION_STORE,
    nativeSend: sendXTeaserNative,
    catalogueClient: CREATOR_CATALOGUE_CLIENT,
  });
}

async function openXTeaserRecorder() {
  const url = chrome.runtime.getURL("x-teaser.html");
  const existing = await chrome.tabs.query({ url });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    return existing[0].id;
  }
  return (await chrome.tabs.create({ url, active: true })).id;
}

async function pairXTeaser(pairing, recorderTabId) {
  const unfinished = (await X_TEASER_SESSION_STORE.list()).find(
    (session) => session.stage !== "moved",
  );
  if (unfinished)
    throw new Error(
      "Finish or recover the existing X teaser session before pairing another file.",
    );
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  const reconciliationSource =
    await CREATOR_CATALOGUE_CLIENT.getReconciliationSource();
  await X_TEASER_SESSION_STORE.save({
    id,
    stage: "paired",
    reconciliationSource,
    pairing: X_TEASER_CONTRACT.freezePairing(pairing?.file, pairing?.catalogue),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const xTabs = await chrome.tabs.query({ url: "https://x.com/*" });
  const xTab =
    xTabs.find((tab) => tab.active) ||
    xTabs[0] ||
    (await chrome.tabs.create({
      url: "https://x.com/compose/post",
      active: true,
    }));
  await chrome.storage.local.set({
    [X_TEASER_BINDING_KEY]: { id, xTabId: xTab.id, recorderTabId },
  });
  return { id, xTabId: xTab.id };
}

const xTeaserCaptureInFlight = new Map();

async function captureBoundXStatusOnce(details) {
  if (
    details.frameId !== 0 ||
    !X_TEASER_CONTRACT.canonicalStatusUrl(details.url)
  )
    return;
  const stored = await chrome.storage.local.get(X_TEASER_BINDING_KEY);
  const binding = stored[X_TEASER_BINDING_KEY];
  if (!binding || binding.xTabId !== details.tabId) return;
  const existingSession = await X_TEASER_SESSION_STORE.load(binding.id);
  if (existingSession?.capture) return;
  await chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    files: ["workflows/x-teaser-observer.js"],
  });
  let capture;
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      func: () =>
        globalThis.CreatorXTeaserObserver.capture(document, location.href),
    });
    try {
      capture = X_TEASER_CONTRACT.validateCapture(execution?.result);
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!capture)
    throw lastError || new Error("X status capture remained incomplete.");
  await X_TEASER_SESSION_STORE.save({
    id: binding.id,
    stage: "status-captured",
    capture,
    updatedAt: Date.now(),
  });
  if (binding.recorderTabId) {
    await chrome.runtime
      .sendMessage({
        type: "X_TEASER_CAPTURED",
        id: binding.id,
        capture,
      })
      .catch(() => {});
  }
}

function captureBoundXStatus(details) {
  const key = Number(details.tabId);
  if (xTeaserCaptureInFlight.has(key)) return xTeaserCaptureInFlight.get(key);
  const operation = captureBoundXStatusOnce(details).finally(() => {
    if (xTeaserCaptureInFlight.get(key) === operation)
      xTeaserCaptureInFlight.delete(key);
  });
  xTeaserCaptureInFlight.set(key, operation);
  return operation;
}

const xTeaserNavigationFilter = {
  url: [{ hostEquals: "x.com", pathContains: "/status/" }],
};
function onXTeaserNavigation(details) {
  captureBoundXStatus(details).catch((error) =>
    console.error("X teaser capture failed.", error),
  );
}

async function rebindXTeaserObservation(recorderTabId) {
  const sessions = await X_TEASER_SESSION_STORE.list();
  const paired = [...sessions]
    .reverse()
    .find((session) => session.stage === "paired" && !session.capture);
  if (!paired) return null;
  const stored = await chrome.storage.local.get(X_TEASER_BINDING_KEY);
  const previous = stored[X_TEASER_BINDING_KEY];
  let xTab = null;
  if (previous?.id === paired.id && previous.xTabId) {
    try {
      xTab = await chrome.tabs.get(previous.xTabId);
    } catch {
      xTab = null;
    }
  }
  if (!xTab) {
    const xTabs = await chrome.tabs.query({ url: "https://x.com/*" });
    const decision = globalThis.CreatorXTeaserTabBinding.choose(
      xTabs,
      X_TEASER_CONTRACT.canonicalStatusUrl,
    );
    if (decision.action === "ambiguous")
      return { action: "ambiguous", id: paired.id };
    if (decision.action === "confirm-status")
      return { ...decision, id: paired.id };
    xTab =
      decision.action === "bind"
        ? xTabs[0]
        : await chrome.tabs.create({
            url: "https://x.com/compose/post",
            active: true,
          });
  }
  await chrome.storage.local.set({
    [X_TEASER_BINDING_KEY]: { id: paired.id, xTabId: xTab.id, recorderTabId },
  });
  if (X_TEASER_CONTRACT.canonicalStatusUrl(xTab.url)) {
    await captureBoundXStatus({ frameId: 0, tabId: xTab.id, url: xTab.url });
  }
  return { id: paired.id, xTabId: xTab.id };
}

async function confirmXTeaserRebind(message, recorderTabId) {
  const session = await X_TEASER_SESSION_STORE.load(message.id);
  if (!session || session.stage !== "paired" || session.capture)
    throw new Error(
      "The paired X teaser session is no longer awaiting capture.",
    );
  const tab = await chrome.tabs.get(Number(message.tabId));
  const statusUrl = X_TEASER_CONTRACT.canonicalStatusUrl(tab?.url);
  if (!statusUrl || statusUrl !== message.statusUrl)
    throw new Error("The proposed X status tab changed; nothing was captured.");
  await chrome.storage.local.set({
    [X_TEASER_BINDING_KEY]: { id: session.id, xTabId: tab.id, recorderTabId },
  });
  await captureBoundXStatus({ frameId: 0, tabId: tab.id, url: statusUrl });
  return {
    id: session.id,
    xTabId: tab.id,
    statusUrl,
    session: await X_TEASER_SESSION_STORE.load(session.id),
  };
}
chrome.webNavigation.onCompleted?.addListener?.(
  onXTeaserNavigation,
  xTeaserNavigationFilter,
);
chrome.webNavigation.onHistoryStateUpdated?.addListener?.(
  onXTeaserNavigation,
  xTeaserNavigationFilter,
);
const GELBOORU_FORBIDDEN_TAG_PARTS = /(^|_)(trans)(_|$)/i;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  ownHandles: ["johnny_guides"],
  avatarMode: "generated",
  gelbooruRatingMode: "any",
  gelbooruUserId: "",
  gelbooruApiKey: "",
  realbooruPercentage: 50,
});

const FIRST_NAMES = [
  "Ada",
  "Adaline",
  "Adelaide",
  "Adriana",
  "Aiko",
  "Alana",
  "Alba",
  "Alexandra",
  "Alice",
  "Alina",
  "Allegra",
  "Amalia",
  "Amara",
  "Amaya",
  "Amelie",
  "Anais",
  "Anastasia",
  "Anika",
  "Annabel",
  "Annika",
  "Antonia",
  "Arabella",
  "Araceli",
  "Aria",
  "Ariana",
  "Arielle",
  "Astrid",
  "Athena",
  "Audrey",
  "Aurora",
  "Ava",
  "Aviva",
  "Aya",
  "Beatrice",
  "Bianca",
  "Billie",
  "Blair",
  "Blythe",
  "Bria",
  "Briar",
  "Bridget",
  "Calla",
  "Callie",
  "Calista",
  "Camille",
  "Carina",
  "Carmen",
  "Caroline",
  "Cassandra",
  "Cecilia",
  "Celeste",
  "Celine",
  "Charlotte",
  "Chloe",
  "Chiara",
  "Clara",
  "Cleo",
  "Colette",
  "Coral",
  "Cordelia",
  "Corinne",
  "Dahlia",
  "Daphne",
  "Delia",
  "Diana",
  "Eden",
  "Edith",
  "Elara",
  "Eleanor",
  "Elena",
  "Elise",
  "Eliza",
  "Elizabeth",
  "Ella",
  "Eloise",
  "Elodie",
  "Elsie",
  "Emilia",
  "Emily",
  "Emma",
  "Emmeline",
  "Esme",
  "Estelle",
  "Eugenia",
  "Eva",
  "Evangeline",
  "Evelina",
  "Evelyn",
  "Faye",
  "Felicity",
  "Fern",
  "Flora",
  "Florence",
  "Frances",
  "Francesca",
  "Freya",
  "Gabriella",
  "Gaia",
  "Gemma",
  "Genevieve",
  "Georgia",
  "Giselle",
  "Gloria",
  "Grace",
  "Greta",
  "Gwen",
  "Hana",
  "Harlow",
  "Hazel",
  "Helena",
  "Ilaria",
  "Imogen",
  "Indigo",
  "Ines",
  "Iris",
  "Isabel",
  "Isla",
  "Ivy",
  "Jane",
  "Jasmine",
  "Joanna",
  "Josephine",
  "Josette",
  "Julia",
  "Juliet",
  "Juniper",
  "Kaia",
  "Kaori",
  "Karina",
  "Katherine",
  "Keira",
  "Kira",
  "Lana",
  "Laurel",
  "Layla",
  "Leilani",
  "Lena",
  "Lenore",
  "Leona",
  "Leora",
  "Lila",
  "Liliana",
  "Lily",
  "Linnea",
  "Lorelei",
  "Lorraine",
  "Louisa",
  "Lucia",
  "Lucy",
  "Luna",
  "Lydia",
  "Lyla",
  "Lyra",
  "Mae",
  "Magnolia",
  "Maia",
  "Malia",
  "Margot",
  "Mariana",
  "Marina",
  "Maren",
  "Marigold",
  "Marisol",
  "Matilda",
  "Maya",
  "Meadow",
  "Mei",
  "Melina",
  "Melody",
  "Meredith",
  "Mila",
  "Mira",
  "Miriam",
  "Morgan",
  "Nadia",
  "Nadine",
  "Naomi",
  "Nell",
  "Nina",
  "Noelle",
  "Nora",
  "Nova",
  "Octavia",
  "Odessa",
  "Olive",
  "Olivia",
  "Oona",
  "Opal",
  "Paloma",
  "Pandora",
  "Penelope",
  "Phoebe",
  "Poppy",
  "Ramona",
  "Rebecca",
  "Rei",
  "Rhea",
  "Rina",
  "Rosalie",
  "Rosalind",
  "Rose",
  "Rowan",
  "Rowena",
  "Ruby",
  "Sabine",
  "Sage",
  "Sakura",
  "Selene",
  "Serena",
  "Sienna",
  "Simone",
  "Sloane",
  "Sofia",
  "Sora",
  "Stella",
  "Susannah",
  "Sylvie",
  "Talia",
  "Tessa",
  "Thea",
  "Valentina",
  "Valerie",
  "Vera",
  "Veronica",
  "Victoria",
  "Violet",
  "Vivian",
  "Viviana",
  "Willa",
  "Willow",
  "Winona",
  "Yara",
  "Yuna",
  "Yuki",
  "Zara",
  "Zelie",
  "Zinnia",
  "Zoe",
];

const NICKNAMES = [
  "angel",
  "babe",
  "baby",
  "bee",
  "belle",
  "bloom",
  "bunny",
  "cherry",
  "cloud",
  "daisy",
  "doll",
  "dream",
  "fairy",
  "glow",
  "honey",
  "kitty",
  "lilac",
  "love",
  "moon",
  "nova",
  "peach",
  "petal",
  "rose",
  "softie",
  "spark",
  "star",
  "sunny",
  "velvet",
];

const HANDLE_SUFFIXES = [
  "archive",
  "diary",
  "dreams",
  "files",
  "garden",
  "jpg",
  "online",
  "room",
  "verse",
  "world",
  "xo",
];

let stateQueue = Promise.resolve();

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomInt(maximum) {
  if (!Number.isInteger(maximum) || maximum <= 1) return 0;
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    const range = 0x100000000;
    const unbiasedLimit = range - (range % maximum);
    do {
      globalThis.crypto.getRandomValues(values);
    } while (values[0] >= unbiasedLimit);
    return values[0] % maximum;
  }
  return Math.floor(Math.random() * maximum);
}

function hueFor(value, offset = 0) {
  return (hashString(value) + offset) % 360;
}

function generatedAvatar(key, displayName) {
  const firstHue = hueFor(key);
  const secondHue = hueFor(key, 68);
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">',
    "<defs>",
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${firstHue} 78% 67%)"/><stop offset="1" stop-color="hsl(${secondHue} 76% 48%)"/></linearGradient>`,
    "</defs>",
    '<rect width="160" height="160" rx="80" fill="url(#g)"/>',
    '<circle cx="126" cy="32" r="18" fill="rgba(255,255,255,.18)"/>',
    `<text x="80" y="96" text-anchor="middle" fill="white" font-family="system-ui,sans-serif" font-size="48" font-weight="700">${initials}</text>`,
    "</svg>",
  ].join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function normalizeSettings(value = {}) {
  const safeValue = { ...value };
  delete safeValue.realbooruEndpoint;
  const ownHandles = Array.isArray(value.ownHandles)
    ? value.ownHandles
    : String(value.ownHandle || DEFAULT_SETTINGS.ownHandles[0]).split(",");
  let gelbooruUserId = String(value.gelbooruUserId || "").trim();
  let gelbooruApiKey = String(value.gelbooruApiKey || "").trim();
  const realbooruPercentage = Math.min(
    100,
    Math.max(
      0,
      Number.isFinite(Number(value.realbooruPercentage))
        ? Math.round(Number(value.realbooruPercentage))
        : DEFAULT_SETTINGS.realbooruPercentage,
    ),
  );

  if (/(?:^|[?&])api_key=/i.test(gelbooruApiKey)) {
    const fragment = gelbooruApiKey.replace(/^[?&]/, "");
    const params = new URLSearchParams(fragment);
    gelbooruApiKey = (params.get("api_key") || "").trim();
    gelbooruUserId = (params.get("user_id") || gelbooruUserId).trim();
  }

  return {
    ...DEFAULT_SETTINGS,
    ...safeValue,
    ownHandles: ownHandles
      .map((handle) => String(handle).trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
    avatarMode: ["gelbooru", "realbooru", "mixed", "custom"].includes(
      value.avatarMode,
    )
      ? value.avatarMode
      : "generated",
    gelbooruRatingMode:
      value.gelbooruRatingMode === "general" ? "general" : "any",
    gelbooruUserId,
    gelbooruApiKey,
    realbooruPercentage,
  };
}

function normalizeState(value = {}) {
  const identities = value.identities || {};
  const usedAvatarIds = value.usedAvatarIds || {};
  const usedRealbooruIds = value.usedRealbooruIds || {};
  const usedAvatarUrls = value.usedAvatarUrls || {};
  const usedAvatarFingerprints = value.usedAvatarFingerprints || {};
  const gelbooruHistory = Array.isArray(value.gelbooruHistory)
    ? value.gelbooruHistory.slice(-1000)
    : [];
  for (const item of gelbooruHistory) {
    if (!item.source) item.source = "gelbooru";
    if (item?.sourceUrl) usedAvatarUrls[item.sourceUrl] = true;
    if (item?.fingerprint) {
      usedAvatarFingerprints[item.fingerprint] = true;
    }
  }
  const recordedIds = new Set(gelbooruHistory.map((item) => String(item.id)));
  for (const id of Object.keys(usedAvatarIds)) {
    if (recordedIds.has(String(id))) continue;
    const identity = Object.values(identities).find(
      (item) => String(item.avatarId) === String(id),
    );
    if (identity?.avatarSourceUrl)
      usedAvatarUrls[identity.avatarSourceUrl] = true;
    if (identity?.avatarFingerprint) {
      usedAvatarFingerprints[identity.avatarFingerprint] = true;
    }
    gelbooruHistory.push({
      id: String(id),
      postUrl: identity?.avatarPostUrl || "",
      sourceUrl: identity?.avatarSourceUrl || "",
      fingerprint: identity?.avatarFingerprint || "",
      action: "previously-used",
      usedAt: 0,
    });
  }

  return {
    version: 3,
    identities,
    aliasToPrimary: value.aliasToPrimary || {},
    usedHandles: value.usedHandles || {},
    usedAvatarIds,
    usedRealbooruIds,
    usedAvatarUrls,
    usedAvatarFingerprints,
    gelbooruHistory: gelbooruHistory.slice(-1000),
    customAvatars: value.customAvatars || {},
    usedCustomAvatarIds: value.usedCustomAvatarIds || {},
    gelbooruPool: Array.isArray(value.gelbooruPool) ? value.gelbooruPool : [],
    realbooruPool: Array.isArray(value.realbooruPool)
      ? value.realbooruPool
      : [],
    gelbooruPageCount:
      Number.isInteger(value.gelbooruPageCount) && value.gelbooruPageCount > 0
        ? value.gelbooruPageCount
        : 0,
    gelbooruRecentPages: Array.isArray(value.gelbooruRecentPages)
      ? value.gelbooruRecentPages.filter(Number.isInteger).slice(-20)
      : [],
    nameResetGeneration: Number.isInteger(value.nameResetGeneration)
      ? value.nameResetGeneration
      : 0,
    pictureResetGeneration: Number.isInteger(value.pictureResetGeneration)
      ? value.pictureResetGeneration
      : 0,
    lastAvatarError: value.lastAvatarError || "",
  };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return normalizeState(stored[STATE_KEY]);
}

function handleSlug(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

function uniqueHandle(base, state, key) {
  const normalizedBase = handleSlug(base) || "girl";
  let candidate = normalizedBase;
  let counter = 2;

  while (state.usedHandles[candidate] && state.usedHandles[candidate] !== key) {
    const suffix = 1 + (hashString(`${key}:${counter}`) % 99);
    candidate = `${normalizedBase}${suffix}`;
    counter += 1;
  }

  state.usedHandles[candidate] = key;
  return candidate;
}

function createName(key, state, ownerKey = key) {
  const hash = hashString(key);
  const first = FIRST_NAMES[hash % FIRST_NAMES.length];
  const firstHandle = handleSlug(first);
  const nickname = NICKNAMES[(hash >>> 8) % NICKNAMES.length];
  const suffix = HANDLE_SUFFIXES[(hash >>> 16) % HANDLE_SUFFIXES.length];
  const compactNumber = 10 + ((hash >>> 20) % 90);

  const displayModes = [
    first,
    first,
    first,
    first.toLowerCase(),
    `${first} ♡`,
    `${first} xo`,
    `its ${first.toLowerCase()}`,
    `${first.toLowerCase()}.jpg`,
    nickname,
  ];
  const handleBases = [
    firstHandle,
    `its${firstHandle}`,
    `hey${firstHandle}`,
    `${firstHandle}xo`,
    `${firstHandle}_${suffix}`,
    `${nickname}${firstHandle}`,
    `${firstHandle}${nickname}`,
    `${firstHandle}${compactNumber}`,
    `x${firstHandle}x`,
  ];

  return {
    displayName: displayModes[(hash >>> 4) % displayModes.length],
    handle: uniqueHandle(
      handleBases[(hash >>> 12) % handleBases.length],
      state,
      ownerKey,
    ),
  };
}

function parseGelbooruResponse(payload, ratingMode = "any") {
  const posts = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.post)
      ? payload.post
      : [];

  return posts
    .filter(
      (post) =>
        ratingMode === "any" ||
        ["general", "safe"].includes(String(post.rating).toLowerCase()),
    )
    .filter((post) => {
      const tags = String(post.tags || "")
        .split(/\s+/)
        .map((tag) => tag.toLowerCase())
        .filter(Boolean);
      const tagSet = new Set(tags);
      return (
        GELBOORU_REQUIRED_POST_TAGS.every((tag) => tagSet.has(tag)) &&
        !tags.some((tag) => GELBOORU_FORBIDDEN_TAG_PARTS.test(tag))
      );
    })
    .map((post) => ({
      source: "gelbooru",
      id: String(post.id),
      url: post.preview_url || post.sample_url || post.file_url || "",
      fingerprint: /^[a-f0-9]{32}$/i.test(String(post.md5 || ""))
        ? String(post.md5).toLowerCase()
        : "",
      postUrl: `https://gelbooru.com/index.php?page=post&s=view&id=${post.id}`,
    }))
    .filter((post) => post.id && /^https:\/\//i.test(post.url));
}

function normalizeBooruTags(value) {
  const rawTags = Array.isArray(value) ? value : String(value || "").split(",");
  return rawTags
    .flatMap((tag) => String(tag).split(/\s*,\s*/))
    .map((tag) =>
      tag
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_"),
    )
    .filter(Boolean);
}

function hasEligibleRealbooruTags(value) {
  const tags = normalizeBooruTags(value);
  const tagSet = new Set(tags);
  const femaleEvidence = [
    "1girl",
    "female",
    "female_only",
    "female_solo",
    "solo_female",
  ].some((tag) => tagSet.has(tag));
  return (
    tagSet.has("selfie") &&
    tagSet.has("solo") &&
    femaleEvidence &&
    !tags.some((tag) => GELBOORU_FORBIDDEN_TAG_PARTS.test(tag))
  );
}

function parseRealbooruResponse(payload) {
  const posts = Array.isArray(payload?.posts) ? payload.posts : [];
  return posts
    .filter((post) => hasEligibleRealbooruTags(post.tags))
    .map((post) => ({
      source: "realbooru",
      id: String(post.id || ""),
      url: String(post.url || ""),
      fingerprint: /^[a-f0-9]{32}$/i.test(String(post.fingerprint || ""))
        ? String(post.fingerprint).toLowerCase()
        : "",
      postUrl: String(post.postUrl || ""),
    }))
    .filter(
      (post) =>
        post.id &&
        /^https:\/\/realbooru\.com\//i.test(post.url) &&
        /^https:\/\/realbooru\.com\//i.test(post.postUrl),
    );
}

async function hasGelbooruPermission() {
  return chrome.permissions.contains({
    origins: ["https://gelbooru.com/*", "https://*.gelbooru.com/*"],
  });
}

async function hasRealbooruPermission() {
  return chrome.permissions.contains({
    origins: ["https://realbooru.com/*"],
  });
}

let realbooruOffscreenCreating = null;
let realbooruScrapeQueue = Promise.resolve();

async function hasRealbooruParser() {
  const parserUrl = chrome.runtime.getURL(REALBOORU_PARSER_PATH);
  if (typeof chrome.runtime.getContexts === "function") {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [parserUrl],
    });
    return contexts.length > 0;
  }
  const contexts = await globalThis.clients?.matchAll();
  return Array.isArray(contexts)
    ? contexts.some((client) => client.url === parserUrl)
    : false;
}

async function ensureRealbooruParser() {
  if (await hasRealbooruParser()) return;
  if (!realbooruOffscreenCreating) {
    realbooruOffscreenCreating = chrome.offscreen
      .createDocument({
        url: REALBOORU_PARSER_PATH,
        reasons: ["DOM_PARSER"],
        justification:
          "Parse inert Realbooru listing and post HTML fetched by the extension.",
      })
      .finally(() => {
        realbooruOffscreenCreating = null;
      });
  }
  await realbooruOffscreenCreating;
}

async function closeRealbooruParser() {
  try {
    if (await hasRealbooruParser()) await chrome.offscreen.closeDocument();
  } catch (error) {
    console.warn("Could not close the Realbooru parser document.", error);
  }
}

async function parseRealbooruHtml(kind, html, expectedId = "") {
  await ensureRealbooruParser();
  const response = await chrome.runtime.sendMessage({
    target: "realbooru-offscreen-parser",
    kind,
    html,
    expectedId,
  });
  if (response?.ok !== true) {
    throw new Error(
      `Bundled Realbooru parser failed: ${cleanGelbooruReason(response?.error)}`,
    );
  }
  return response.result;
}

function realbooruListingUrl(pid = 0) {
  const query = new URLSearchParams({
    page: "post",
    s: "list",
    tags: REALBOORU_QUERY_TAGS,
  });
  if (pid > 0) query.set("pid", String(pid));
  return `${REALBOORU_ORIGIN}/index.php?${query}`;
}

async function fetchRealbooruHtml(url) {
  const target = new URL(url);
  if (target.origin !== REALBOORU_ORIGIN || target.pathname !== "/index.php") {
    throw new Error("Refused an unexpected Realbooru request URL.");
  }
  let response;
  try {
    const signal = globalThis.AbortSignal?.timeout?.(20000);
    response = await fetch(target.href, {
      credentials: "omit",
      headers: { Accept: "text/html" },
      redirect: "follow",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new Error(`Could not reach Realbooru: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`Realbooru returned HTTP ${response.status}.`);
  }
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (
      finalUrl.origin !== target.origin ||
      finalUrl.pathname !== target.pathname ||
      finalUrl.searchParams.get("page") !== target.searchParams.get("page") ||
      finalUrl.searchParams.get("s") !== target.searchParams.get("s") ||
      (target.searchParams.get("s") === "view" &&
        finalUrl.searchParams.get("id") !== target.searchParams.get("id"))
    ) {
      throw new Error("Realbooru redirected to an unexpected page.");
    }
  }
  const contentType = response.headers?.get("content-type") || "";
  if (!/\btext\/html\b/i.test(contentType)) {
    throw new Error(
      `Realbooru returned unexpected content type ${contentType}.`,
    );
  }
  const html = await response.text();
  if (!html || html.length > REALBOORU_MAX_HTML_LENGTH) {
    throw new Error("Realbooru returned empty or oversized HTML.");
  }
  return html;
}

async function scrapeRealbooruPosts(count) {
  const firstListing = await parseRealbooruHtml(
    "listing",
    await fetchRealbooruHtml(realbooruListingUrl()),
  );
  const pageCount =
    Math.floor(
      Math.max(0, Number(firstListing.maxPid) || 0) / REALBOORU_PAGE_SIZE,
    ) + 1;
  const selectedPid = randomInt(pageCount) * REALBOORU_PAGE_SIZE;
  const listing =
    selectedPid > 0
      ? await parseRealbooruHtml(
          "listing",
          await fetchRealbooruHtml(realbooruListingUrl(selectedPid)),
        )
      : firstListing;
  const candidates = Array.isArray(listing.posts) ? listing.posts : [];
  const eligible = candidates.filter((post) =>
    hasEligibleRealbooruTags(post.tags),
  );
  for (let index = eligible.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [eligible[index], eligible[swapIndex]] = [
      eligible[swapIndex],
      eligible[index],
    ];
  }

  const posts = [];
  for (const candidate of eligible) {
    if (posts.length >= count) break;
    try {
      const detail = await parseRealbooruHtml(
        "detail",
        await fetchRealbooruHtml(candidate.postUrl),
        candidate.id,
      );
      posts.push({ ...detail, tags: candidate.tags });
    } catch (error) {
      console.warn(
        `Skipped unverifiable Realbooru post ${candidate.id}.`,
        error,
      );
    }
  }
  return {
    returnedPosts: candidates.length,
    posts: parseRealbooruResponse({ posts }),
  };
}

async function requestRealbooruPosts(_settings, count = REALBOORU_BATCH_SIZE) {
  if (!(await hasRealbooruPermission())) {
    throw new Error("Realbooru site permission has not been granted.");
  }
  const boundedCount = Math.min(20, Math.max(1, Number(count) || 1));
  const next = realbooruScrapeQueue
    .catch(() => {})
    .then(async () => {
      try {
        return await scrapeRealbooruPosts(boundedCount);
      } finally {
        await closeRealbooruParser();
      }
    });
  realbooruScrapeQueue = next.catch(() => {});
  return next;
}

async function testRealbooruConnection() {
  const settings = normalizeSettings({ avatarMode: "realbooru" });
  const result = await requestRealbooruPosts(settings, 3);
  return {
    query: REALBOORU_QUERY_TAGS,
    returnedPosts: result.returnedPosts,
    usablePosts: result.posts.length,
    message:
      result.posts.length > 0
        ? "The extension-native Realbooru fetcher and local filtering both work."
        : "Realbooru responded, but this random page had no eligible solo selfies.",
  };
}

function validateGelbooruSettings(settings) {
  if (!settings.gelbooruUserId || !settings.gelbooruApiKey) {
    throw new Error("Gelbooru API user ID and API key are required.");
  }
  if (!/^\d+$/.test(String(settings.gelbooruUserId))) {
    throw new Error(
      "Gelbooru user ID must be numeric, not a username. Copy the digits shown beside your API key or in your profile URL.",
    );
  }
}

function cleanGelbooruReason(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function readGelbooruResponse(response) {
  let rawText = "";
  if (typeof response.text === "function") {
    rawText = await response.text();
  } else if (typeof response.json === "function") {
    return response.json();
  }

  if (/captcha|cloudflare|checking your browser|just a moment/i.test(rawText)) {
    throw new Error(
      "Gelbooru returned a CAPTCHA/Cloudflare page instead of API data. This is a Gelbooru-side block; wait a little and test again.",
    );
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(
      "Gelbooru returned a non-JSON response. The API may be temporarily blocked or unavailable.",
    );
  }
}

async function requestGelbooruPage(settings, pid, limit = 100) {
  validateGelbooruSettings(settings);
  if (!(await hasGelbooruPermission())) {
    throw new Error("Gelbooru site permission has not been granted.");
  }

  const query = new URLSearchParams({
    page: "dapi",
    s: "post",
    q: "index",
    json: "1",
    limit: String(limit),
    pid: String(pid),
    tags: GELBOORU_QUERY_TAGS,
    user_id: settings.gelbooruUserId,
    api_key: settings.gelbooruApiKey,
  });

  let response;
  try {
    response = await fetch(`https://gelbooru.com/index.php?${query}`, {
      credentials: "omit",
      headers: {
        Accept: "application/json",
      },
    });
  } catch (error) {
    throw new Error(`Could not reach Gelbooru: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(
      `Gelbooru API returned HTTP ${response.status}. Check the numeric user ID, API key, and try again later.`,
    );
  }

  const payload = await readGelbooruResponse(response);
  if (
    payload?.success === false ||
    payload?.["@attributes"]?.success === "false"
  ) {
    const reason = cleanGelbooruReason(
      payload.reason || payload.message || payload?.["@attributes"]?.reason,
    );
    throw new Error(
      `Gelbooru API rejected the request${reason ? `: ${reason}` : "."}`,
    );
  }

  const rawPosts = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.post)
      ? payload.post
      : [];
  const totalCountCandidate =
    payload?.["@attributes"]?.count ?? payload?.count ?? rawPosts.length;
  const totalCount = Number.parseInt(String(totalCountCandidate), 10);

  return {
    rawCount: rawPosts.length,
    totalCount: Number.isFinite(totalCount) ? totalCount : rawPosts.length,
    posts: parseGelbooruResponse(payload, settings.gelbooruRatingMode),
  };
}

async function refillGelbooruPool(state, settings) {
  let firstPageResult = null;
  if (!state.gelbooruPageCount) {
    firstPageResult = await requestGelbooruPage(
      settings,
      0,
      GELBOORU_PAGE_SIZE,
    );
    state.gelbooruPageCount = Math.max(
      1,
      Math.ceil(firstPageResult.totalCount / GELBOORU_PAGE_SIZE),
    );
  }

  const recentPages = new Set(state.gelbooruRecentPages);
  let page = randomInt(state.gelbooruPageCount);
  for (
    let attempt = 0;
    attempt < 12 &&
    recentPages.has(page) &&
    recentPages.size < state.gelbooruPageCount;
    attempt += 1
  ) {
    page = randomInt(state.gelbooruPageCount);
  }

  const result =
    page === 0 && firstPageResult
      ? firstPageResult
      : await requestGelbooruPage(settings, page, GELBOORU_PAGE_SIZE);

  state.gelbooruRecentPages.push(page);
  state.gelbooruRecentPages = state.gelbooruRecentPages.slice(
    -Math.min(20, Math.max(1, state.gelbooruPageCount - 1)),
  );

  const queuedIds = new Set(state.gelbooruPool.map((post) => post.id));
  const queuedUrls = new Set(state.gelbooruPool.map((post) => post.url));
  const queuedFingerprints = new Set(
    state.gelbooruPool.map((post) => post.fingerprint).filter(Boolean),
  );
  const unused = result.posts.filter(
    (post) =>
      !state.usedAvatarIds[post.id] &&
      !state.usedAvatarUrls[post.url] &&
      (!post.fingerprint || !state.usedAvatarFingerprints[post.fingerprint]) &&
      !queuedIds.has(post.id) &&
      !queuedUrls.has(post.url) &&
      (!post.fingerprint || !queuedFingerprints.has(post.fingerprint)),
  );

  for (let index = unused.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [unused[index], unused[swapIndex]] = [unused[swapIndex], unused[index]];
  }

  state.gelbooruPool.push(...unused);
}

async function refillRealbooruPool(state, settings) {
  const result = await requestRealbooruPosts(settings);
  const queuedIds = new Set(state.realbooruPool.map((post) => post.id));
  const queuedUrls = new Set(state.realbooruPool.map((post) => post.url));
  const queuedFingerprints = new Set(
    state.realbooruPool.map((post) => post.fingerprint).filter(Boolean),
  );
  const unused = result.posts.filter(
    (post) =>
      !state.usedRealbooruIds[post.id] &&
      !state.usedAvatarUrls[post.url] &&
      (!post.fingerprint || !state.usedAvatarFingerprints[post.fingerprint]) &&
      !queuedIds.has(post.id) &&
      !queuedUrls.has(post.url) &&
      (!post.fingerprint || !queuedFingerprints.has(post.fingerprint)),
  );

  for (let index = unused.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [unused[index], unused[swapIndex]] = [unused[swapIndex], unused[index]];
  }
  state.realbooruPool.push(...unused);
}

function recordGelbooruUse(state, avatar, primaryKey, action) {
  if (!avatar?.id) return;
  const source = avatar.source || "gelbooru";
  if (
    !state.gelbooruHistory.some(
      (item) => (item.source || "gelbooru") === source && item.id === avatar.id,
    )
  ) {
    state.gelbooruHistory.push({
      source,
      id: avatar.id,
      postUrl: avatar.postUrl || "",
      sourceUrl: avatar.url || "",
      fingerprint: avatar.fingerprint || "",
      primaryKey,
      action,
      usedAt: Date.now(),
    });
    state.gelbooruHistory = state.gelbooruHistory.slice(-1000);
  }
}

async function testGelbooruConnection(
  gelbooruUserId,
  gelbooruApiKey,
  gelbooruRatingMode = "any",
) {
  const settings = normalizeSettings({
    avatarMode: "gelbooru",
    gelbooruRatingMode,
    gelbooruUserId: String(gelbooruUserId || "").trim(),
    gelbooruApiKey: String(gelbooruApiKey || "").trim(),
  });
  const result = await requestGelbooruPage(settings, 0, 100);
  const usablePosts = result.posts.length;

  return {
    query: GELBOORU_QUERY_TAGS,
    ratingMode: settings.gelbooruRatingMode,
    returnedPosts: result.rawCount,
    usablePosts,
    message:
      usablePosts > 0
        ? "Authentication and image filtering both work."
        : result.rawCount > 0
          ? "Authentication works, but this page had no solo selfies accepted by the local filters."
          : "Authentication works, but Gelbooru returned no posts for this query.",
  };
}

async function takeGelbooruAvatar(state, settings) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    while (state.gelbooruPool.length > 0) {
      const avatar = state.gelbooruPool.shift();
      if (
        state.usedAvatarIds[avatar.id] ||
        state.usedAvatarUrls[avatar.url] ||
        (avatar.fingerprint && state.usedAvatarFingerprints[avatar.fingerprint])
      ) {
        continue;
      }
      state.usedAvatarIds[avatar.id] = true;
      state.usedAvatarUrls[avatar.url] = true;
      if (avatar.fingerprint) {
        state.usedAvatarFingerprints[avatar.fingerprint] = true;
      }
      // Persist the reservation before any caller downloads the image bytes.
      // IDs, source URLs, and Gelbooru MD5s are all retired first, so a crash or
      // service-worker restart cannot cause a second fetch of the same asset.
      await chrome.storage.local.set({ [STATE_KEY]: state });
      return avatar;
    }
    await refillGelbooruPool(state, settings);
  }

  throw new Error("No unused eligible Gelbooru selfies were returned.");
}

async function takeRealbooruAvatar(state, settings) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    while (state.realbooruPool.length > 0) {
      const avatar = state.realbooruPool.shift();
      if (
        state.usedRealbooruIds[avatar.id] ||
        state.usedAvatarUrls[avatar.url] ||
        (avatar.fingerprint && state.usedAvatarFingerprints[avatar.fingerprint])
      ) {
        continue;
      }
      state.usedRealbooruIds[avatar.id] = true;
      state.usedAvatarUrls[avatar.url] = true;
      if (avatar.fingerprint) {
        state.usedAvatarFingerprints[avatar.fingerprint] = true;
      }
      await chrome.storage.local.set({ [STATE_KEY]: state });
      return avatar;
    }
    await refillRealbooruPool(state, settings);
  }
  throw new Error("No unused eligible Realbooru selfies were returned.");
}

function preferredRemoteSources(settings, roll = randomInt(100)) {
  if (settings.avatarMode === "mixed") {
    return roll < settings.realbooruPercentage
      ? ["realbooru", "gelbooru"]
      : ["gelbooru", "realbooru"];
  }
  return [settings.avatarMode];
}

async function takeConfiguredRemoteAvatar(state, settings) {
  const sources = preferredRemoteSources(settings);
  const errors = [];
  for (const source of sources) {
    try {
      return source === "realbooru"
        ? await takeRealbooruAvatar(state, settings)
        : await takeGelbooruAvatar(state, settings);
    } catch (error) {
      errors.push(`${source}: ${error.message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

function takeCustomAvatar(state, key) {
  const availableIds = Object.keys(state.customAvatars).filter(
    (id) => !state.usedCustomAvatarIds[id],
  );
  if (availableIds.length === 0) {
    throw new Error("The imported avatar pack has no unused images.");
  }

  const index = hashString(key) % availableIds.length;
  const id = availableIds[index];
  state.usedCustomAvatarIds[id] = true;
  return {
    id,
    url: state.customAvatars[id].url,
    detection: state.customAvatars[id].detection || "smart",
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function faceCrop(bitmap, face) {
  const box = face.boundingBox;
  const maximumSide = Math.min(bitmap.width, bitmap.height);
  const side = clamp(Math.max(box.width, box.height) * 2.35, 48, maximumSide);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2 + box.height * 0.12;
  return {
    x: clamp(centerX - side / 2, 0, bitmap.width - side),
    y: clamp(centerY - side / 2, 0, bitmap.height - side),
    side,
    mode: "face",
  };
}

async function detectFaceCrop(bitmap) {
  if (!("FaceDetector" in globalThis)) return null;
  try {
    const detector = new FaceDetector({
      fastMode: true,
      maxDetectedFaces: 5,
    });
    const faces = await detector.detect(bitmap);
    if (!faces.length) return null;
    const largest = faces.reduce((best, face) => {
      const area = face.boundingBox.width * face.boundingBox.height;
      const bestArea = best.boundingBox.width * best.boundingBox.height;
      return area > bestArea ? face : best;
    });
    return faceCrop(bitmap, largest);
  } catch {
    return null;
  }
}

function smartBitmapCrop(bitmap) {
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, 128 / longest);
  const width = Math.max(8, Math.round(bitmap.width * scale));
  const height = Math.max(8, Math.round(bitmap.height * scale));
  const analysis = new OffscreenCanvas(width, height);
  const context = analysis.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);

  const luminance = (x, y) => {
    const index = (y * width + x) * 4;
    return (
      data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114
    );
  };

  let total = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const gradient =
        Math.abs(luminance(x + 1, y) - luminance(x - 1, y)) +
        Math.abs(luminance(x, y + 1) - luminance(x, y - 1));
      const dx = (x - width / 2) / (width / 2);
      const dy = (y - height * 0.4) / (height / 2);
      const centerPrior = 0.35 + 0.65 * Math.exp(-(dx * dx + dy * dy) * 1.8);
      const upperPrior = y < height * 0.72 ? 1.15 : 0.65;
      const weight = (gradient + 2) * centerPrior * upperPrior;
      total += weight;
      weightedX += x * weight;
      weightedY += y * weight;
    }
  }

  const salientX = total ? weightedX / total / scale : bitmap.width / 2;
  const salientY = total ? weightedY / total / scale : bitmap.height * 0.4;
  const centerX = salientX * 0.65 + bitmap.width * 0.5 * 0.35;
  const centerY = salientY * 0.65 + bitmap.height * 0.38 * 0.35;
  const side = Math.min(bitmap.width, bitmap.height);
  return {
    x: clamp(centerX - side / 2, 0, bitmap.width - side),
    y: clamp(centerY - side / 2, 0, bitmap.height - side),
    side,
    mode: "smart",
  };
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:${blob.type || "image/webp"};base64,${btoa(binary)}`;
}

async function cropRemoteAvatar(url) {
  const response = await fetch(url, {
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error(`Avatar image returned HTTP ${response.status}.`);

  const sourceBlob = await response.blob();
  if (sourceBlob.type && !/^image\//i.test(sourceBlob.type)) {
    throw new Error(`Avatar response was ${sourceBlob.type}, not an image.`);
  }

  const cachedOriginal = async () => ({
    url: await blobToDataUrl(sourceBlob),
    mode: "cached",
  });

  if (
    !("OffscreenCanvas" in globalThis) ||
    !("createImageBitmap" in globalThis)
  ) {
    return cachedOriginal();
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(sourceBlob);
  } catch {
    return cachedOriginal();
  }

  try {
    try {
      const crop = (await detectFaceCrop(bitmap)) || smartBitmapCrop(bitmap);
      const canvas = new OffscreenCanvas(AVATAR_CACHE_SIZE, AVATAR_CACHE_SIZE);
      const context = canvas.getContext("2d");
      context.drawImage(
        bitmap,
        crop.x,
        crop.y,
        crop.side,
        crop.side,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const avatarBlob = await canvas.convertToBlob({
        type: "image/webp",
        quality: 0.8,
      });
      return {
        url: await blobToDataUrl(avatarBlob),
        mode: crop.mode,
      };
    } catch {
      return cachedOriginal();
    }
  } finally {
    bitmap.close();
  }
}

async function ensureIdentityAvatarCropped(identity, state) {
  if (!["gelbooru", "realbooru"].includes(identity.avatarKind)) return identity;
  if (/^data:image\//i.test(identity.avatarUrl || "")) {
    if (!identity.avatarCropMode) identity.avatarCropMode = "cached";
    return identity;
  }

  try {
    const cropped = await cropRemoteAvatar(identity.avatarUrl);
    identity.avatarUrl = cropped.url;
    identity.avatarCropMode = cropped.mode;
  } catch (error) {
    identity.avatarUrl = generatedAvatar(
      identity.handle || identity.avatarId || "fallback",
      identity.displayName,
    );
    identity.avatarCropMode = "fallback";
    state.lastAvatarError = `Remote image cache failed: ${error.message}`;
  }
  return identity;
}

async function createAvatar(primaryKey, displayName, state, settings) {
  const generatedSeed = `${primaryKey}:picture:${state.pictureResetGeneration}`;
  let avatar = {
    kind: "generated",
    id: `generated:${generatedSeed}`,
    url: generatedAvatar(generatedSeed, displayName),
    postUrl: "",
  };

  if (["gelbooru", "realbooru", "mixed"].includes(settings.avatarMode)) {
    try {
      const gelbooruAvatar = await takeConfiguredRemoteAvatar(state, settings);
      recordGelbooruUse(
        state,
        gelbooruAvatar,
        primaryKey,
        "initial-assignment",
      );
      avatar = {
        kind: gelbooruAvatar.source || "gelbooru",
        id: gelbooruAvatar.id,
        url: gelbooruAvatar.url,
        postUrl: gelbooruAvatar.postUrl,
        sourceUrl: gelbooruAvatar.url,
        fingerprint: gelbooruAvatar.fingerprint,
      };
      state.lastAvatarError = "";
    } catch (error) {
      state.lastAvatarError = error.message;
    }
  } else if (settings.avatarMode === "custom") {
    try {
      const customAvatar = takeCustomAvatar(state, primaryKey);
      avatar = {
        kind: "custom",
        id: customAvatar.id,
        url: customAvatar.url,
        postUrl: "",
      };
      state.lastAvatarError = "";
    } catch (error) {
      state.lastAvatarError = error.message;
    }
  }

  return avatar;
}

async function createIdentity(primaryKey, state, settings) {
  const name = createName(primaryKey, state);
  const avatar = await createAvatar(
    primaryKey,
    name.displayName,
    state,
    settings,
  );

  return {
    aliasStyleVersion: 2,
    displayName: name.displayName,
    handle: name.handle,
    avatarUrl: avatar.url,
    avatarKind: avatar.kind,
    avatarId: avatar.id,
    avatarPostUrl: avatar.postUrl,
    avatarSourceUrl: avatar.sourceUrl || "",
    avatarFingerprint: avatar.fingerprint || "",
    avatarCropMode:
      avatar.kind === "generated"
        ? "generated"
        : avatar.kind === "custom"
          ? "imported"
          : "",
  };
}

function migrateIdentityStyle(identity, canonicalKey, state) {
  if (identity.aliasStyleVersion === 2) return identity;

  if (identity.handle && state.usedHandles[identity.handle] === canonicalKey) {
    delete state.usedHandles[identity.handle];
  }
  const name = createName(canonicalKey, state);
  identity.displayName = name.displayName;
  identity.handle = name.handle;
  identity.aliasStyleVersion = 2;

  if (identity.avatarKind === "generated") {
    identity.avatarUrl = generatedAvatar(canonicalKey, name.displayName);
  }

  return identity;
}

async function migrateAvatarMode(identity, canonicalKey, state, settings) {
  const desiredKind = settings.avatarMode;
  if (
    identity.avatarKind === desiredKind ||
    (desiredKind === "mixed" &&
      ["gelbooru", "realbooru"].includes(identity.avatarKind))
  ) {
    return identity;
  }

  const avatar = await createAvatar(
    canonicalKey,
    identity.displayName,
    state,
    settings,
  );
  identity.avatarUrl = avatar.url;
  identity.avatarKind = avatar.kind;
  identity.avatarId = avatar.id;
  identity.avatarPostUrl = avatar.postUrl;
  identity.avatarSourceUrl = avatar.sourceUrl || "";
  identity.avatarFingerprint = avatar.fingerprint || "";
  identity.avatarCropMode =
    avatar.kind === "generated"
      ? "generated"
      : avatar.kind === "custom"
        ? "imported"
        : "";
  return identity;
}

function resolveCanonicalKey(state, keys) {
  for (const key of keys) {
    if (state.aliasToPrimary[key]) return state.aliasToPrimary[key];
    if (state.identities[key]) return key;
  }
  return keys[0];
}

function queueStateMutation(mutator) {
  const operation = stateQueue
    .catch(() => undefined)
    .then(async () => {
      const [settings, state] = await Promise.all([getSettings(), getState()]);
      const result = await mutator(state, settings);
      await chrome.storage.local.set({ [STATE_KEY]: state });
      return result;
    });
  stateQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function resolveIdentityInState(primaryKey, aliases, state, settings) {
  const keys = [...new Set([primaryKey, ...aliases].filter(Boolean))];
  if (keys.length === 0) throw new Error("No stable account key was supplied.");

  const canonicalKey = resolveCanonicalKey(state, keys);
  if (!state.identities[canonicalKey]) {
    state.identities[canonicalKey] = await createIdentity(
      canonicalKey,
      state,
      settings,
    );
  } else {
    migrateIdentityStyle(state.identities[canonicalKey], canonicalKey, state);
    await migrateAvatarMode(
      state.identities[canonicalKey],
      canonicalKey,
      state,
      settings,
    );
  }

  for (const key of keys) state.aliasToPrimary[key] = canonicalKey;
  return state.identities[canonicalKey];
}

async function resolveIdentity(primaryKey, aliases = []) {
  return queueStateMutation(async (state, settings) => {
    const identity = await resolveIdentityInState(
      primaryKey,
      aliases,
      state,
      settings,
    );
    await ensureIdentityAvatarCropped(identity, state);
    return identity;
  });
}

async function resolveIdentities(items = []) {
  return queueStateMutation(async (state, settings) => {
    const results = [];
    for (const item of items) {
      const aliases = Array.isArray(item.aliases) ? item.aliases : [];
      results.push({
        primaryKey: item.primaryKey,
        aliases,
        identity: await resolveIdentityInState(
          item.primaryKey,
          aliases,
          state,
          settings,
        ),
      });
    }
    await Promise.all(
      results.map((item) => ensureIdentityAvatarCropped(item.identity, state)),
    );
    return results;
  });
}

async function rotateAvatar(primaryKey, aliases = []) {
  const outcome = await queueStateMutation(async (state, settings) => {
    if (!["gelbooru", "realbooru", "mixed"].includes(settings.avatarMode)) {
      return {
        error:
          "Click-to-change pictures is available in Gelbooru, Realbooru, or mixed mode.",
      };
    }

    const keys = [...new Set([primaryKey, ...aliases].filter(Boolean))];
    if (keys.length === 0) return { error: "No account key was supplied." };
    const canonicalKey = resolveCanonicalKey(state, keys);
    const identity = state.identities[canonicalKey];
    if (!identity) return { error: "The masked identity is not ready yet." };

    let latestError = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const avatar = await takeConfiguredRemoteAvatar(state, settings);
        recordGelbooruUse(state, avatar, canonicalKey, "manual-reroll");
        try {
          const cached = await cropRemoteAvatar(avatar.url);
          identity.avatarUrl = cached.url;
          identity.avatarKind = avatar.source || "gelbooru";
          identity.avatarId = avatar.id;
          identity.avatarPostUrl = avatar.postUrl;
          identity.avatarSourceUrl = avatar.url;
          identity.avatarFingerprint = avatar.fingerprint || "";
          identity.avatarCropMode = cached.mode;
          identity.avatarRevision = (identity.avatarRevision || 0) + 1;
          state.lastAvatarError = "";
          for (const key of keys) state.aliasToPrimary[key] = canonicalKey;
          return { identity, primaryKey: canonicalKey, aliases: keys };
        } catch (error) {
          latestError = `Remote image cache failed: ${error.message}`;
        }
      } catch (error) {
        latestError = error.message;
        break;
      }
    }

    state.lastAvatarError =
      latestError || "Could not obtain a different remote picture.";
    return { error: state.lastAvatarError };
  });

  if (outcome.error) throw new Error(outcome.error);
  await signalIdentityRefresh("pictures");
  return outcome;
}

async function reenableRemoteAvatar(sourceValue, idValue) {
  const source = String(sourceValue || "").toLowerCase();
  const id = String(idValue || "");
  if (!["gelbooru", "realbooru"].includes(source) || !id) {
    throw new Error("A valid retired remote picture is required.");
  }

  return queueStateMutation((state) => {
    const index = state.gelbooruHistory.findIndex(
      (item) =>
        (item.source || "gelbooru") === source && String(item.id) === id,
    );
    if (index < 0) throw new Error("The retired picture was not found.");

    const retired = state.gelbooruHistory[index];
    const assigned = Object.values(state.identities).some(
      (identity) =>
        (identity.avatarKind === source && String(identity.avatarId) === id) ||
        (retired.sourceUrl && identity.avatarSourceUrl === retired.sourceUrl) ||
        (retired.fingerprint &&
          identity.avatarFingerprint === retired.fingerprint),
    );
    if (assigned) {
      throw new Error("A currently assigned picture cannot be re-enabled.");
    }

    state.gelbooruHistory.splice(index, 1);
    const idMap =
      source === "realbooru" ? state.usedRealbooruIds : state.usedAvatarIds;
    if (
      !state.gelbooruHistory.some(
        (item) =>
          (item.source || "gelbooru") === source && String(item.id) === id,
      )
    ) {
      delete idMap[id];
    }

    const stillReferences = (historyKey, identityKey, value) =>
      value &&
      (state.gelbooruHistory.some((item) => item[historyKey] === value) ||
        Object.values(state.identities).some(
          (identity) => identity[identityKey] === value,
        ));
    if (
      retired.sourceUrl &&
      !stillReferences("sourceUrl", "avatarSourceUrl", retired.sourceUrl)
    ) {
      delete state.usedAvatarUrls[retired.sourceUrl];
    }
    if (
      retired.fingerprint &&
      !stillReferences("fingerprint", "avatarFingerprint", retired.fingerprint)
    ) {
      delete state.usedAvatarFingerprints[retired.fingerprint];
    }
  });
}

async function updateSettings(patch) {
  const current = await getSettings();
  const settings = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function resetMappings() {
  const previous = await getState();
  const next = normalizeState({
    customAvatars: previous.customAvatars,
    usedAvatarIds: previous.usedAvatarIds,
    usedRealbooruIds: previous.usedRealbooruIds,
    usedAvatarUrls: previous.usedAvatarUrls,
    usedAvatarFingerprints: previous.usedAvatarFingerprints,
    gelbooruHistory: previous.gelbooruHistory,
    realbooruPool: previous.realbooruPool,
    gelbooruPageCount: previous.gelbooruPageCount,
    gelbooruRecentPages: previous.gelbooruRecentPages,
  });
  await chrome.storage.local.set({ [STATE_KEY]: next });
}

async function signalIdentityRefresh(kind) {
  await chrome.storage.local.set({
    [CONTROL_KEY]: {
      kind,
      at: Date.now(),
    },
  });
}

async function resetNames() {
  const count = await queueStateMutation(async (state) => {
    state.nameResetGeneration += 1;
    state.usedHandles = {};

    for (const [canonicalKey, identity] of Object.entries(state.identities)) {
      const previousDisplayName = identity.displayName;
      const previousHandle = identity.handle;
      let replacement = null;

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = createName(
          `${canonicalKey}:name:${state.nameResetGeneration}:${attempt}`,
          state,
          canonicalKey,
        );
        if (
          candidate.displayName !== previousDisplayName &&
          candidate.handle !== previousHandle
        ) {
          replacement = candidate;
          break;
        }
        if (state.usedHandles[candidate.handle] === canonicalKey) {
          delete state.usedHandles[candidate.handle];
        }
      }

      replacement ||= {
        displayName: `${previousDisplayName || "girl"} xo`,
        handle: uniqueHandle(
          `${previousHandle || "girl"}x`,
          state,
          canonicalKey,
        ),
      };
      identity.displayName = replacement.displayName;
      identity.handle = replacement.handle;
      identity.aliasStyleVersion = 2;
    }
    return Object.keys(state.identities).length;
  });
  await signalIdentityRefresh("names");
  return count;
}

async function resetPictures() {
  const count = await queueStateMutation(async (state) => {
    state.pictureResetGeneration += 1;
    for (const [canonicalKey, identity] of Object.entries(state.identities)) {
      const seed = `${canonicalKey}:picture:${state.pictureResetGeneration}`;
      identity.avatarKind = "pending";
      identity.avatarId = `pending:${seed}`;
      identity.avatarUrl = generatedAvatar(seed, identity.displayName);
      identity.avatarPostUrl = "";
      identity.avatarSourceUrl = "";
      identity.avatarFingerprint = "";
      identity.avatarCropMode = "pending";
      identity.avatarRevision = (identity.avatarRevision || 0) + 1;
    }
    return Object.keys(state.identities).length;
  });
  await signalIdentityRefresh("pictures");
  return count;
}

async function addCustomAvatars(avatars = []) {
  return queueStateMutation(async (state) => {
    for (const avatar of avatars.slice(0, 300)) {
      if (!avatar?.id || !/^data:image\//i.test(avatar.url || "")) continue;
      state.customAvatars[avatar.id] = {
        url: avatar.url,
        detection: avatar.detection || "smart",
      };
    }
    return Object.keys(state.customAvatars).length;
  });
}

async function clearCustomAvatars() {
  return queueStateMutation(async (state) => {
    state.customAvatars = {};
    state.usedCustomAvatarIds = {};
    for (const identity of Object.values(state.identities)) {
      if (identity.avatarKind !== "custom") continue;
      identity.avatarKind = "generated";
      identity.avatarId = `generated:${identity.handle}`;
      identity.avatarUrl = generatedAvatar(
        identity.handle,
        identity.displayName,
      );
      identity.avatarPostUrl = "";
      identity.avatarCropMode = "generated";
    }
    return 0;
  });
}

async function getStats() {
  const state = await getState();
  return {
    mappedAccounts: Object.keys(state.identities).length,
    usedAnimeSelfies: Object.keys(state.usedAvatarIds).length,
    usedRealSelfies: Object.keys(state.usedRealbooruIds).length,
    usedRemoteSelfies:
      Object.keys(state.usedAvatarIds).length +
      Object.keys(state.usedRealbooruIds).length,
    importedAvatars: Object.keys(state.customAvatars).length,
    usedImportedAvatars: Object.keys(state.usedCustomAvatarIds).length,
    queuedAnimeSelfies: state.gelbooruPool.length,
    lastAvatarError: state.lastAvatarError,
  };
}

async function getAvatarManagementView() {
  const state = await getState();
  const currentIds = new Set();
  const currentUrls = new Set();
  const currentFingerprints = new Set();

  const current = Object.entries(state.identities).map(
    ([primaryKey, identity]) => {
      const source = ["gelbooru", "realbooru"].includes(identity.avatarKind)
        ? identity.avatarKind
        : "";
      if (source && identity.avatarId) {
        currentIds.add(`${source}:${identity.avatarId}`);
      }
      if (identity.avatarSourceUrl) currentUrls.add(identity.avatarSourceUrl);
      if (identity.avatarFingerprint) {
        currentFingerprints.add(identity.avatarFingerprint);
      }
      return {
        primaryKey,
        displayName: identity.displayName || "Masked account",
        handle: identity.handle || "",
        avatarUrl: identity.avatarUrl || "",
        avatarKind: identity.avatarKind || "generated",
      };
    },
  );

  const retired = state.gelbooruHistory
    .slice()
    .reverse()
    .filter((item) => {
      const source = item.source || "gelbooru";
      return (
        !currentIds.has(`${source}:${item.id}`) &&
        (!item.sourceUrl || !currentUrls.has(item.sourceUrl)) &&
        (!item.fingerprint || !currentFingerprints.has(item.fingerprint))
      );
    })
    .map(({ source, id, sourceUrl, postUrl, fingerprint }) => ({
      source: source || "gelbooru",
      id,
      sourceUrl: sourceUrl || "",
      postUrl: postUrl || "",
      fingerprint: fingerprint || "",
    }));

  return { current, retired };
}

async function getGelbooruHistory() {
  const state = await getState();
  return state.gelbooruHistory
    .slice()
    .reverse()
    .map(({ source, id, postUrl, action, usedAt }) => ({
      source: source || "gelbooru",
      id,
      postUrl,
      action,
      usedAt,
    }));
}

const CREATOR_SCRIPT_DEFINITIONS = Object.freeze([
  {
    id: "creator-toolkit-upload-trace-onlyfans",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://onlyfans.com/*"],
    matches: ["https://onlyfans.com/*"],
    js: ["workflows/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-fansly",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://fansly.com/*"],
    matches: ["https://fansly.com/*"],
    js: ["workflows/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-manyvids",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://www.manyvids.com/*"],
    matches: ["https://www.manyvids.com/*"],
    js: ["workflows/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-pornhub",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://pornhub.mainhub.com/*"],
    matches: ["https://pornhub.mainhub.com/*"],
    js: ["workflows/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-x",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://x.com/*"],
    matches: ["https://x.com/*"],
    js: ["workflows/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-redgifs",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://www.redgifs.com/*", "https://studio.redgifs.com/*"],
    matches: ["https://www.redgifs.com/*", "https://studio.redgifs.com/*"],
    js: ["workflows/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-reddit",
    toolIds: ["uploadTraceRecorder"],
    origins: [
      "https://www.reddit.com/*",
      "https://sh.reddit.com/*",
      "https://old.reddit.com/*",
    ],
    matches: [
      "https://www.reddit.com/*",
      "https://sh.reddit.com/*",
      "https://old.reddit.com/*",
    ],
    js: ["workflows/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-c4s",
    toolIds: ["c4sUpload"],
    origins: ["https://workspace.clips4sale.com/*"],
    matches: ["https://workspace.clips4sale.com/upload*"],
    js: [
      "workflows/registry.js",
      "workflows/common.js",
      "workflows/c4s-upload.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-pornhub",
    toolIds: ["phUploader"],
    origins: ["https://pornhub.mainhub.com/*"],
    matches: ["https://pornhub.mainhub.com/upload/uploader*"],
    js: [
      "workflows/registry.js",
      "workflows/common.js",
      "workflows/ph-uploader.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-fansly",
    toolIds: ["fanslyPrefill"],
    origins: ["https://fansly.com/*"],
    matches: ["https://fansly.com/*"],
    js: [
      "workflows/registry.js",
      "workflows/common.js",
      "workflows/fansly-prefill.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-manyvids",
    toolIds: ["manyvidsAutofill"],
    origins: ["https://www.manyvids.com/*"],
    matches: ["https://www.manyvids.com/Edit-vid/*"],
    js: [
      "workflows/registry.js",
      "workflows/common.js",
      "workflows/manyvids-autofill.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-sheer",
    toolIds: ["sheerTags"],
    origins: ["https://my.sheer.com/*"],
    matches: ["https://my.sheer.com/content/update/*"],
    js: [
      "workflows/registry.js",
      "workflows/common.js",
      "workflows/sheer-tags.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-onlyfans-lists",
    toolIds: ["onlyfansAutoSelect", "onlyfansAutoFollow"],
    origins: ["https://onlyfans.com/*"],
    matches: ["https://onlyfans.com/my/collections/user-lists*"],
    js: [
      "workflows/registry.js",
      "workflows/common.js",
      "workflows/onlyfans-list-common.js",
      "workflows/onlyfans-auto-select.js",
      "workflows/onlyfans-auto-follow.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-reddit",
    toolIds: ["redditBannerCensor"],
    origins: [
      "https://www.reddit.com/*",
      "https://sh.reddit.com/*",
      "https://old.reddit.com/*",
    ],
    matches: [
      "https://www.reddit.com/r/*",
      "https://sh.reddit.com/r/*",
      "https://old.reddit.com/r/*",
    ],
    js: [
      "workflows/registry.js",
      "workflows/common.js",
      "workflows/reddit-banner-censor.js",
    ],
    runAt: "document_start",
  },
]);

async function getCreatorSettings() {
  const stored = await chrome.storage.local.get([
    CREATOR_REGISTRY.STORAGE_KEY,
    CREATOR_REGISTRY.LEGACY_STORAGE_KEY,
  ]);
  if (stored[CREATOR_REGISTRY.STORAGE_KEY]) {
    const current = stored[CREATOR_REGISTRY.STORAGE_KEY];
    const normalized = CREATOR_REGISTRY.normalizeSettings(current).value;
    if (JSON.stringify(current) !== JSON.stringify(normalized)) {
      await chrome.storage.local.set({
        [CREATOR_REGISTRY.STORAGE_KEY]: normalized,
      });
    }
    return normalized;
  }
  const migrated = CREATOR_REGISTRY.migrateLegacySettings(
    stored[CREATOR_REGISTRY.LEGACY_STORAGE_KEY],
  );
  await chrome.storage.local.set({
    [CREATOR_REGISTRY.STORAGE_KEY]: migrated,
  });
  return migrated;
}

async function hasAllOrigins(origins) {
  return chrome.permissions.contains({ origins });
}

const CREATOR_TRACE_PLATFORM_LABELS = Object.freeze({
  "creator-toolkit-upload-trace-onlyfans": "OnlyFans",
  "creator-toolkit-upload-trace-fansly": "Fansly",
  "creator-toolkit-upload-trace-manyvids": "ManyVids",
  "creator-toolkit-upload-trace-pornhub": "Pornhub",
  "creator-toolkit-upload-trace-x": "X",
  "creator-toolkit-upload-trace-redgifs": "Redgifs",
  "creator-toolkit-upload-trace-reddit": "Reddit",
});

function creatorDefinitionMatchesUrl(definition, url) {
  try {
    const currentOrigin = new URL(url).origin;
    return definition.matches.some(
      (match) => new URL(match.replace(/\*$/, "")).origin === currentOrigin,
    );
  } catch {
    return false;
  }
}

function showCreatorUploadTraceRecorderPanel() {
  return globalThis.CreatorUploadTraceRecorder?.showPanel?.() === true;
}

async function showUploadTraceRecorder() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const definition = CREATOR_SCRIPT_DEFINITIONS.find(
    (entry) =>
      entry.toolIds.includes("uploadTraceRecorder") &&
      creatorDefinitionMatchesUrl(entry, tab?.url),
  );
  if (!tab?.id || !definition) {
    throw new Error(
      "Open a supported creator site, then show the trace recorder again.",
    );
  }
  const settings = await getCreatorSettings();
  if (settings.tools.uploadTraceRecorder?.enabled !== true) {
    throw new Error(
      "Enable Upload trace recorder in Upload console → Settings.",
    );
  }
  if (!(await hasAllOrigins(definition.origins))) {
    throw new Error("Grant this extension site access, then try again.");
  }
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  const mainFrame = frames?.find((frame) => frame.frameId === 0);
  if (
    !mainFrame?.documentId ||
    !creatorDefinitionMatchesUrl(definition, mainFrame.url)
  ) {
    throw new Error("The active page changed. Try showing the recorder again.");
  }
  const target = { tabId: tab.id, documentIds: [mainFrame.documentId] };
  await chrome.scripting.executeScript({ target, files: definition.js });
  const [shown] = await chrome.scripting.executeScript({
    target,
    func: showCreatorUploadTraceRecorderPanel,
  });
  if (shown?.result !== true) {
    throw new Error("The trace recorder could not open on this page.");
  }
  return {
    tabId: tab.id,
    platform: CREATOR_TRACE_PLATFORM_LABELS[definition.id],
  };
}

async function performCreatorToolRegistrationSync(settings = null) {
  const currentSettings = settings || (await getCreatorSettings());
  const knownIds = CREATOR_SCRIPT_DEFINITIONS.map(
    (definition) => definition.id,
  );
  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: knownIds,
  });
  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({
      ids: existing.map((entry) => entry.id),
    });
  }

  const registrations = [];
  const activeDefinitions = [];
  const skipped = [];
  for (const definition of CREATOR_SCRIPT_DEFINITIONS) {
    const enabled = definition.toolIds.some(
      (toolId) => currentSettings.tools[toolId]?.enabled === true,
    );
    if (!enabled) continue;
    if (!(await hasAllOrigins(definition.origins))) {
      skipped.push({
        id: definition.id,
        reason: "required site access is not available",
      });
      continue;
    }
    registrations.push({
      id: definition.id,
      matches: definition.matches,
      js: definition.js,
      runAt: definition.runAt,
      allFrames: false,
      persistAcrossSessions: true,
      world: "ISOLATED",
    });
    activeDefinitions.push(definition);
  }
  if (registrations.length) {
    await chrome.scripting.registerContentScripts(registrations);
  }
  for (const definition of activeDefinitions.filter((entry) =>
    entry.toolIds.includes("uploadTraceRecorder"),
  )) {
    const tabs = await chrome.tabs.query({ url: definition.matches });
    for (const tab of tabs) {
      try {
        const frames = await chrome.webNavigation.getAllFrames({
          tabId: tab.id,
        });
        const mainFrame = frames?.find((frame) => frame.frameId === 0);
        if (
          !mainFrame?.documentId ||
          !creatorDefinitionMatchesUrl(definition, mainFrame.url)
        ) {
          continue;
        }
        await chrome.scripting.executeScript({
          target: {
            tabId: tab.id,
            documentIds: [mainFrame.documentId],
          },
          files: definition.js,
        });
      } catch (error) {
        console.warn(
          `Could not mount ${definition.id} in tab ${tab.id}.`,
          error,
        );
      }
    }
  }
  return {
    registered: registrations.map((entry) => entry.id),
    skipped,
  };
}

let creatorRegistrationSync = Promise.resolve();

function syncCreatorToolRegistrations(settings = null) {
  const next = creatorRegistrationSync
    .catch(() => {})
    .then(() => performCreatorToolRegistrationSync(settings));
  creatorRegistrationSync = next.catch(() => {});
  return next;
}

const CREATOR_UPLOAD_TARGETS = Object.freeze({
  onlyfans: Object.freeze({
    match: "https://onlyfans.com/*",
    landingUrl: "https://onlyfans.com/posts/create",
    origin: "https://onlyfans.com",
  }),
  fansly: Object.freeze({
    match: "https://fansly.com/*",
    landingUrl: "https://fansly.com/",
    origin: "https://fansly.com",
  }),
  manyvids: Object.freeze({
    match: "https://www.manyvids.com/*",
    landingUrl: "https://www.manyvids.com/upload-video",
    origin: "https://www.manyvids.com",
  }),
  pornhub: Object.freeze({
    match: "https://pornhub.mainhub.com/*",
    // Session bootstrap entry; execution is never injected into this origin.
    entryUrl: "https://www.pornhub.com/upload/videodata",
    landingUrl: "https://pornhub.mainhub.com/upload/uploader?site=ph",
    origin: "https://pornhub.mainhub.com",
  }),
});
const CREATOR_UPLOAD_PROBE_FILE = "workflows/upload-capability-probe.js";
let uploadConsoleOpening = null;
let uploadConsoleTabId = null;
let uploadConsoleTabPending = false;

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== uploadConsoleTabId) return;
  const consoleUrl = chrome.runtime.getURL("upload-console.html");
  if (changeInfo.url && changeInfo.url !== consoleUrl) {
    uploadConsoleTabId = null;
    uploadConsoleTabPending = false;
    return;
  }
  if (changeInfo.status === "complete") uploadConsoleTabPending = false;
});

async function waitForCreatorTab(tabId, timeoutMs = 20000) {
  await new Promise((resolve, reject) => {
    let timeout;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    timeout = setTimeout(
      () => finish(new Error("Timed out waiting for the platform tab.")),
      timeoutMs,
    );
    chrome.tabs
      .get(tabId)
      .then((current) => {
        if (current?.status === "complete") finish();
      })
      .catch(finish);
  });
}

function manyVidsRoute(url, stage) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://www.manyvids.com") return null;
    if (stage === "success" && /^\/upload-video\/?$/.test(parsed.pathname)) {
      return { url: parsed.href };
    }
    const edit = /^\/Edit-vid\/(\d+)\/?$/.exec(parsed.pathname);
    return stage === "edit" && edit
      ? { url: parsed.href, manyvidsId: edit[1] }
      : null;
  } catch {
    return null;
  }
}

async function waitForManyVidsRoute(tabId, stage, timeoutMs = 45 * 60_000) {
  if (!new Set(["edit", "success"]).has(stage)) {
    throw new Error("Invalid ManyVids navigation stage.");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve(result);
    };
    const inspect = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        const result =
          tab?.status === "complete" && manyVidsRoute(tab.url, stage);
        if (result) finish(null, result);
      } catch (error) {
        finish(error);
      }
    };
    const onUpdated = (updatedTabId) => {
      if (updatedTabId === tabId) inspect();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timeout = setTimeout(
      () =>
        finish(new Error(`Timed out waiting for the ManyVids ${stage} page.`)),
      timeoutMs,
    );
    inspect();
  });
}

function creatorUrlMatches(url, definition) {
  try {
    return new URL(url).origin === definition.origin;
  } catch {
    return false;
  }
}

const CREATOR_UPLOAD_SESSION_PATTERN = /^[a-f0-9]{48}$/;
const CREATOR_UPLOAD_FILE_BRIDGE = "workflows/upload-file-bridge.js";
const CREATOR_UPLOAD_ADAPTERS = "workflows/upload-platform-adapters.js";
const CREATOR_UPLOAD_RESPONSE_OBSERVER =
  "workflows/upload-response-observer.js";

function installCreatorUploadFileBridge(config) {
  if (
    globalThis.CreatorUploadPlatformAdapters?.revision !== "upload-hub-0.20.76"
  )
    throw new Error(
      "Stale Upload Hub page runtime. Review existing uploads, reload the extension and this page, then prepare again. No new file was delivered.",
    );
  return globalThis.CreatorUploadFileBridge.install(config);
}

function installCreatorUploadResponseObserver(config) {
  return globalThis.CreatorUploadResponseObserver.install(config);
}

function markCreatorToolkitMasterRun() {
  globalThis.CreatorToolkitMasterRun = true;
}

function cancelCreatorUploadResponseObserverInPage(config) {
  globalThis.CreatorUploadResponseObserver?.cancel(
    config.sessionId,
    config.platform,
  );
}
const creatorUploadSessions = new Map();
const creatorUploadPreparations = new Set();
const creatorUploadConsolePorts = new Set();
const creatorUploadFileRequests = new Map();
let creatorUploadForeground = null;
let creatorUploadRequestCounter = 0;
const CREATOR_UPLOAD_TERMINAL_STATUSES = new Set([
  "recorded-local",
  "catalogue-updated",
  "uploaded-no-sheet",
  "manual-submit-required",
  "already-linked",
  "idempotent",
]);

async function assertCreatorUploadPageBinding(session, target, sender) {
  const facts = {
    active: Boolean(session && !session.cancelled),
    topFrame: sender?.frameId === 0,
    tabMatch: Boolean(target && sender?.tab?.id === target.tabId),
    documentMatch: Boolean(
      sender?.documentId && target?.documentId === sender.documentId,
    ),
    routeMatch: Boolean(target?.boundUrl && sender?.url === target.boundUrl),
  };
  const refuse = (code) => {
    throw Object.assign(new Error(code), {
      rejectionCode: code,
      bindingFacts: facts,
    });
  };
  if (
    !facts.active ||
    !facts.topFrame ||
    !facts.tabMatch ||
    !facts.documentMatch ||
    !target.boundUrl
  )
    refuse("upload-page-binding-unauthorized");
  const port = creatorUploadPort(session.id);
  if (!port || session.executionPort !== port)
    refuse("upload-connection-changed");
  const originalUrl = target.boundUrl;
  const alias =
    target.platform === "fansly" &&
    ["https://fansly.com/", "https://fansly.com/home"].includes(originalUrl) &&
    ["https://fansly.com/", "https://fansly.com/home"].includes(sender.url);
  if (!facts.routeMatch && !alias) refuse("upload-page-binding-route-mismatch");
  const inspectFrame = async () => {
    const frames = await chrome.webNavigation.getAllFrames({
      tabId: target.tabId,
    });
    const frame = frames?.find((item) => item.frameId === 0);
    if (
      session.cancelled ||
      creatorUploadPort(session.id) !== port ||
      session.executionPort !== port ||
      target.documentId !== sender.documentId ||
      (target.boundUrl !== originalUrl &&
        !(
          alias &&
          ["https://fansly.com/", "https://fansly.com/home"].includes(
            target.boundUrl,
          )
        )) ||
      frame?.documentId !== sender.documentId ||
      (frame?.url !== sender.url &&
        !(
          alias &&
          ["https://fansly.com/", "https://fansly.com/home"].includes(
            frame?.url,
          )
        ))
    )
      refuse("upload-page-binding-changed");
  };
  await inspectFrame();
  if (alias) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [sender.documentId] },
      func: (id) => {
        const composer = globalThis.CreatorFanslyComposers?.get(id);
        const candidates = [
          ...document.querySelectorAll("app-post-creation"),
        ].filter((node) => node.isConnected && node.getClientRects().length);
        return {
          url: location.href,
          owned: Boolean(
            composer &&
            composer.isConnected &&
            candidates.length === 1 &&
            candidates[0] === composer,
          ),
        };
      },
      args: [session.id],
    });
    // Chrome MessageSender.url retains the document's initial URL after pushState.
    // Verify the live homepage alias and original composer in the exact document.
    if (
      result?.frameId !== 0 ||
      result?.documentId !== sender.documentId ||
      !["https://fansly.com/", "https://fansly.com/home"].includes(
        result?.result?.url,
      ) ||
      result?.result?.owned !== true
    )
      refuse("upload-page-binding-composer-changed");
    await inspectFrame();
    target.boundUrl = result.result.url;
  }
}

function creatorUploadSessionRecord(session) {
  return {
    id: session.id,
    launcher: session.launcher,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    draft: session.draft,
    catalogue: session.catalogue,
    platforms: Object.fromEntries(
      [...session.platforms].map(([platform, target]) => [
        platform,
        {
          platform,
          tabId: target.tabId,
          stage: target.stage,
          status: target.status,
          createdAt: target.createdAt,
          updatedAt: target.updatedAt,
          manyvidsId: target.manyvidsId,
          commitArmed: target.commitArmed,
          submitAttempted: target.submitAttempted,
          postUrl: target.postUrl,
          error: target.error,
          documentId: target.documentId,
          boundUrl: target.boundUrl,
          progressSequence: target.progressSequence,
          progressStage: target.progressStage,
          editorHandoff: target.editorHandoff,
        },
      ]),
    ),
  };
}

async function checkpointCreatorUploadSession(session) {
  session.updatedAt = Date.now();
  for (const target of session.platforms.values()) {
    if (!target.createdAt) target.createdAt = session.createdAt;
    target.updatedAt = session.updatedAt;
  }
  const saved = await CREATOR_UPLOAD_SESSION_STORE.save(
    creatorUploadSessionRecord(session),
  );
  if (
    session.platforms.size > 0 &&
    [...session.platforms.values()].every((target) =>
      CREATOR_UPLOAD_TERMINAL_STATUSES.has(target.status),
    )
  ) {
    await CREATOR_UPLOAD_SESSION_STORE.remove(session.id);
  }
  return saved;
}

async function ensureCreatorUploadRuntimeVersion() {
  return CREATOR_UPLOAD_SESSION_STORE.ensureRuntimeVersion(
    chrome.runtime.getManifest().version,
  );
}

async function getCreatorUploadSession(sessionId) {
  await ensureCreatorUploadRuntimeVersion();
  const id = creatorUploadClean(sessionId, 64);
  if (!CREATOR_UPLOAD_SESSION_PATTERN.test(id)) return null;
  const active = creatorUploadSessions.get(id);
  if (active) return active;
  const stored = await CREATOR_UPLOAD_SESSION_STORE.load(id);
  // Durable final-action receipts remain reviewable, but are not executable drafts.
  if (!stored?.draft) return null;
  const session = {
    id,
    createdAt: stored.createdAt || Date.now(),
    updatedAt: stored.updatedAt || Date.now(),
    draft: stored.draft || {},
    catalogue: stored.catalogue ?? null,
    launcher: stored.launcher || "extension",
    platforms: new Map(Object.entries(stored.platforms || {})),
    commitChain: Promise.resolve(),
    cleanupTimer: null,
    restored: true,
  };
  for (const target of session.platforms.values()) {
    if (target.submitAttempted && !target.postUrl) {
      target.status = "posted-link-unresolved";
      target.error =
        "The restored platform submission may already exist; recover its link manually.";
    } else if (
      new Set([
        "uploading-full",
        "upload-observing",
        "upload-progress-unknown",
        "upload-ready",
        "edit-requested",
        "configuring",
        "waiting-for-teaser",
        "waiting-for-thumbnail",
      ]).has(target.status)
    ) {
      target.status = target.manyvidsId ? "edit-failed" : "failed";
      target.error = target.manyvidsId
        ? "The extension worker restarted. Resume this exact ManyVids editor after verifying the open draft."
        : "The extension worker restarted before submission. Retry after verifying the open draft.";
    }
  }
  creatorUploadSessions.set(id, session);
  await checkpointCreatorUploadSession(session);
  session.cleanupTimer = setTimeout(
    () => creatorUploadSessions.delete(id),
    2 * 60 * 60_000,
  );
  return session;
}

function creatorUploadSessionProofMatches(session, proof) {
  if (!session?.draft || !proof || typeof proof !== "object") return false;
  for (const role of ["full", "teaser", "thumbnail", "pornhub"]) {
    const expected = session.draft.fileProof?.[role];
    if (!expected) continue;
    const actual = proof.fileProof?.[role];
    if (
      !actual ||
      actual.name !== expected.name ||
      actual.size !== expected.size ||
      actual.lastModified !== expected.lastModified ||
      actual.type !== expected.type
    )
      return false;
  }
  return (
    creatorUploadClean(proof.fullFilename, 500) ===
      session.draft.fullFilename &&
    creatorUploadClean(proof.pornhubFilename, 500) ===
      session.draft.pornhubFilename &&
    (proof.manyvidsThumbnail === true) ===
      (session.draft.manyvidsThumbnail === true) &&
    (proof.pornhubThumbnail === true) ===
      (session.draft.pornhubThumbnail === true) &&
    (proof.pornhubMode || "free") === (session.draft.pornhubMode || "free") &&
    (creatorUploadClean(proof.profileSignature, 50_000) ===
      session.draft.profileSignature ||
      creatorUploadClean(proof.profileSignature, 50_000) ===
        session.draft.legacyProfileSignature)
  );
}

function creatorUploadClean(value, maximum) {
  return String(value || "")
    .trim()
    .slice(0, maximum);
}

function creatorUploadResumeFileProof(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid upload file proof.");
  const proof = {};
  for (const role of ["full", "teaser", "thumbnail", "pornhub"]) {
    const item = value[role];
    if (item == null) continue;
    const name = creatorUploadClean(item.name, 500);
    if (
      !name ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0 ||
      !Number.isSafeInteger(item.lastModified) ||
      item.lastModified <= 0
    )
      throw new Error("Invalid upload file proof.");
    proof[role] = {
      name,
      size: item.size,
      lastModified: item.lastModified,
      type: creatorUploadClean(item.type, 100),
    };
  }
  return proof;
}

async function validateCreatorUploadRequest(message) {
  if (
    !["manual", "autonomous"].includes(message.draft?.publishMode ?? "manual")
  )
    throw new Error("Invalid publishing mode.");
  const sessionId = creatorUploadClean(message?.sessionId, 64);
  if (!CREATOR_UPLOAD_SESSION_PATTERN.test(sessionId)) {
    throw new Error("Invalid creator upload session.");
  }
  const targets = Array.isArray(message.targets)
    ? [...new Set(message.targets)]
    : [];
  if (
    !targets.length ||
    targets.length !== message.targets.length ||
    targets.some(
      (platform) =>
        typeof platform !== "string" ||
        !Object.hasOwn(CREATOR_UPLOAD_TARGETS, platform),
    )
  ) {
    throw new Error("Choose an allow-listed upload platform.");
  }
  const draft = {
    title: creatorUploadClean(message.draft?.title, 500),
    description: creatorUploadClean(message.draft?.description, 10_000),
    fullFilename: creatorUploadClean(message.draft?.fullFilename, 500),
    releaseDate: creatorUploadClean(message.draft?.releaseDate, 10),
    scheduledIso: creatorUploadClean(message.draft?.scheduledIso, 40),
    timeZone: creatorUploadClean(message.draft?.timeZone, 100),
    fanslyPreset: creatorUploadClean(message.draft?.fanslyPreset, 100),
    fanslyPresetSelection:
      message.draft?.fanslyPresetSelection === "first" ? "first" : "exact",
    manyvidsThumbnail: message.draft?.manyvidsThumbnail === true,
    pornhubThumbnail: message.draft?.pornhubThumbnail === true,
    pornhubMode: creatorUploadClean(message.draft?.pornhubMode || "free", 10),
    pornhubCertificationsConfirmed:
      message.draft?.pornhubCertificationsConfirmed === true,
    hasTeaser: message.draft?.hasTeaser !== false,
    publishMode: message.draft?.publishMode ?? "manual",
    pornhubFilename: creatorUploadClean(message.draft?.pornhubFilename, 500),
    fileProof: creatorUploadResumeFileProof(message.draft?.fileProof),
    contentPreset: creatorUploadClean(message.draft?.contentPreset, 100),
    fanslyCaption: creatorUploadClean(message.draft?.fanslyCaption, 15_000),
  };
  const normalizedProfiles = CREATOR_REGISTRY.normalizeSettings({
    profiles: message.draft?.profiles,
  }).value.profiles;
  draft.profiles = {
    fanslyPrefill: normalizedProfiles.fanslyPrefill,
    manyvidsAutofill: normalizedProfiles.manyvidsAutofill,
    phUploader: normalizedProfiles.phUploader,
  };
  draft.profileSignature = await CREATOR_REGISTRY.uploadProfileSignature(
    draft.profiles,
  );
  const providedProfileSignature = creatorUploadClean(
    message.draft?.profileSignature,
    50_000,
  );
  const legacyProfileSignature = creatorUploadClean(
    JSON.stringify(draft.profiles),
    50_000,
  );
  if (
    providedProfileSignature &&
    providedProfileSignature !== draft.profileSignature &&
    providedProfileSignature !== legacyProfileSignature
  ) {
    throw new Error(
      "Creator workflow profiles changed during preflight. Review the settings and click Upload again.",
    );
  }
  if (providedProfileSignature === legacyProfileSignature) {
    draft.legacyProfileSignature = legacyProfileSignature;
  }
  if (
    (draft.fileProof.full &&
      draft.fileProof.full.name !== draft.fullFilename) ||
    (draft.fileProof.pornhub &&
      draft.fileProof.pornhub.name !== draft.pornhubFilename) ||
    (draft.fileProof.thumbnail &&
      !draft.manyvidsThumbnail &&
      !draft.pornhubThumbnail) ||
    (draft.fileProof.teaser && !draft.hasTeaser)
  )
    throw new Error("Upload file proof does not match the selected draft.");
  const scheduled = new Date(draft.scheduledIso);
  if (
    !draft.title ||
    !/^\d{4}-\d{2}-\d{2}$/.test(draft.releaseDate) ||
    Number.isNaN(scheduled.getTime()) ||
    scheduled.toISOString().slice(0, 10) !== draft.releaseDate ||
    scheduled.getUTCDay() !== 5 ||
    scheduled.getUTCHours() !== 15 ||
    scheduled.getUTCMinutes() !== 0 ||
    scheduled.getUTCSeconds() !== 0
  ) {
    throw new Error("Creator uploads must target Friday at 15:00 UTC.");
  }
  if (
    targets.includes("fansly") &&
    draft.fanslyPresetSelection !== "first" &&
    draft.fanslyPreset !== "defaulT"
  ) {
    throw new Error("Fansly full media requires the exact defaulT preset.");
  }
  if (targets.includes("fansly") && !draft.fanslyCaption) {
    draft.fanslyCaption = draft.description;
  }
  if (targets.includes("pornhub")) {
    if (!["free", "paid"].includes(draft.pornhubMode))
      throw new Error("Invalid MainHub video type.");
    if (
      Object.hasOwn(message.draft || {}, "pornhubCertificationsConfirmed") &&
      typeof message.draft.pornhubCertificationsConfirmed !== "boolean"
    )
      throw new Error("Invalid Pornhub certification authorization.");
    if (draft.pornhubMode === "paid") {
      if (draft.pornhubThumbnail)
        throw new Error("Pay To View does not offer custom thumbnails.");
      const price = Number(draft.profiles.manyvidsAutofill.price);
      if (!Number.isFinite(price) || price <= 0)
        throw new Error(
          "Pay To View requires a positive saved ManyVids price.",
        );
      const tags = draft.profiles.phUploader.presets[draft.contentPreset]?.tags;
      if (!Array.isArray(tags) || tags.length < 2)
        throw new Error("Pay To View requires at least two preset tags.");
    }
    if (
      Object.hasOwn(message.draft || {}, "pornhubThumbnail") &&
      typeof message.draft.pornhubThumbnail !== "boolean"
    ) {
      throw new Error("Invalid Pornhub thumbnail selection.");
    }
    if (!draft.pornhubFilename || !draft.contentPreset) {
      throw new Error(
        "Pornhub preparation requires a file and content preset.",
      );
    }
    if (
      !Object.hasOwn(draft.profiles.phUploader.presets, draft.contentPreset)
    ) {
      throw new Error("Pornhub content preset is unavailable.");
    }
  }
  if (targets.includes("manyvids")) {
    if (!draft.fullFilename) {
      throw new Error("ManyVids requires the selected full-video filename.");
    }
    if (
      Object.hasOwn(message.draft || {}, "manyvidsThumbnail") &&
      typeof message.draft.manyvidsThumbnail !== "boolean"
    ) {
      throw new Error("Invalid ManyVids thumbnail selection.");
    }
  }
  // Only an explicit upload-only confirmation may omit catalogue validation.
  if (message.catalogue === null) {
    return { sessionId, targets, draft, catalogue: null };
  }
  const catalogue = {
    source: message.catalogue?.source === "desktop" ? "desktop" : "legacy",
    itemId: creatorUploadClean(message.catalogue?.itemId, 200),
    repeatPlatforms:
      message.catalogue?.source === "desktop" &&
      Array.isArray(message.catalogue?.repeatPlatforms)
        ? [...new Set(message.catalogue.repeatPlatforms)].filter(
            (platform) =>
              targets.includes(platform) &&
              ["onlyfans", "fansly", "manyvids", "pornhub"].includes(platform),
          )
        : [],
    publicationState: Object.fromEntries(
      ["pornhub", "onlyfans", "fansly", "manyvids"].map((platform) => [
        platform,
        new Set(["empty", "published", "review"]).has(
          message.catalogue?.publicationState?.[platform],
        )
          ? message.catalogue.publicationState[platform]
          : "empty",
      ]),
    ),
    row: Number(message.catalogue?.row),
    id: creatorUploadClean(message.catalogue?.id, 500),
    releaseDate: creatorUploadClean(message.catalogue?.releaseDate, 10),
    title: creatorUploadClean(message.catalogue?.title, 500),
    description: creatorUploadClean(message.catalogue?.description, 10_000),
    seasonArc: creatorUploadClean(message.catalogue?.seasonArc, 500),
    episode: creatorUploadClean(message.catalogue?.episode, 40),
    pornhubLink: creatorUploadClean(message.catalogue?.pornhubLink, 500),
    onlyfansLink: creatorUploadClean(message.catalogue?.onlyfansLink, 500),
    fanslyLink: creatorUploadClean(message.catalogue?.fanslyLink, 500),
    manyvidsLink: creatorUploadClean(message.catalogue?.manyvidsLink, 500),
    fingerprint: creatorUploadClean(message.catalogue?.fingerprint, 64),
    status: creatorUploadClean(message.catalogue?.status, 20),
  };
  const catalogueRelease = new Date(`${catalogue.releaseDate}T15:00:00.000Z`);
  if (
    !Number.isInteger(catalogue.row) ||
    catalogue.row < 2 ||
    catalogue.row > 5002 ||
    !catalogue.id ||
    !catalogue.title ||
    !new Set(["matched", "new"]).has(catalogue.status) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(catalogue.releaseDate) ||
    Number.isNaN(catalogueRelease.getTime()) ||
    catalogueRelease.toISOString().slice(0, 10) !== catalogue.releaseDate ||
    (catalogue.status === "new" &&
      catalogue.releaseDate !== draft.releaseDate) ||
    !/^[a-f0-9]{8,64}$/i.test(catalogue.fingerprint)
  ) {
    throw new Error("Invalid catalogue upload preview.");
  }
  if (
    catalogue.repeatPlatforms.length &&
    message.type !== "CHECK_CREATOR_UPLOAD_AVAILABILITY" &&
    message.catalogue?.repeatUploadConfirmed !== true
  )
    throw new Error("Confirm uploading another copy before continuing.");
  for (const platform of ["pornhub", "onlyfans", "fansly", "manyvids"]) {
    if (
      targets.includes(platform) &&
      message.catalogue?.publicationState?.[platform] === "review"
    )
      throw new Error(
        `Review the existing ${platform} catalogue links before uploading.`,
      );
    const field = `${platform}Link`;
    const raw = catalogue[field];
    const canonical = raw
      ? CREATOR_CATALOGUE_CONTRACT.canonicalPostUrl(platform, raw)
      : "";
    if (raw && !canonical) {
      throw new Error(`Invalid ${platform} catalogue link.`);
    }
    catalogue[field] = canonical;
    if (
      targets.includes(platform) &&
      canonical &&
      !catalogue.repeatPlatforms.includes(platform)
    ) {
      const label = {
        pornhub: "Pornhub",
        onlyfans: "OnlyFans",
        fansly: "Fansly",
        manyvids: "ManyVids",
      }[platform];
      throw new Error(`Catalogue row already has a ${label} link.`);
    }
  }
  return { sessionId, targets, draft, catalogue };
}

async function focusCreatorUploadObservation(session, target, sender) {
  await assertCreatorUploadPageBinding(session, target, sender);
  if (
    target.platform !== "manyvids" ||
    target.stage !== "upload" ||
    target.boundUrl !== "https://www.manyvids.com/upload-video" ||
    target.submitAttempted ||
    target.submitted ||
    target.editorHandoff ||
    ![
      "uploading-full",
      "upload-observing",
      "upload-progress-unknown",
      "upload-ready",
    ].includes(target.status)
  )
    throw new Error(
      "ManyVids [foreground-observation]: This document is not an active owned upload observation.",
    );
  const interactiveStages = new Set([
    "configuring",
    "waiting-for-teaser",
    "waiting-for-thumbnail",
    "upload-ready",
    "edit-requested",
  ]);
  const interactionBusy = () =>
    creatorUploadFileRequests.size > 0 ||
    [...session.platforms.values()].some(
      (other) => other !== target && interactiveStages.has(other.status),
    );
  if (creatorUploadForeground || interactionBusy())
    return { focused: false, deferred: true };
  let release;
  const lease = new Promise((resolve) => {
    release = resolve;
  });
  creatorUploadForeground = lease;
  try {
    const tab = await chrome.tabs.get(target.tabId);
    await assertCreatorUploadPageBinding(session, target, sender);
    if (
      !Number.isSafeInteger(tab?.windowId) ||
      tab.windowId < 0 ||
      tab.id !== target.tabId ||
      tab.url !== target.boundUrl
    )
      throw new Error(
        "ManyVids [foreground-observation]: The owned tab/window changed.",
      );
    if (interactionBusy()) return { focused: false, deferred: true };
    const window = await chrome.windows.get(tab.windowId);
    await assertCreatorUploadPageBinding(session, target, sender);
    if (interactionBusy()) return { focused: false, deferred: true };
    if (!tab.active) {
      await chrome.tabs.update(target.tabId, { active: true });
      await assertCreatorUploadPageBinding(session, target, sender);
    }
    if (!window.focused) {
      const beforeFocus = await chrome.tabs.get(target.tabId);
      await assertCreatorUploadPageBinding(session, target, sender);
      if (
        beforeFocus.id !== target.tabId ||
        beforeFocus.windowId !== tab.windowId ||
        beforeFocus.url !== target.boundUrl ||
        !beforeFocus.active
      )
        throw new Error(
          "ManyVids [foreground-observation]: The upload tab/window changed before window activation; no window was focused.",
        );
      if (interactionBusy()) return { focused: false, deferred: true };
      await chrome.windows.update(tab.windowId, { focused: true });
      await assertCreatorUploadPageBinding(session, target, sender);
    }
    const current = await chrome.tabs.get(target.tabId);
    const focusedWindow = await chrome.windows.get(tab.windowId);
    await assertCreatorUploadPageBinding(session, target, sender);
    if (
      current.id !== target.tabId ||
      current.windowId !== tab.windowId ||
      !current.active ||
      !focusedWindow.focused
    )
      throw new Error(
        "ManyVids [foreground-observation]: Chrome did not focus the upload tab. Activate that existing tab; no upload or Edit action was repeated.",
      );
    return { focused: true };
  } finally {
    if (creatorUploadForeground === lease) creatorUploadForeground = null;
    release();
  }
}

function creatorUploadRandomToken() {
  const values = crypto.getRandomValues(new Uint8Array(24));
  return [...values]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function creatorUploadPort(sessionId) {
  return [...creatorUploadConsolePorts].find(
    (port) => port.creatorUploadSessionId === sessionId,
  );
}

function creatorSocialPort(sessionId) {
  return [...creatorUploadConsolePorts].find(
    (port) =>
      port.creatorSocialSessionId === sessionId ||
      port.creatorUploadSessionId === sessionId,
  );
}

function creatorUploadPost(sessionId, message) {
  const port = creatorUploadPort(sessionId);
  if (!port) throw new Error("The upload console is not connected.");
  try {
    port.postMessage({ sessionId, ...message });
  } catch {
    throw new Error("The upload port disconnected.");
  }
}

function creatorUploadRequestFile(session, platform, role) {
  const target = session.platforms.get(platform);
  const token = target?.tokens?.[role];
  if (!token)
    return Promise.reject(
      new Error("The requested upload file role is unavailable."),
    );
  const port = creatorUploadPort(session.id);
  if (!port) return Promise.reject(new Error("The upload console was closed."));
  target.requestedRoles ||= new Set();
  if (target.requestedRoles.has(role))
    return Promise.reject(
      new Error(
        "This upload role has already been requested; inspect its existing attachment.",
      ),
    );
  target.requestedRoles.add(role);
  creatorUploadRequestCounter += 1;
  const requestId = `${session.id}:${creatorUploadRequestCounter}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      creatorUploadFileRequests.delete(requestId);
      reject(
        new Error(
          `Timed out waiting for the ${role} video in the upload console.`,
        ),
      );
    }, 60 * 60_000);
    creatorUploadFileRequests.set(requestId, {
      port,
      sessionId: session.id,
      platform,
      role,
      token,
      tabId: target.tabId,
      documentId: target.documentId,
      boundUrl: target.boundUrl,
      resolve,
      reject,
      timeout,
    });
    port.postMessage({
      type: "file-request",
      sessionId: session.id,
      requestId,
      platform,
      role,
      token,
    });
  });
}

async function creatorSocialRequestFile({
  sessionId,
  platform,
  role,
  token,
  tabId,
}) {
  while (creatorUploadForeground) await creatorUploadForeground;
  if (
    !["x", "redgifs"].includes(platform) ||
    role !== "social" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(String(token || ""))
  ) {
    return Promise.reject(new Error("Invalid social teaser file request."));
  }
  const port = creatorSocialPort(sessionId);
  if (!port) return Promise.reject(new Error("The upload console was closed."));
  creatorUploadRequestCounter += 1;
  const requestId = `${sessionId}:social:${creatorUploadRequestCounter}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      creatorUploadFileRequests.delete(requestId);
      reject(new Error("Timed out waiting for the social teaser."));
    }, 60 * 60_000);
    creatorUploadFileRequests.set(requestId, {
      port,
      sessionId,
      platform,
      role,
      token,
      tabId,
      resolve,
      reject,
      timeout,
    });
    port.postMessage({
      type: "file-request",
      sessionId,
      requestId,
      platform,
      role,
      token,
    });
  });
}

async function resolveCreatorPaidUploadLink(dependency) {
  const session = await getCreatorUploadSession(dependency.uploadSessionId);
  const target = session?.platforms.get(dependency.platform);
  return target?.postUrl
    ? {
        platform: dependency.platform,
        uploadSessionId: dependency.uploadSessionId,
        postUrl: target.postUrl,
      }
    : null;
}

let creatorSocialRuntime = null;

function getCreatorSocialRuntime() {
  creatorSocialRuntime ||= globalThis.CreatorSocialChromeRuntime.create({
    chrome,
    contract: CREATOR_SOCIAL_CONTRACT,
    store: CREATOR_SOCIAL_SESSION_STORE,
    orchestratorFactory: CREATOR_SOCIAL_ORCHESTRATOR,
    catalogueClient: CREATOR_CATALOGUE_CLIENT,
    fileRequest: creatorSocialRequestFile,
    resolvePaidLink: resolveCreatorPaidUploadLink,
  });
  return creatorSocialRuntime;
}

function creatorUploadHandlePortMessage(port, message) {
  if (message?.type === "bind-social-session") {
    const sessionId = creatorUploadClean(message.sessionId, 64);
    if (!CREATOR_UPLOAD_SESSION_PATTERN.test(sessionId)) {
      port.disconnect();
      return;
    }
    port.creatorSocialSessionId = sessionId;
    return;
  }
  if (message?.type === "bind-session") {
    const sessionId = creatorUploadClean(message.sessionId, 64);
    if (!CREATOR_UPLOAD_SESSION_PATTERN.test(sessionId)) {
      port.disconnect();
      return;
    }
    port.creatorUploadSessionId = sessionId;
    void getCreatorUploadSession(sessionId)
      .then((session) => {
        if (!session) {
          port.postMessage({
            type: "session-bound",
            sessionId,
            existing: false,
          });
          return;
        }
        if (!creatorUploadSessionProofMatches(session, message.proof)) {
          port.creatorUploadSessionId = "";
          port.postMessage({
            type: "session-restore-rejected",
            sessionId,
            error:
              "The open Master Uploader draft no longer matches the persisted upload plan.",
          });
          return;
        }
        if (
          session.executionPort &&
          session.executionPort !== port &&
          creatorUploadConsolePorts.has(session.executionPort)
        ) {
          port.creatorUploadSessionId = "";
          port.postMessage({
            type: "session-restore-rejected",
            sessionId,
            error: "This upload is already connected in another console tab.",
          });
          return;
        }
        session.executionPort = port;
        port.postMessage({ type: "session-bound", sessionId, existing: true });
        port.postMessage({
          type: "session-restored",
          sessionId,
          platforms: [...session.platforms.values()].map((target) => ({
            platform: target.platform,
            stage: target.stage,
            status: target.status,
            postUrl: target.postUrl,
            manyvidsId: target.manyvidsId,
            error: target.error,
          })),
        });
      })
      .catch((error) => {
        console.error("Upload console binding failed.", error);
        try {
          port.postMessage({
            type: "session-restore-rejected",
            sessionId,
            error: error.message,
          });
        } catch (closed) {
          console.warn(
            "Upload console closed before binding failure could be delivered.",
            closed,
          );
        }
      });
    return;
  }
  if (message?.type !== "file-response") return;
  const pending = creatorUploadFileRequests.get(message.requestId);
  if (!pending || pending.port !== port) return;
  clearTimeout(pending.timeout);
  creatorUploadFileRequests.delete(message.requestId);
  if (message.ok) pending.resolve();
  else
    pending.reject(
      new Error(
        creatorUploadClean(message.error, 500) || "Video transfer failed.",
      ),
    );
}

chrome.runtime.onConnect?.addListener((port) => {
  if (port.name !== "creator-upload-console") return;
  if (port.sender?.url !== chrome.runtime.getURL("upload-console.html")) {
    port.disconnect();
    return;
  }
  creatorUploadConsolePorts.add(port);
  port.onMessage.addListener((message) =>
    creatorUploadHandlePortMessage(port, message),
  );
  port.onDisconnect.addListener(() => {
    creatorUploadConsolePorts.delete(port);
    for (const [requestId, pending] of creatorUploadFileRequests) {
      if (pending.port !== port) continue;
      clearTimeout(pending.timeout);
      pending.reject(new Error("The upload console was closed."));
      creatorUploadFileRequests.delete(requestId);
    }
  });
});

async function probeCreatorUploadTarget(platform) {
  const supported =
    typeof platform === "string" &&
    Object.hasOwn(CREATOR_UPLOAD_TARGETS, platform);
  if (!supported) return { platform, status: "unsupported" };
  const definition = CREATOR_UPLOAD_TARGETS[platform];

  try {
    const matches = await chrome.tabs.query({ url: definition.match });
    if (matches.length > 1) {
      return { platform, status: "ambiguous-tabs", tabCount: matches.length };
    }
    const created = matches.length === 0;
    const tab = created
      ? await chrome.tabs.create({ url: definition.landingUrl, active: true })
      : await chrome.tabs.update(matches[0].id, { active: true });
    if (created) await waitForCreatorTab(tab.id);

    const beforeProbe = await chrome.tabs.get(tab.id);
    if (!creatorUrlMatches(beforeProbe?.url, definition)) {
      throw new Error(
        "The platform tab left its expected origin before inspection.",
      );
    }
    const execution = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [CREATOR_UPLOAD_PROBE_FILE],
    });
    const report = execution?.[0]?.result;
    if (!report || typeof report.status !== "string") {
      throw new Error("The platform probe returned no capability report.");
    }
    const afterProbe = await chrome.tabs.get(tab.id);
    if (
      !creatorUrlMatches(afterProbe?.url, definition) ||
      report.platform !== platform ||
      !creatorUrlMatches(report.route, definition)
    ) {
      throw new Error("The platform tab changed origin during inspection.");
    }
    return {
      ...report,
      tabId: tab.id,
      tabAction: created ? "opened" : "reused",
    };
  } catch (error) {
    return {
      platform,
      status: /timed out/i.test(error.message)
        ? "load-timeout"
        : "probe-failed",
      error: error.message,
    };
  }
}

async function probeCreatorUploadTargets(targets) {
  const results = [];
  for (const platform of Array.isArray(targets) ? targets : []) {
    results.push(await probeCreatorUploadTarget(platform));
  }
  return results;
}

function creatorPornhubUploaderRoute(value) {
  try {
    const url = new URL(value);
    const query = [...url.searchParams];
    return (
      url.origin === "https://pornhub.mainhub.com" &&
      url.pathname === "/upload/uploader" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (query.length === 0 ||
        (query.length === 1 && query[0][0] === "site" && query[0][1] === "ph"))
    );
  } catch {
    return false;
  }
}

async function resolveCreatorPornhubDocument(tabId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const main = (frames || []).filter((frame) => frame.frameId === 0);
    if (main.length > 1)
      throw new Error(
        "Pornhub [uploader-acquisition]: The top-frame document is ambiguous.",
      );
    const frame = main[0];
    if (frame?.documentId && creatorPornhubUploaderRoute(frame.url))
      return frame;
    if (frame?.url && frame.url !== "about:blank") {
      let url;
      try {
        url = new URL(frame.url);
      } catch {
        throw new Error(
          "Pornhub [uploader-acquisition]: Untrusted redirect origin; no file was delivered.",
        );
      }
      if (
        !["https://www.pornhub.com", "https://pornhub.mainhub.com"].includes(
          url.origin,
        ) ||
        url.username ||
        url.password
      )
        throw new Error(
          "Pornhub [uploader-acquisition]: Untrusted redirect origin; no file was delivered.",
        );
      if (
        /^\/(?:login|signin|sign-in|auth)(?:\/|$)/i.test(url.pathname) ||
        (url.origin === "https://www.pornhub.com" && url.pathname === "/")
      )
        throw new Error(
          "Pornhub [uploader-acquisition]: Authentication did not reach the uploader. Sign in, open Upload Video, and retry preparation; no file was delivered.",
        );
      if (
        frame.url !== CREATOR_UPLOAD_TARGETS.pornhub.entryUrl &&
        !creatorPornhubUploaderRoute(frame.url)
      )
        throw new Error(
          "Pornhub [uploader-acquisition]: Unsupported uploader route or page. Open Upload Video in the signed-in session and capture a trace; no file was delivered.",
        );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Pornhub [uploader-acquisition]: Timed out resolving the authenticated uploader document. Sign in and inspect Upload Video; no file was delivered.",
  );
}

async function inspectCreatorPornhubUploader(expectedUrl) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (window !== top || location.href !== expectedUrl)
      throw new Error(
        "Pornhub [uploader-capability]: The uploader document binding changed.",
      );
    let proof;
    try {
      proof = globalThis.CreatorUploadPlatformAdapters.inspectPornhubUploader();
    } catch (error) {
      throw new Error(`Pornhub [uploader-capability]: ${error.message}`, {
        cause: error,
      });
    }
    if (proof?.uploader === true && proof.deviceActions === 1) return proof;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Pornhub [uploader-capability]: The current page has no unique device-upload capability. Sign in, use Upload Video and capture a trace; no file was delivered.",
  );
}

async function prepareCreatorUploadPlatform(session, platform, tabId = null) {
  const definition = CREATOR_UPLOAD_TARGETS[platform];
  const existing = tabId
    ? [await chrome.tabs.get(tabId)]
    : await chrome.tabs.query({ url: definition.match });
  // Do not navigate away from an unrelated, possibly occupied MainHub uploader.
  const useExisting =
    existing.length === 1 && (platform !== "pornhub" || tabId !== null);
  const navigationUrl = definition.entryUrl || definition.landingUrl;
  const tab = useExisting
    ? await chrome.tabs.update(existing[0].id, {
        active: true,
        url: navigationUrl,
      })
    : await chrome.tabs.create({ url: navigationUrl, active: true });
  await waitForCreatorTab(tab.id);
  const loaded = await chrome.tabs.get(tab.id);
  if (platform !== "pornhub" && !creatorUrlMatches(loaded?.url, definition)) {
    throw new Error(
      `${platform} left its expected origin before upload preparation.`,
    );
  }
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  const frame =
    platform === "pornhub"
      ? await resolveCreatorPornhubDocument(tab.id)
      : frames?.find((item) => item.frameId === 0);
  if (
    !frame?.documentId ||
    (platform !== "pornhub" &&
      frame.url !== definition.landingUrl &&
      !(platform === "fansly" && frame.url === "https://fansly.com/home"))
  )
    throw new Error("The exact upload route or document is unavailable.");
  const injectionTarget = { tabId: tab.id, documentIds: [frame.documentId] };
  const tokens =
    platform === "pornhub"
      ? {
          pornhub: creatorUploadRandomToken(),
          ...(session.draft.pornhubThumbnail
            ? { thumbnail: creatorUploadRandomToken() }
            : {}),
        }
      : {
          full: creatorUploadRandomToken(),
          ...(["fansly", "manyvids"].includes(platform) &&
          session.draft.hasTeaser !== false
            ? { teaser: creatorUploadRandomToken() }
            : {}),
          ...(platform === "manyvids" && session.draft.manyvidsThumbnail
            ? { thumbnail: creatorUploadRandomToken() }
            : {}),
        };
  const roles =
    platform === "pornhub"
      ? {
          pornhub: {
            selector: "input.dz-hidden-input[type='file']",
            token: tokens.pornhub,
            kind: "video",
          },
          ...(tokens.thumbnail
            ? {
                thumbnail: {
                  selector:
                    "v-upload-video-details[form-id] form.video-details-form .custom-thumbnails.pcView input.uploadFile[type='file']",
                  token: tokens.thumbnail,
                  kind: "image",
                },
              }
            : {}),
        }
      : platform === "onlyfans"
        ? { full: { selector: "#file_upload_input", token: tokens.full } }
        : platform === "fansly"
          ? {
              full: {
                selector: "input[data-creator-fansly-file]",
                token: tokens.full,
              },
              teaser: {
                selector: "input[data-creator-fansly-file]",
                token: tokens.teaser,
              },
            }
          : {
              full: {
                selector:
                  "input.uppy-Dashboard-input[type='file']:not([webkitdirectory])",
                token: tokens.full,
                kind: "video",
              },
            };
  if (["fansly", "pornhub"].includes(platform)) {
    if (!tokens.teaser) delete roles.teaser;
    await chrome.scripting.executeScript({
      target: injectionTarget,
      func: markCreatorToolkitMasterRun,
    });
  }
  await chrome.scripting.executeScript({
    target: injectionTarget,
    files: [
      ...(platform === "fansly"
        ? [
            "workflows/registry.js",
            "workflows/common.js",
            "workflows/fansly-prefill.js",
          ]
        : platform === "pornhub"
          ? [
              "workflows/registry.js",
              "workflows/common.js",
              "workflows/ph-uploader.js",
            ]
          : []),
      CREATOR_UPLOAD_FILE_BRIDGE,
      CREATOR_UPLOAD_ADAPTERS,
    ],
  });
  if (platform === "pornhub") {
    const [proof] = await chrome.scripting.executeScript({
      target: injectionTarget,
      func: inspectCreatorPornhubUploader,
      args: [frame.url],
    });
    const currentFrames = await chrome.webNavigation.getAllFrames({
      tabId: tab.id,
    });
    const current = currentFrames?.filter((item) => item.frameId === 0);
    if (proof?.result?.uploader !== true || proof.result.deviceActions !== 1)
      throw new Error(
        "Pornhub [uploader-capability]: Positive uploader capability verification failed; no file was delivered.",
      );
    if (
      proof.frameId !== 0 ||
      proof.documentId !== frame.documentId ||
      current?.length !== 1 ||
      current[0].documentId !== frame.documentId ||
      current[0].url !== frame.url
    )
      throw new Error(
        "Pornhub [uploader-acquisition]: The resolved uploader document changed during capability validation.",
      );
  }
  if (platform === "fansly") {
    const [ready] = await chrome.scripting.executeScript({
      target: injectionTarget,
      func: async (id) => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const candidates = [
            ...document.querySelectorAll("app-post-creation"),
          ].filter((node) => node.isConnected && node.getClientRects().length);
          if (candidates.length > 1)
            throw new Error(
              "Fansly [composer-acquisition]: Homepage composer is ambiguous (2 or more). Close the extra composer before retrying; no file was delivered.",
            );
          if (
            candidates.length === 1 &&
            candidates[0].querySelector("textarea, [contenteditable='true']")
          ) {
            globalThis.CreatorFanslyComposers ||= new Map();
            globalThis.CreatorFanslyComposers.set(id, candidates[0]);
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(
          "Fansly [composer-acquisition]: No ready homepage composer. Sign in, use the desktop homepage and expand the browser viewport; capture Add Media if it remains unavailable. No file was delivered.",
        );
      },
      args: [session.id],
    });
    const currentFrames = await chrome.webNavigation.getAllFrames({
      tabId: tab.id,
    });
    const current = currentFrames?.find((item) => item.frameId === 0);
    if (
      ready?.result !== true ||
      current?.documentId !== frame.documentId ||
      !["https://fansly.com/", "https://fansly.com/home"].includes(current.url)
    )
      throw new Error("Fansly acquisition document or route changed.");
    frame.url = current.url;
  }
  const bridgeBase = chrome.runtime.getURL("file-bridge.html");
  const bridgeOrigin = new URL(bridgeBase).origin;
  const bridgeUrl = `${bridgeBase}?session=${encodeURIComponent(session.id)}&platform=${encodeURIComponent(platform)}&parentOrigin=${encodeURIComponent(definition.origin)}`;
  await chrome.scripting.executeScript({
    target: injectionTarget,
    func: installCreatorUploadFileBridge,
    args: [
      {
        sessionId: session.id,
        platform,
        bridgeUrl,
        bridgeOrigin,
        roles,
      },
    ],
  });
  if (platform === "pornhub") {
    const finalFrames = await chrome.webNavigation.getAllFrames({
      tabId: tab.id,
    });
    const final = finalFrames?.filter((item) => item.frameId === 0);
    if (
      session.cancelled ||
      final?.length !== 1 ||
      final[0].documentId !== frame.documentId ||
      final[0].url !== frame.url
    )
      throw new Error(
        "Pornhub [uploader-acquisition]: The uploader document changed before binding; no file was delivered.",
      );
  }
  const target = {
    platform,
    tabId: tab.id,
    documentId: frame.documentId,
    boundUrl: frame.url,
    progressStage: "upload",
    tokens,
    stage: "prepared",
    status: "prepared",
    createdAt: Date.now(),
  };
  session.platforms.set(platform, target);
  await checkpointCreatorUploadSession(session);
  return target;
}

async function verifyCreatorManyVidsEditor(expectedUrl, videoId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (location.href !== expectedUrl) return false;
    const titles = [...document.querySelectorAll("#Title[name='video_title']")];
    if (titles.length > 1) return false;
    const form = titles[0]?.closest("form");
    if (form) {
      const identities = [
        ...form.querySelectorAll(
          "input[name='video_id'], input[name='videoId']",
        ),
      ];
      return identities.every((input) => input.value === videoId);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function prepareCreatorManyVidsEdit(session, target) {
  const definition = CREATOR_UPLOAD_TARGETS.manyvids;
  const loaded = await chrome.tabs.get(target.tabId);
  const editRoute = manyVidsRoute(loaded?.url, "edit");
  if (!editRoute || editRoute.manyvidsId !== target.manyvidsId) {
    throw new Error("ManyVids left the expected edit page.");
  }
  const [verified] = await chrome.scripting.executeScript({
    target: { tabId: target.tabId, documentIds: [target.documentId] },
    func: verifyCreatorManyVidsEditor,
    args: [target.boundUrl, target.manyvidsId],
  });
  if (verified?.result !== true)
    throw new Error("ManyVids destination editor identity is unverified.");
  await chrome.scripting.executeScript({
    target: { tabId: target.tabId, documentIds: [target.documentId] },
    func: markCreatorToolkitMasterRun,
  });
  await chrome.scripting.executeScript({
    target: { tabId: target.tabId, documentIds: [target.documentId] },
    files: [
      "workflows/registry.js",
      "workflows/common.js",
      "workflows/manyvids-autofill.js",
      CREATOR_UPLOAD_FILE_BRIDGE,
      CREATOR_UPLOAD_ADAPTERS,
    ],
  });
  const bridgeBase = chrome.runtime.getURL("file-bridge.html");
  const bridgeOrigin = new URL(bridgeBase).origin;
  const roles = {
    ...(target.tokens.teaser
      ? {
          teaser: {
            selector: "input.noborder[name='file']",
            token: target.tokens.teaser,
            kind: "video",
          },
        }
      : {}),
    ...(target.tokens.thumbnail
      ? {
          thumbnail: {
            selector: "#fileUploader[name='image']",
            token: target.tokens.thumbnail,
            kind: "image",
          },
        }
      : {}),
  };
  await chrome.scripting.executeScript({
    target: { tabId: target.tabId, documentIds: [target.documentId] },
    func: installCreatorUploadFileBridge,
    args: [
      {
        sessionId: session.id,
        platform: "manyvids",
        bridgeUrl: `${bridgeBase}?session=${encodeURIComponent(session.id)}&platform=manyvids&parentOrigin=${encodeURIComponent(definition.origin)}`,
        bridgeOrigin,
        roles,
      },
    ],
  });
}

async function checkCreatorUploadPreflight(message, launcher = "extension") {
  await ensureCreatorUploadRuntimeVersion();
  const request = await validateCreatorUploadRequest(message);
  request.launcher = launcher === "desktop" ? "desktop" : "extension";
  await CREATOR_UPLOAD_SESSION_STORE.assertAvailable(
    {
      id: request.sessionId,
      draft: request.draft,
      catalogue: request.catalogue,
      launcher: request.launcher,
    },
    request.targets,
  );
  if (request.catalogue?.source === "desktop") {
    const snapshot = await CREATOR_CATALOGUE_CLIENT.getCatalogueSnapshot();
    const current = snapshot.rows?.find(
      (row) =>
        row.id === request.catalogue.id &&
        row.row === request.catalogue.row &&
        row.itemId === request.catalogue.itemId,
    );
    if (!current || current.fingerprint !== request.catalogue.fingerprint)
      throw new Error(
        "The connected catalogue changed. Review the item again before uploading.",
      );
    for (const platform of request.targets)
      if (
        current.publicationState?.[platform] !== "empty" &&
        !(
          current.publicationState?.[platform] === "published" &&
          request.catalogue.repeatPlatforms.includes(platform)
        )
      )
        throw new Error(
          `The catalogue already contains a ${platform} result or a link requiring review.`,
        );
  }
  return request;
}

async function prepareCreatorUpload(message, launcher = "extension") {
  const id = message?.sessionId;
  if (creatorUploadPreparations.has(id))
    throw Object.assign(
      new Error(
        "This upload is already preparing. Review the existing run; do not start it again.",
      ),
      { uploadAdmission: "uncertain" },
    );
  creatorUploadPreparations.add(id);
  let admitted = false;
  try {
    const request = await checkCreatorUploadPreflight(message, launcher);
    if (await getCreatorUploadSession(request.sessionId)) {
      throw new Error("This creator upload session already exists.");
    }
    const session = {
      id: request.sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      draft: request.draft,
      catalogue: request.catalogue,
      launcher: request.launcher,
      platforms: new Map(),
      commitChain: Promise.resolve(),
      cleanupTimer: null,
    };
    creatorUploadSessions.set(session.id, session);
    admitted = true;
    await checkpointCreatorUploadSession(session);
    session.cleanupTimer = setTimeout(
      () => creatorUploadSessions.delete(session.id),
      2 * 60 * 60_000,
    );
    const platforms = [];
    for (const platform of request.targets) {
      try {
        const prepared = await prepareCreatorUploadPlatform(session, platform);
        platforms.push({
          platform,
          status: prepared.status,
          tabId: prepared.tabId,
        });
      } catch (error) {
        const failed = { platform, status: "failed", error: error.message };
        session.platforms.set(platform, failed);
        await checkpointCreatorUploadSession(session);
        platforms.push(failed);
      }
    }
    return { sessionId: session.id, platforms };
  } catch (error) {
    error.uploadAdmission ||=
      admitted || creatorUploadSessions.has(id) ? "uncertain" : "not-started";
    throw error;
  } finally {
    creatorUploadPreparations.delete(id);
  }
}

async function invokeCreatorUploadAdapter(args) {
  globalThis.CreatorUploadRuns ||= new Map();
  const key = `${args.sessionId}:${args.platform}:${args.stage || "upload"}`;
  const previous = globalThis.CreatorUploadRuns.get(key);
  if (previous) return previous.promise;
  const controller = new AbortController();
  let resumeObserver = null;
  let sequence = 0;
  const state = { status: "running", result: null, error: "" };
  let verifiedDraft = null;
  const draftSnapshot = () =>
    JSON.stringify(
      [
        ...(globalThis.document?.querySelectorAll(
          "app-post-creation input, app-post-creation textarea, app-post-creation select, app-post-creation app-account-media-template, form:has(#Title) input:not([type='file']):not([type='hidden']), form:has(#Title) textarea, form:has(#Title) select, form:has(#Title) img.js-video-screenshot, .tiptap.ProseMirror[role='textbox'], .b-dropzone__preview__delete",
        ) || []),
      ].map((element) => [
        element.tagName,
        element.id,
        element.type === "password" ? "" : element.value,
        element.checked,
        element.getAttribute("src"),
        element.getAttribute("role") === "textbox" ? element.textContent : "",
      ]),
    );
  const onLeave = () => controller.abort();
  globalThis.addEventListener("pagehide", onLeave, { once: true });
  const sendOnce = (message) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(
            Object.assign(new Error("transport-acknowledgement-lost"), {
              transientTransport: true,
            }),
          );
          return;
        }
        if (!response?.ok) {
          const code = response
            ? response.rejectionCode || "preparation-request-rejected"
            : "preparation-response-missing";
          const facts = response?.bindingFacts;
          const detail =
            code === "preparation-request-rejected" &&
            typeof response?.error === "string"
              ? response.error.slice(0, 300)
              : "";
          reject(
            Object.assign(
              new Error(
                code +
                  " [" +
                  message.type +
                  ":" +
                  (args.stage || "upload") +
                  "]" +
                  (detail ? " " + detail : "") +
                  (facts ? " " + JSON.stringify(facts) : ""),
              ),
              {
                rejectionCode: code,
                bindingFacts: facts,
              },
            ),
          );
          return;
        }
        resolve(response);
      });
    });
  const send = async (message) => {
    for (;;) {
      if (controller.signal.aborted)
        throw new Error("Preparation was cancelled.");
      try {
        return await sendOnce(message);
      } catch (error) {
        if (
          (error.transientTransport !== true &&
            ![
              "upload-console-disconnected",
              "upload-connection-changed",
            ].includes(error.rejectionCode)) ||
          ![
            "CREATOR_UPLOAD_PLATFORM_PROGRESS",
            "CHECKPOINT_CREATOR_UPLOAD_STEP",
          ].includes(message.type)
        )
          throw error;
        // Only idempotent, sequence/command-bound acknowledgements may be retried.
        // Never repeat file delivery or an intermediate site action here.
        state.error = `Preparation paused: ${String(error.message || error).slice(0, 350)} Resume observation of this document.`;
        const paused = context.pauseObservation();
        await sendOnce({
          type: "CREATOR_UPLOAD_PLATFORM_PROGRESS",
          sessionId: args.sessionId,
          platform: args.platform,
          status: "upload-attention-required",
          error: state.error,
          sequence: ++sequence,
          executionStage: args.stage || "upload",
        }).catch(() => {});
        await paused;
      }
    }
  };
  const context = {
    draft: args.draft,
    signal: controller.signal,
    supportsNativePicker: args.nativePicker === true,
    pauseObservation() {
      state.status = "paused";
      return new Promise((resolve, reject) => {
        const abort = () => {
          resumeObserver = null;
          reject(new Error("Preparation was cancelled."));
        };
        if (controller.signal.aborted) return abort();
        controller.signal.addEventListener("abort", abort, { once: true });
        resumeObserver = () => {
          controller.signal.removeEventListener("abort", abort);
          resumeObserver = null;
          state.status = "running";
          state.error = "";
          resolve();
        };
      });
    },
    checkpointStep(actionId, commandId, outcome, evidence) {
      return send({
        type: "CHECKPOINT_CREATOR_UPLOAD_STEP",
        sessionId: args.sessionId,
        platform: args.platform,
        actionId,
        commandId,
        outcome,
        evidence,
      });
    },
    attachFile: async (role, selector) => {
      if (selector !== args.selectors[role]) {
        throw new Error(
          "The platform adapter requested an unexpected file control.",
        );
      }
      const commandId = crypto.randomUUID();
      await context.checkpointStep(`select-${role}`, commandId, "intent");
      if (
        args.platform === "pornhub" &&
        role === "pornhub" &&
        !context.supportsNativePicker
      ) {
        const input =
          await globalThis.CreatorUploadPlatformAdapters.activatePornhubUploader(
            context.signal,
          );
        globalThis.CreatorUploadFileBridge.bindActivatedInput(
          args.sessionId,
          role,
          input,
        );
      }
      await send({
        type: "DELIVER_CREATOR_UPLOAD_FILE",
        sessionId: args.sessionId,
        platform: args.platform,
        role,
        commandId,
      });
      const selected = await globalThis.CreatorUploadFileBridge.waitFor(
        args.sessionId,
        role,
      );
      if (controller.signal.aborted)
        throw new Error("Preparation was cancelled.");
      await context.checkpointStep(`select-${role}`, commandId, "observed");
      return selected;
    },
    focusPage() {
      return send({
        type: "FOREGROUND_CREATOR_UPLOAD_OBSERVATION",
        sessionId: args.sessionId,
        platform: args.platform,
      });
    },
    progress(status) {
      return send({
        type: "CREATOR_UPLOAD_PLATFORM_PROGRESS",
        sessionId: args.sessionId,
        platform: args.platform,
        status,
        sequence: ++sequence,
        executionStage: args.stage || "upload",
      });
    },
    beforeCommit() {
      return send({
        type: "CHECKPOINT_CREATOR_UPLOAD_COMMIT",
        sessionId: args.sessionId,
        platform: args.platform,
      });
    },
  };
  const execute = () => {
    if (
      globalThis.CreatorUploadPlatformAdapters?.revision !==
      "upload-hub-0.20.76"
    )
      throw new Error(
        "Stale Upload Hub page runtime. Review existing uploads, reload the extension and this page, then prepare again. No new file was delivered.",
      );
    if (args.platform === "onlyfans") {
      return globalThis.CreatorUploadPlatformAdapters.runOnlyFans(context);
    }
    if (args.platform === "fansly") {
      return globalThis.CreatorUploadPlatformAdapters.runFansly(context);
    }
    if (args.platform === "pornhub") {
      return globalThis.CreatorUploadPlatformAdapters.runPornhub(context);
    }
    if (args.platform === "manyvids" && args.stage === "upload") {
      return globalThis.CreatorUploadPlatformAdapters.runManyVidsUpload(
        context,
      );
    }
    if (args.platform === "manyvids" && args.stage === "edit") {
      return globalThis.CreatorUploadPlatformAdapters.runManyVidsEdit(context);
    }
    throw new Error("Unknown creator upload adapter stage.");
  };
  const promise = Promise.resolve()
    .then(execute)
    .then(
      (result) => {
        state.status = "completed";
        state.result = result;
        verifiedDraft = draftSnapshot();
        return result;
      },
      (error) => {
        state.status = "failed";
        state.error = String(error.message || error).slice(0, 500);
        throw error;
      },
    )
    .finally(() => globalThis.removeEventListener("pagehide", onLeave));
  globalThis.CreatorUploadRuns.set(key, {
    controller,
    promise,
    state,
    verifyDraft: () =>
      verifiedDraft !== null && verifiedDraft === draftSnapshot(),
    resumeObservation: () => {
      if (!resumeObserver || controller.signal.aborted) return false;
      resumeObserver();
      return true;
    },
  });
  return promise;
}

async function resolveCreatorUploadAdapterResult(
  tabId,
  key,
  execution,
  documentId,
) {
  if (!documentId)
    throw new Error("Adapter result document binding is missing.");
  const direct = execution?.[0]?.result;
  if (typeof direct?.status === "string") return direct;
  let state = null;
  try {
    const [inspection] = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      func: (runKey) =>
        globalThis.CreatorUploadRuns?.get(runKey)?.state || null,
      args: [key],
    });
    state = inspection?.result || null;
  } catch (error) {
    throw new Error(
      `The platform adapter result was unavailable and its bound page could not be inspected: ${error.message}`,
    );
  }
  if (
    state?.status === "completed" &&
    typeof state.result?.status === "string"
  ) {
    return state.result;
  }
  if (state?.error) throw new Error(state.error);
  throw new Error(
    `The platform adapter result was unavailable; bound page state: ${state?.status || "missing"}.`,
  );
}

async function prepareCreatorUploadResponseObserver(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: [
      "workflows/catalogue-contract.js",
      CREATOR_UPLOAD_RESPONSE_OBSERVER,
    ],
  });
}

function startCreatorUploadResponseObserver(tabId, sessionId, platform) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: installCreatorUploadResponseObserver,
    args: [{ sessionId, platform, deferred: true }],
  });
}

async function cancelCreatorUploadResponseObserver(tabId, sessionId, platform) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: cancelCreatorUploadResponseObserverInPage,
      args: [{ sessionId, platform }],
    });
  } catch {
    // Navigation may already have destroyed the observer world.
  }
}

async function commitCreatorUploadResult(session, platform, postUrl) {
  if (session.catalogue === null) return { status: "uploaded-no-sheet" };
  session.commitChain = session.commitChain
    .catch(() => {})
    .then(async () => {
      const result = await CREATOR_CATALOGUE_CLIENT.commitPlatformLink({
        row: session.catalogue.row,
        repeatUploadConfirmed:
          session.catalogue.source === "desktop" &&
          session.catalogue.repeatPlatforms?.includes(platform) === true,
        fingerprint: session.catalogue.fingerprint,
        platform,
        postUrl,
        metadata: {
          id: session.catalogue.id,
          releaseDate: session.catalogue.releaseDate,
          title: session.catalogue.title,
          description: session.catalogue.description,
        },
      });
      if (result.fingerprint)
        session.catalogue.fingerprint = result.fingerprint;
      await checkpointCreatorUploadSession(session);
      return result;
    });
  return session.commitChain;
}

async function runCreatorManyVidsPlatform(session, target) {
  const platform = "manyvids";
  try {
    if (!target.manyvidsId) {
      target.status = "uploading-full";
      target.stage = "upload";
      await checkpointCreatorUploadSession(session);
      creatorUploadPost(session.id, {
        type: "platform-progress",
        platform,
        status: target.status,
      });
      let uploadResult;
      try {
        const uploadExecution = await chrome.scripting.executeScript({
          target: { tabId: target.tabId, documentIds: [target.documentId] },
          func: invokeCreatorUploadAdapter,
          args: [
            {
              sessionId: session.id,
              platform,
              stage: "upload",
              selectors: {
                full: "input.uppy-Dashboard-input[type='file']:not([webkitdirectory])",
              },
              draft: session.draft,
            },
          ],
        });
        uploadResult = await resolveCreatorUploadAdapterResult(
          target.tabId,
          `${session.id}:${platform}:upload`,
          uploadExecution,
          target.documentId,
        );
      } catch (error) {
        // The source execution can end just before Chrome reports onCommitted.
        // An armed handoff may wait for that event, but never implies acceptance.
        if (!target.editorHandoff || target.editorHandoff.invalid) throw error;
        uploadResult = { status: "edit-requested" };
      }
      if (uploadResult.status !== "edit-requested") {
        throw new Error("ManyVids did not request its edit page.");
      }
      const editRoute = await waitForManyVidsRoute(
        target.tabId,
        "edit",
        2 * 60_000,
      );
      const handoff = target.editorHandoff;
      const frames = await chrome.webNavigation.getAllFrames({
        tabId: target.tabId,
      });
      const editorFrame = frames?.find((frame) => frame.frameId === 0);
      if (
        !handoff ||
        handoff.invalid ||
        !handoff.documentId ||
        editorFrame?.documentId !== handoff.documentId ||
        editorFrame.url !== handoff.url ||
        manyVidsRoute(editorFrame.url, "edit")?.manyvidsId !==
          handoff.videoId ||
        editorFrame.url !== handoff.expectedUrl
      )
        throw new Error(
          "ManyVids editor navigation is not associated with the recorded completed-card action.",
        );
      target.documentId = editorFrame.documentId;
      target.boundUrl = editorFrame.url;
      target.progressSequence = 0;
      target.progressStage = "edit";
      handoff.cleanup?.();
      target.manyvidsId = editRoute.manyvidsId;
      await checkpointCreatorUploadSession(session);
    }

    target.status = "configuring";
    target.stage = "edit";
    await checkpointCreatorUploadSession(session);
    creatorUploadPost(session.id, {
      type: "platform-progress",
      platform,
      status: target.status,
    });
    await prepareCreatorManyVidsEdit(session, target);
    const selectors = {
      ...(target.tokens.teaser
        ? { teaser: "input.noborder[name='file']" }
        : {}),
      ...(target.tokens.thumbnail
        ? { thumbnail: "#fileUploader[name='image']" }
        : {}),
    };
    const editExecution = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] },
      func: invokeCreatorUploadAdapter,
      args: [
        {
          sessionId: session.id,
          platform,
          stage: "edit",
          selectors,
          draft: { ...session.draft, manyvidsId: target.manyvidsId },
        },
      ],
    });
    const editResult = await resolveCreatorUploadAdapterResult(
      target.tabId,
      `${session.id}:${platform}:edit`,
      editExecution,
      target.documentId,
    );
    if (editResult.status !== "save-clicked") {
      if (editResult.status === "manual-submit-required")
        return recordCreatorManualPreparation(session, target);
      throw new Error("ManyVids did not confirm its final Save click.");
    }
    target.submitted = true;
    target.submitAttempted = true;
    target.status = "save-clicked";
    await checkpointCreatorUploadSession(session);
    creatorUploadPost(session.id, {
      type: "platform-progress",
      platform,
      status: target.status,
    });
    if (editResult.accepted !== true) {
      throw new Error(
        "ManyVids Save was attempted once. Site acceptance is unverified; recover the existing result before any retry.",
      );
    }
    const postUrl = CREATOR_CATALOGUE_CONTRACT.canonicalPostUrl(
      platform,
      target.manyvidsId,
    );
    if (!postUrl) throw new Error("ManyVids returned an invalid video ID.");
    target.postUrl = postUrl;
    await checkpointCreatorUploadSession(session);
    const commit = await commitCreatorUploadResult(session, platform, postUrl);
    const result = {
      platform,
      postUrl,
      status:
        commit.status === "updated" || commit.status === "idempotent"
          ? "catalogue-updated"
          : commit.status,
      ...(commit.status === "conflict" || commit.status === "stale"
        ? { error: `Catalogue commit stopped: ${commit.status}.` }
        : {}),
    };
    Object.assign(target, result);
    await checkpointCreatorUploadSession(session);
    creatorUploadPost(session.id, {
      type: "platform-result",
      platform,
      result,
    });
    return result;
  } catch (error) {
    const result = {
      platform,
      status: target.postUrl
        ? "catalogue-commit-failed"
        : target.submitAttempted || target.submitted
          ? "posted-link-unresolved"
          : target.manyvidsId
            ? "edit-failed"
            : "failed",
      ...(target.submitAttempted || target.submitted
        ? { submitted: true }
        : {}),
      ...(target.postUrl ? { postUrl: target.postUrl } : {}),
      ...(target.manyvidsId ? { manyvidsId: target.manyvidsId } : {}),
      error: error.message,
    };
    Object.assign(target, result);
    await checkpointCreatorUploadSession(session);
    try {
      creatorUploadPost(session.id, {
        type: "platform-result",
        platform,
        result,
      });
    } catch {
      // The console may have closed after the platform operation started.
    }
    return result;
  }
}

async function runCreatorPornhubPlatform(session, target) {
  const platform = "pornhub";
  try {
    const loaded = await chrome.tabs.get(target.tabId);
    if (!creatorUrlMatches(loaded?.url, CREATOR_UPLOAD_TARGETS.pornhub)) {
      throw new Error("Pornhub left the expected uploader origin.");
    }
    target.stage = "upload";
    target.status = "uploading-full";
    await checkpointCreatorUploadSession(session);
    const execution = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] },
      func: invokeCreatorUploadAdapter,
      args: [
        {
          sessionId: session.id,
          platform,
          stage: "upload",
          selectors: {
            pornhub: "input.dz-hidden-input[type='file']",
            ...(session.draft.pornhubThumbnail
              ? {
                  thumbnail:
                    "v-upload-video-details[form-id] form.video-details-form .custom-thumbnails.pcView input.uploadFile[type='file']",
                }
              : {}),
          },
          draft: session.draft,
          nativePicker: creatorUploadPort(session.id)?.desktop === true,
        },
      ],
    });
    const result = await resolveCreatorUploadAdapterResult(
      target.tabId,
      `${session.id}:${platform}:upload`,
      execution,
      target.documentId,
    );
    if (result?.status !== "manual-submit-required") {
      throw new Error("Pornhub metadata preparation did not finish safely.");
    }
    Object.assign(target, result);
    await checkpointCreatorUploadSession(session);
    creatorUploadPost(session.id, {
      type: "platform-result",
      platform,
      result,
    });
    return result;
  } catch (error) {
    const result = {
      platform,
      stage: target.stage,
      status: "failed",
      error: error.message,
    };
    Object.assign(target, result);
    await checkpointCreatorUploadSession(session);
    try {
      creatorUploadPost(session.id, {
        type: "platform-result",
        platform,
        result,
      });
    } catch {
      // The console may close while metadata is being prepared.
    }
    return result;
  }
}

async function runCreatorUploadPlatform(session, platform) {
  const target = session.platforms.get(platform);
  if (target?.submitAttempted && !target.postUrl) {
    const result = {
      platform,
      status: "posted-link-unresolved",
      submitted: true,
      error:
        "The restored platform submission may already exist; manual link recovery is required.",
    };
    Object.assign(target, result);
    await checkpointCreatorUploadSession(session);
    return result;
  }
  if (!target?.tabId || target.status !== "prepared") {
    return (
      target || {
        platform,
        status: "failed",
        error: "Platform was not prepared.",
      }
    );
  }
  if (platform === "manyvids") {
    return runCreatorManyVidsPlatform(session, target);
  }
  if (platform === "pornhub") {
    return runCreatorPornhubPlatform(session, target);
  }
  target.status = "uploading-full";
  target.stage = "upload";
  await checkpointCreatorUploadSession(session);
  creatorUploadPost(session.id, {
    type: "platform-progress",
    platform,
    status: target.status,
  });
  let observerExecution = null;
  try {
    if (session.draft.publishMode === "autonomous") {
      await prepareCreatorUploadResponseObserver(target.tabId);
      observerExecution = startCreatorUploadResponseObserver(
        target.tabId,
        session.id,
        platform,
      )
        .then(
          async (value) => {
            const receipt = value?.[0]?.result;
            const postUrl = CREATOR_CATALOGUE_CONTRACT.canonicalPostUrl(
              platform,
              receipt?.postUrl,
            );
            if (
              target.submitAttempted &&
              receipt?.sessionId === session.id &&
              receipt.status === "link-captured" &&
              postUrl
            ) {
              target.postUrl = postUrl;
              target.status = "link-captured";
              await checkpointCreatorUploadSession(session);
            }
            return { ok: true, value };
          },
          (error) => ({ ok: false, error }),
        )
        .catch((error) => ({ ok: false, error }));
    }
    const selectors =
      platform === "onlyfans"
        ? { full: "#file_upload_input" }
        : {
            full: "input[data-creator-fansly-file]",
            teaser: "input[data-creator-fansly-file]",
          };
    const execution = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] },
      func: invokeCreatorUploadAdapter,
      args: [
        {
          sessionId: session.id,
          platform,
          selectors,
          draft: session.draft,
          nativePicker: creatorUploadPort(session.id)?.desktop === true,
        },
      ],
    });
    const adapterResult = await resolveCreatorUploadAdapterResult(
      target.tabId,
      `${session.id}:${platform}:upload`,
      execution,
      target.documentId,
    );
    if (adapterResult?.status === "manual-submit-required") {
      await cancelCreatorUploadResponseObserver(
        target.tabId,
        session.id,
        platform,
      );
      return recordCreatorManualPreparation(session, target);
    }
    if (adapterResult?.status !== "submitted") {
      throw new Error("The platform adapter did not confirm final submission.");
    }
    target.submitted = true;
    target.submitAttempted = true;
    target.status = "submitted";
    await checkpointCreatorUploadSession(session);
    creatorUploadPost(session.id, {
      type: "platform-progress",
      platform,
      status: target.status,
    });
    const observation = await observerExecution;
    if (!observation.ok) throw observation.error;
    const observedExecution = observation.value;
    const observed = observedExecution?.[0]?.result;
    const postUrl = CREATOR_CATALOGUE_CONTRACT.canonicalPostUrl(
      platform,
      observed?.postUrl,
    );
    if (observed?.status !== "link-captured" || !postUrl) {
      throw new Error(
        "The platform posted, but its post link could not be resolved safely.",
      );
    }
    target.status = "link-captured";
    target.postUrl = postUrl;
    await checkpointCreatorUploadSession(session);
    creatorUploadPost(session.id, {
      type: "platform-progress",
      platform,
      status: target.status,
    });
    const commit = await commitCreatorUploadResult(session, platform, postUrl);
    const result = {
      platform,
      postUrl,
      status:
        commit.status === "updated" || commit.status === "idempotent"
          ? "catalogue-updated"
          : commit.status,
      ...(commit.status === "conflict" || commit.status === "stale"
        ? { error: `Catalogue commit stopped: ${commit.status}.` }
        : {}),
    };
    Object.assign(target, result);
    await checkpointCreatorUploadSession(session);
    creatorUploadPost(session.id, {
      type: "platform-result",
      platform,
      result,
    });
    return result;
  } catch (error) {
    await cancelCreatorUploadResponseObserver(
      target.tabId,
      session.id,
      platform,
    );
    const result = {
      platform,
      status: target.postUrl
        ? "catalogue-commit-failed"
        : target.submitAttempted || target.submitted
          ? "posted-link-unresolved"
          : "failed",
      ...(target.submitAttempted || target.submitted
        ? { submitted: true }
        : {}),
      ...(target.postUrl ? { postUrl: target.postUrl } : {}),
      error: error.message,
    };
    Object.assign(target, result);
    await checkpointCreatorUploadSession(session);
    try {
      creatorUploadPost(session.id, {
        type: "platform-result",
        platform,
        result,
      });
    } catch {
      // The console may have closed after the platform operation started.
    }
    return result;
  }
}

async function startCreatorUpload(sessionId, targets) {
  const session = await getCreatorUploadSession(sessionId);
  if (!session) throw new Error("Unknown creator upload session.");
  if (session.cancelled || session.restored)
    throw new Error(
      "This interrupted run requires explicit reconciliation before resume.",
    );
  const requested = Array.isArray(targets) ? [...new Set(targets)] : [];
  if (
    !requested.length ||
    requested.some((platform) => !session.platforms.has(platform))
  ) {
    throw new Error("Invalid creator upload targets.");
  }
  if (!session.execution) {
    session.executionPort = creatorUploadPort(session.id);
    await checkpointCreatorUploadSession(session);
    session.execution = Promise.allSettled(
      requested.map(async (platform) => {
        try {
          return await runCreatorUploadPlatform(session, platform);
        } catch (error) {
          const target = session.platforms.get(platform);
          if (!CREATOR_UPLOAD_TERMINAL_STATUSES.has(target.status)) {
            Object.assign(target, {
              status: session.cancelled ? "cancelled" : "failed",
              error: error.message,
            });
            await checkpointCreatorUploadSession(session);
            creatorUploadPost(session.id, {
              type: "platform-result",
              platform,
              result: target,
            });
          }
          return target;
        }
      }),
    );
  }
  return [];
}

async function retryCreatorUploadPlatform(sessionId, platform) {
  const session = await getCreatorUploadSession(sessionId);
  const target = session?.platforms.get(platform);
  if (!session || !target || !Object.hasOwn(CREATOR_UPLOAD_TARGETS, platform)) {
    throw new Error("Unknown creator upload retry target.");
  }
  if (CREATOR_UPLOAD_TERMINAL_STATUSES.has(target.status)) return [target];
  if (target.postUrl) {
    try {
      const commit = await commitCreatorUploadResult(
        session,
        platform,
        target.postUrl,
      );
      const result = {
        platform,
        status:
          commit.status === "updated" || commit.status === "idempotent"
            ? "catalogue-updated"
            : commit.status,
        submitted: true,
        postUrl: target.postUrl,
        ...(commit.status === "conflict" || commit.status === "stale"
          ? { error: `Catalogue commit stopped: ${commit.status}.` }
          : {}),
      };
      Object.assign(target, result);
      await checkpointCreatorUploadSession(session);
      try {
        creatorUploadPost(session.id, {
          type: "platform-result",
          platform,
          result,
        });
      } catch {
        // The sheet retry remains valid if the console closed meanwhile.
      }
      return [result];
    } catch (error) {
      const result = {
        platform,
        status: "catalogue-commit-failed",
        submitted: true,
        postUrl: target.postUrl,
        error: error.message,
      };
      Object.assign(target, result);
      await checkpointCreatorUploadSession(session);
      return [result];
    }
  }
  if (
    target.submitAttempted ||
    target.submitted ||
    target.status === "posted-link-unresolved"
  ) {
    throw new Error(
      "The platform submission may already exist; manual link recovery is required before any retry.",
    );
  }
  if (target.stage !== "prepared") {
    if (session.cancelled || target.stage === "cancelled")
      throw new Error(
        "Preparation was cancelled. The existing draft is preserved.",
      );
    if (target.documentId) {
      const [inspection] = await chrome.scripting.executeScript({
        target: { tabId: target.tabId, documentIds: [target.documentId] },
        func: (key) => {
          const run = globalThis.CreatorUploadRuns?.get(key);
          if (!run || run.controller.signal.aborted) return null;
          if (run.state?.status === "completed" && !run.verifyDraft?.())
            return { status: "draft-changed" };
          if (run.state?.status === "paused") run.resumeObservation();
          return run.state || null;
        },
        args: [`${session.id}:${platform}:${target.stage || "upload"}`],
      });
      if (
        inspection?.result?.status === "completed" &&
        inspection.result.result?.status === "manual-submit-required"
      )
        return [await recordCreatorManualPreparation(session, target)];
      if (inspection?.result?.status === "running") {
        target.status = "upload-observing";
        delete target.error;
        await checkpointCreatorUploadSession(session);
        return [{ platform, status: target.status }];
      }
    }
    if (
      !session.cancelled &&
      target.documentId &&
      target.status === "upload-attention-required"
    ) {
      const [resumed] = await chrome.scripting.executeScript({
        target: { tabId: target.tabId, documentIds: [target.documentId] },
        func: (key) =>
          globalThis.CreatorUploadRuns?.get(key)?.resumeObservation?.() ===
          true,
        args: [`${session.id}:${platform}:${target.stage || "upload"}`],
      });
      if (resumed?.result === true)
        return [{ platform, status: "upload-observing" }];
    }
    throw new Error(
      "Preparation requires inspection of the existing bound draft. An uncertain upload will not be replayed or navigated away from.",
    );
  }
  return [await runCreatorUploadPlatform(session, platform)];
}

async function checkpointCreatorUploadCommit(
  sessionId,
  platform,
  tabId,
  sender,
) {
  const session = await getCreatorUploadSession(sessionId);
  const target = session?.platforms.get(platform);
  if (session?.draft?.publishMode !== "autonomous")
    throw new Error("Publication checkpoint forbidden in manual mode.");
  if (session?.cancelled) throw new Error("Preparation was cancelled.");
  if (
    !session ||
    !target ||
    target.tabId !== tabId ||
    !Object.hasOwn(CREATOR_UPLOAD_TARGETS, platform)
  ) {
    throw new Error("Unauthorized creator upload commit checkpoint.");
  }
  if (target.submitAttempted) {
    throw new Error(
      "The platform submission may already exist; manual link recovery is required before any retry.",
    );
  }
  await assertCreatorUploadPageBinding(session, target, sender);
  target.stage = "submit-attempted";
  target.commitArmed = true;
  target.submitAttempted = true;
  await checkpointCreatorUploadSession(session);
  const persisted = await CREATOR_UPLOAD_SESSION_STORE.load(session.id);
  const durable = persisted?.platforms?.[platform];
  if (!durable?.commitArmed || !durable.submitAttempted) {
    throw new Error("The creator upload commit checkpoint was not durable.");
  }
  await assertCreatorUploadPageBinding(session, target, sender);
  if (platform === "onlyfans" || platform === "fansly") {
    const armed = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] },
      world: "MAIN",
      func: (id, name) =>
        globalThis.CreatorUploadResponseObserver?.arm(id, name) === true,
      args: [session.id, platform],
    });
    if (armed?.[0]?.result !== true)
      throw new Error(
        "Publication response observer could not be armed in the bound document.",
      );
    await assertCreatorUploadPageBinding(session, target, sender);
  }
  return { armed: true };
}

async function openUploadConsole() {
  if (!uploadConsoleOpening) {
    uploadConsoleOpening = (async () => {
      const url = chrome.runtime.getURL("upload-console.html");
      if (uploadConsoleTabId !== null) {
        try {
          const tracked = await chrome.tabs.get(uploadConsoleTabId);
          const knownUrls = [tracked?.url, tracked?.pendingUrl].filter(Boolean);
          if (
            knownUrls.includes(url) ||
            (uploadConsoleTabPending && knownUrls.length === 0)
          ) {
            const focused = await chrome.tabs.update(uploadConsoleTabId, {
              active: true,
            });
            return { tabId: focused.id };
          }
        } catch {
          // A closed tab is rediscovered below.
        }
        uploadConsoleTabId = null;
        uploadConsoleTabPending = false;
      }
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["TAB"],
        documentUrls: [url],
      });
      const tab = contexts[0]
        ? await chrome.tabs.update(contexts[0].tabId, { active: true })
        : await chrome.tabs.create({ url, active: true });
      uploadConsoleTabId = tab.id;
      uploadConsoleTabPending = !contexts[0] && tab.status !== "complete";
      return { tabId: tab.id };
    })();
  }
  try {
    return await uploadConsoleOpening;
  } finally {
    uploadConsoleOpening = null;
  }
}

async function initializeInstalledExtension() {
  await ensureCreatorUploadRuntimeVersion();
  const current = await chrome.storage.local.get([
    SETTINGS_KEY,
    STATE_KEY,
    CREATOR_REGISTRY.STORAGE_KEY,
    CREATOR_REGISTRY.LEGACY_STORAGE_KEY,
  ]);
  const writes = {};
  const normalizedIdentitySettings = normalizeSettings(
    current[SETTINGS_KEY] || {},
  );
  if (
    !current[SETTINGS_KEY] ||
    JSON.stringify(current[SETTINGS_KEY]) !==
      JSON.stringify(normalizedIdentitySettings)
  ) {
    writes[SETTINGS_KEY] = normalizedIdentitySettings;
  }
  if (!current[STATE_KEY]) writes[STATE_KEY] = normalizeState();
  const currentCreatorSettings = current[CREATOR_REGISTRY.STORAGE_KEY];
  const normalizedCreatorSettings = currentCreatorSettings
    ? CREATOR_REGISTRY.normalizeSettings(currentCreatorSettings).value
    : CREATOR_REGISTRY.migrateLegacySettings(
        current[CREATOR_REGISTRY.LEGACY_STORAGE_KEY],
      );
  if (
    !currentCreatorSettings ||
    JSON.stringify(currentCreatorSettings) !==
      JSON.stringify(normalizedCreatorSettings)
  ) {
    writes[CREATOR_REGISTRY.STORAGE_KEY] = normalizedCreatorSettings;
  }
  if (Object.keys(writes).length > 0) await chrome.storage.local.set(writes);
  await syncCreatorToolRegistrations();
  await extensionLifecycle?.completeInstallation();
}

chrome.runtime.onInstalled.addListener(() => initializeInstalledExtension());

// A service worker may stop between the genuine install event and receipt
// publication. Resume the same durable initialization without minting a new
// installation identity on reload or worker restart.
extensionLifecycle
  ?.needsInitialization()
  .then((needed) => (needed ? initializeInstalledExtension() : undefined))
  .catch((error) =>
    console.error("Extension installation initialization failed.", error),
  );

chrome.runtime.onStartup.addListener(() => {
  syncCreatorToolRegistrations().catch((error) => {
    console.error("Creator tool registration sync failed on startup.", error);
  });
});

function syncCreatorToolsAfterPermissionChange() {
  return syncCreatorToolRegistrations().catch((error) => {
    console.error(
      "Creator tool registration sync failed after permission change.",
      error,
    );
  });
}

chrome.permissions.onAdded.addListener(syncCreatorToolsAfterPermissionChange);
chrome.permissions.onRemoved.addListener(syncCreatorToolsAfterPermissionChange);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[CREATOR_REGISTRY.STORAGE_KEY]) {
    syncCreatorToolRegistrations().catch((error) => {
      console.error("Creator tool registration sync failed.", error);
    });
  }
});

async function stopCreatorUploadSession(session) {
  session.cancelled = true;
  for (const [id, pending] of creatorUploadFileRequests) {
    if (pending.sessionId !== session.id) continue;
    clearTimeout(pending.timeout);
    pending.fileController?.abort();
    pending.reject(new Error("Preparation was cancelled."));
    creatorUploadFileRequests.delete(id);
  }
  for (const target of session.platforms.values()) {
    if (CREATOR_UPLOAD_TERMINAL_STATUSES.has(target.status)) continue;
    target.status = "cancelled";
    target.stage = "cancelled";
    if (target.tabId) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: target.tabId, documentIds: [target.documentId] },
          func: (sessionId) => {
            for (const [key, run] of globalThis.CreatorUploadRuns || [])
              if (key.startsWith(`${sessionId}:`)) run.controller.abort();
          },
          args: [session.id],
        });
      } catch {
        /* A closed document has already stopped its executor. */
      }
    }
    creatorUploadPost(session.id, {
      type: "platform-result",
      platform: target.platform,
      result: {
        platform: target.platform,
        status: "cancelled",
        error:
          "Preparation stopped. The site may continue an upload already started; the draft is preserved.",
      },
    });
  }
  await checkpointCreatorUploadSession(session);
}

let creatorUploadRetirement = null;
async function retireCreatorUploadSessions() {
  if (creatorUploadRetirement) return creatorUploadRetirement;
  const retirement = (async () => {
    await ensureCreatorUploadRuntimeVersion();
    const records = await CREATOR_UPLOAD_SESSION_STORE.list();
    let retired = 0;
    for (const record of records) {
      if (!record.draft) continue;
      const session = await getCreatorUploadSession(record.id);
      if (session) {
        await stopCreatorUploadSession(session);
        if (session.execution) {
          let timeout;
          try {
            await Promise.race([
              session.execution,
              new Promise((_, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error(
                        "The current upload has not stopped yet. Review it before starting New.",
                      ),
                    ),
                  15_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
        }
        clearTimeout(session.cleanupTimer);
        creatorUploadSessions.delete(record.id);
      }
      await CREATOR_UPLOAD_SESSION_STORE.remove(record.id);
      retired++;
    }
    let superseded = 0;
    for (const surface of ["extension", "desktop"]) {
      const recovery = await CREATOR_UPLOAD_SESSION_STORE.supersedePreparation(
        [],
        surface,
      );
      superseded += recovery.superseded;
    }
    return { retired, superseded };
  })();
  creatorUploadRetirement = retirement;
  try {
    return await retirement;
  } finally {
    creatorUploadRetirement = null;
  }
}

function handleExtensionMessage(message, sender, sendResponse) {
  (async () => {
    if (
      sender?.tab &&
      /CREATOR_UPLOAD/.test(message?.type || "") &&
      !new Set([
        "CHECKPOINT_CREATOR_UPLOAD_COMMIT",
        "CHECKPOINT_CREATOR_UPLOAD_STEP",
        "DELIVER_CREATOR_UPLOAD_FILE",
        "CREATOR_UPLOAD_PLATFORM_PROGRESS",
        "FOREGROUND_CREATOR_UPLOAD_OBSERVATION",
      ]).has(message.type) &&
      !String(sender.url || "").startsWith(chrome.runtime.getURL(""))
    )
      throw new Error(
        "Upload administration is restricted to the uploader console.",
      );
    switch (message?.type) {
      case "LOAD_DEVELOPMENT_TEMPLATE":
        assertDevelopmentConsole(sender);
        return {
          files: await sendDesktopRequest("loadDevelopmentFixtures", {
            extensionVersion: chrome.runtime.getManifest().version,
          }),
        };
      case "DELIVER_DEVELOPMENT_FILE":
        assertDevelopmentConsole(sender);
        return attachDevelopmentFile(message, sender);
      case "DELIVER_CATALOGUE_THUMBNAIL_FILE":
        assertDevelopmentConsole(sender);
        return attachCatalogueThumbnailFile(message, sender);
      case "GET_SETTINGS":
        return { settings: await getSettings() };
      case "SET_SETTINGS":
        return { settings: await updateSettings(message.patch || {}) };
      case "GET_STATS":
        return { stats: await getStats() };
      case "GET_GELBOORU_HISTORY":
        return { history: await getGelbooruHistory() };
      case "GET_AVATAR_MANAGEMENT_VIEW":
        return { avatarView: await getAvatarManagementView() };
      case "REENABLE_REMOTE_AVATAR":
        await reenableRemoteAvatar(message.source, message.id);
        return { avatarView: await getAvatarManagementView() };
      case "GET_CREATOR_SETTINGS":
        return { creatorSettings: await getCreatorSettings() };
      case "GET_DESKTOP_STATUS":
        return { desktopStatus: await getDesktopStatus() };
      case "OFENHANCER_APP_REQUEST":
        return {
          result: await routeOFEnhancerAppRequest(
            message.operation,
            message.payload,
          ),
        };
      case "OPEN_UPLOAD_CONSOLE":
        return { uploadConsole: await openUploadConsole() };
      case "SHOW_UPLOAD_TRACE_RECORDER":
        return { traceRecorder: await showUploadTraceRecorder() };
      case "GET_UPLOAD_TRACE_CONTEXT":
        return { ownerId: sender.tab?.id ? `tab-${sender.tab.id}` : "" };
      case "GET_CREATOR_UPLOAD_RECOVERY": {
        await ensureCreatorUploadRuntimeVersion();
        const records = await CREATOR_UPLOAD_SESSION_STORE.listRecovery();
        const publication =
          await CREATOR_UPLOAD_SESSION_STORE.listPublication();
        return {
          publication: message.sessionId
            ? publication.filter((record) => record.id === message.sessionId)
            : publication,
          records: message.sessionId
            ? records.filter((record) => record.id === message.sessionId)
            : records,
        };
      }
      case "GET_CREATOR_UPLOAD_RESUMABLE": {
        await ensureCreatorUploadRuntimeVersion();
        const launcher = sender?.desktopUploadRuntime ? "desktop" : "extension";
        const allSessions = await CREATOR_UPLOAD_SESSION_STORE.list();
        const sessions = allSessions
          .filter(
            (record) =>
              (record.launcher || "extension") === launcher &&
              record.draft &&
              Object.keys(record.platforms || {}).length,
          )
          .sort(
            (left, right) =>
              (right.updatedAt || right.createdAt || 0) -
              (left.updatedAt || left.createdAt || 0),
          );
        const latest = sessions[0];
        const recovery = await CREATOR_UPLOAD_SESSION_STORE.listRecovery();
        return {
          resumable: latest
            ? {
                id: latest.id,
                draft: {
                  title: latest.draft.title || "",
                  fullFilename: latest.draft.fullFilename || "",
                  pornhubFilename: latest.draft.pornhubFilename || "",
                  fileProof: latest.draft.fileProof || {},
                  hasTeaser: latest.draft.hasTeaser === true,
                  manyvidsThumbnail: latest.draft.manyvidsThumbnail === true,
                  pornhubThumbnail: latest.draft.pornhubThumbnail === true,
                  profileSignature: latest.draft.profileSignature || "",
                  releaseDate: latest.draft.releaseDate || "",
                  description: latest.draft.description || "",
                  contentPreset: latest.draft.contentPreset || "",
                  publishMode: latest.draft.publishMode || "manual",
                },
                platforms: Object.values(latest.platforms || {}).map(
                  (target) => ({
                    platform: target.platform,
                    stage: target.stage,
                    status: target.status,
                    error: target.error,
                    postUrl: target.postUrl,
                  }),
                ),
              }
            : null,
          pendingRecovery: recovery.filter((record) => !record.supersededAt)
            .length,
        };
      }
      case "START_NEW_CREATOR_UPLOAD":
        return {
          reset: await retireCreatorUploadSessions(),
        };
      case "CLEAR_CREATOR_UPLOAD_PREPARATION":
        return {
          reset: await CREATOR_UPLOAD_SESSION_STORE.clearPreparation(),
        };
      case "OPEN_X_TEASER_RECORDER":
        return { recorderTabId: await openXTeaserRecorder() };
      case "GET_X_TEASER_SESSIONS":
        return {
          sessions: await X_TEASER_SESSION_STORE.list(),
          rebind: await rebindXTeaserObservation(sender.tab?.id),
        };
      case "CONFIRM_X_TEASER_REBIND":
        return { rebind: await confirmXTeaserRebind(message, sender.tab?.id) };
      case "PAIR_X_TEASER":
        return { xTeaser: await pairXTeaser(message.pairing, sender.tab?.id) };
      case "RECONCILE_X_TEASER":
        return { xTeaser: await reconcileXTeaser(message.id, message.frames) };
      case "PROBE_CREATOR_UPLOAD_TARGETS":
        return {
          results: await probeCreatorUploadTargets(message.targets),
        };
      case "CHECK_CREATOR_UPLOAD_AVAILABILITY":
        await checkCreatorUploadPreflight(
          message,
          sender?.desktopUploadRuntime ? "desktop" : "extension",
        );
        return { availability: { ready: true } };
      case "PREPARE_CREATOR_UPLOAD":
        return {
          uploadSession: await prepareCreatorUpload(
            message,
            sender?.desktopUploadRuntime ? "desktop" : "extension",
          ),
        };
      case "START_CREATOR_UPLOAD":
        return {
          accepted: true,
          results: await startCreatorUpload(message.sessionId, message.targets),
        };
      case "CANCEL_CREATOR_UPLOAD": {
        const session = await getCreatorUploadSession(message.sessionId);
        if (!session) throw new Error("Unknown preparation run.");
        await stopCreatorUploadSession(session);
        return { cancelled: true };
      }
      case "PREPARE_CREATOR_SOCIAL_DISTRIBUTION":
        return {
          socialDistribution: await getCreatorSocialRuntime().prepare({
            plan: message.plan,
            caption: message.caption,
            subreddits: message.subreddits,
          }),
        };
      case "START_CREATOR_SOCIAL_DISTRIBUTION":
        return {
          socialDistribution: await getCreatorSocialRuntime().start(
            message.sessionId,
          ),
        };
      case "RESUME_CREATOR_SOCIAL_DISTRIBUTION":
        return {
          socialDistribution: await getCreatorSocialRuntime().resume(
            message.sessionId,
          ),
        };
      case "PREPARE_CREATOR_REDDIT_LINKS":
        return {
          socialDistribution:
            await getCreatorSocialRuntime().prepareRedditLinks(
              message.sessionId,
              message.redgifsUrl,
            ),
        };
      case "ASSOCIATE_CREATOR_SOCIAL_CATALOGUE":
        return {
          socialDistribution:
            await getCreatorSocialRuntime().associateCatalogue(
              message.sessionId,
              message.catalogue,
            ),
        };
      case "ASSOCIATE_CREATOR_UPLOAD_CATALOGUE":
        return {
          results: await associateCreatorUploadCatalogue(
            message.sessionId,
            message.catalogue,
          ),
        };
      case "RETRY_CREATOR_UPLOAD_PLATFORM":
        return {
          results: await retryCreatorUploadPlatform(
            message.sessionId,
            message.platform,
          ),
        };
      case "CHECKPOINT_CREATOR_UPLOAD_COMMIT":
        return checkpointCreatorUploadCommit(
          message.sessionId,
          message.platform,
          sender.tab?.id,
          sender,
        );
      case "CHECKPOINT_CREATOR_UPLOAD_STEP": {
        const session = await getCreatorUploadSession(message.sessionId);
        const target = session?.platforms.get(message.platform);
        if (
          !session ||
          session.cancelled ||
          !target ||
          target.tabId !== sender.tab?.id ||
          !sender.documentId ||
          sender.frameId !== 0 ||
          target.stage === "cancelled"
        )
          throw new Error("Unauthorized preparation step.");
        await assertCreatorUploadPageBinding(session, target, sender);
        const signatureBytes = new TextEncoder().encode(
          JSON.stringify(
            CREATOR_UPLOAD_SESSION_STORE.sanitize({
              id: session.id,
              draft: session.draft,
            }).draft,
            (_key, value) =>
              value && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(
                    Object.keys(value)
                      .sort()
                      .map((key) => [key, value[key]]),
                  )
                : value,
          ),
        );
        const digest = await crypto.subtle.digest("SHA-256", signatureBytes);
        const signature = [...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        const step = await CREATOR_UPLOAD_SESSION_STORE.recordStep(session.id, {
          launcher: session.launcher,
          actionId: message.actionId,
          commandId: message.commandId,
          outcome: message.outcome,
          platform: message.platform,
          documentId: sender.documentId,
          frameId: sender.frameId,
          tabId: target.tabId,
          signature,
          work: await CREATOR_UPLOAD_SESSION_STORE.workIdentity(session),
        });
        await assertCreatorUploadPageBinding(session, target, sender);
        if (
          message.actionId === "open-editor" &&
          message.outcome === "intent"
        ) {
          if (message.platform !== "manyvids" || target.stage !== "upload")
            throw new Error("Unauthorized editor handoff.");
          const expected = manyVidsRoute(
            message.evidence?.destinationUrl,
            "edit",
          );
          const buttonHandoff =
            !message.evidence?.destinationUrl &&
            message.evidence?.completedCard === true;
          if (
            !buttonHandoff &&
            (!expected ||
              expected.manyvidsId !== message.evidence?.videoId ||
              new URL(expected.url).search ||
              new URL(expected.url).hash)
          )
            throw new Error("ManyVids editor destination evidence is missing.");
          if (buttonHandoff) {
            const [proof] = await chrome.scripting.executeScript({
              target: { tabId: target.tabId, documentIds: [sender.documentId] },
              func: (commandId, filename) => {
                const action =
                  globalThis.CreatorManyVidsCompletedActions?.get(commandId);
                return Boolean(
                  location.href === "https://www.manyvids.com/upload-video" &&
                  action?.filename === filename &&
                  action.verify(),
                );
              },
              args: [message.commandId, session.draft.fullFilename],
            });
            if (
              proof?.result !== true ||
              proof.frameId !== 0 ||
              proof.documentId !== sender.documentId
            )
              throw new Error(
                "ManyVids completed-card handoff proof is unavailable.",
              );
            await assertCreatorUploadPageBinding(session, target, sender);
          }
          if (!target.editorHandoff) {
            if (!chrome.webNavigation.onCommitted)
              throw new Error("Editor navigation evidence is unavailable.");
            const handoff = {
              commandId: message.commandId,
              sourceDocumentId: sender.documentId,
              expectedUrl: expected?.url || "",
              videoId: expected?.manyvidsId || "",
              expiresAt: Date.now() + 30_000,
              documentId: "",
              url: "",
              invalid: false,
            };
            target.editorHandoff = handoff;
            const boundPort = session.executionPort;
            const observe = (details, sameDocument = false) => {
              if (details.tabId !== target.tabId || details.frameId !== 0)
                return;
              handoff.cleanup?.();
              const route = manyVidsRoute(details.url, "edit");
              if (
                !route ||
                (handoff.videoId && route.manyvidsId !== handoff.videoId) ||
                (handoff.expectedUrl && details.url !== handoff.expectedUrl) ||
                new URL(details.url).search ||
                new URL(details.url).hash ||
                Date.now() > handoff.expiresAt ||
                session.cancelled ||
                creatorUploadPort(session.id) !== boundPort ||
                session.executionPort !== boundPort ||
                target.documentId !== handoff.sourceDocumentId ||
                !details.documentId ||
                (sameDocument
                  ? details.documentId !== handoff.sourceDocumentId
                  : details.documentId === handoff.sourceDocumentId)
              )
                handoff.invalid = true;
              else {
                handoff.videoId ||= route.manyvidsId;
                handoff.expectedUrl ||= details.url;
                handoff.documentId = details.documentId;
                handoff.url = details.url;
              }
              void checkpointCreatorUploadSession(session).catch(() => {
                handoff.invalid = true;
              });
            };
            const sameDocument = (details) => observe(details, true);
            handoff.cleanup = () => {
              chrome.webNavigation.onCommitted.removeListener(observe);
              chrome.webNavigation.onHistoryStateUpdated?.removeListener(
                sameDocument,
              );
            };
            chrome.webNavigation.onCommitted.addListener(observe);
            chrome.webNavigation.onHistoryStateUpdated?.addListener(
              sameDocument,
            );
            await checkpointCreatorUploadSession(session);
          } else if (target.editorHandoff.commandId !== message.commandId)
            throw new Error("An editor handoff is already pending.");
        }
        return { step };
      }
      case "FOREGROUND_CREATOR_UPLOAD_OBSERVATION": {
        const session = await getCreatorUploadSession(message.sessionId);
        const target = session?.platforms.get(message.platform);
        return focusCreatorUploadObservation(session, target, sender);
      }
      case "DELIVER_CREATOR_UPLOAD_FILE": {
        const session = await getCreatorUploadSession(message.sessionId);
        const target = session?.platforms.get(message.platform);
        if (
          !session ||
          session.cancelled ||
          !target ||
          sender.tab?.id !== target.tabId ||
          !Object.hasOwn(target.tokens || {}, message.role)
        ) {
          throw new Error("Unauthorized creator upload file request.");
        }
        await assertCreatorUploadPageBinding(session, target, sender);
        const journal = (
          await CREATOR_UPLOAD_SESSION_STORE.listRecovery()
        ).find((record) => record.id === session.id);
        const intent = journal?.steps.find(
          (step) =>
            step.commandId === message.commandId &&
            step.actionId === `select-${message.role}` &&
            step.platform === message.platform &&
            step.documentId === sender.documentId &&
            step.tabId === target.tabId &&
            step.frameId === 0,
        );
        if (!intent || intent.outcome !== "intent" || session.restored)
          throw new Error(
            "File delivery has no fresh, bound, unissued selection intent.",
          );
        await CREATOR_UPLOAD_SESSION_STORE.recordStep(session.id, {
          ...intent,
          launcher: session.launcher,
          outcome: "issued",
        });
        await assertCreatorUploadPageBinding(session, target, sender);
        // Foreground observation never overlaps a native chooser or file handoff.
        while (creatorUploadForeground) await creatorUploadForeground;
        await assertCreatorUploadPageBinding(session, target, sender);
        await creatorUploadRequestFile(session, message.platform, message.role);
        return { delivered: true };
      }
      case "CREATOR_UPLOAD_PLATFORM_PROGRESS": {
        const session = await getCreatorUploadSession(message.sessionId);
        const target = session?.platforms.get(message.platform);
        if (!session || !target || sender.tab?.id !== target.tabId) {
          throw new Error("Unauthorized creator upload progress update.");
        }
        await assertCreatorUploadPageBinding(session, target, sender);
        if (
          !sender.documentId ||
          !Number.isSafeInteger(message.sequence) ||
          message.sequence < 1
        )
          throw new Error(
            "Preparation progress has no document or sequence binding.",
          );
        if (
          target.documentId &&
          (target.documentId !== sender.documentId ||
            target.progressStage !== message.executionStage)
        ) {
          if (
            message.platform !== "manyvids" ||
            message.executionStage !== "edit" ||
            target.stage !== "edit" ||
            manyVidsRoute(sender.url, "edit")?.manyvidsId !== target.manyvidsId
          )
            throw new Error("Preparation document changed.");
          target.progressSequence = 0;
        }
        if (
          session.cancelled ||
          target.stage === "cancelled" ||
          CREATOR_UPLOAD_TERMINAL_STATUSES.has(target.status)
        )
          throw new Error("Preparation progress is stale or cancelled.");
        if (message.sequence <= (target.progressSequence || 0)) {
          // A lost acknowledgement may follow a storage failure; re-confirm
          // durability before acknowledging the already applied sequence.
          await checkpointCreatorUploadSession(session);
          return { forwarded: false };
        }
        const status = creatorUploadClean(message.status, 100);
        if (
          !new Set([
            "uploading-full",
            "upload-observing",
            "upload-progress-unknown",
            "upload-attention-required",
            "configuring",
            "prepared",
            "waiting-for-teaser",
            "waiting-for-thumbnail",
            "upload-ready",
            "edit-requested",
            "save-clicked",
            "submitted",
          ]).has(status)
        ) {
          throw new Error("Invalid creator upload progress state.");
        }
        target.documentId = sender.documentId;
        target.progressStage = message.executionStage;
        target.progressSequence = message.sequence;
        if (status === "submitted") target.submitted = true;
        target.status = status;
        target.error =
          status === "upload-attention-required"
            ? creatorUploadClean(message.error, 500)
            : "";
        await checkpointCreatorUploadSession(session);
        creatorUploadPost(session.id, {
          type: "platform-progress",
          platform: message.platform,
          status,
          error: target.error,
        });
        return { forwarded: true };
      }
      case "SYNC_CREATOR_TOOLS":
        return {
          creatorTools: await syncCreatorToolRegistrations(
            message.settings
              ? CREATOR_REGISTRY.normalizeSettings(message.settings).value
              : null,
          ),
        };
      case "TEST_GELBOORU":
        return {
          test: await testGelbooruConnection(
            message.gelbooruUserId,
            message.gelbooruApiKey,
            message.gelbooruRatingMode,
          ),
        };
      case "TEST_REALBOORU":
        return {
          test: await testRealbooruConnection(),
        };
      case "RESET_MAPPINGS":
        await resetMappings();
        return { stats: await getStats() };
      case "RESET_NAMES":
        return {
          resetAccounts: await resetNames(),
          stats: await getStats(),
        };
      case "RESET_PICTURES":
        return {
          resetAccounts: await resetPictures(),
          stats: await getStats(),
        };
      case "ADD_CUSTOM_AVATARS":
        return { importedAvatars: await addCustomAvatars(message.avatars) };
      case "CLEAR_CUSTOM_AVATARS":
        await clearCustomAvatars();
        return { stats: await getStats() };
      case "RESOLVE_IDENTITY":
        return {
          identity: await resolveIdentity(message.primaryKey, message.aliases),
        };
      case "RESOLVE_IDENTITIES":
        return {
          items: await resolveIdentities(message.items),
        };
      case "ROTATE_AVATAR":
        return {
          result: await rotateAvatar(message.primaryKey, message.aliases),
        };
      default:
        throw new Error("Unknown extension request.");
    }
  })()
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error.message,
        ...(error.uploadAdmission
          ? { uploadAdmission: error.uploadAdmission }
          : {}),
        ...(error.recoveryRequired ? { recoveryRequired: true } : {}),
        rejectionCode:
          error.rejectionCode ||
          {
            "Preparation document changed.": "preparation-document-changed",
            "Preparation progress is stale or cancelled.":
              "preparation-progress-stale",
            "File delivery has no fresh, bound, unissued selection intent.":
              "preparation-selection-intent-invalid",
            "Preparation progress has no document or sequence binding.":
              "preparation-progress-binding-missing",
            "Unauthorized preparation step.": "preparation-step-unauthorized",
            "Unauthorized creator upload progress update.":
              "preparation-progress-unauthorized",
            "Invalid creator upload progress state.":
              "preparation-progress-state-invalid",
            "The upload console is not connected.":
              "upload-console-disconnected",
            "The upload port disconnected.": "upload-console-disconnected",
          }[error.message] ||
          "preparation-request-rejected",
        ...(error.bindingFacts ? { bindingFacts: error.bindingFacts } : {}),
      }),
    );

  return true;
}
chrome.runtime.onMessage.addListener(handleExtensionMessage);

async function recordCreatorManualPreparation(session, target) {
  if (session.cancelled || target.stage === "cancelled")
    throw new Error("Preparation was cancelled.");
  const result = {
    platform: target.platform,
    status: "manual-submit-required",
  };
  Object.assign(target, result);
  await checkpointCreatorUploadSession(session);
  creatorUploadPost(session.id, {
    type: "platform-result",
    platform: target.platform,
    result,
  });
  return result;
}

async function associateCreatorUploadCatalogue(sessionId, candidate) {
  const session = await getCreatorUploadSession(sessionId);
  if (!session) throw new Error("This upload session is no longer available.");
  const snapshot = await CREATOR_CATALOGUE_CLIENT.getCatalogueSnapshot();
  const row = snapshot.rows?.find(
    (row) => row.row === candidate?.row && row.id === candidate?.id,
  );
  if (!row || row.fingerprint !== candidate.fingerprint)
    throw new Error("The catalogue changed. Choose the item again.");
  if (
    session.catalogue &&
    (session.catalogue.id !== row.id || session.catalogue.row !== row.row)
  )
    throw new Error(
      "This upload is already associated with another catalogue item.",
    );
  session.catalogue = { ...row, status: "matched" };
  await checkpointCreatorUploadSession(session);
  const results = [];
  for (const [platform, target] of session.platforms) {
    if (!target.postUrl) continue;
    const result = await commitCreatorUploadResult(
      session,
      platform,
      target.postUrl,
    );
    Object.assign(target, { status: result.status });
    await checkpointCreatorUploadSession(session);
    results.push({ platform, postUrl: target.postUrl, status: result.status });
  }
  return results;
}

function assertDevelopmentConsole(sender) {
  if (
    sender?.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("upload-console.html") ||
    !sender.documentId
  )
    throw new Error(
      "Development fixtures are restricted to the personal Upload Console.",
    );
}

async function attachDevelopmentFile(message, sender) {
  const pending = creatorUploadFileRequests.get(message.requestId);
  if (
    !pending ||
    pending.port.desktop ||
    !creatorUploadConsolePorts.has(pending.port) ||
    pending.port.sender?.documentId !== sender.documentId ||
    pending.port.sender?.tab?.id !== sender.tab?.id
  )
    throw new Error("The template no longer belongs to this upload window.");
  const file = await sendDesktopRequest("resolveDevelopmentFixture", {
    fixtureToken: message.fixtureToken,
    extensionVersion: chrome.runtime.getManifest().version,
  });
  if (
    file.name !== message.name ||
    file.size !== message.size ||
    file.lastModified !== message.lastModified
  )
    throw new Error("Template changed. Click Load Template again.");
  return attachBoundUploadFile({ ...message, filePath: file.filePath });
}

async function attachCatalogueThumbnailFile(message, sender) {
  const pending = creatorUploadFileRequests.get(message.requestId);
  if (
    !pending ||
    pending.role !== "thumbnail" ||
    pending.port.desktop ||
    !creatorUploadConsolePorts.has(pending.port) ||
    pending.port.sender?.documentId !== sender.documentId ||
    pending.port.sender?.tab?.id !== sender.tab?.id
  )
    throw new Error(
      "The selected thumbnail no longer belongs to this upload window.",
    );
  const file = await sendDesktopRequest("resolveUploadThumbnail", {
    catalogueId: message.catalogueId,
    assetId: message.assetId,
    name: message.name,
    size: message.size,
    lastModified: message.lastModified,
  });
  return attachBoundUploadFile({
    ...message,
    filePath: file.filePath,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  });
}

async function attachDesktopUploadFile(command, ports) {
  const pending = creatorUploadFileRequests.get(command.requestId);
  if (!pending?.port.desktop || ![...ports.values()].includes(pending.port))
    throw new Error(
      "The selected file no longer belongs to this upload request.",
    );
  return attachBoundUploadFile(command);
}

async function attachBoundUploadFile(command) {
  const pending = creatorUploadFileRequests.get(command.requestId);
  if (
    !pending ||
    pending.sessionId !== command.sessionId ||
    pending.platform !== command.platform ||
    pending.role !== command.role ||
    pending.token !== command.token ||
    !Number.isInteger(pending.tabId)
  )
    throw new Error(
      "The selected file no longer belongs to this upload request.",
    );
  if (pending.deliveryStarted)
    throw new Error("This file assignment has already been attempted.");
  pending.deliveryStarted = true;
  const validateBinding = async () => {
    if (new Set(["x", "redgifs"]).has(pending.platform)) return;
    const session = await getCreatorUploadSession(pending.sessionId);
    const target = session?.platforms.get(pending.platform);
    if (
      !session ||
      session.executionPort !== pending.port ||
      target?.documentId !== pending.documentId ||
      target?.boundUrl !== pending.boundUrl
    )
      throw new Error("The upload file request binding changed.");
    await assertCreatorUploadPageBinding(session, target, {
      tab: { id: pending.tabId },
      frameId: 0,
      documentId: pending.documentId,
      url: pending.boundUrl,
    });
  };
  await validateBinding();
  const injectionTarget = {
    tabId: pending.tabId,
    ...(pending.documentId ? { documentIds: [pending.documentId] } : {}),
  };
  const origins = {
    onlyfans: "https://onlyfans.com",
    pornhub: "https://pornhub.mainhub.com",
    fansly: "https://fansly.com",
    manyvids: "https://www.manyvids.com",
    x: "https://x.com",
    redgifs: "https://studio.redgifs.com",
  };
  const origin = origins[pending.platform];
  pending.fileController = new AbortController();
  const tab = await chrome.tabs.get(pending.tabId);
  if (!origin || new URL(tab.url).origin !== origin)
    throw new Error("The upload page changed.");
  const [target] = await chrome.scripting.executeScript({
    target: injectionTarget,
    func: (id, role, token) =>
      globalThis.CreatorUploadFileBridge.attachmentTarget(id, role, token),
    args: [pending.sessionId, pending.role, pending.token],
  });
  await validateBinding();
  let pickerSelector;
  if (pending.platform === "pornhub" && pending.role === "pornhub") {
    const [binding] = await chrome.scripting.executeScript({
      target: injectionTarget,
      func: () =>
        globalThis.CreatorUploadPlatformAdapters.bindPornhubDeviceAction(),
    });
    pickerSelector = binding?.result;
    if (!pickerSelector)
      throw new Error("Pornhub device action binding is unavailable.");
  }
  const receipt = await globalThis.CreatorLocalFileAttacher.attach({
    validateBinding,
    validatePicker: async () => {
      await validateBinding();
      if (pending.platform !== "pornhub" || pending.role !== "pornhub") return;
      const [verified] = await chrome.scripting.executeScript({
        target: injectionTarget,
        func: (selector) =>
          globalThis.CreatorUploadPlatformAdapters.verifyPornhubDeviceAction(
            selector,
          ),
        args: [pickerSelector],
      });
      if (verified?.result !== true)
        throw new Error("Pornhub device action changed before activation.");
      await validateBinding();
    },
    tabId: pending.tabId,
    selector: target.result.selector,
    pickerSelector:
      pending.platform === "onlyfans" && pending.role === "full"
        ? "#attach_file_photo[aria-label='Add media']"
        : pending.platform === "pornhub" && pending.role === "pornhub"
          ? pickerSelector
          : undefined,
    activatePicker:
      pending.platform === "pornhub" && pending.role === "pornhub",
    requireConnectedInput: pending.platform === "pornhub",
    filePath: command.filePath,
    allowedOrigins: [origin],
    signal: pending.fileController.signal,
    expected: {
      name: command.name,
      size: command.size,
      lastModified: command.lastModified,
    },
  });
  if (
    pending.fileController.signal.aborted ||
    !creatorUploadFileRequests.has(command.requestId)
  )
    throw new Error("The file request was cancelled or interrupted.");
  await validateBinding();
  if (receipt?.attached !== true)
    throw new Error("Native file receipt is unverified.");
  await chrome.scripting.executeScript({
    target: injectionTarget,
    func: (id, role, token, expected) =>
      globalThis.CreatorUploadFileBridge.acknowledgeNative(
        id,
        role,
        token,
        expected,
        true,
      ),
    args: [
      pending.sessionId,
      pending.role,
      pending.token,
      { name: command.name, size: command.size },
    ],
  });
  creatorUploadHandlePortMessage(pending.port, {
    type: "file-response",
    requestId: command.requestId,
    ok: true,
  });
  return { delivered: true };
}

if (chrome.runtime.connectNative && globalThis.CreatorDesktopUploadRuntime) {
  globalThis.CreatorDesktopUploadRuntime.create({
    chrome,
    lifecycle: extensionLifecycle,
    handleMessage: handleExtensionMessage,
    bindPort(port, message) {
      creatorUploadConsolePorts.add(port);
      creatorUploadHandlePortMessage(port, message);
    },
    unbindPort(port) {
      creatorUploadConsolePorts.delete(port);
      for (const [id, pending] of creatorUploadFileRequests) {
        if (pending.port !== port) continue;
        clearTimeout(pending.timeout);
        pending.reject(new Error("The desktop upload window disconnected."));
        creatorUploadFileRequests.delete(id);
      }
    },
    attachFile: attachDesktopUploadFile,
  }).start();
}
