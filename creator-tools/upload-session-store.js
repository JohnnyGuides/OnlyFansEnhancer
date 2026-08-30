(() => {
  "use strict";

  if (globalThis.CreatorUploadSessionStore) return;

  const KEY_PREFIX = "creatorUploadSessionV1:";
  const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
  const PLATFORMS = new Set(["onlyfans", "fansly", "manyvids", "pornhub"]);
  const writeChains = new Map();
  const DRAFT_STRINGS = Object.freeze({
    title: 500,
    description: 10_000,
    fullFilename: 500,
    pornhubFilename: 500,
    releaseDate: 10,
    scheduledIso: 40,
    timeZone: 100,
    fanslyPreset: 100,
    fanslyCaption: 15_000,
    contentPreset: 100,
    profileSignature: 50_000,
  });
  const CATALOGUE_STRINGS = Object.freeze({
    id: 500,
    releaseDate: 10,
    title: 500,
    description: 10_000,
    seasonArc: 500,
    episode: 40,
    pornhubLink: 500,
    onlyfansLink: 500,
    fanslyLink: 500,
    manyvidsLink: 500,
    fingerprint: 64,
    status: 20,
  });

  function clean(value, maximum) {
    return String(value || "")
      .trim()
      .slice(0, maximum);
  }

  function finiteInteger(
    value,
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
  ) {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum
      ? number
      : undefined;
  }

  function safeJson(value, depth = 0, counter = { values: 0 }) {
    if (counter.values >= 2000 || depth > 6) return undefined;
    counter.values += 1;
    if (typeof value === "string") return value.slice(0, 5000);
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      return value
        .slice(0, 100)
        .map((item) => safeJson(item, depth + 1, counter))
        .filter((item) => item !== undefined);
    }
    if (!value || typeof value !== "object") return undefined;
    const output = {};
    for (const [rawKey, item] of Object.entries(value).slice(0, 100)) {
      const key = clean(rawKey, 100);
      if (!key || new Set(["__proto__", "constructor", "prototype"]).has(key)) {
        continue;
      }
      const safe = safeJson(item, depth + 1, counter);
      if (safe !== undefined) output[key] = safe;
    }
    return output;
  }

  function sanitizeDraft(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const output = {};
    for (const [field, maximum] of Object.entries(DRAFT_STRINGS)) {
      if (Object.hasOwn(value, field))
        output[field] = clean(value[field], maximum);
    }
    if (Object.hasOwn(value, "manyvidsThumbnail")) {
      output.manyvidsThumbnail = value.manyvidsThumbnail === true;
    }
    for (const field of ["profiles"]) {
      if (!Object.hasOwn(value, field)) continue;
      const safe = safeJson(value[field]);
      if (safe !== undefined) output[field] = safe;
    }
    return output;
  }

  function sanitizeCatalogue(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const output = {};
    const row = finiteInteger(value.row, 2, 5000);
    if (row !== undefined) output.row = row;
    for (const [field, maximum] of Object.entries(CATALOGUE_STRINGS)) {
      if (Object.hasOwn(value, field))
        output[field] = clean(value[field], maximum);
    }
    return output;
  }

  function sanitizePlatform(name, value) {
    if (!PLATFORMS.has(name) || !value || typeof value !== "object")
      return null;
    const output = { platform: name };
    const tabId = finiteInteger(value.tabId, 0);
    if (tabId !== undefined) output.tabId = tabId;
    for (const [field, maximum] of [
      ["stage", 100],
      ["status", 100],
      ["manyvidsId", 100],
      ["postUrl", 500],
      ["error", 500],
    ]) {
      if (Object.hasOwn(value, field))
        output[field] = clean(value[field], maximum);
    }
    for (const field of ["createdAt", "updatedAt"]) {
      const timestamp = finiteInteger(value[field]);
      if (timestamp !== undefined) output[field] = timestamp;
    }
    for (const field of ["commitArmed", "submitAttempted"]) {
      if (Object.hasOwn(value, field)) output[field] = value[field] === true;
    }
    return output;
  }

  function sanitize(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Invalid creator upload session record.");
    }
    const id = clean(record.id, 64);
    if (!ID_PATTERN.test(id))
      throw new Error("Invalid creator upload session ID.");
    const output = { id };
    for (const field of ["createdAt", "updatedAt"]) {
      const timestamp = finiteInteger(record[field]);
      if (timestamp !== undefined) output[field] = timestamp;
    }
    if (Object.hasOwn(record, "draft"))
      output.draft = sanitizeDraft(record.draft);
    if (record.catalogue === null) output.catalogue = null;
    else if (Object.hasOwn(record, "catalogue")) {
      output.catalogue = sanitizeCatalogue(record.catalogue);
    }
    if (Object.hasOwn(record, "platforms")) {
      output.platforms = {};
      for (const [name, platform] of Object.entries(record.platforms || {})) {
        const safe = sanitizePlatform(name, platform);
        if (safe) output.platforms[name] = safe;
      }
    }
    return output;
  }

  function mergePlatform(previous = {}, next = {}) {
    const merged = { ...previous, ...next };
    for (const field of ["commitArmed", "submitAttempted"]) {
      if (previous[field] === true) merged[field] = true;
    }
    for (const field of ["manyvidsId", "postUrl"]) {
      if (previous[field]) merged[field] = previous[field];
    }
    return merged;
  }

  function merge(previous, next) {
    if (!previous) return next;
    const output = { ...previous, ...next, id: next.id };
    if (next.draft) output.draft = { ...(previous.draft || {}), ...next.draft };
    if (next.catalogue && previous.catalogue) {
      output.catalogue = { ...previous.catalogue, ...next.catalogue };
    }
    if (next.platforms) {
      output.platforms = { ...(previous.platforms || {}) };
      for (const [name, platform] of Object.entries(next.platforms)) {
        output.platforms[name] = mergePlatform(
          output.platforms[name],
          platform,
        );
      }
    }
    return output;
  }

  function key(id) {
    const normalized = clean(id, 64);
    if (!ID_PATTERN.test(normalized))
      throw new Error("Invalid creator upload session ID.");
    return `${KEY_PREFIX}${normalized}`;
  }

  async function load(id) {
    const storageKey = key(id);
    const stored = await chrome.storage.session.get(storageKey);
    return stored[storageKey] ? sanitize(stored[storageKey]) : null;
  }

  function enqueueWrite(id, operation) {
    const previous = writeChains.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    writeChains.set(id, current);
    return current.finally(() => {
      if (writeChains.get(id) === current) writeChains.delete(id);
    });
  }

  async function save(record) {
    const next = sanitize(record);
    return enqueueWrite(next.id, async () => {
      const previous = await load(next.id);
      const value = sanitize(merge(previous, next));
      await chrome.storage.session.set({ [key(next.id)]: value });
      return value;
    });
  }

  async function remove(id) {
    const normalized = clean(id, 64);
    await enqueueWrite(normalized, () =>
      chrome.storage.session.remove(key(normalized)),
    );
  }

  async function list() {
    const stored = await chrome.storage.session.get(null);
    return Object.entries(stored)
      .filter(([storageKey]) => storageKey.startsWith(KEY_PREFIX))
      .map(([, record]) => sanitize(record))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  globalThis.CreatorUploadSessionStore = Object.freeze({
    KEY_PREFIX,
    sanitize,
    save,
    load,
    remove,
    list,
  });
})();
