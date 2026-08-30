"use strict";

const SETTINGS_KEY = "fimSettingsV1";
const STATE_KEY = "fimStateV1";
const CONTROL_KEY = "fimControlV1";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  consentAccepted: false,
  ownHandles: ["johnny_guides"],
  avatarMode: "generated"
});

const FIRST_NAMES = [
  "Ada", "Adaline", "Adelaide", "Adriana", "Aiko", "Alana", "Alba", "Alexandra",
  "Alice", "Alina", "Allegra", "Amalia", "Amara", "Amaya", "Amelie", "Anais",
  "Anastasia", "Anika", "Annabel", "Annika", "Antonia", "Arabella", "Aria", "Ariana",
  "Arielle", "Astrid", "Athena", "Audrey", "Aurora", "Ava", "Aviva", "Aya",
  "Beatrice", "Bianca", "Billie", "Blair", "Blythe", "Bria", "Briar", "Bridget",
  "Calla", "Callie", "Calista", "Camille", "Carina", "Carmen", "Caroline", "Cassandra",
  "Cecilia", "Celeste", "Celine", "Charlotte", "Chloe", "Chiara", "Clara", "Cleo",
  "Colette", "Coral", "Cordelia", "Corinne", "Dahlia", "Daphne", "Delia", "Diana",
  "Eden", "Edith", "Elara", "Eleanor", "Elena", "Elise", "Eliza", "Elizabeth",
  "Ella", "Eloise", "Elodie", "Elsie", "Emilia", "Emily", "Emma", "Emmeline",
  "Esme", "Estelle", "Eva", "Evangeline", "Evelina", "Evelyn", "Faye", "Felicity",
  "Fern", "Flora", "Florence", "Frances", "Francesca", "Freya", "Gabriella", "Gaia",
  "Gemma", "Genevieve", "Georgia", "Giselle", "Gloria", "Grace", "Greta", "Gwen",
  "Hana", "Harlow", "Hazel", "Helena", "Ilaria", "Imogen", "Indigo", "Ines",
  "Iris", "Isabel", "Isla", "Ivy", "Jane", "Jasmine", "Joanna", "Josephine",
  "Julia", "Juliet", "Juniper", "Kaia", "Kaori", "Karina", "Katherine", "Keira",
  "Kira", "Lana", "Laurel", "Layla", "Leilani", "Lena", "Lenore", "Leona",
  "Leora", "Lila", "Liliana", "Lily", "Linnea", "Lorelei", "Louisa", "Lucia",
  "Lucy", "Luna", "Lydia", "Lyla", "Lyra", "Mae", "Magnolia", "Maia",
  "Malia", "Margot", "Mariana", "Marina", "Maren", "Marigold", "Marisol", "Matilda",
  "Maya", "Meadow", "Mei", "Melina", "Melody", "Meredith", "Mila", "Mira",
  "Miriam", "Morgan", "Nadia", "Nadine", "Naomi", "Nell", "Nina", "Noelle",
  "Nora", "Nova", "Octavia", "Odessa", "Olive", "Olivia", "Oona", "Opal",
  "Paloma", "Penelope", "Phoebe", "Poppy", "Ramona", "Rebecca", "Rei", "Rhea",
  "Rina", "Rosalie", "Rose", "Rowan", "Ruby", "Sabine", "Sage", "Sakura",
  "Selene", "Serena", "Sienna", "Simone", "Sloane", "Sofia", "Sora", "Stella",
  "Sylvie", "Talia", "Tessa", "Thea", "Valentina", "Valerie", "Vera", "Veronica",
  "Victoria", "Violet", "Vivian", "Willa", "Willow", "Winona", "Yara", "Yuna",
  "Yuki", "Zara", "Zinnia", "Zoe"
];

