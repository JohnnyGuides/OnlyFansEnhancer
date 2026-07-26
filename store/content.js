(() => {
  "use strict";

  const core = globalThis.FanIdentityMaskCore;
  if (!core) return;

  let settings = {
    enabled: false,
    consentAccepted: false,
    ownHandles: ["johnny_guides"]
  };
  let scheduled = false;
  let scanning = false;
  let rescanRequested = false;
  const identityCache = new Map();

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Extension request failed."));
          return;
        }
        resolve(response);
      });
    });
  }

  async function loadSettings() {
    const response = await sendMessage({ type: "GET_SETTINGS" });
    settings = response.settings;
  }

  function cachedIdentity(context) {
    for (const key of [context.primaryKey, ...context.aliases]) {
      if (identityCache.has(key)) return identityCache.get(key);
    }
    return null;
  }

  function markPendingContexts() {
    if (!settings.enabled || !document.documentElement) return [];
    const contexts = core.collectContexts(document, settings);
    for (const context of contexts) {
      if (!context.container.dataset.fimIdentity) {
        context.container.classList.add("fim-identity-pending");
      }
    }
    return contexts;
  }

  async function resolveIdentityBatch(contexts) {
    const unresolvedByPrimary = new Map();
    for (const context of contexts) {
      if (cachedIdentity(context)) continue;
      if (!unresolvedByPrimary.has(context.primaryKey)) {
        unresolvedByPrimary.set(context.primaryKey, {
          primaryKey: context.primaryKey,
          aliases: [...context.aliases]
        });
      } else {
        const item = unresolvedByPrimary.get(context.primaryKey);
        item.aliases = [...new Set([...item.aliases, ...context.aliases])];
      }
    }

    if (unresolvedByPrimary.size > 0) {
      const response = await sendMessage({
        type: "RESOLVE_IDENTITIES",
        items: [...unresolvedByPrimary.values()]
      });

      for (const item of response.items) {
        for (const key of [item.primaryKey, ...item.aliases]) {
          identityCache.set(key, item.identity);
        }
      }
    }
  }

  async function scan() {
    scheduled = false;
    if (scanning || !settings.enabled || !document.documentElement) return;
    scanning = true;

    try {
      const contexts = markPendingContexts();
      await resolveIdentityBatch(contexts);
      for (const context of contexts) {
        core.maskContext(context, cachedIdentity(context));
      }
    } catch (error) {
      console.warn("[Fan Identity Mask]", error);
    } finally {
      scanning = false;
      if (rescanRequested) {
        rescanRequested = false;
        scheduleScan();
      }
    }
  }

  function scheduleScan() {
    if (scheduled || !settings.enabled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      window.setTimeout(scan, 40);
    });
  }

  const observer = new MutationObserver(() => {
    markPendingContexts();
    scheduleScan();
  });

  function finishFailedRotation(keys, message) {
    const acceptableKeys = new Set(keys.filter(Boolean));
    for (const image of document.querySelectorAll("[data-fim-avatar-primary]")) {
      let aliases = [];
      try {
        aliases = JSON.parse(image.dataset.fimAvatarAliases || "[]");
      } catch {
        aliases = [];
      }
      if (
        !acceptableKeys.has(image.dataset.fimAvatarPrimary) &&
        !aliases.some((key) => acceptableKeys.has(key))
      ) {
        continue;
      }
      image.closest(".g-avatar__img-wrapper")?.classList.remove("fim-avatar-loading");
      image.title = `Could not change picture: ${message}`;
    }
  }

  async function rotateAvatar(detail = {}) {
    const primaryKey = String(detail.primaryKey || "");
    const aliases = Array.isArray(detail.aliases) ? detail.aliases : [];
    const keys = [...new Set([primaryKey, ...aliases].filter(Boolean))];
    if (!primaryKey) return;

    try {
      const { result } = await sendMessage({
        type: "ROTATE_AVATAR",
        primaryKey,
        aliases
      });
      const identity = result.identity;
      const resultKeys = [
        result.primaryKey,
        ...(Array.isArray(result.aliases) ? result.aliases : []),
        ...keys
      ].filter(Boolean);

      for (const [key, cached] of identityCache.entries()) {
        if (cached?.handle === identity.handle) identityCache.set(key, identity);
      }
      for (const key of resultKeys) identityCache.set(key, identity);

      const acceptableKeys = new Set(resultKeys);
      for (const context of core.collectContexts(document, settings)) {
        if (
          acceptableKeys.has(context.primaryKey) ||
          context.aliases.some((key) => acceptableKeys.has(key))
        ) {
          core.maskContext(context, identity);
        }
      }
    } catch (error) {
      finishFailedRotation(keys, error.message);
      console.warn("[Fan Identity Mask] Could not change avatar.", error);
    }
  }

  async function start() {
    document.documentElement.classList.add("fim-mask-pending");
    try {
      await loadSettings();
    } catch (error) {
      console.warn("[Fan Identity Mask] Could not load settings.", error);
    }

    if (!settings.enabled) {
      document.documentElement.classList.remove("fim-mask-pending");
      return;
    }

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    markPendingContexts();
    scheduleScan();
    window.setTimeout(() => {
      document.documentElement.classList.remove("fim-mask-pending");
    }, 3500);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.fimControlV1) {
      identityCache.clear();
      markPendingContexts();
      if (scanning) {
        rescanRequested = true;
      } else {
        scheduleScan();
      }
      return;
    }
    if (!changes.fimSettingsV1) return;
    const previousEnabled = settings.enabled;
    settings = changes.fimSettingsV1.newValue || settings;
    identityCache.clear();

    if (previousEnabled !== settings.enabled) {
      location.reload();
      return;
    }
    scheduleScan();
  });

  window.addEventListener("fim:rotate-avatar", (event) => {
    rotateAvatar(event.detail);
  });

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
})();
