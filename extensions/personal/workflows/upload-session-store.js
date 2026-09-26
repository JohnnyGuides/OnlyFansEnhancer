(() => {
  "use strict";

  if (globalThis.CreatorUploadSessionStore) return;

  const KEY_PREFIX = "creatorUploadSessionV1:";
  const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
  const PLATFORMS = new Set(["onlyfans", "fansly", "manyvids", "pornhub"]);
  const LAUNCHERS = new Set(["extension", "desktop"]);
  const writeChains = new Map();
  const RECOVERY_KEY = "creatorUploadRecoveryV1";
  const ACTION_KEY = "creatorUploadActionsV1";
  const RUNTIME_VERSION_KEY = "creatorUploadRuntimeVersionV1";
  const VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;

  async function digest(value) {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify(value, (_key, item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(
                Object.keys(item)
                  .sort()
                  .map((field) => [field, item[field]]),
              )
            : item,
        ),
      ),
    );
    return [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function workIdentity(record, legacy = false) {
    const catalogue = record.catalogue;
    const launcher = LAUNCHERS.has(record.launcher)
      ? record.launcher
      : "extension";
    return digest(
      catalogue?.itemId || catalogue?.id
        ? {
            ...(legacy ? {} : { launcher }),
            source: catalogue.source,
            id: catalogue.itemId || catalogue.id,
          }
        : record.draft?.fullFilename
          ? { ...(legacy ? {} : { launcher }), file: record.draft.fullFilename }
          : { ...(legacy ? {} : { launcher }), title: record.draft?.title },
    );
  }

  async function actionRecords() {
    const stored = (await chrome.storage.local.get(ACTION_KEY))[ACTION_KEY];
    if (stored === undefined) return [];
    if (
      !Array.isArray(stored) ||
      stored.some(
        (item) =>
          item?.schemaVersion !== 1 ||
          !ID_PATTERN.test(item.id || "") ||
          !PLATFORMS.has(item.platform) ||
          !/^[a-f0-9]{64}$/.test(item.work || "") ||
          !/^[a-f0-9]{64}$/.test(item.plan || "") ||
          item.submitAttempted !== true,
      )
    )
      throw new Error(
        "Publication recovery journal is invalid; reconcile existing attempts before continuing.",
      );
    return stored.map((item) => ({
      schemaVersion: 1,
      id: item.id,
      platform: item.platform,
      work: item.work,
      plan: item.plan,
      ...(finiteInteger(item.tabId) !== undefined
        ? { tabId: finiteInteger(item.tabId) }
        : {}),
      ...(/^[a-f0-9-]{32,36}$/i.test(item.documentId || "")
        ? { documentId: item.documentId }
        : {}),
      commitArmed: true,
      submitAttempted: true,
      ...(globalThis.CreatorCatalogueContract?.canonicalPostUrl(
        item.platform,
        item.postUrl,
      ) === item.postUrl && item.postUrl
        ? { postUrl: item.postUrl }
        : {}),
    }));
  }

  async function assertAvailable(record, platforms) {
    await migrateFinalActions();
    const work = await workIdentity(record);
    const legacyWork = await workIdentity(record, true);
    // Final attempts were historically written with missing launcher metadata.
    // Preserve all hashes and refuse across launchers at the publication boundary.
    const finalWorks = new Set(
      await Promise.all([
        workIdentity(record, true),
        workIdentity({ ...record, launcher: "extension" }),
        workIdentity({ ...record, launcher: "desktop" }),
      ]),
    );
    const signature = await digest(sanitizeDraft(record.draft));
    if (
      (await listRecovery()).some(
        (item) =>
          !item.supersededAt &&
          item.steps.some(
            (step) =>
              (step.work === work ||
                step.work === legacyWork ||
                (!step.work && step.signature === signature) ||
                item.id === record.id) &&
              platforms.includes(step.platform),
          ),
      )
    )
      throw Object.assign(
        new Error(
          "An existing prepared or uncertain draft exists for this work item. Reconcile the existing draft before starting another session.",
        ),
        {
          rejectionCode: "upload-preparation-recovery-required",
          recoveryRequired: true,
        },
      );
    if (
      (await actionRecords()).some(
        (item) =>
          (item.id === record.id || finalWorks.has(item.work)) &&
          platforms.includes(item.platform),
      )
    )
      throw Object.assign(
        new Error(
          "An unresolved publication attempt already exists for this work item. Recover the existing result; do not start another upload.",
        ),
        {
          rejectionCode: "upload-publication-recovery-required",
          recoveryRequired: true,
        },
      );
  }

  async function persistActions(record) {
    const targets = Object.entries(record.platforms || {}).filter(
      ([, target]) => target.commitArmed || target.submitAttempted,
    );
    if (!targets.length) return;
    await enqueueWrite(ACTION_KEY, async () => {
      const records = await actionRecords();
      for (const [platform, target] of targets) {
        const previous = records.find(
          (item) => item.id === record.id && item.platform === platform,
        );
        const postUrl =
          globalThis.CreatorCatalogueContract?.canonicalPostUrl(
            platform,
            target.postUrl,
          ) || "";
        if (previous) {
          if (record.draft && previous.plan !== (await digest(record.draft)))
            throw new Error(
              "The approved publication plan changed after its durable intent.",
            );
          if (postUrl && previous.postUrl && previous.postUrl !== postUrl)
            throw new Error(
              "Publication result identity changed; reconcile the existing result.",
            );
          if (postUrl) previous.postUrl = postUrl;
          continue;
        }
        const work = await workIdentity(record);
        const finalWorks = new Set(
          await Promise.all([
            workIdentity(record, true),
            workIdentity({ ...record, launcher: "extension" }),
            workIdentity({ ...record, launcher: "desktop" }),
          ]),
        );
        if (
          records.some(
            (item) => finalWorks.has(item.work) && item.platform === platform,
          )
        )
          throw new Error(
            "An unresolved publication attempt already exists for this work item.",
          );
        if (records.length >= 200)
          throw new Error(
            "Publication recovery journal is full. Reconcile existing attempts before new publication; no records were removed.",
          );
        records.push({
          schemaVersion: 1,
          id: record.id,
          platform,
          work,
          plan: await digest(record.draft || {}),
          ...(finiteInteger(target.tabId) !== undefined
            ? { tabId: finiteInteger(target.tabId) }
            : {}),
          ...(/^[a-f0-9-]{32,36}$/i.test(target.documentId || "")
            ? { documentId: target.documentId }
            : {}),
          commitArmed: true,
          submitAttempted: true,
          ...(postUrl ? { postUrl } : {}),
        });
      }
      await chrome.storage.local.set({ [ACTION_KEY]: records });
      const readback = await actionRecords();
      if (JSON.stringify(readback) !== JSON.stringify(records))
        throw new Error("Publication recovery checkpoint was not durable.");
    });
  }
  async function migrateFinalActions() {
    const stored = await chrome.storage.session.get(null);
    for (const [storageKey, record] of Object.entries(stored)) {
      if (!storageKey.startsWith(KEY_PREFIX)) continue;
      const safe = sanitize(record);
      if (
        Object.values(safe.platforms || {}).some(
          (target) => target.commitArmed || target.submitAttempted,
        )
      )
        await persistActions(safe);
    }
  }
  const STEP_KINDS = new Set([
    "select-full",
    "select-pornhub",
    "select-teaser",
    "select-thumbnail",
    "start-upload",
    "open-editor",
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
        "issued",
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
      ...(/^[a-f0-9]{64}$/.test(value.work || "") ? { work: value.work } : {}),
      tabId,
      frameId,
      recipeVersion: 1,
      at: Date.now(),
    };
  }

  async function listRecovery() {
    const stored = await chrome.storage.local.get(RECOVERY_KEY);
    if (stored[RECOVERY_KEY] === undefined) return [];
    if (
      !Array.isArray(stored[RECOVERY_KEY]) ||
      stored[RECOVERY_KEY].some(
        (record) =>
          !ID_PATTERN.test(record?.id || "") || !Array.isArray(record.steps),
      )
    )
      throw new Error(
        "Preparation recovery journal is invalid; reconcile existing drafts before continuing.",
      );
    return stored[RECOVERY_KEY].map((record) => ({
      id: record.id,
      schemaVersion: 1,
      explicitResumeRequired: true,
      ...(LAUNCHERS.has(record.launcher) ? { launcher: record.launcher } : {}),
      ...(record.archivedVersion === "legacy" ||
      VERSION.test(record.archivedVersion || "")
        ? { archivedVersion: record.archivedVersion }
        : {}),
      ...(finiteInteger(record.supersededAt, 1)
        ? { supersededAt: record.supersededAt }
        : {}),
      steps: record.steps.map((step) => ({
        ...recoveryStep(step),
        at: finiteInteger(step.at) || 0,
      })),
    }));
  }

  async function recordStep(id, value) {
    key(id);
    const step = recoveryStep(value);
    return enqueueWrite(RECOVERY_KEY, async () => {
      const records = await listRecovery();
      let record = records.find((item) => item.id === id);
      if (!record) {
        if (records.length >= 200)
          throw new Error(
            "Preparation recovery journal is full. Inspect and reconcile existing drafts before starting new work; no recovery records were removed.",
          );
        record = {
          id,
          schemaVersion: 1,
          explicitResumeRequired: true,
          launcher: LAUNCHERS.has(value.launcher)
            ? value.launcher
            : "extension",
          steps: [],
        };
        records.push(record);
      }
      if (LAUNCHERS.has(value.launcher)) {
        if (record.launcher && record.launcher !== value.launcher)
          throw new Error("Preparation launcher changed.");
        record.launcher = value.launcher;
      }
      if (record.supersededAt)
        throw new Error("A retired preparation run cannot accept new actions.");
      const previous = record.steps.find(
        (item) => item.commandId === step.commandId,
      );
      if (previous) {
        for (const field of [
          "actionId",
          "platform",
          "documentId",
          "signature",
          "work",
          "tabId",
          "frameId",
        ])
          if (previous[field] !== step[field])
            throw new Error("Preparation command identity changed.");
        if (previous.outcome !== "intent" && previous.outcome !== "issued")
          return previous;
        if (step.outcome === "intent") return previous;
        if (previous.outcome === "issued" && step.outcome === "issued")
          return previous;
        Object.assign(previous, step);
      } else {
        if (step.outcome !== "intent")
          throw new Error("Preparation outcome has no recorded intent.");
        if (
          step.actionId !== "configure" &&
          step.actionId !== "verify" &&
          records.some(
            (item) =>
              !item.supersededAt &&
              (item.id === id ||
                (step.work &&
                  item.steps.some((entry) => entry.work === step.work))) &&
              item.steps.some(
                (entry) =>
                  entry.platform === step.platform &&
                  entry.actionId === step.actionId,
              ),
          )
        )
          throw new Error(
            "An existing preparation action cannot be repeated after an uncertain or completed attempt.",
          );
        if (record.steps.length >= 64)
          throw new Error("Preparation recovery journal is full.");
        record.steps.push(step);
      }
      await chrome.storage.local.set({ [RECOVERY_KEY]: records });
      const durable = (await listRecovery())
        .find((item) => item.id === id)
        ?.steps.find((item) => item.commandId === step.commandId);
      if (!durable || durable.outcome !== step.outcome)
        throw new Error("Preparation journal was not durable.");
      return durable;
    });
  }

  async function clearPreparation() {
    return enqueueWrite(RECOVERY_KEY, async () => {
      const records = await listRecovery();
      await chrome.storage.local.set({ [RECOVERY_KEY]: [] });
      return { cleared: records.length };
    });
  }
  async function supersedePreparation(exceptIds = [], launcher = "extension") {
    const protectedIds = new Set([
      ...exceptIds,
      ...(await actionRecords()).map((record) => record.id),
    ]);
    return enqueueWrite(RECOVERY_KEY, async () => {
      const records = await listRecovery();
      const at = Date.now();
      let superseded = 0;
      for (const record of records) {
        if (
          record.supersededAt ||
          protectedIds.has(record.id) ||
          (record.launcher || "extension") !== launcher
        )
          continue;
        record.supersededAt = at;
        superseded++;
      }
      await chrome.storage.local.set({ [RECOVERY_KEY]: records });
      const readback = await listRecovery();
      if (
        readback.length !== records.length ||
        readback.some(
          (record, index) =>
            record.id !== records[index].id ||
            record.supersededAt !== records[index].supersededAt,
        )
      )
        throw new Error("Preparation retirement was not durable.");
      return { superseded };
    });
  }
  async function ensureRuntimeVersion(version) {
    if (typeof version !== "string" || !VERSION.test(version))
      throw new Error(
        "Upload runtime version is invalid; no queue state was changed.",
      );
    return enqueueWrite(RUNTIME_VERSION_KEY, async () => {
      const previous = (await chrome.storage.local.get(RUNTIME_VERSION_KEY))[
        RUNTIME_VERSION_KEY
      ];
      if (previous === version) return { changed: false, version };
      if (
        previous !== undefined &&
        (typeof previous !== "string" || !VERSION.test(previous))
      )
        throw new Error(
          "Stored upload runtime version is invalid; preserve recovery data and repair the installation.",
        );
      if (typeof previous === "string") {
        const old = previous.split(".").map(Number),
          next = version.split(".").map(Number);
        const first = next.findIndex((value, index) => value !== old[index]);
        if (first >= 0 && next[first] < old[first])
          throw new Error(
            "Upload runtime downgrade is not allowed to adopt a newer queue. Reload the matching installed version.",
          );
      }
      // An upgrade retires execution bindings, not evidence of effects on a site.
      await migrateFinalActions();
      return enqueueWrite(RECOVERY_KEY, async () => {
        const records = await listRecovery();
        const archived = records.map((record) => ({
          ...record,
          archivedVersion: record.archivedVersion || previous || "legacy",
        }));
        await chrome.storage.local.set({ [RECOVERY_KEY]: archived });
        if ((await digest(await listRecovery())) !== (await digest(archived)))
          throw new Error(
            "Upload upgrade archive was not durable. Old bindings were preserved.",
          );
        const stored = await chrome.storage.session.get(null);
        const keys = Object.keys(stored).filter((name) =>
          name.startsWith(KEY_PREFIX),
        );
        // Recheck legacy final flags before removing any transient session token.
        await migrateFinalActions();
        if (keys.length) await chrome.storage.session.remove(keys);
        const current = await chrome.storage.session.get(keys);
        if (keys.some((name) => Object.hasOwn(current, name)))
          throw new Error(
            "Old upload queue bindings could not be retired. No new run may start.",
          );
        await chrome.storage.local.set({ [RUNTIME_VERSION_KEY]: version });
        if (
          (await chrome.storage.local.get(RUNTIME_VERSION_KEY))[
            RUNTIME_VERSION_KEY
          ] !== version
        )
          throw new Error("Upload runtime version checkpoint was not durable.");
        return {
          changed: true,
          version,
          retiredSessions: keys.length,
          archivedPreparations: archived.length,
        };
      });
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
    pornhubMode: 10,
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
    if (Object.hasOwn(value, "pornhubThumbnail")) {
      output.pornhubThumbnail = value.pornhubThumbnail === true;
    }
    if (Object.hasOwn(value, "pornhubCertificationsConfirmed")) {
      output.pornhubCertificationsConfirmed =
        value.pornhubCertificationsConfirmed === true;
    }
    if (Object.hasOwn(value, "hasTeaser"))
      output.hasTeaser = value.hasTeaser !== false;
    if (Object.hasOwn(value, "fileProof")) {
      if (!value.fileProof || typeof value.fileProof !== "object")
        throw new Error("Invalid saved upload file proof.");
      output.fileProof = {};
      for (const role of ["full", "teaser", "thumbnail", "pornhub"]) {
        const item = value.fileProof[role];
        if (item == null) continue;
        const name = clean(item.name, 500);
        const size = finiteInteger(item.size, 1);
        const lastModified = finiteInteger(item.lastModified, 1);
        if (!name || size === undefined || lastModified === undefined)
          throw new Error("Invalid saved upload file proof.");
        output.fileProof[role] = {
          name,
          size,
          lastModified,
          type: clean(item.type, 100),
        };
      }
    }
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
    if (output.source === "desktop" && Array.isArray(value.repeatPlatforms))
      output.repeatPlatforms = [...new Set(value.repeatPlatforms)].filter(
        (platform) => PLATFORMS.has(platform),
      );
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
      ["boundUrl", 500],
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
    if (name === "manyvids" && value.editorHandoff) {
      const handoff = value.editorHandoff;
      const expected =
        /^https:\/\/www\.manyvids\.com\/Edit-vid\/(\d+)\/?$/.exec(
          handoff.expectedUrl || "",
        );
      if (
        expected &&
        expected[1] === handoff.videoId &&
        /^[a-f0-9-]{36}$/i.test(handoff.commandId || "")
      ) {
        output.editorHandoff = {
          commandId: handoff.commandId,
          sourceDocumentId: clean(handoff.sourceDocumentId, 36),
          expectedUrl: handoff.expectedUrl,
          videoId: handoff.videoId,
          documentId: clean(handoff.documentId, 36),
          url: handoff.url === handoff.expectedUrl ? handoff.url : "",
          invalid: handoff.invalid === true,
        };
      }
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
    if (LAUNCHERS.has(record.launcher)) output.launcher = record.launcher;
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
    let record = stored[storageKey] ? sanitize(stored[storageKey]) : null;
    for (const action of await actionRecords()) {
      if (action.id !== id) continue;
      record ||= { id, platforms: {} };
      record.platforms ||= {};
      record.platforms[action.platform] = mergePlatform(
        record.platforms[action.platform],
        {
          platform: action.platform,
          tabId: action.tabId,
          documentId: action.documentId,
          commitArmed: true,
          submitAttempted: true,
          ...(action.postUrl &&
          globalThis.CreatorCatalogueContract?.canonicalPostUrl(
            action.platform,
            action.postUrl,
          ) === action.postUrl
            ? { postUrl: action.postUrl }
            : {}),
        },
      );
    }
    return record;
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
      await persistActions(value);
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
    await migrateFinalActions();
    const stored = await chrome.storage.session.get(null);
    const ids = new Set([
      ...Object.entries(stored)
        .filter(([storageKey]) => storageKey.startsWith(KEY_PREFIX))
        .map(([, record]) => sanitize(record).id),
      ...(await actionRecords()).map((record) => record.id),
    ]);
    const records = await Promise.all([...ids].map(load));
    return records
      .filter(Boolean)
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
    clearPreparation,
    supersedePreparation,
    ensureRuntimeVersion,
    assertAvailable,
    ACTION_KEY,
    workIdentity,
    async listPublication() {
      await migrateFinalActions();
      return actionRecords();
    },
  });
})();
