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
    manyvids: Object.freeze({
      origin: "https://www.manyvids.com",
      path: "/includes/saveVideo.php",
    }),
  });
  const MANUAL_WATCH_EVENT = "creator-upload-manual-publish";
  const MANUAL_WATCH_MAX_MS = 12 * 60 * 60_000;
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
        platform === "fansly" &&
        Array.isArray(current.value.posts) &&
        current.value.posts.length !== 1
      )
        return null;
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
          (typeof value === "string" || Number.isSafeInteger(value)) &&
          /^\d{5,}$/.test(String(value))
        ) {
          if (normalizedKey === "postid") {
            explicitIds.add(String(value));
          } else if (normalizedKey === "id") {
            const parent = String(current.path.at(-1) || "").toLowerCase();
            if (
              current.path.length === 0 ||
              new Set(["post", "data", "response"]).has(parent) ||
              (platform === "fansly" && current.path.at(-2) === "posts")
            ) {
              contextualIds.add(String(value));
            }
          }
        }
        if (value && typeof value === "object" && path.length < 6) {
          // Attachment ownership and account-media identities are not post IDs.
          if (
            platform === "fansly" &&
            new Set(["attachments", "accountMedia"]).has(key)
          )
            continue;
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

  function extractFanslyMediaId(payload, postUrl) {
    if (!postUrl || extractPostUrl("fansly", payload) !== postUrl) return "";
    const response = payload.response;
    if (!response || typeof response !== "object") return "";
    const post = Array.isArray(response.posts)
      ? response.posts.length === 1 && response.posts[0]
      : response.post || response;
    const id = (value) =>
      typeof value === "string" && /^\d{1,40}$/.test(value) ? value : "";
    if (
      !post ||
      !id(post.id) ||
      canonical("fansly", post.id) !== postUrl ||
      !Array.isArray(post.attachments) ||
      !Array.isArray(response.accountMedia)
    )
      return "";
    const videos = new Set();
    for (const attachment of post.attachments) {
      if (
        !attachment ||
        attachment.postId !== post.id ||
        attachment.contentType !== 1 ||
        !id(attachment.contentId)
      )
        return "";
      const matches = response.accountMedia.filter(
        (item) => item && item.id === attachment.contentId,
      );
      if (matches.length !== 1) return "";
      const item = matches[0];
      if (
        item.media?.type === 2 &&
        /^video\//.test(item.media.mimetype || "")
      ) {
        if (!id(item.mediaId) || item.media.id !== item.mediaId) return "";
        videos.add(item.mediaId);
      } else if (!(
        item.media?.type === 1 && /^image\//.test(item.media.mimetype || "")
      ))
        return "";
    }
    return videos.size === 1 ? [...videos][0] : "";
  }

  function expectedMediaIdList(value) {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 20 ||
      value.some((id) => typeof id !== "string" || !/^\d{1,40}$/.test(id)) ||
      new Set(value).size !== value.length
    )
      return null;
    return [...value].sort();
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
        !matchesEndpoint(meta, observer.platform) ||
        (observer.platform === "manyvids" && meta.videoId !== observer.videoId)
      )
        continue;
      if (xhr.status < 200 || xhr.status >= 300) {
        // A manual watch outlives site validation errors: the owner may fix
        // the post and publish again from the same composer.
        if (observer.manual) continue;
        settle(
          observer,
          null,
          new Error(
            `${observer.platform} rejected the final post request (${xhr.status}).`,
          ),
        );
        continue;
      }
      const payload = responsePayload(xhr);
      // ManyVids' current Save handler accepts a JSON object without an error.
      // The ID comes from the exact editor's save request, never an upload card.
      if (
        observer.platform === "manyvids" &&
        (!payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          payload.error)
      ) {
        if (observer.manual) continue;
        settle(observer, null, new Error("ManyVids rejected the final Save."));
        continue;
      }
      const postUrl =
        observer.platform === "manyvids"
          ? canonical("manyvids", observer.videoId)
          : extractPostUrl(observer.platform, payload);
      const fanslyMediaId =
        observer.platform === "fansly"
          ? extractFanslyMediaId(payload, postUrl)
          : "";
      // No verified OnlyFans response/request media-identity contract is
      // available. Never turn a same-endpoint response into a manual receipt.
      if (observer.manual && observer.platform === "onlyfans") continue;
      if (
        observer.manual &&
        observer.platform === "fansly" &&
        (!postUrl ||
          !fanslyMediaId ||
          observer.expectedMediaIds.length !== 1 ||
          observer.expectedMediaIds[0] !== fanslyMediaId)
      )
        continue;
      settle(observer, {
        platform: observer.platform,
        postUrl,
        ...(fanslyMediaId ? { fanslyMediaId } : {}),
        sessionId: observer.sessionId,
        status: postUrl ? "link-captured" : "posted-link-unresolved",
      });
    }
  }

  function patchXhr() {
    if (patched) return;
    patched = true;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
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
    XMLHttpRequest.prototype.send = function creatorUploadObservedSend(body) {
      const meta = xhrMeta.get(this);
      if (matchesEndpoint(meta, "manyvids") && typeof body === "string") {
        const fields = new URLSearchParams(body);
        if (
          fields.getAll("vid_id").length === 1 &&
          fields.get("edit_video") === "true"
        )
          meta.videoId = fields.get("vid_id");
      }
      return originalSend.call(this, body);
    };
  }

  function install({
    sessionId,
    platform,
    timeoutMs = 30 * 60_000,
    deferred = false,
    manual = false,
    videoId = "",
    expectedMediaIds = null,
  }) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(sessionId || ""))) {
      return Promise.reject(new Error("Invalid upload response session."));
    }
    if (!Object.hasOwn(ENDPOINTS, platform)) {
      return Promise.reject(new Error("Unsupported upload response platform."));
    }
    const normalizedExpectedMediaIds = expectedMediaIdList(expectedMediaIds);
    if (manual && platform === "onlyfans")
      return Promise.reject(
        new Error(
          "OnlyFans manual observation has no verified media identity contract.",
        ),
      );
    if (manual && platform === "fansly" && !normalizedExpectedMediaIds)
      return Promise.reject(
        new Error("Manual publish observation requires prepared media IDs."),
      );
    if (
      platform === "manyvids" &&
      (!/^\d+$/.test(String(videoId)) ||
        new URL(location.href).origin !== ENDPOINTS.manyvids.origin ||
        new URL(location.href).pathname.replace(/\/$/, "") !==
          `/Edit-vid/${videoId}` ||
        /** @type {HTMLInputElement|null} */ (
          document.querySelector("#videoSettingsForm #video_id")
        )?.value !== String(videoId))
    )
      return Promise.reject(new Error("The ManyVids editor identity changed."));
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
        manual: manual === true,
        videoId: String(videoId),
        expectedMediaIds: normalizedExpectedMediaIds || [],
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
      Math.max(
        1_000,
        Math.min(
          Number(observer.timeoutMs) || 0,
          observer.manual ? MANUAL_WATCH_MAX_MS : 60 * 60_000,
        ),
      ),
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

  // Passive watch for a post the owner publishes from a prepared composer.
  // Only requests opened after arming in this document count, and the first
  // matching response settles it. The outcome is announced to the isolated
  // bridge, and from there to the extension worker.
  function watch({
    sessionId,
    platform,
    watchId,
    timeoutMs,
    videoId,
    expectedMediaIds,
  }) {
    if (!/^[a-f0-9]{32}$/.test(String(watchId || ""))) return false;
    const normalizedExpectedMediaIds = expectedMediaIdList(expectedMediaIds);
    if (platform === "onlyfans") return false;
    if (platform === "fansly" && !normalizedExpectedMediaIds) return false;
    cancel(sessionId, platform);
    const announce = (outcome, postUrl = "", fanslyMediaId = "") =>
      document.dispatchEvent(
        new CustomEvent(MANUAL_WATCH_EVENT, {
          detail: JSON.stringify({
            watchId,
            outcome,
            postUrl,
            ...(fanslyMediaId ? { fanslyMediaId } : {}),
          }),
        }),
      );
    install({
      sessionId,
      platform,
      timeoutMs,
      videoId,
      expectedMediaIds: normalizedExpectedMediaIds,
      manual: true,
    }).then(
      (receipt) =>
        announce(
          receipt?.postUrl ? "captured" : "unresolved",
          receipt?.postUrl || "",
          receipt?.fanslyMediaId || "",
        ),
      (error) =>
        announce(/cancelled/i.test(error?.message) ? "cancelled" : "expired"),
    );
    return [...observers].some(
      (item) =>
        item.manual &&
        item.armed &&
        item.sessionId === sessionId &&
        item.platform === platform,
    );
  }

  globalThis.CreatorUploadResponseObserver = Object.freeze({
    cancel,
    extractPostUrl,
    install,
    arm,
    watch,
    MANUAL_WATCH_EVENT,
  });
})();
