(() => {
  "use strict";

  if (globalThis.CreatorUploadResponseObserver) return;

  const ENDPOINTS = Object.freeze({
    onlyfans: Object.freeze({
      origin: "https://onlyfans.com",
      path: "/api2/v2/posts",
    }),
    fansly: Object.freeze({
      origin: "https://apiv3.fansly.com",
      path: "/api/v1/post",
    }),
  });
  const observers = new Set();
  const xhrMeta = new WeakMap();
  let patched = false;

  function canonical(platform, value) {
    return (
      globalThis.CreatorCatalogueContract?.canonicalPostUrl(platform, value) ||
      null
    );
  }

  function extractPostUrl(platform, payload) {
    if (
      !Object.hasOwn(ENDPOINTS, platform) ||
      !payload ||
      typeof payload !== "object"
    ) {
      return null;
    }
    if (
      payload.success === false ||
      payload.error ||
      payload.errors ||
      payload.status === "error"
    )
      return null;
    const urls = new Set();
    const explicitIds = new Set();
    const contextualIds = new Set();
    const queue = [{ value: payload, path: [] }];
    let visited = 0;
    while (queue.length && visited < 200) {
      const current = queue.shift();
      visited += 1;
      if (!current.value || typeof current.value !== "object") continue;
      if (
        current.value.success === false ||
        current.value.status === "error" ||
        current.value.error ||
        (Array.isArray(current.value.errors) && current.value.errors.length)
      )
        return null;
      for (const [key, value] of Object.entries(current.value)) {
        const normalizedKey = key.toLowerCase().replace(/_/g, "");
        const path = [...current.path, key];
        if (
          typeof value === "string" &&
          new Set(["url", "link", "permalink", "posturl"]).has(normalizedKey)
        ) {
          const result = canonical(platform, value);
          if (result) urls.add(result);
        }
        if (
          (typeof value === "string" || typeof value === "number") &&
          /^\d{5,}$/.test(String(value))
        ) {
          if (normalizedKey === "postid") {
            explicitIds.add(String(value));
          } else if (normalizedKey === "id") {
            const parent = String(current.path.at(-1) || "").toLowerCase();
            if (
              current.path.length === 0 ||
              new Set(["post", "data", "response"]).has(parent)
            ) {
              contextualIds.add(String(value));
            }
          }
        }
        if (value && typeof value === "object" && path.length < 6) {
          queue.push({ value, path });
        }
      }
    }
    const candidates = new Set(urls);
    const ids = new Set([...explicitIds, ...contextualIds]);
    for (const id of ids) {
      const result = canonical(platform, id);
      if (result) candidates.add(result);
    }
    return candidates.size === 1 ? [...candidates][0] : null;
  }

  function matchesEndpoint(meta, platform) {
    if (!meta || meta.method !== "POST") return false;
    try {
      const url = new URL(meta.url, location.href);
      const expected = ENDPOINTS[platform];
      if (platform === "fansly") {
        return (
          url.pathname === expected.path &&
          new Set([expected.origin, "https://fansly.com"]).has(url.origin)
        );
      }
      return url.origin === expected.origin && url.pathname === expected.path;
    } catch {
      return false;
    }
  }

  function responsePayload(xhr) {
    if (xhr.responseType === "json") return xhr.response;
    const text = String(xhr.responseText || "");
    if (!text || text.length > 2_000_000) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function settle(observer, result, error = null) {
    if (!observers.delete(observer)) return;
    clearTimeout(observer.timeout);
    if (error) observer.reject(error);
    else observer.resolve(result);
  }

  function inspectCompletedXhr(xhr) {
    const meta = xhrMeta.get(xhr);
    for (const observer of [...observers]) {
      if (
        !meta?.epochs?.has(observer) ||
        !matchesEndpoint(meta, observer.platform)
      )
        continue;
      if (xhr.status < 200 || xhr.status >= 300) {
        settle(
          observer,
          null,
          new Error(
            `${observer.platform} rejected the final post request (${xhr.status}).`,
          ),
        );
        continue;
      }
      const postUrl = extractPostUrl(observer.platform, responsePayload(xhr));
      settle(observer, {
        platform: observer.platform,
        postUrl,
        sessionId: observer.sessionId,
        status: postUrl ? "link-captured" : "posted-link-unresolved",
      });
    }
  }

  function patchXhr() {
    if (patched) return;
    patched = true;
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function creatorUploadObservedOpen(
      method,
      url,
      ...rest
    ) {
      xhrMeta.set(this, {
        method: String(method || "").toUpperCase(),
        url: String(url || ""),
        epochs: new Set([...observers].filter((observer) => observer.armed)),
      });
      this.addEventListener("loadend", () => inspectCompletedXhr(this), {
        once: true,
      });
      return originalOpen.call(this, method, url, ...rest);
    };
  }

  function install({
    sessionId,
    platform,
    timeoutMs = 30 * 60_000,
    deferred = false,
  }) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(sessionId || ""))) {
      return Promise.reject(new Error("Invalid upload response session."));
    }
    if (!Object.hasOwn(ENDPOINTS, platform)) {
      return Promise.reject(new Error("Unsupported upload response platform."));
    }
    patchXhr();
    return new Promise((resolve, reject) => {
      const observer = {
        sessionId,
        platform,
        resolve,
        reject,
        timeout: null,
        armed: false,
        timeoutMs,
      };
      observers.add(observer);
      if (!deferred) arm(sessionId, platform);
    });
  }

  function arm(sessionId, platform) {
    const matches = [...observers].filter(
      (item) => item.sessionId === sessionId && item.platform === platform,
    );
    if (matches.length !== 1 || matches[0].armed) return false;
    const observer = matches[0];
    observer.armed = true;
    observer.timeout = setTimeout(
      () =>
        settle(
          observer,
          null,
          new Error(`Timed out waiting for ${platform} post confirmation.`),
        ),
      Math.max(1_000, Math.min(Number(observer.timeoutMs) || 0, 60 * 60_000)),
    );
    return true;
  }

  function cancel(sessionId, platform) {
    for (const observer of [...observers]) {
      if (observer.sessionId === sessionId && observer.platform === platform) {
        settle(
          observer,
          null,
          new Error("Upload response observation cancelled."),
        );
      }
    }
  }

  globalThis.CreatorUploadResponseObserver = Object.freeze({
    cancel,
    extractPostUrl,
    install,
    arm,
  });
})();
