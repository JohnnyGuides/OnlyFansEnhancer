importScripts(
  "creator-tools/registry.js",
  "creator-tools/catalogue-contract.js",
  "creator-tools/catalogue-client.js",
  "creator-tools/subreddit-presets.js",
  "creator-tools/upload-session-store.js",
  "creator-tools/social-distribution-contract.js",
  "creator-tools/social-distribution-session-store.js",
  "creator-tools/social-distribution-orchestrator.js",
  "creator-tools/social-chrome-runtime.js",
  "creator-tools/x-teaser-contract.js",
  "creator-tools/x-teaser-session-store.js",
  "creator-tools/x-teaser-reconcile.js",
  "creator-tools/x-teaser-tab-binding.js",
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

async function routeOFEnhancerAppRequest(operation) {
  if (operation === "getStatus") return getDesktopStatus();
  if (operation === "openChromeUploader") {
    await openUploadConsole();
    return { opened: true };
  }
  throw new Error("unsupported-operation");
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
  await X_TEASER_SESSION_STORE.save({
    id,
    stage: "paired",
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
    files: ["creator-tools/x-teaser-observer.js"],
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
    js: ["creator-tools/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-fansly",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://fansly.com/*"],
    matches: ["https://fansly.com/*"],
    js: ["creator-tools/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-manyvids",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://www.manyvids.com/*"],
    matches: ["https://www.manyvids.com/*"],
    js: ["creator-tools/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-pornhub",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://pornhub.mainhub.com/*"],
    matches: ["https://pornhub.mainhub.com/*"],
    js: ["creator-tools/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-x",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://x.com/*"],
    matches: ["https://x.com/*"],
    js: ["creator-tools/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-upload-trace-redgifs",
    toolIds: ["uploadTraceRecorder"],
    origins: ["https://www.redgifs.com/*", "https://studio.redgifs.com/*"],
    matches: ["https://www.redgifs.com/*", "https://studio.redgifs.com/*"],
    js: ["creator-tools/upload-trace-recorder.js"],
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
    js: ["creator-tools/upload-trace-recorder.js"],
    runAt: "document_start",
  },
  {
    id: "creator-toolkit-c4s",
    toolIds: ["c4sUpload"],
    origins: ["https://workspace.clips4sale.com/*"],
    matches: ["https://workspace.clips4sale.com/upload*"],
    js: [
      "creator-tools/registry.js",
      "creator-tools/common.js",
      "creator-tools/c4s-upload.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-pornhub",
    toolIds: ["phUploader"],
    origins: ["https://pornhub.mainhub.com/*"],
    matches: ["https://pornhub.mainhub.com/upload/uploader*"],
    js: [
      "creator-tools/registry.js",
      "creator-tools/common.js",
      "creator-tools/ph-uploader.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-fansly",
    toolIds: ["fanslyPrefill"],
    origins: ["https://fansly.com/*"],
    matches: ["https://fansly.com/*"],
    js: [
      "creator-tools/registry.js",
      "creator-tools/common.js",
      "creator-tools/fansly-prefill.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-manyvids",
    toolIds: ["manyvidsAutofill"],
    origins: ["https://www.manyvids.com/*"],
    matches: ["https://www.manyvids.com/Edit-vid/*"],
    js: [
      "creator-tools/registry.js",
      "creator-tools/common.js",
      "creator-tools/manyvids-autofill.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-sheer",
    toolIds: ["sheerTags"],
    origins: ["https://my.sheer.com/*"],
    matches: ["https://my.sheer.com/content/update/*"],
    js: [
      "creator-tools/registry.js",
      "creator-tools/common.js",
      "creator-tools/sheer-tags.js",
    ],
    runAt: "document_idle",
  },
  {
    id: "creator-toolkit-onlyfans-lists",
    toolIds: ["onlyfansAutoSelect", "onlyfansAutoFollow"],
    origins: ["https://onlyfans.com/*"],
    matches: ["https://onlyfans.com/my/collections/user-lists*"],
    js: [
      "creator-tools/registry.js",
      "creator-tools/common.js",
      "creator-tools/onlyfans-list-common.js",
      "creator-tools/onlyfans-auto-select.js",
      "creator-tools/onlyfans-auto-follow.js",
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
      "creator-tools/registry.js",
      "creator-tools/common.js",
      "creator-tools/reddit-banner-censor.js",
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
    landingUrl: "https://pornhub.mainhub.com/upload/uploader",
    origin: "https://pornhub.mainhub.com",
  }),
});
const CREATOR_UPLOAD_PROBE_FILE = "creator-tools/upload-capability-probe.js";
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
const CREATOR_UPLOAD_FILE_BRIDGE = "creator-tools/upload-file-bridge.js";
const CREATOR_UPLOAD_ADAPTERS = "creator-tools/upload-platform-adapters.js";
const CREATOR_UPLOAD_RESPONSE_OBSERVER =
  "creator-tools/upload-response-observer.js";

function installCreatorUploadFileBridge(config) {
  return globalThis.CreatorUploadFileBridge.install(config);
}

function installCreatorUploadResponseObserver(config) {
  return globalThis.CreatorUploadResponseObserver.install(config);
}

function markCreatorToolkitMasterRun() {
  globalThis.CreatorToolkitMasterRun = true;
}

async function invokeCreatorPornhubPreparation(args) {
  const adapter = globalThis.CreatorToolkitAdapters?.phUploader;
  const toolkit = globalThis.CreatorToolkit;
  if (!adapter || !toolkit) {
    throw new Error("Pornhub metadata recipe is unavailable.");
  }
  const resolved = adapter.resolvePreset(args.profile, "", args.contentPreset);
  if (!resolved) throw new Error("Pornhub content preset is unavailable.");
  const plan = adapter.inspectPreset(resolved.name, resolved.preset);
  const result = await adapter.applyPreset(
    plan,
    undefined,
    toolkit.createBudget(undefined, {
      maxActions: 100,
      maxDurationMs: 180_000,
    }),
  );
  if (result.status !== "success") {
    throw new Error(result.summary || "Pornhub metadata preparation stopped.");
  }
  return {
    platform: "pornhub",
    status: "manual-submit-required",
    effectiveFilename: args.effectiveFilename,
    preset: resolved.name,
  };
}

function cancelCreatorUploadResponseObserverInPage(config) {
  globalThis.CreatorUploadResponseObserver?.cancel(
    config.sessionId,
    config.platform,
  );
}
const creatorUploadSessions = new Map();
const creatorUploadConsolePorts = new Set();
const creatorUploadFileRequests = new Map();
let creatorUploadRequestCounter = 0;
const CREATOR_UPLOAD_TERMINAL_STATUSES = new Set([
  "catalogue-updated",
  "uploaded-no-sheet",
  "manual-submit-required",
  "already-linked",
  "idempotent",
]);

function creatorUploadSessionRecord(session) {
  return {
    id: session.id,
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

async function getCreatorUploadSession(sessionId) {
  const id = creatorUploadClean(sessionId, 64);
  if (!CREATOR_UPLOAD_SESSION_PATTERN.test(id)) return null;
  const active = creatorUploadSessions.get(id);
  if (active) return active;
  const stored = await CREATOR_UPLOAD_SESSION_STORE.load(id);
  if (!stored) return null;
  const session = {
    id,
    createdAt: stored.createdAt || Date.now(),
    updatedAt: stored.updatedAt || Date.now(),
    draft: stored.draft || {},
    catalogue: stored.catalogue ?? null,
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
  return (
    creatorUploadClean(proof.fullFilename, 500) ===
      session.draft.fullFilename &&
    creatorUploadClean(proof.pornhubFilename, 500) ===
      session.draft.pornhubFilename &&
    (proof.manyvidsThumbnail === true) ===
      (session.draft.manyvidsThumbnail === true) &&
    creatorUploadClean(proof.profileSignature, 50_000) ===
      session.draft.profileSignature
  );
}

function creatorUploadClean(value, maximum) {
  return String(value || "")
    .trim()
    .slice(0, maximum);
}

function validateCreatorUploadRequest(message) {
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
    manyvidsThumbnail: message.draft?.manyvidsThumbnail === true,
    pornhubFilename: creatorUploadClean(message.draft?.pornhubFilename, 500),
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
  draft.profileSignature = JSON.stringify(draft.profiles);
  const providedProfileSignature = creatorUploadClean(
    message.draft?.profileSignature,
    50_000,
  );
  if (
    providedProfileSignature &&
    providedProfileSignature !== draft.profileSignature
  ) {
    throw new Error("Creator workflow profiles changed after confirmation.");
  }
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
  if (targets.includes("fansly") && draft.fanslyPreset !== "defaulT") {
    throw new Error("Fansly full media requires the exact defaulT preset.");
  }
  if (targets.includes("fansly") && !draft.fanslyCaption) {
    draft.fanslyCaption = draft.description;
  }
  if (targets.includes("pornhub")) {
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
    catalogue.row > 5000 ||
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
  for (const platform of ["pornhub", "onlyfans", "fansly", "manyvids"]) {
    const field = `${platform}Link`;
    const raw = catalogue[field];
    const canonical = raw
      ? CREATOR_CATALOGUE_CONTRACT.canonicalPostUrl(platform, raw)
      : "";
    if (raw && !canonical) {
      throw new Error(`Invalid ${platform} catalogue link.`);
    }
    catalogue[field] = canonical;
    if (targets.includes(platform) && canonical) {
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
  port.postMessage({ sessionId, ...message });
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

function creatorSocialRequestFile({ sessionId, platform, role, token }) {
  if (
    platform !== "x" ||
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
        if (!session) return;
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
        port.postMessage({
          type: "session-restored",
          sessionId,
          platforms: [...session.platforms.values()].map((target) => ({
            platform: target.platform,
            status: target.status,
            postUrl: target.postUrl,
            manyvidsId: target.manyvidsId,
            error: target.error,
          })),
        });
      })
      .catch(() => {});
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

async function prepareCreatorUploadPlatform(session, platform, tabId = null) {
  const definition = CREATOR_UPLOAD_TARGETS[platform];
  const existing = tabId
    ? [await chrome.tabs.get(tabId)]
    : await chrome.tabs.query({ url: definition.match });
  const useExisting = existing.length === 1;
  const tab = useExisting
    ? await chrome.tabs.update(existing[0].id, {
        active: true,
        url: definition.landingUrl,
      })
    : await chrome.tabs.create({ url: definition.landingUrl, active: true });
  await waitForCreatorTab(tab.id);
  const loaded = await chrome.tabs.get(tab.id);
  if (!creatorUrlMatches(loaded?.url, definition)) {
    throw new Error(
      `${platform} left its expected origin before upload preparation.`,
    );
  }
  if (platform === "pornhub") {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: markCreatorToolkitMasterRun,
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [
        "creator-tools/registry.js",
        "creator-tools/common.js",
        "creator-tools/ph-uploader.js",
      ],
    });
    const target = {
      platform,
      tabId: tab.id,
      stage: "prepared",
      status: "prepared",
      createdAt: Date.now(),
    };
    session.platforms.set(platform, target);
    await checkpointCreatorUploadSession(session);
    return target;
  }
  const tokens = {
    full: creatorUploadRandomToken(),
    ...(["fansly", "manyvids"].includes(platform)
      ? { teaser: creatorUploadRandomToken() }
      : {}),
    ...(platform === "manyvids" && session.draft.manyvidsThumbnail
      ? { thumbnail: creatorUploadRandomToken() }
      : {}),
  };
  const roles =
    platform === "onlyfans"
      ? { full: { selector: "#file_upload_input", token: tokens.full } }
      : platform === "fansly"
        ? {
            full: {
              selector: "app-post-creation input[type='file']",
              token: tokens.full,
            },
            teaser: {
              selector: "app-post-creation input[type='file']",
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
  if (platform === "fansly") {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: markCreatorToolkitMasterRun,
    });
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: [
      ...(platform === "fansly"
        ? [
            "creator-tools/registry.js",
            "creator-tools/common.js",
            "creator-tools/fansly-prefill.js",
          ]
        : []),
      CREATOR_UPLOAD_FILE_BRIDGE,
      CREATOR_UPLOAD_ADAPTERS,
    ],
  });
  const bridgeBase = chrome.runtime.getURL("file-bridge.html");
  const bridgeOrigin = new URL(bridgeBase).origin;
  const bridgeUrl = `${bridgeBase}?session=${encodeURIComponent(session.id)}&platform=${encodeURIComponent(platform)}&parentOrigin=${encodeURIComponent(definition.origin)}`;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
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
  const target = {
    platform,
    tabId: tab.id,
    tokens,
    stage: "prepared",
    status: "prepared",
    createdAt: Date.now(),
  };
  session.platforms.set(platform, target);
  await checkpointCreatorUploadSession(session);
  return target;
}

async function prepareCreatorManyVidsEdit(session, target) {
  const definition = CREATOR_UPLOAD_TARGETS.manyvids;
  const loaded = await chrome.tabs.get(target.tabId);
  const editRoute = manyVidsRoute(loaded?.url, "edit");
  if (!editRoute || editRoute.manyvidsId !== target.manyvidsId) {
    throw new Error("ManyVids left the expected edit page.");
  }
  await chrome.scripting.executeScript({
    target: { tabId: target.tabId },
    func: markCreatorToolkitMasterRun,
  });
  await chrome.scripting.executeScript({
    target: { tabId: target.tabId },
    files: [
      "creator-tools/registry.js",
      "creator-tools/common.js",
      "creator-tools/manyvids-autofill.js",
      CREATOR_UPLOAD_FILE_BRIDGE,
      CREATOR_UPLOAD_ADAPTERS,
    ],
  });
  const bridgeBase = chrome.runtime.getURL("file-bridge.html");
  const bridgeOrigin = new URL(bridgeBase).origin;
  const roles = {
    teaser: {
      selector: "input.noborder[name='file']",
      token: target.tokens.teaser,
      kind: "video",
    },
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
    target: { tabId: target.tabId },
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

async function prepareCreatorUpload(message) {
  const request = validateCreatorUploadRequest(message);
  if (await getCreatorUploadSession(request.sessionId)) {
    throw new Error("This creator upload session already exists.");
  }
  const session = {
    id: request.sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    draft: request.draft,
    catalogue: request.catalogue,
    platforms: new Map(),
    commitChain: Promise.resolve(),
    cleanupTimer: null,
  };
  creatorUploadSessions.set(session.id, session);
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
}

function invokeCreatorUploadAdapter(args) {
  const send = (message) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(
            new Error(response?.error || "Creator upload request failed."),
          );
          return;
        }
        resolve(response);
      });
    });
  const context = {
    draft: args.draft,
    attachFile: async (role, selector) => {
      if (selector !== args.selectors[role]) {
        throw new Error(
          "The platform adapter requested an unexpected file control.",
        );
      }
      await send({
        type: "DELIVER_CREATOR_UPLOAD_FILE",
        sessionId: args.sessionId,
        platform: args.platform,
        role,
      });
      return globalThis.CreatorUploadFileBridge.waitFor(args.sessionId, role);
    },
    progress(status) {
      send({
        type: "CREATOR_UPLOAD_PLATFORM_PROGRESS",
        sessionId: args.sessionId,
        platform: args.platform,
        status,
      }).catch(() => {});
    },
    beforeCommit() {
      return send({
        type: "CHECKPOINT_CREATOR_UPLOAD_COMMIT",
        sessionId: args.sessionId,
        platform: args.platform,
      });
    },
  };
  if (args.platform === "onlyfans") {
    return globalThis.CreatorUploadPlatformAdapters.runOnlyFans(context);
  }
  if (args.platform === "fansly") {
    return globalThis.CreatorUploadPlatformAdapters.runFansly(context);
  }
  if (args.platform === "manyvids" && args.stage === "upload") {
    return globalThis.CreatorUploadPlatformAdapters.runManyVidsUpload(context);
  }
  if (args.platform === "manyvids" && args.stage === "edit") {
    return globalThis.CreatorUploadPlatformAdapters.runManyVidsEdit(context);
  }
  throw new Error("Unknown creator upload adapter stage.");
}

async function prepareCreatorUploadResponseObserver(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: [
      "creator-tools/catalogue-contract.js",
      CREATOR_UPLOAD_RESPONSE_OBSERVER,
    ],
  });
}

function startCreatorUploadResponseObserver(tabId, sessionId, platform) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: installCreatorUploadResponseObserver,
    args: [{ sessionId, platform }],
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
      const uploadExecution = await chrome.scripting.executeScript({
        target: { tabId: target.tabId },
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
      if (uploadExecution?.[0]?.result?.status !== "edit-requested") {
        throw new Error("ManyVids did not request its edit page.");
      }
      const editRoute = await waitForManyVidsRoute(
        target.tabId,
        "edit",
        2 * 60_000,
      );
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
      teaser: "input.noborder[name='file']",
      ...(target.tokens.thumbnail
        ? { thumbnail: "#fileUploader[name='image']" }
        : {}),
    };
    const editExecution = await chrome.scripting.executeScript({
      target: { tabId: target.tabId },
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
    if (editExecution?.[0]?.result?.status !== "save-clicked") {
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
    await waitForManyVidsRoute(target.tabId, "success", 5 * 60_000);
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
    target.stage = "metadata";
    target.status = "configuring";
    await checkpointCreatorUploadSession(session);
    const execution = await chrome.scripting.executeScript({
      target: { tabId: target.tabId },
      func: invokeCreatorPornhubPreparation,
      args: [
        {
          profile: session.draft.profiles.phUploader,
          contentPreset: session.draft.contentPreset,
          effectiveFilename: session.draft.pornhubFilename,
        },
      ],
    });
    const result = execution?.[0]?.result;
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
    const result = { platform, status: "failed", error: error.message };
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
    await prepareCreatorUploadResponseObserver(target.tabId);
    observerExecution = startCreatorUploadResponseObserver(
      target.tabId,
      session.id,
      platform,
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    const selectors =
      platform === "onlyfans"
        ? { full: "#file_upload_input" }
        : {
            full: "app-post-creation input[type='file']",
            teaser: "app-post-creation input[type='file']",
          };
    const execution = await chrome.scripting.executeScript({
      target: { tabId: target.tabId },
      func: invokeCreatorUploadAdapter,
      args: [
        {
          sessionId: session.id,
          platform,
          selectors,
          draft: session.draft,
        },
      ],
    });
    const adapterResult = execution?.[0]?.result;
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
  const requested = Array.isArray(targets) ? [...new Set(targets)] : [];
  if (
    !requested.length ||
    requested.some((platform) => !session.platforms.has(platform))
  ) {
    throw new Error("Invalid creator upload targets.");
  }
  return Promise.all(
    requested.map((platform) => runCreatorUploadPlatform(session, platform)),
  );
}

async function retryCreatorUploadPlatform(sessionId, platform) {
  const session = await getCreatorUploadSession(sessionId);
  const target = session?.platforms.get(platform);
  if (!session || !target || !Object.hasOwn(CREATOR_UPLOAD_TARGETS, platform)) {
    throw new Error("Unknown creator upload retry target.");
  }
  if (
    [
      "catalogue-updated",
      "uploaded-no-sheet",
      "manual-submit-required",
    ].includes(target.status)
  )
    return [target];
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
  if (platform === "manyvids" && target.manyvidsId) {
    if (!target.tokens) {
      target.tokens = {
        teaser: creatorUploadRandomToken(),
        ...(session.draft.manyvidsThumbnail
          ? { thumbnail: creatorUploadRandomToken() }
          : {}),
      };
    }
    const editUrl = `https://www.manyvids.com/Edit-vid/${target.manyvidsId}`;
    await chrome.tabs.update(target.tabId, { active: true, url: editUrl });
    await waitForCreatorTab(target.tabId);
    const route = await waitForManyVidsRoute(target.tabId, "edit", 20_000);
    if (route.manyvidsId !== target.manyvidsId) {
      throw new Error("ManyVids retry opened a different video.");
    }
    target.status = "prepared";
    target.stage = "edit";
    await checkpointCreatorUploadSession(session);
    return [await runCreatorUploadPlatform(session, platform)];
  }
  const prepared = await prepareCreatorUploadPlatform(
    session,
    platform,
    target.tabId,
  );
  return [await runCreatorUploadPlatform(session, prepared.platform)];
}

async function checkpointCreatorUploadCommit(sessionId, platform, tabId) {
  const session = await getCreatorUploadSession(sessionId);
  const target = session?.platforms.get(platform);
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
  target.stage = "submit-attempted";
  target.commitArmed = true;
  target.submitAttempted = true;
  await checkpointCreatorUploadSession(session);
  const persisted = await CREATOR_UPLOAD_SESSION_STORE.load(session.id);
  const durable = persisted?.platforms?.[platform];
  if (!durable?.commitArmed || !durable.submitAttempted) {
    throw new Error("The creator upload commit checkpoint was not durable.");
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

chrome.runtime.onInstalled.addListener(async () => {
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
});

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
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
        return { result: await routeOFEnhancerAppRequest(message.operation) };
      case "OPEN_UPLOAD_CONSOLE":
        return { uploadConsole: await openUploadConsole() };
      case "SHOW_UPLOAD_TRACE_RECORDER":
        return { traceRecorder: await showUploadTraceRecorder() };
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
      case "PREPARE_CREATOR_UPLOAD":
        return {
          uploadSession: await prepareCreatorUpload(message),
        };
      case "START_CREATOR_UPLOAD":
        return {
          results: await startCreatorUpload(message.sessionId, message.targets),
        };
      case "PREPARE_CREATOR_SOCIAL_DISTRIBUTION":
        return {
          socialDistribution: await getCreatorSocialRuntime().prepare({
            plan: message.plan,
            caption: message.caption,
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
        );
      case "DELIVER_CREATOR_UPLOAD_FILE": {
        const session = await getCreatorUploadSession(message.sessionId);
        const target = session?.platforms.get(message.platform);
        if (
          !session ||
          !target ||
          sender.tab?.id !== target.tabId ||
          !Object.hasOwn(target.tokens || {}, message.role)
        ) {
          throw new Error("Unauthorized creator upload file request.");
        }
        await creatorUploadRequestFile(session, message.platform, message.role);
        return { delivered: true };
      }
      case "CREATOR_UPLOAD_PLATFORM_PROGRESS": {
        const session = await getCreatorUploadSession(message.sessionId);
        const target = session?.platforms.get(message.platform);
        if (!session || !target || sender.tab?.id !== target.tabId) {
          throw new Error("Unauthorized creator upload progress update.");
        }
        const status = creatorUploadClean(message.status, 100);
        if (
          !new Set([
            "uploading-full",
            "configuring",
            "waiting-for-teaser",
            "upload-ready",
            "edit-requested",
            "save-clicked",
            "submitted",
          ]).has(status)
        ) {
          throw new Error("Invalid creator upload progress state.");
        }
        if (status === "submitted") target.submitted = true;
        target.status = status;
        await checkpointCreatorUploadSession(session);
        creatorUploadPost(session.id, {
          type: "platform-progress",
          platform: message.platform,
          status,
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
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
