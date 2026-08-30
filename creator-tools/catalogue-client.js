(() => {
  "use strict";

  if (globalThis.CreatorCatalogueClient) return;

  const STORAGE_KEY = "creatorUploadSheetBridgeV1";
  const ACTIONS = new Set(["matchCatalogue", "commitPlatformLink"]);

  function normalizeConfig(value = {}) {
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
          ? payload.targets.slice(0, 2)
          : [],
        forceNew: payload.forceNew === true,
      };
      if (
        !value.title ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value.releaseDate) ||
        !value.targets.length ||
        value.targets.some(
          (target) => !new Set(["onlyfans", "fansly"]).has(target),
        )
      ) {
        throw new Error("Invalid catalogue match request.");
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
      !new Set(["onlyfans", "fansly"]).has(value.platform) ||
      !value.postUrl
    ) {
      throw new Error("Invalid catalogue commit request.");
    }
    return value;
  }

  /**
   * @param {{endpoint: string, secret: string}} config
   * @param {string} action
   * @param {Record<string, unknown>} payload
   * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
   */
  async function request(config, action, payload, options = {}) {
    const { fetchImpl = fetch, signal } = options;
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
          payload: boundedPayload(action, payload),
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
    return normalizeConfig(stored[STORAGE_KEY] || {}).value;
  }

  async function saveConfig(config) {
    const normalized = normalizeConfig(config);
    if (!normalized.valid) throw new Error(normalized.errors.join(" "));
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized.value });
    return normalized.value;
  }

  async function matchCatalogue(payload, options) {
    return request(await loadConfig(), "matchCatalogue", payload, options);
  }

  async function commitPlatformLink(payload, options) {
    return request(await loadConfig(), "commitPlatformLink", payload, options);
  }

  globalThis.CreatorCatalogueClient = Object.freeze({
    STORAGE_KEY,
    commitPlatformLink,
    loadConfig,
    matchCatalogue,
    normalizeConfig,
    request,
    saveConfig,
  });
})();
