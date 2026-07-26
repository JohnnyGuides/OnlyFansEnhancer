(() => {
  "use strict";

  const STORAGE_KEY = "creatorToolkitV1";
  const DEFAULTS = Object.freeze({
    c4sUpload: true,
    phUploader: true,
    fanslyPrefill: true,
    manyvidsAutofill: true,
    sheerTags: true,
    onlyfansAutoSelect: false,
    onlyfansAutoFollow: true,
    redditBannerCensor: true
  });

  async function settings() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return {
      ...DEFAULTS,
      ...(stored[STORAGE_KEY] || {})
    };
  }

  async function isEnabled(key) {
    const current = await settings();
    return current[key] !== false;
  }

  async function runWhenEnabled(key, callback) {
    if (!(await isEnabled(key))) return false;
    await callback();
    return true;
  }

  globalThis.CreatorToolkit = Object.freeze({
    DEFAULTS,
    STORAGE_KEY,
    isEnabled,
    runWhenEnabled,
    settings
  });
})();
