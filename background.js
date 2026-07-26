"use strict";

const SETTINGS_KEY = "fimSettingsV1";
const STATE_KEY = "fimStateV1";
const CONTROL_KEY = "fimControlV1";
const AVATAR_CACHE_SIZE = 96;
const GELBOORU_QUERY_TAGS = "1girl solo selfie score:>=50";
const GELBOORU_PAGE_SIZE = 100;
const GELBOORU_REQUIRED_POST_TAGS = ["selfie", "1girl", "solo"];
const REALBOORU_QUERY_TAGS = "1girl solo selfie score:>=20";
const REALBOORU_BATCH_SIZE = 12;
const GELBOORU_FORBIDDEN_TAG_PARTS =
  /(^|_)(trans)(_|$)/i;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  ownHandles: ["johnny_guides"],
  avatarMode: "generated",
  gelbooruRatingMode: "any",
  gelbooruUserId: "",
  gelbooruApiKey: "",
  realbooruEndpoint: "http://127.0.0.1:47831",
  realbooruPercentage: 50
});

const FIRST_NAMES = [
  "Ada", "Adaline", "Adelaide", "Adriana", "Aiko", "Alana", "Alba", "Alexandra",
  "Alice", "Alina", "Allegra", "Amalia", "Amara", "Amaya", "Amelie", "Anais",
  "Anastasia", "Anika", "Annabel", "Annika", "Antonia", "Arabella", "Araceli", "Aria",
  "Ariana", "Arielle", "Astrid", "Athena", "Audrey", "Aurora", "Ava", "Aviva",
  "Aya", "Beatrice", "Bianca", "Billie", "Blair", "Blythe", "Bria", "Briar",
  "Bridget", "Calla", "Callie", "Calista", "Camille", "Carina", "Carmen", "Caroline",
  "Cassandra", "Cecilia", "Celeste", "Celine", "Charlotte", "Chloe", "Chiara", "Clara",
  "Cleo", "Colette", "Coral", "Cordelia", "Corinne", "Dahlia", "Daphne", "Delia",
  "Diana", "Eden", "Edith", "Elara", "Eleanor", "Elena", "Elise", "Eliza",
  "Elizabeth", "Ella", "Eloise", "Elodie", "Elsie", "Emilia", "Emily", "Emma",
  "Emmeline", "Esme", "Estelle", "Eugenia", "Eva", "Evangeline", "Evelina", "Evelyn",
  "Faye", "Felicity", "Fern", "Flora", "Florence", "Frances", "Francesca", "Freya",
  "Gabriella", "Gaia", "Gemma", "Genevieve", "Georgia", "Giselle", "Gloria", "Grace",
  "Greta", "Gwen", "Hana", "Harlow", "Hazel", "Helena", "Ilaria", "Imogen",
  "Indigo", "Ines", "Iris", "Isabel", "Isla", "Ivy", "Jane", "Jasmine",
  "Joanna", "Josephine", "Josette", "Julia", "Juliet", "Juniper", "Kaia", "Kaori",
  "Karina", "Katherine", "Keira", "Kira", "Lana", "Laurel", "Layla", "Leilani",
  "Lena", "Lenore", "Leona", "Leora", "Lila", "Liliana", "Lily", "Linnea",
  "Lorelei", "Lorraine", "Louisa", "Lucia", "Lucy", "Luna", "Lydia", "Lyla",
  "Lyra", "Mae", "Magnolia", "Maia", "Malia", "Margot", "Mariana", "Marina",
  "Maren", "Marigold", "Marisol", "Matilda", "Maya", "Meadow", "Mei", "Melina",
  "Melody", "Meredith", "Mila", "Mira", "Miriam", "Morgan", "Nadia", "Nadine",
  "Naomi", "Nell", "Nina", "Noelle", "Nora", "Nova", "Octavia", "Odessa",
  "Olive", "Olivia", "Oona", "Opal", "Paloma", "Pandora", "Penelope", "Phoebe",
  "Poppy", "Ramona", "Rebecca", "Rei", "Rhea", "Rina", "Rosalie", "Rosalind",
  "Rose", "Rowan", "Rowena", "Ruby", "Sabine", "Sage", "Sakura", "Selene",
  "Serena", "Sienna", "Simone", "Sloane", "Sofia", "Sora", "Stella", "Susannah",
  "Sylvie", "Talia", "Tessa", "Thea", "Valentina", "Valerie", "Vera", "Veronica",
  "Victoria", "Violet", "Vivian", "Viviana", "Willa", "Willow", "Winona", "Yara",
  "Yuna", "Yuki", "Zara", "Zelie", "Zinnia", "Zoe"
];

