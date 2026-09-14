(() => {
  "use strict";

  if (globalThis.CreatorUploadSessionStore) return;

  const KEY_PREFIX = "creatorUploadSessionV1:";
  const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
  const PLATFORMS = new Set(["onlyfans", "fansly", "manyvids", "pornhub"]);
  const writeChains = new Map();
  const RECOVERY_KEY = "creatorUploadRecoveryV1";
  const STEP_KINDS = new Set([
    "select-full",
    "select-teaser",
    "select-thumbnail",
    "start-upload",
    "attach-media",
    "confirm-preview",
    "confirm-thumbnail",
    "configure",
    "verify",
  ]);

  function recoveryStep(value) {
    if (
      !value ||
      !STEP_KINDS.has(value.actionId) ||
      !PLATFORMS.has(value.platform) ||
      ![
        "intent",
        "observed",
        "attention-required",
        "cancelled",
        "prepared",
      ].includes(value.outcome) ||
      !/^[a-f0-9-]{36}$/i.test(value.commandId || "") ||
      !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(
        value.documentId || "",
      ) ||
      !/^[a-f0-9]{64}$/i.test(value.signature || "")
    )
      throw new Error("Invalid preparation step journal record.");
    const tabId = finiteInteger(value.tabId, 1);
    const frameId = finiteInteger(value.frameId, 0);
    if (tabId === undefined || frameId === undefined)
      throw new Error("Invalid preparation step binding.");
    return {
      actionId: value.actionId,
      platform: value.platform,
      outcome: value.outcome,
      commandId: value.commandId,
      documentId: value.documentId,
      signature: value.signature,
      tabId,
      frameId,
      recipeVersion: 1,
      at: Date.now(),
    };
  }

  async function listRecovery() {
    const stored = await chrome.storage.local.get(RECOVERY_KEY);
    if (!Array.isArray(stored[RECOVERY_KEY])) return [];
    return stored[RECOVERY_KEY].slice(-20)
      .filter(
        (record) =>
          ID_PATTERN.test(record?.id || "") && Array.isArray(record.steps),
      )
      .map((record) => ({
        id: record.id,
        schemaVersion: 1,
        explicitResumeRequired: true,
        steps: record.steps.slice(0, 64).flatMap((step) => {
          try {
            return [{ ...recoveryStep(step), at: finiteInteger(step.at) || 0 }];
          } catch {
            return [];
          }
        }),
      }));
  }

  async function recordStep(id, value) {
    key(id);
    const step = recoveryStep(value);
    return enqueueWrite(RECOVERY_KEY, async () => {
      const records = await listRecovery();
      let record = records.find((item) => item.id === id);
      if (!record) {
        record = {
          id,
          schemaVersion: 1,
          explicitResumeRequired: true,
          steps: [],
        };
        records.push(record);
      }
      const previous = record.steps.find(
        (item) => item.commandId === step.commandId,
      );
      if (previous) {
        for (const field of [
          "actionId",
          "platform",
          "documentId",
          "signature",
          "tabId",
          "frameId",
        ])
          if (previous[field] !== step[field])
            throw new Error("Preparation command identity changed.");
        if (previous.outcome !== "intent") return previous;
        if (step.outcome === "intent") return previous;
        Object.assign(previous, step);
      } else {
        if (step.outcome !== "intent")
          throw new Error("Preparation outcome has no recorded intent.");
        if (record.steps.length >= 64)
          throw new Error("Preparation recovery journal is full.");
        record.steps.push(step);
      }
      await chrome.storage.local.set({ [RECOVERY_KEY]: records.slice(-20) });
      const durable = (await listRecovery())
        .find((item) => item.id === id)
        ?.steps.find((item) => item.commandId === step.commandId);
      if (!durable || durable.outcome !== step.outcome)
        throw new Error("Preparation journal was not durable.");
      return durable;
    });
  }
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
    source: 20,
    itemId: 200,
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
    if (Object.hasOwn(value, "hasTeaser"))
      output.hasTeaser = value.hasTeaser !== false;
    if (value.fanslyPresetSelection === "first")
      output.fanslyPresetSelection = "first";
    if (!["manual", "autonomous"].includes(value.publishMode ?? "manual"))
      throw new Error("Invalid publishing mode.");
    output.publishMode = value.publishMode ?? "manual";
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
    const row = finiteInteger(value.row, 2, 5002);
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
      ["documentId", 36],
      ["progressStage", 20],
    ]) {
      if (Object.hasOwn(value, field))
        output[field] = clean(value[field], maximum);
    }
    for (const field of ["createdAt", "updatedAt"]) {
      const timestamp = finiteInteger(value[field]);
      if (timestamp !== undefined) output[field] = timestamp;
    }
    const progressSequence = finiteInteger(value.progressSequence);
    if (progressSequence !== undefined)
      output.progressSequence = progressSequence;
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
    if (
      previous.documentId &&
      previous.documentId === next.documentId &&
      Number.isSafeInteger(next.progressSequence) &&
      next.progressSequence < (previous.progressSequence || 0)
    )
      return previous;
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
    RECOVERY_KEY,
    listRecovery,
    recordStep,
  });
})();
