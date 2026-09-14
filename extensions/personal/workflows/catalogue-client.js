(() => {
  "use strict";

  if (globalThis.CreatorCatalogueClient) return;

  const STORAGE_KEY = "creatorUploadSheetBridgeV1";
  const ACTIONS = new Set([
    "getCatalogueSnapshot",
    "matchCatalogue",
    "commitPlatformLink",
    "appendTwitterTeaser",
    "appendRedditPost",
    "appendDistributionLedger",
    "getSubredditPresetSnapshot",
  ]);

  function normalizeConfig(value = {}) {
    if (value.source === "desktop")
      return {
        valid: true,
        errors: [],
        value: { source: "desktop", connected: true, endpoint: "", secret: "" },
      };
    const endpoint = String(value.endpoint || "").trim();
    const secret = String(value.secret || "").trim();
    const errors = [];
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      errors.push("Enter the deployed Apps Script web-app URL.");
    }
    if (
      url &&
      (url.protocol !== "https:" ||
        url.hostname !== "script.google.com" ||
        !/^\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/.test(url.pathname))
    ) {
      errors.push("Use the HTTPS /macros/s/.../exec Apps Script URL.");
    }
    if (!/^[\x21-\x7e]{24,256}$/.test(secret)) {
      errors.push("Use a random bridge secret between 24 and 256 characters.");
    }
    return {
      valid: errors.length === 0,
      errors,
      value: { endpoint: url ? url.href : endpoint, secret },
    };
  }

  function boundedPayload(action, payload = {}) {
    if (action === "getCatalogueSnapshot") return {};
    if (action === "getSubredditPresetSnapshot") return {};
    if (action === "matchCatalogue") {
      const value = {
        filename: String(payload.filename || "").slice(0, 255),
        title: String(payload.title || "")
          .trim()
          .slice(0, 500),
        description: String(payload.description || "")
          .trim()
          .slice(0, 10_000),
        releaseDate: String(payload.releaseDate || ""),
        targets: Array.isArray(payload.targets)
          ? payload.targets.slice(0, 3)
          : [],
        forceNew: payload.forceNew === true,
      };
      if (
        !value.title ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value.releaseDate) ||
        !value.targets.length ||
        value.targets.some(
          (target) => !new Set(["onlyfans", "fansly", "manyvids"]).has(target),
        )
      ) {
        throw new Error("Invalid catalogue match request.");
      }
      return value;
    }
    if (action === "appendTwitterTeaser") {
      const value = {
        row: Number(payload.row),
        id: String(payload.id || "")
          .trim()
          .slice(0, 500),
        fingerprint: String(payload.fingerprint || "").slice(0, 64),
        statusUrl: String(payload.statusUrl || "").slice(0, 500),
      };
      if (
        !Number.isInteger(value.row) ||
        value.row < 2 ||
        !value.id ||
        !/^[a-f0-9]{8,64}$/i.test(value.fingerprint) ||
        !value.statusUrl
      ) {
        throw new Error("Invalid Twitter teaser append request.");
      }
      return value;
    }
    if (action === "appendRedditPost") {
      const value = {
        row: Number(payload.row),
        id: String(payload.id || "")
          .trim()
          .slice(0, 500),
        fingerprint: String(payload.fingerprint || "").slice(0, 64),
        redditUrl: String(payload.redditUrl || "").slice(0, 500),
      };
      if (
        !Number.isInteger(value.row) ||
        value.row < 2 ||
        !value.id ||
        !/^[a-f0-9]{8,64}$/i.test(value.fingerprint) ||
        !value.redditUrl
      ) {
        throw new Error("Invalid Reddit post append request.");
      }
      return value;
    }
    if (action === "appendDistributionLedger") {
      const value = {};
      for (const [field, maximum] of [
        ["eventId", 100],
        ["runId", 64],
        ["jobId", 100],
        ["platform", 20],
        ["catalogueId", 500],
        ["resultId", 200],
        ["resultUrl", 1000],
        ["status", 50],
      ]) {
        value[field] = String(payload[field] || "")
          .trim()
          .slice(0, Number(maximum));
      }
      value.catalogueRow = Number(payload.catalogueRow);
      value.recordedAt = Number(payload.recordedAt);
      if (
        !/^[A-Za-z0-9_-]{2,100}$/.test(value.eventId) ||
        !/^[A-Za-z0-9_-]{8,64}$/.test(value.runId) ||
        !/^[A-Za-z0-9:_-]{1,100}$/.test(value.jobId) ||
        !new Set(["x", "redgifs", "reddit"]).has(value.platform) ||
        !Number.isInteger(value.catalogueRow) ||
        value.catalogueRow < 2 ||
        !value.catalogueId ||
        !value.resultId ||
        !value.resultUrl ||
        !new Set(["published", "deleted", "removed", "unresolved"]).has(
          value.status,
        ) ||
        !Number.isSafeInteger(value.recordedAt) ||
        value.recordedAt < 1
      ) {
        throw new Error("Invalid distribution ledger append request.");
      }
      return value;
    }
    const metadata = payload.metadata || {};
    const value = {
      row: Number(payload.row),
      fingerprint: String(payload.fingerprint || "").slice(0, 64),
      platform: String(payload.platform || ""),
      postUrl: String(payload.postUrl || "").slice(0, 500),
      metadata: {
        id: String(metadata.id || "").slice(0, 500),
        releaseDate: String(metadata.releaseDate || ""),
        title: String(metadata.title || "").slice(0, 500),
        description: String(metadata.description || "").slice(0, 10_000),
      },
    };
    if (
      !Number.isInteger(value.row) ||
      value.row < 2 ||
      !/^[a-f0-9]{8,64}$/i.test(value.fingerprint) ||
      !new Set(["onlyfans", "fansly", "manyvids"]).has(value.platform) ||
      !value.postUrl
    ) {
      throw new Error("Invalid catalogue commit request.");
    }
    return value;
  }

  /**
   * @param {{endpoint?: string, secret?: string, source?: string, connected?: boolean}} config
   * @param {string} action
   * @param {Record<string, unknown>} payload
   * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
   */
  async function request(config, action, payload, options = {}) {
    if (config?.source === "desktop") return desktopRequest(action, payload);
    const { fetchImpl = fetch, signal } = options;
    const expectedSource =
      /** @type {{backend?: string, workbookId?: string, sheetName?: string} | undefined} */ (
        payload.expectedSource
      );
    const normalized = normalizeConfig(config);
    if (!normalized.valid) throw new Error(normalized.errors.join(" "));
    if (!ACTIONS.has(action)) throw new Error("Unsupported catalogue action.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(normalized.value.endpoint, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({
          action,
          payload: {
            ...boundedPayload(action, payload),
            ...(expectedSource
              ? {
                  expectedSource: {
                    backend: String(expectedSource.backend),
                    workbookId: String(expectedSource.workbookId).slice(0, 200),
                    sheetName: String(expectedSource.sheetName).slice(0, 200),
                  },
                }
              : {}),
          },
          secret: normalized.value.secret,
        }),
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`Catalogue bridge returned HTTP ${response.status}.`);
      const body = await response.json();
      if (!body?.ok)
        throw new Error(
          body?.error || "Catalogue bridge rejected the request.",
        );
      return body.result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          "Catalogue bridge request timed out or was cancelled.",
          {
            cause: error,
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function loadConfig() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value =
      /** @type {{source?: string, endpoint?: string, secret?: string}} */ (
        stored[STORAGE_KEY]
      );
    return value?.source === "legacy"
      ? normalizeConfig(value).value
      : normalizeConfig({ source: "desktop" }).value;
  }

  async function saveConfig(config) {
    const normalized = normalizeConfig(config);
    if (!normalized.valid) throw new Error(normalized.errors.join(" "));
    await chrome.storage.local.set({
      [STORAGE_KEY]: { ...normalized.value, source: "legacy" },
    });
    return normalized.value;
  }

  async function matchCatalogue(payload, options) {
    return request(await loadConfig(), "matchCatalogue", payload, options);
  }

  async function desktopRequest(action, payload = {}) {
    const operation =
      action === "getCatalogueSnapshot"
        ? "getUploadCatalogueSnapshot"
        : action === "getSubredditPresetSnapshot"
          ? "getSubredditPresets"
          : new Set([
                "commitPlatformLink",
                "appendTwitterTeaser",
                "appendRedditPost",
                "appendDistributionLedger",
              ]).has(action)
            ? "recordUploadResult"
            : null;
    if (!operation)
      throw new Error(
        "Choose an existing catalogue item or continue without matching it.",
      );
    const value =
      operation === "recordUploadResult"
        ? {
            ...payload,
            platform:
              action === "appendTwitterTeaser"
                ? "x"
                : action === "appendRedditPost"
                  ? "reddit"
                  : payload.platform,
            postUrl:
              payload.postUrl ||
              payload.statusUrl ||
              payload.redditUrl ||
              payload.resultUrl,
            action,
          }
        : {};
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const done = (response) => {
        if (chrome.runtime.lastError || !response?.ok)
          return reject(
            new Error(
              response?.error?.code ||
                response?.error ||
                "Open OFEnhancer on this PC to connect your catalogue.",
            ),
          );
        resolve(
          operation === "recordUploadResult" &&
            response.result?.status === "idempotent"
            ? { ...response.result, status: "recorded-local" }
            : response.result,
        );
      };
      if (chrome.runtime.sendNativeMessage)
        chrome.runtime.sendNativeMessage(
          "com.johnnyguides.ofenhancer",
          { protocolVersion: 1, requestId, operation, payload: value },
          done,
        );
      else
        chrome.runtime.sendMessage(
          { type: "OFENHANCER_APP_REQUEST", operation, payload: value },
          done,
        );
    });
  }

  async function getCatalogueSnapshot(options) {
    return request(await loadConfig(), "getCatalogueSnapshot", {}, options);
  }

  async function getReconciliationSource() {
    const config = await loadConfig();
    if (config.source === "desktop")
      throw new Error(
        "The desktop catalogue records locally. X reconciliation requires a verified Apps Script Sheet source.",
      );
    const snapshot = await request(config, "getCatalogueSnapshot", {});
    if (
      snapshot.source?.backend !== "apps-script" ||
      !snapshot.source.workbookId ||
      !snapshot.source.sheetName
    )
      throw new Error(
        "Update and verify the Apps Script bridge before pairing an X reconciliation session.",
      );
    return { ...snapshot.source, endpoint: config.endpoint };
  }

  async function reconciliationRequest(source, action, payload) {
    const config = await loadConfig();
    if (config.source === "desktop" || config.endpoint !== source.endpoint)
      throw new Error(
        "The approved catalogue backend changed; reconciliation stopped.",
      );
    const result = await request(config, action, {
      ...payload,
      expectedSource: source,
    });
    if (
      action === "getCatalogueSnapshot" &&
      (result.source?.workbookId !== source.workbookId ||
        result.source?.sheetName !== source.sheetName)
    )
      throw new Error("The approved Sheet changed; reconciliation stopped.");
    return result;
  }

  async function getReconciliationSnapshot(source) {
    return reconciliationRequest(source, "getCatalogueSnapshot", {});
  }
  async function appendVerifiedTwitterTeaser(payload, source) {
    return reconciliationRequest(source, "appendTwitterTeaser", payload);
  }

  async function commitPlatformLink(payload, options) {
    return request(await loadConfig(), "commitPlatformLink", payload, options);
  }

  async function appendTwitterTeaser(payload, options) {
    return request(await loadConfig(), "appendTwitterTeaser", payload, options);
  }

  async function appendRedditPost(payload, options) {
    return request(await loadConfig(), "appendRedditPost", payload, options);
  }

  async function appendDistributionLedger(payload, options) {
    return request(
      await loadConfig(),
      "appendDistributionLedger",
      payload,
      options,
    );
  }

  async function getSubredditPresetSnapshot(options) {
    return request(
      await loadConfig(),
      "getSubredditPresetSnapshot",
      {},
      options,
    );
  }

  globalThis.CreatorCatalogueClient = Object.freeze({
    getReconciliationSource,
    getReconciliationSnapshot,
    appendVerifiedTwitterTeaser,
    STORAGE_KEY,
    appendDistributionLedger,
    appendRedditPost,
    appendTwitterTeaser,
    commitPlatformLink,
    getCatalogueSnapshot,
    getSubredditPresetSnapshot,
    loadConfig,
    matchCatalogue,
    normalizeConfig,
    request,
    saveConfig,
  });
})();