const NICKNAMES = [
  "angel", "babe", "baby", "bee", "belle", "bloom", "bunny", "cherry",
  "cloud", "daisy", "doll", "dream", "fairy", "glow", "honey", "kitty",
  "lilac", "love", "moon", "nova", "peach", "petal", "rose", "softie",
  "spark", "star", "sunny", "velvet"
];

const HANDLE_SUFFIXES = [
  "archive", "diary", "dreams", "files", "garden", "jpg", "online", "room",
  "verse", "world", "xo"
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
    "</svg>"
  ].join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function normalizeSettings(value = {}) {
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
        : DEFAULT_SETTINGS.realbooruPercentage
    )
  );

  if (/(?:^|[?&])api_key=/i.test(gelbooruApiKey)) {
    const fragment = gelbooruApiKey.replace(/^[?&]/, "");
    const params = new URLSearchParams(fragment);
    gelbooruApiKey = (params.get("api_key") || "").trim();
    gelbooruUserId = (params.get("user_id") || gelbooruUserId).trim();
  }

  return {
    ...DEFAULT_SETTINGS,
    ...value,
    ownHandles: ownHandles
      .map((handle) => String(handle).trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
    avatarMode: ["gelbooru", "realbooru", "mixed", "custom"].includes(
      value.avatarMode
    )
      ? value.avatarMode
      : "generated",
    gelbooruRatingMode:
      value.gelbooruRatingMode === "general" ? "general" : "any",
    gelbooruUserId,
    gelbooruApiKey,
    realbooruEndpoint: normalizeRealbooruEndpoint(
      value.realbooruEndpoint || DEFAULT_SETTINGS.realbooruEndpoint
    ),
    realbooruPercentage
  };
}

function normalizeRealbooruEndpoint(value) {
  try {
    const endpoint = new URL(String(value || ""));
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1"
    ) {
      return DEFAULT_SETTINGS.realbooruEndpoint;
    }
    endpoint.pathname = "";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_SETTINGS.realbooruEndpoint;
  }
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
      (item) => String(item.avatarId) === String(id)
    );
    if (identity?.avatarSourceUrl) usedAvatarUrls[identity.avatarSourceUrl] = true;
    if (identity?.avatarFingerprint) {
      usedAvatarFingerprints[identity.avatarFingerprint] = true;
    }
    gelbooruHistory.push({
      id: String(id),
      postUrl: identity?.avatarPostUrl || "",
      sourceUrl: identity?.avatarSourceUrl || "",
      fingerprint: identity?.avatarFingerprint || "",
      action: "previously-used",
      usedAt: 0
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
    lastAvatarError: value.lastAvatarError || ""
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
    nickname
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
    `x${firstHandle}x`
  ];

  return {
    displayName: displayModes[(hash >>> 4) % displayModes.length],
    handle: uniqueHandle(
      handleBases[(hash >>> 12) % handleBases.length],
      state,
      ownerKey
    )
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
        ["general", "safe"].includes(String(post.rating).toLowerCase())
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
      postUrl: `https://gelbooru.com/index.php?page=post&s=view&id=${post.id}`
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
        .replace(/[\s-]+/g, "_")
    )
    .filter(Boolean);
}

function parseRealbooruResponse(payload) {
  const posts = Array.isArray(payload?.posts) ? payload.posts : [];
  return posts
    .filter((post) => {
      const tags = normalizeBooruTags(post.tags);
      const tagSet = new Set(tags);
      const femaleEvidence = [
        "1girl",
        "female",
        "female_only",
        "female_solo",
        "solo_female"
      ].some((tag) => tagSet.has(tag));
      return (
        tagSet.has("selfie") &&
        tagSet.has("solo") &&
        femaleEvidence &&
        !tags.some((tag) => GELBOORU_FORBIDDEN_TAG_PARTS.test(tag))
      );
    })
    .map((post) => ({
      source: "realbooru",
      id: String(post.id || ""),
      url: String(post.url || ""),
      fingerprint: /^[a-f0-9]{32}$/i.test(String(post.fingerprint || ""))
        ? String(post.fingerprint).toLowerCase()
        : "",
      postUrl: String(post.postUrl || "")
    }))
    .filter(
      (post) =>
        post.id &&
        /^https:\/\/realbooru\.com\//i.test(post.url) &&
        /^https:\/\/realbooru\.com\//i.test(post.postUrl)
    );
}

