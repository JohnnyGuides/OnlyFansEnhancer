(() => {
  "use strict";

  if (globalThis.CreatorXTeaserSessionStore) return;

  const contract = globalThis.CreatorXTeaserContract;
  if (!contract) throw new Error("CreatorXTeaserContract is unavailable.");

  const api = globalThis.browser || globalThis.chrome;
  const storage = api?.storage?.local;
  if (!storage) throw new Error("Extension local storage is unavailable.");

  const KEY_PREFIX = "creatorXTeaserSessionV1:";
  const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
  const STAGES = Object.freeze([
    "paired",
    "status-captured",
    "audit-complete",
    "sheet-complete",
    "moved",
  ]);
  let writeChain = Promise.resolve();

  function clean(value, maximum = 5000) {
    return String(value == null ? "" : value)
      .trim()
      .slice(0, maximum);
  }

  function key(id) {
    const value = clean(id, 64);
    if (!ID_PATTERN.test(value))
      throw new Error("Invalid X teaser session ID.");
    return `${KEY_PREFIX}${value}`;
  }

  function stage(value) {
    const normalized = clean(value, 30);
    if (!STAGES.includes(normalized)) {
      throw new Error("Invalid X teaser session stage.");
    }
    return normalized;
  }

  function sanitizePairing(value) {
    return contract.freezePairing(value?.file, value?.catalogue);
  }

  function sanitizeCapture(value) {
    if (!value || !clean(value.statusId, 30)) return null;
    const statusId = clean(value.statusId, 30);
    const statusUrl = contract.canonicalStatusUrl(value.statusUrl);
    const timestamp = clean(value.timestamp, 40);
    const duration = Number(value.duration);
    let poster;
    try {
      poster = new URL(clean(value.poster, 1000));
    } catch {
      poster = null;
    }
    if (
      !/^\d{1,30}$/.test(statusId) ||
      !statusUrl ||
      statusUrl.split("/").at(-1) !== statusId ||
      new Date(timestamp).toISOString() !== timestamp ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 8 * 60 * 60 ||
      !poster ||
      poster.protocol !== "https:" ||
      !(
        poster.hostname === "pbs.twimg.com" ||
        poster.hostname.endsWith(".twimg.com")
      )
    ) {
      throw new Error("Invalid captured X status metadata.");
    }
    return {
      statusId,
      statusUrl,
      caption: clean(value.caption, 5000),
      timestamp,
      duration,
      poster: poster.href,
    };
  }

  function sanitizeInput(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Invalid X teaser session record.");
    }
    const output = { id: clean(record.id, 64) };
    key(output.id);
    if (Object.hasOwn(record, "stage")) output.stage = stage(record.stage);
    if (Object.hasOwn(record, "pairing")) {
      output.pairing = sanitizePairing(record.pairing);
    }
    if (Object.hasOwn(record, "capture")) {
      const capture = sanitizeCapture(record.capture);
      if (capture) output.capture = capture;
    }
    for (const field of [
      "auditOutcome",
      "sheetOutcome",
      "moveOutcome",
      "error",
    ]) {
      if (Object.hasOwn(record, field))
        output[field] = clean(record[field], 500);
    }
    for (const field of ["createdAt", "updatedAt"]) {
      const number = Number(record[field]);
      if (Number.isSafeInteger(number) && number >= 0) output[field] = number;
    }
    return output;
  }

  function merge(previous, next) {
    if (!previous) {
      if (!next.stage || !next.pairing) {
        throw new Error("A new X teaser session requires a frozen pairing.");
      }
      return next;
    }
    const output = { ...previous, ...next, id: previous.id };
    if (previous.pairing && next.pairing) {
      if (JSON.stringify(previous.pairing) !== JSON.stringify(next.pairing)) {
        throw new Error("A frozen X teaser pairing cannot be changed.");
      }
      output.pairing = previous.pairing;
    }
    if (previous.capture) {
      if (next.capture && next.capture.statusId !== previous.capture.statusId) {
        throw new Error("A captured X status cannot be changed.");
      }
      output.capture = previous.capture;
    }
    const previousRank = STAGES.indexOf(previous.stage);
    const nextRank = STAGES.indexOf(next.stage || previous.stage);
    output.stage = STAGES[Math.max(previousRank, nextRank)];
    for (const field of ["auditOutcome", "sheetOutcome", "moveOutcome"]) {
      if (previous[field]) output[field] = previous[field];
    }
    if (STAGES.indexOf(output.stage) >= 1 && !output.capture) {
      throw new Error(
        "Captured status metadata is required for reconciliation.",
      );
    }
    return output;
  }

  async function load(id) {
    const storageKey = key(id);
    const result = await storage.get(storageKey);
    return result[storageKey] || null;
  }

  async function storedRecords() {
    const result = await storage.get(null);
    return Object.entries(result)
      .filter(([storageKey]) => storageKey.startsWith(KEY_PREFIX))
      .map(([, record]) => record);
  }

  async function save(record) {
    const next = sanitizeInput(record);
    const operation = writeChain
      .catch(() => {})
      .then(async () => {
        const previous = await load(next.id);
        const value = merge(previous, next);
        if (value.capture) {
          const duplicate = (await storedRecords()).find(
            (candidate) =>
              candidate.id !== value.id &&
              candidate.capture?.statusId === value.capture.statusId,
          );
          if (duplicate) {
            throw new Error(
              "This X status already belongs to another session.",
            );
          }
        }
        await storage.set({ [key(value.id)]: value });
        return value;
      });
    writeChain = operation;
    return operation;
  }

  async function remove(id) {
    const operation = writeChain
      .catch(() => {})
      .then(() => storage.remove(key(id)));
    writeChain = operation;
    return operation;
  }

  async function list() {
    return (await storedRecords()).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  function nextAction(record) {
    return {
      paired: "observe-status",
      "status-captured": "write-audit",
      "audit-complete": "append-sheet",
      "sheet-complete": "move-source",
      moved: "complete",
    }[record?.stage];
  }

  globalThis.CreatorXTeaserSessionStore = Object.freeze({
    KEY_PREFIX,
    list,
    load,
    nextAction,
    remove,
    save,
  });
})();