const NICKNAMES = [
  "angel", "babe", "bee", "belle", "bloom", "bunny", "cherry", "cloud",
  "daisy", "dream", "fairy", "glow", "honey", "lilac", "love", "moon",
  "nova", "peach", "petal", "rose", "softie", "spark", "star", "sunny"
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

function generatedAvatar(key, displayName) {
  const firstHue = hashString(key) % 360;
  const secondHue = (firstHue + 68) % 360;
  const initials = String(displayName)
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
  const consentAccepted = value.consentAccepted === true;
  return {
    enabled: consentAccepted && value.enabled === true,
    consentAccepted,
    ownHandles: ownHandles
      .map((handle) => String(handle).trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
    avatarMode: value.avatarMode === "custom" ? "custom" : "generated"
  };
}

function normalizeState(value = {}) {
  return {
    version: 4,
    identities: value.identities || {},
    aliasToPrimary: value.aliasToPrimary || {},
    usedHandles: value.usedHandles || {},
    customAvatars: value.customAvatars || {},
    usedCustomAvatarIds: value.usedCustomAvatarIds || {},
    nameResetGeneration: Number.isInteger(value.nameResetGeneration)
      ? value.nameResetGeneration
      : 0,
    pictureResetGeneration: Number.isInteger(value.pictureResetGeneration)
      ? value.pictureResetGeneration
      : 0
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
  const normalizedBase = handleSlug(base) || "fan";
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
    `${firstHandle}${compactNumber}`
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

function takeCustomAvatar(state, key) {
  const availableIds = Object.keys(state.customAvatars).filter(
    (id) => !state.usedCustomAvatarIds[id]
  );
  if (availableIds.length === 0) return null;
  const id = availableIds[hashString(key) % availableIds.length];
  state.usedCustomAvatarIds[id] = true;
  return { id, url: state.customAvatars[id].url };
}

function createAvatar(primaryKey, displayName, state, settings, revision = 0) {
  if (settings.avatarMode === "custom") {
    const customAvatar = takeCustomAvatar(
      state,
      `${primaryKey}:${state.pictureResetGeneration}:${revision}`
    );
    if (customAvatar) {
      return {
        kind: "custom",
        id: customAvatar.id,
        url: customAvatar.url,
        cropMode: "imported"
      };
    }
  }
  const seed =
    `${primaryKey}:picture:${state.pictureResetGeneration}:revision:${revision}`;
  return {
    kind: "generated",
    id: `generated:${seed}`,
    url: generatedAvatar(seed, displayName),
    cropMode: "generated"
  };
}

function applyAvatar(identity, avatar) {
  identity.avatarUrl = avatar.url;
  identity.avatarKind = avatar.kind;
  identity.avatarId = avatar.id;
  identity.avatarCropMode = avatar.cropMode;
  identity.avatarRevision = (identity.avatarRevision || 0) + 1;
  delete identity.avatarPostUrl;
  delete identity.avatarSourceUrl;
  delete identity.avatarFingerprint;
  return identity;
}

function createIdentity(primaryKey, state, settings) {
  const name = createName(primaryKey, state);
  const identity = {
    aliasStyleVersion: 2,
    displayName: name.displayName,
    handle: name.handle,
    avatarRevision: 0
  };
  return applyAvatar(
    identity,
    createAvatar(primaryKey, name.displayName, state, settings)
  );
}

function migrateIdentity(identity, canonicalKey, state, settings) {
  if (identity.aliasStyleVersion !== 2) {
    if (identity.handle && state.usedHandles[identity.handle] === canonicalKey) {
      delete state.usedHandles[identity.handle];
    }
    const name = createName(canonicalKey, state);
    identity.displayName = name.displayName;
    identity.handle = name.handle;
    identity.aliasStyleVersion = 2;
  }

  const customIsValid =
    identity.avatarKind === "custom" &&
    settings.avatarMode === "custom" &&
    Boolean(state.customAvatars[identity.avatarId]);
  const generatedIsValid =
    identity.avatarKind === "generated" && settings.avatarMode === "generated";
  if (!customIsValid && !generatedIsValid) {
    applyAvatar(
      identity,
      createAvatar(
        canonicalKey,
        identity.displayName,
        state,
        settings,
        identity.avatarRevision || 0
      )
    );
  }
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

function resolveIdentityInState(primaryKey, aliases, state, settings) {
  const keys = [...new Set([primaryKey, ...aliases].filter(Boolean))];
  if (keys.length === 0) throw new Error("No stable account key was supplied.");
  const canonicalKey = resolveCanonicalKey(state, keys);
  if (!state.identities[canonicalKey]) {
    state.identities[canonicalKey] = createIdentity(canonicalKey, state, settings);
  } else {
    migrateIdentity(state.identities[canonicalKey], canonicalKey, state, settings);
  }
  for (const key of keys) state.aliasToPrimary[key] = canonicalKey;
  return state.identities[canonicalKey];
}

async function resolveIdentity(primaryKey, aliases = []) {
  return queueStateMutation((state, settings) =>
    resolveIdentityInState(primaryKey, aliases, state, settings)
  );
}

async function resolveIdentities(items = []) {
  return queueStateMutation((state, settings) =>
    items.map((item) => {
      const aliases = Array.isArray(item.aliases) ? item.aliases : [];
      return {
        primaryKey: item.primaryKey,
        aliases,
        identity: resolveIdentityInState(
          item.primaryKey,
          aliases,
          state,
          settings
        )
      };
    })
  );
}

async function rotateAvatar(primaryKey, aliases = []) {
  return queueStateMutation((state, settings) => {
    const keys = [...new Set([primaryKey, ...aliases].filter(Boolean))];
    if (keys.length === 0) throw new Error("No account key was supplied.");
    const canonicalKey = resolveCanonicalKey(state, keys);
    const identity = state.identities[canonicalKey];
    if (!identity) throw new Error("The masked identity is not ready yet.");
    const revision = (identity.avatarRevision || 0) + 1;
    applyAvatar(
      identity,
      createAvatar(
        canonicalKey,
        identity.displayName,
        state,
        settings,
        revision
      )
    );
    for (const key of keys) state.aliasToPrimary[key] = canonicalKey;
    return { identity, primaryKey: canonicalKey, aliases: keys };
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
  const next = normalizeState({ customAvatars: previous.customAvatars });
  await chrome.storage.local.set({ [STATE_KEY]: next });
  await signalIdentityRefresh("all");
}

async function signalIdentityRefresh(kind) {
  await chrome.storage.local.set({
    [CONTROL_KEY]: { kind, at: Date.now() }
  });
}

async function resetNames() {
  const count = await queueStateMutation((state) => {
    state.nameResetGeneration += 1;
    state.usedHandles = {};
    for (const [canonicalKey, identity] of Object.entries(state.identities)) {
      const replacement = createName(
        `${canonicalKey}:name:${state.nameResetGeneration}`,
        state,
        canonicalKey
      );
      identity.displayName = replacement.displayName;
      identity.handle = replacement.handle;
      identity.aliasStyleVersion = 2;
      if (identity.avatarKind === "generated") {
        identity.avatarUrl = generatedAvatar(
          `${canonicalKey}:picture:${state.pictureResetGeneration}:revision:${identity.avatarRevision || 0}`,
          replacement.displayName
        );
      }
    }
    return Object.keys(state.identities).length;
  });
  await signalIdentityRefresh("names");
  return count;
}

async function resetPictures() {
  const count = await queueStateMutation((state, settings) => {
    state.pictureResetGeneration += 1;
    state.usedCustomAvatarIds = {};
    for (const [canonicalKey, identity] of Object.entries(state.identities)) {
      applyAvatar(
        identity,
        createAvatar(
          canonicalKey,
          identity.displayName,
          state,
          settings,
          state.pictureResetGeneration
        )
      );
    }
    return Object.keys(state.identities).length;
  });
  await signalIdentityRefresh("pictures");
  return count;
}

async function addCustomAvatars(avatars = []) {
  return queueStateMutation((state) => {
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
  return queueStateMutation((state) => {
    state.customAvatars = {};
    state.usedCustomAvatarIds = {};
    for (const [canonicalKey, identity] of Object.entries(state.identities)) {
      if (identity.avatarKind !== "custom") continue;
      applyAvatar(
        identity,
        createAvatar(
          canonicalKey,
          identity.displayName,
          state,
          { avatarMode: "generated" },
          identity.avatarRevision || 0
        )
      );
    }
    return 0;
  });
}

async function getStats() {
  const state = await getState();
  return {
    mappedAccounts: Object.keys(state.identities).length,
    importedAvatars: Object.keys(state.customAvatars).length,
    usedImportedAvatars: Object.keys(state.usedCustomAvatarIds).length
  };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.local.get([SETTINGS_KEY, STATE_KEY]);
  const writes = {};
  if (!current[SETTINGS_KEY]) writes[SETTINGS_KEY] = normalizeSettings();
  if (!current[STATE_KEY]) writes[STATE_KEY] = normalizeState();
  if (Object.keys(writes).length > 0) await chrome.storage.local.set(writes);
  if (details.reason === "install") await chrome.runtime.openOptionsPage();
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
        return { items: await resolveIdentities(message.items) };
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