async function hasGelbooruPermission() {
  return chrome.permissions.contains({
    origins: ["https://gelbooru.com/*", "https://*.gelbooru.com/*"]
  });
}

async function hasRealbooruPermission() {
  return chrome.permissions.contains({
    origins: ["https://realbooru.com/*", "http://127.0.0.1/*"]
  });
}

async function requestRealbooruPosts(settings, count = REALBOORU_BATCH_SIZE) {
  if (!(await hasRealbooruPermission())) {
    throw new Error(
      "Realbooru and loopback scraper permissions have not been granted."
    );
  }
  const endpoint = normalizeRealbooruEndpoint(settings.realbooruEndpoint);
  const query = new URLSearchParams({
    tags: REALBOORU_QUERY_TAGS,
    count: String(Math.min(20, Math.max(1, count)))
  });
  let response;
  try {
    response = await fetch(`${endpoint}/random?${query}`, {
      credentials: "omit",
      headers: { Accept: "application/json" }
    });
  } catch (error) {
    throw new Error(
      `Could not reach the local Realbooru scraper at ${endpoint}: ${error.message}`
    );
  }
  if (!response.ok) {
    throw new Error(`Local Realbooru scraper returned HTTP ${response.status}.`);
  }
  const payload = await readGelbooruResponse(response);
  if (payload?.ok !== true) {
    throw new Error(
      `Local Realbooru scraper failed: ${cleanGelbooruReason(payload?.error)}`
    );
  }
  return {
    returnedPosts: Array.isArray(payload.posts) ? payload.posts.length : 0,
    posts: parseRealbooruResponse(payload)
  };
}

async function testRealbooruConnection(realbooruEndpoint) {
  const settings = normalizeSettings({
    realbooruEndpoint,
    avatarMode: "realbooru"
  });
  const result = await requestRealbooruPosts(settings, 3);
  return {
    endpoint: settings.realbooruEndpoint,
    returnedPosts: result.returnedPosts,
    usablePosts: result.posts.length,
    message:
      result.posts.length > 0
        ? "The local scraper and Realbooru post filtering both work."
        : "The local scraper responded, but this random page had no eligible solo selfies."
  };
}

function validateGelbooruSettings(settings) {
  if (!settings.gelbooruUserId || !settings.gelbooruApiKey) {
    throw new Error("Gelbooru API user ID and API key are required.");
  }
  if (!/^\d+$/.test(String(settings.gelbooruUserId))) {
    throw new Error(
      "Gelbooru user ID must be numeric, not a username. Copy the digits shown beside your API key or in your profile URL."
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
      "Gelbooru returned a CAPTCHA/Cloudflare page instead of API data. This is a Gelbooru-side block; wait a little and test again."
    );
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(
      "Gelbooru returned a non-JSON response. The API may be temporarily blocked or unavailable."
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
    api_key: settings.gelbooruApiKey
  });

  let response;
  try {
    response = await fetch(`https://gelbooru.com/index.php?${query}`, {
      credentials: "omit",
      headers: {
        Accept: "application/json"
      }
    });
  } catch (error) {
    throw new Error(`Could not reach Gelbooru: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(
      `Gelbooru API returned HTTP ${response.status}. Check the numeric user ID, API key, and try again later.`
    );
  }

  const payload = await readGelbooruResponse(response);
  if (payload?.success === false || payload?.["@attributes"]?.success === "false") {
    const reason = cleanGelbooruReason(
      payload.reason || payload.message || payload?.["@attributes"]?.reason
    );
    throw new Error(`Gelbooru API rejected the request${reason ? `: ${reason}` : "."}`);
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
    posts: parseGelbooruResponse(payload, settings.gelbooruRatingMode)
  };
}

async function refillGelbooruPool(state, settings) {
  let firstPageResult = null;
  if (!state.gelbooruPageCount) {
    firstPageResult = await requestGelbooruPage(
      settings,
      0,
      GELBOORU_PAGE_SIZE
    );
    state.gelbooruPageCount = Math.max(
      1,
      Math.ceil(firstPageResult.totalCount / GELBOORU_PAGE_SIZE)
    );
  }

  const recentPages = new Set(state.gelbooruRecentPages);
  let page = randomInt(state.gelbooruPageCount);
  for (
    let attempt = 0;
    attempt < 12 && recentPages.has(page) && recentPages.size < state.gelbooruPageCount;
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
    -Math.min(20, Math.max(1, state.gelbooruPageCount - 1))
  );

  const queuedIds = new Set(state.gelbooruPool.map((post) => post.id));
  const queuedUrls = new Set(state.gelbooruPool.map((post) => post.url));
  const queuedFingerprints = new Set(
    state.gelbooruPool.map((post) => post.fingerprint).filter(Boolean)
  );
  const unused = result.posts.filter(
    (post) =>
      !state.usedAvatarIds[post.id] &&
      !state.usedAvatarUrls[post.url] &&
      (!post.fingerprint || !state.usedAvatarFingerprints[post.fingerprint]) &&
      !queuedIds.has(post.id) &&
      !queuedUrls.has(post.url) &&
      (!post.fingerprint || !queuedFingerprints.has(post.fingerprint))
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
    state.realbooruPool.map((post) => post.fingerprint).filter(Boolean)
  );
  const unused = result.posts.filter(
    (post) =>
      !state.usedRealbooruIds[post.id] &&
      !state.usedAvatarUrls[post.url] &&
      (!post.fingerprint || !state.usedAvatarFingerprints[post.fingerprint]) &&
      !queuedIds.has(post.id) &&
      !queuedUrls.has(post.url) &&
      (!post.fingerprint || !queuedFingerprints.has(post.fingerprint))
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
      (item) =>
        (item.source || "gelbooru") === source && item.id === avatar.id
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
      usedAt: Date.now()
    });
    state.gelbooruHistory = state.gelbooruHistory.slice(-1000);
  }
}

async function testGelbooruConnection(
  gelbooruUserId,
  gelbooruApiKey,
  gelbooruRatingMode = "any"
) {
  const settings = normalizeSettings({
    avatarMode: "gelbooru",
    gelbooruRatingMode,
    gelbooruUserId: String(gelbooruUserId || "").trim(),
    gelbooruApiKey: String(gelbooruApiKey || "").trim()
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
          : "Authentication works, but Gelbooru returned no posts for this query."
  };
}

async function takeGelbooruAvatar(state, settings) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    while (state.gelbooruPool.length > 0) {
      const avatar = state.gelbooruPool.shift();
      if (
        state.usedAvatarIds[avatar.id] ||
        state.usedAvatarUrls[avatar.url] ||
        (avatar.fingerprint &&
          state.usedAvatarFingerprints[avatar.fingerprint])
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
        (avatar.fingerprint &&
          state.usedAvatarFingerprints[avatar.fingerprint])
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
    (id) => !state.usedCustomAvatarIds[id]
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
    detection: state.customAvatars[id].detection || "smart"
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
    mode: "face"
  };
}

async function detectFaceCrop(bitmap) {
  if (!("FaceDetector" in globalThis)) return null;
  try {
    const detector = new FaceDetector({
      fastMode: true,
      maxDetectedFaces: 5
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
    return data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
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
    mode: "smart"
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
    credentials: "omit"
  });
  if (!response.ok) throw new Error(`Avatar image returned HTTP ${response.status}.`);

  const sourceBlob = await response.blob();
  if (sourceBlob.type && !/^image\//i.test(sourceBlob.type)) {
    throw new Error(`Avatar response was ${sourceBlob.type}, not an image.`);
  }

  const cachedOriginal = async () => ({
    url: await blobToDataUrl(sourceBlob),
    mode: "cached"
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
        canvas.height
      );
      const avatarBlob = await canvas.convertToBlob({
        type: "image/webp",
        quality: 0.8
      });
      return {
        url: await blobToDataUrl(avatarBlob),
        mode: crop.mode
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
      identity.displayName
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
    postUrl: ""
  };

  if (["gelbooru", "realbooru", "mixed"].includes(settings.avatarMode)) {
    try {
      const gelbooruAvatar = await takeConfiguredRemoteAvatar(state, settings);
      recordGelbooruUse(
        state,
        gelbooruAvatar,
        primaryKey,
        "initial-assignment"
      );
      avatar = {
        kind: gelbooruAvatar.source || "gelbooru",
        id: gelbooruAvatar.id,
        url: gelbooruAvatar.url,
        postUrl: gelbooruAvatar.postUrl,
        sourceUrl: gelbooruAvatar.url,
        fingerprint: gelbooruAvatar.fingerprint
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
        postUrl: ""
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
  const avatar = await createAvatar(primaryKey, name.displayName, state, settings);

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
          : ""
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
    settings
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
  const operation = stateQueue.catch(() => undefined).then(async () => {
    const [settings, state] = await Promise.all([getSettings(), getState()]);
    const result = await mutator(state, settings);
    await chrome.storage.local.set({ [STATE_KEY]: state });
    return result;
  });
  stateQueue = operation.then(
    () => undefined,
    () => undefined
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
      settings
    );
  } else {
    migrateIdentityStyle(state.identities[canonicalKey], canonicalKey, state);
    await migrateAvatarMode(
      state.identities[canonicalKey],
      canonicalKey,
      state,
      settings
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
      settings
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
          settings
        )
      });
    }
    await Promise.all(
      results.map((item) => ensureIdentityAvatarCropped(item.identity, state))
    );
    return results;
  });
}

async function rotateAvatar(primaryKey, aliases = []) {
  const outcome = await queueStateMutation(async (state, settings) => {
    if (
      !["gelbooru", "realbooru", "mixed"].includes(settings.avatarMode)
    ) {
      return {
        error:
          "Click-to-change pictures is available in Gelbooru, Realbooru, or mixed mode."
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
  return outcome;
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
    gelbooruRecentPages: previous.gelbooruRecentPages
  });
  await chrome.storage.local.set({ [STATE_KEY]: next });
}

async function signalIdentityRefresh(kind) {
  await chrome.storage.local.set({
    [CONTROL_KEY]: {
      kind,
      at: Date.now()
    }
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
          canonicalKey
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
          canonicalKey
        )
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
        detection: avatar.detection || "smart"
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
      identity.avatarUrl = generatedAvatar(identity.handle, identity.displayName);
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
    lastAvatarError: state.lastAvatarError
  };
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
      usedAt
    }));
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get([SETTINGS_KEY, STATE_KEY]);
  const writes = {};
  if (!current[SETTINGS_KEY]) writes[SETTINGS_KEY] = normalizeSettings();
  if (!current[STATE_KEY]) writes[STATE_KEY] = normalizeState();
  if (Object.keys(writes).length > 0) await chrome.storage.local.set(writes);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
      case "TEST_GELBOORU":
        return {
          test: await testGelbooruConnection(
            message.gelbooruUserId,
            message.gelbooruApiKey,
            message.gelbooruRatingMode
          )
        };
      case "TEST_REALBOORU":
        return {
          test: await testRealbooruConnection(message.realbooruEndpoint)
        };
      case "RESET_MAPPINGS":
        await resetMappings();
        return { stats: await getStats() };
      case "RESET_NAMES":
        return {
          resetAccounts: await resetNames(),
          stats: await getStats()
        };
      case "RESET_PICTURES":
        return {
          resetAccounts: await resetPictures(),
          stats: await getStats()
        };
      case "ADD_CUSTOM_AVATARS":
        return { importedAvatars: await addCustomAvatars(message.avatars) };
      case "CLEAR_CUSTOM_AVATARS":
        await clearCustomAvatars();
        return { stats: await getStats() };
      case "RESOLVE_IDENTITY":
        return {
          identity: await resolveIdentity(message.primaryKey, message.aliases)
        };
      case "RESOLVE_IDENTITIES":
        return {
          items: await resolveIdentities(message.items)
        };
      case "ROTATE_AVATAR":
        return {
          result: await rotateAvatar(message.primaryKey, message.aliases)
        };
      default:
        throw new Error("Unknown extension request.");
    }
  })()
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
